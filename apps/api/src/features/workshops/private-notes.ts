// Private brainstorming (docs/WAVE3-CONTRACTS.md "private-notes"; build plan §9): editors write
// sticky notes that only they can see, and the starter or a board owner reveals them into the board in
// one controlled operation. Owned by the private-notes engineer; registered from workshops/index.ts.
//
// Privacy (server-side; the UI only hides controls):
// - A draft is returned to its author and nobody else, by every route; another person's draft is a
//   404 (its existence is as private as its text). Events carry counts only ("7 notes from 4 people").
// - The text reaches the board only through the sync server's place-notes endpoint, after the
//   session is marked revealed in one transaction. Placed drafts are deleted, so no row keeps who
//   wrote what. Anonymous sessions send no author to the sync server at all, and order the notes by
//   their random ids, so neither the canvas nor the layout tells who wrote which.
// - Draft text is never logged (Fastify request logging is off; nothing here logs a body).
//
// Permissions:
// - GET: `view` (everyone on the board sees the session, its prompt and the counts).
// - Start, add/edit/delete your own drafts: `edit` on an active board.
// - Reveal / place / cancel: `edit`, and the person who started it or a board owner. Once the starter
//   can no longer edit the board (removed, lowered to a read-only role, or a name-only guest who
//   signed out or whose session ended), any editor with an account may too, so a session nobody can
//   end never blocks the board (round-2 SEAM-07). Guests never take over someone else's session.
// - At reveal, drafts of people who left the board (removed from it, or a name-only guest who signed
//   out or whose session ended) are discarded, never placed: in an anonymous session nobody could
//   tell which note to take down. People lowered to a read-only role are still on the board and keep
//   their drafts (written while they could edit).

import {
  AddPrivateNoteInput,
  PRIVATE_FRAME_DEFAULT_NAME,
  PRIVATE_NOTES_EVENTS,
  PRIVATE_NOTES_PER_PERSON_MAX,
  PRIVATE_NOTES_PER_SESSION_MAX,
  type PrivateBrainstorm,
  type PrivateBrainstormEvent,
  type PrivateBrainstormState,
  type PrivateBrainstormStatus,
  type PrivateCounts,
  type PrivateNote,
  type PrivateNoteColor,
  StartPrivateBrainstormInput,
  UpdatePrivateNoteInput,
} from '@draftroom/contracts'
import { isUniqueViolation, type Queryable } from '@draftroom/db'
import { can } from '@draftroom/permissions'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { type BoardAccess, loadBoardAccessMany, pairKey, requireBoardAction } from '../../access.ts'
import { userKind } from '../../auth/users.ts'
import type { Params } from '../../context.ts'
import { ApiError, conflict, forbidden, notFound, parse } from '../../errors.ts'
import { SlidingWindowLimiter } from '../../rate-limit.ts'
import type { FeatureContext } from '../context.ts'

export interface PrivateNotesOptions {
  /** Draft writes (add, edit, delete) per person per minute (default 120). */
  writesPerMinute?: number
  /**
   * Brainstorms one person may start per minute (default 10). A start makes every open client of
   * the board refetch its view, so a start/cancel loop must not turn into a request flood.
   */
  startsPerMinute?: number
}

// ---- rows and ids --------------------------------------------------------------------------------

interface SessionRow {
  id: string
  workspace_id: string
  board_id: string
  prompt: string
  anonymous: boolean
  frame_id: string
  frame_page_id: string
  frame_x: number
  frame_y: number
  frame_w: number
  frame_h: number
  status: PrivateBrainstormStatus
  created_by: string
  created_at: Date
  revealed_at: Date | null
  ended_at: Date | null
  placed_count: number | null
}

interface NoteRow {
  id: string
  session_id: string
  author_id: string
  body: string
  color: PrivateNoteColor
  created_at: Date
  updated_at: Date
}

const SESSION_COLUMNS =
  'id, workspace_id, board_id, prompt, anonymous, frame_id, frame_page_id, frame_x, frame_y, frame_w, frame_h, status, created_by, created_at, revealed_at, ended_at, placed_count'
const NOTE_COLUMNS = 'id, session_id, author_id, body, color, created_at, updated_at'

const SESSION_RE = /^pbs_[0-9A-Za-z]{10,40}$/
const NOTE_RE = /^pnt_[0-9A-Za-z]{10,40}$/
const BASE62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'

/** `<prefix>_` + 20 uniform base62 characters (the same shape as @draftroom/db newId). */
export function privateId(prefix: 'pbs' | 'pnt'): string {
  const limit = 256 - (256 % BASE62.length)
  let out = ''
  while (out.length < 20) {
    const bytes = new Uint8Array(32)
    crypto.getRandomValues(bytes)
    for (const b of bytes) {
      if (b >= limit) continue
      out += BASE62[b % BASE62.length]
      if (out.length === 20) break
    }
  }
  return `${prefix}_${out}`
}

const iso = (d: Date | null) => (d ? d.toISOString() : null)

function toSession(r: SessionRow): PrivateBrainstorm {
  return {
    id: r.id,
    boardId: r.board_id,
    prompt: r.prompt,
    anonymous: r.anonymous,
    frameId: r.frame_id,
    status: r.status,
    createdBy: r.created_by,
    createdAt: r.created_at.toISOString(),
    revealedAt: iso(r.revealed_at),
    endedAt: iso(r.ended_at),
    placedCount: r.placed_count,
  }
}

const toNote = (r: NoteRow): PrivateNote => ({
  id: r.id,
  text: r.body,
  color: r.color,
  createdAt: r.created_at.toISOString(),
  updatedAt: r.updated_at.toISOString(),
})

// ---- errors ------------------------------------------------------------------------------------------

const alreadyActive = () =>
  conflict('PRIVATE_ALREADY_ACTIVE', 'A private brainstorm is already running on this board.')
const notOpen = () => conflict('PRIVATE_NOT_OPEN', 'This brainstorm has been revealed or has ended.')
const placeFailed = () =>
  new ApiError(
    503,
    'PLACE_FAILED',
    "The notes are revealed, but they couldn't be put on the board yet. Try Place notes again.",
  )

// ---- queries -----------------------------------------------------------------------------------------

async function activeSession(q: Queryable, boardId: string): Promise<SessionRow | null> {
  return q.maybeOne<SessionRow>(
    `SELECT ${SESSION_COLUMNS} FROM private_brainstorms
      WHERE board_id = $1 AND status IN ('open', 'revealed') LIMIT 1`,
    [boardId],
  )
}

async function lockSession(tx: Queryable, id: string): Promise<SessionRow> {
  return tx.one<SessionRow>(`SELECT ${SESSION_COLUMNS} FROM private_brainstorms WHERE id = $1 FOR UPDATE`, [
    id,
  ])
}

async function countsOf(q: Queryable, sessionId: string): Promise<PrivateCounts> {
  return q.one<PrivateCounts>(
    `SELECT count(*)::int AS notes, count(DISTINCT author_id)::int AS people
       FROM private_notes WHERE session_id = $1`,
    [sessionId],
  )
}

/** The caller's OWN drafts. Nothing else in this module reads draft rows for a response. */
async function myNotes(q: Queryable, sessionId: string, userId: string): Promise<PrivateNote[]> {
  const rows = await q.query<NoteRow>(
    `SELECT ${NOTE_COLUMNS} FROM private_notes WHERE session_id = $1 AND author_id = $2 ORDER BY seq`,
    [sessionId, userId],
  )
  return rows.rows.map(toNote)
}

const mayEdit = (access: BoardAccess) => can(access.role, 'edit', access.board.status)

/**
 * Which of `userIds` may `action` on the board right now: the board role for it and, for a name-only
 * guest, a live session (a guest who signed out cannot sign in again; the guest sweep removes their
 * grants later, this does not wait for it).
 */
async function allowedNow(
  q: Queryable,
  boardId: string,
  userIds: readonly string[],
  action: 'view' | 'edit',
  at: Date,
): Promise<Set<string>> {
  const ids = [...new Set(userIds)]
  if (ids.length === 0) return new Set()
  const access = await loadBoardAccessMany(
    q,
    ids.map((userId) => ({ boardId, userId })),
  )
  const allowed = ids.filter((userId) => {
    const a = access.get(pairKey({ boardId, userId }))
    return !!a && can(a.role, action, a.board.status)
  })
  if (allowed.length === 0) return new Set()
  const gone = await q.query<{ id: string }>(
    `SELECT u.id FROM users u
      WHERE u.id = ANY($1::text[]) AND u.kind = 'guest'
        AND NOT EXISTS (SELECT 1 FROM sessions s
                         WHERE s.user_id = u.id AND s.revoked_at IS NULL AND s.expires_at > $2)`,
    [allowed, at],
  )
  const left = new Set(gone.rows.map((r) => r.id))
  return new Set(allowed.filter((id) => !left.has(id)))
}

interface RevealRight {
  canReveal: boolean
  /** The starter can no longer edit the board (reported to people who can edit it only). */
  starterLeft: boolean
}

/**
 * May the caller reveal, place or cancel `row`? The starter and board owners may; once the starter
 * can no longer edit the board, so may any editor with an account.
 */
async function revealRight(
  q: Queryable,
  access: BoardAccess,
  row: SessionRow,
  userId: string,
  at: Date,
): Promise<RevealRight> {
  if (!mayEdit(access)) return { canReveal: false, starterLeft: false }
  if (row.created_by === userId) return { canReveal: true, starterLeft: false }
  const starterLeft = !(await allowedNow(q, row.board_id, [row.created_by], 'edit', at)).has(row.created_by)
  if (access.role === 'owner') return { canReveal: true, starterLeft }
  if (!starterLeft) return { canReveal: false, starterLeft }
  return { canReveal: (await userKind(q, userId)) === 'account', starterLeft }
}

// ---- placement ----------------------------------------------------------------------------------------

const PlaceResult = z.object({
  placed: z.array(z.string()),
  existing: z.array(z.string()),
  frameId: z.string(),
  frameCreated: z.boolean(),
})

// biome-ignore lint/suspicious/noControlCharactersInRegex: the point is to replace control characters
const CONTROL_RE = /[\u0000-\u001f\u007f-\u009f]/g
/** A display name the sync server accepts (users.name allows what a note does not). */
const authorName = (name: string) =>
  [...name.replace(CONTROL_RE, ' ').replace(/\s+/g, ' ').trim()].slice(0, 200).join('') || 'Someone'

/**
 * The request for the sync server. Not anonymous: authors in order of their first draft, each
 * author's drafts together (oldest first). Anonymous: ordered by draft id (random), no author at all.
 */
async function placementRequest(q: Queryable, row: SessionRow, notes: NoteRow[]) {
  const frame = {
    id: row.frame_id,
    pageId: row.frame_page_id,
    x: row.frame_x,
    y: row.frame_y,
    w: row.frame_w,
    h: row.frame_h,
    name: PRIVATE_FRAME_DEFAULT_NAME,
  }
  if (row.anonymous) {
    const sorted = [...notes].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    return {
      sessionId: row.id,
      anonymous: true,
      frame,
      notes: sorted.map((n) => ({ id: n.id, text: n.body, color: n.color, authorId: null })),
      authors: [],
    }
  }
  // `notes` are in the order they were written (seq): authors by their first draft, a stable sort
  // keeps each author's drafts in writing order.
  const first = new Map<string, number>()
  notes.forEach((n, i) => {
    if (!first.has(n.author_id)) first.set(n.author_id, i)
  })
  const sorted = [...notes].sort((a, b) => (first.get(a.author_id) ?? 0) - (first.get(b.author_id) ?? 0))
  const ids = [...first.keys()]
  const users = await q.query<{ id: string; name: string; color: string }>(
    'SELECT id, name, color FROM users WHERE id = ANY($1::text[])',
    [ids],
  )
  return {
    sessionId: row.id,
    anonymous: false,
    frame,
    notes: sorted.map((n) => ({ id: n.id, text: n.body, color: n.color, authorId: n.author_id })),
    authors: users.rows.map((u) => ({ id: u.id, name: authorName(u.name), color: u.color })),
  }
}

// ---- routes -------------------------------------------------------------------------------------------

export function registerPrivateNotes(
  app: FastifyInstance,
  ctx: FeatureContext,
  opts: PrivateNotesOptions = {},
) {
  const { db, now, events } = ctx
  const writes = new SlidingWindowLimiter(opts.writesPerMinute ?? 120, 60_000)
  const starts = new SlidingWindowLimiter(opts.startsPerMinute ?? 10, 60_000)
  /**
   * Sessions whose drafts are being placed right now (a reveal between reading the drafts and
   * recording the result), with how many reveals are doing it. Cancel refuses while one is: it would
   * discard drafts the sync server is writing onto the board. In-process, like the event hub (one API
   * instance, docs/DEPLOY.md). A reveal takes its hold while it has the session row locked, and
   * cancel checks it under the same lock, so the two never both go ahead.
   */
  const placing = new Map<string, number>()

  const publish = async (row: SessionRow) => {
    const data: PrivateBrainstormEvent = { session: toSession(row), counts: await countsOf(db, row.id) }
    events.publish(row.board_id, { type: PRIVATE_NOTES_EVENTS.changed, data })
  }

  /** The caller's view of the board's active session (or none). */
  async function stateFor(access: BoardAccess, userId: string): Promise<PrivateBrainstormState> {
    const row = await activeSession(db, access.board.id)
    if (!row)
      return {
        session: null,
        counts: { notes: 0, people: 0 },
        myNotes: [],
        canReveal: false,
        starterLeft: false,
        placed: null,
      }
    return {
      session: toSession(row),
      counts: await countsOf(db, row.id),
      // Your own drafts, whatever your role now (you wrote them while you could edit).
      myNotes: await myNotes(db, row.id, userId),
      ...(await revealRight(db, access, row, userId, now())),
      placed: null,
    }
  }

  /** A session the caller can see (404 otherwise), with their access for `action` on its board. */
  async function sessionFor(req: { params: unknown }, userId: string, action: 'view' | 'edit') {
    const { sid = '' } = req.params as Params
    if (!SESSION_RE.test(sid)) throw notFound()
    const row = await db.maybeOne<SessionRow>(
      `SELECT ${SESSION_COLUMNS} FROM private_brainstorms WHERE id = $1`,
      [sid],
    )
    if (!row) throw notFound()
    const access = await requireBoardAction(db, row.board_id, userId, action)
    if (access.board.workspace_id !== row.workspace_id) throw notFound()
    return { row, access }
  }

  /** One of the CALLER's drafts; anyone else's (or a missing one) is a 404. */
  async function ownNote(req: { params: unknown }, userId: string) {
    const { nid = '' } = req.params as Params
    if (!NOTE_RE.test(nid)) throw notFound()
    const note = await db.maybeOne<NoteRow>(
      `SELECT ${NOTE_COLUMNS} FROM private_notes WHERE id = $1 AND author_id = $2`,
      [nid, userId],
    )
    if (!note) throw notFound()
    const row = await db.one<SessionRow>(`SELECT ${SESSION_COLUMNS} FROM private_brainstorms WHERE id = $1`, [
      note.session_id,
    ])
    const access = await requireBoardAction(db, row.board_id, userId, 'edit')
    if (access.board.workspace_id !== row.workspace_id) throw notFound()
    return { note, row, access }
  }

  const limit = (
    limiter: SlidingWindowLimiter,
    userId: string,
    reply: { header(k: string, v: string): unknown },
    message: string,
  ) => {
    const t = now().getTime()
    if (limiter.take(userId, t)) return
    reply.header('retry-after', String(Math.max(1, Math.ceil(limiter.retryAfterMs(userId, t) / 1000))))
    throw new ApiError(429, 'RATE_LIMITED', message)
  }
  const limitWrites = (userId: string, reply: { header(k: string, v: string): unknown }) =>
    limit(writes, userId, reply, 'That is a lot of changes. Wait a moment and try again.')

  const hold = (sessionId: string) => placing.set(sessionId, (placing.get(sessionId) ?? 0) + 1)
  const release = (sessionId: string) => {
    const n = (placing.get(sessionId) ?? 1) - 1
    if (n > 0) placing.set(sessionId, n)
    else placing.delete(sessionId)
  }

  // ---- state and start ---------------------------------------------------------------------------

  app.get('/api/boards/:bid/private-brainstorm', async (req) => {
    const user = await ctx.requireUser(req)
    const { bid = '' } = req.params as Params
    const access = await requireBoardAction(db, bid, user.id, 'view')
    return stateFor(access, user.id)
  })

  app.post('/api/boards/:bid/private-brainstorm', async (req, reply) => {
    const user = await ctx.requireUser(req)
    const { bid = '' } = req.params as Params
    const input = parse(StartPrivateBrainstormInput, req.body)
    let row: SessionRow
    try {
      row = await db.transaction(async (tx) => {
        const access = await requireBoardAction(tx, bid, user.id, 'edit', { forUpdate: true })
        if (await activeSession(tx, access.board.id)) throw alreadyActive()
        limit(starts, user.id, reply, 'That is a lot of brainstorms. Wait a moment and try again.')
        const t = input.target
        return tx.one<SessionRow>(
          `INSERT INTO private_brainstorms (id, workspace_id, board_id, prompt, anonymous, frame_id, frame_page_id,
             frame_x, frame_y, frame_w, frame_h, status, created_by, created_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'open', $12, $13)
           RETURNING ${SESSION_COLUMNS}`,
          [
            privateId('pbs'),
            access.board.workspace_id,
            access.board.id,
            input.prompt,
            input.anonymous,
            t.frameId,
            t.pageId,
            t.x,
            t.y,
            t.w,
            t.h,
            user.id,
            now(),
          ],
        )
      })
    } catch (e) {
      // Two people started one at the same moment: the partial unique index picked one.
      if (isUniqueViolation(e)) throw alreadyActive()
      throw e
    }
    await publish(row)
    const access = await requireBoardAction(db, row.board_id, user.id, 'view')
    return reply.code(201).send(await stateFor(access, user.id))
  })

  // ---- drafts (your own only) ---------------------------------------------------------------------

  app.post('/api/private-brainstorms/:sid/notes', async (req, reply) => {
    const user = await ctx.requireUser(req)
    const input = parse(AddPrivateNoteInput, req.body)
    const { row: found, access } = await sessionFor(req, user.id, 'edit')
    limitWrites(user.id, reply)
    const at = now()
    const row = await db.transaction(async (tx) => {
      // The session lock serializes a session's drafts, so the caps below stay exact.
      const locked = await lockSession(tx, found.id)
      if (locked.status !== 'open') throw notOpen()
      const n = await tx.one<{ mine: number; all: number }>(
        `SELECT count(*) FILTER (WHERE author_id = $2)::int AS mine, count(*)::int AS "all"
           FROM private_notes WHERE session_id = $1`,
        [locked.id, user.id],
      )
      if (n.mine >= PRIVATE_NOTES_PER_PERSON_MAX)
        throw conflict('TOO_MANY_NOTES', `You can write at most ${PRIVATE_NOTES_PER_PERSON_MAX} notes here.`)
      if (n.all >= PRIVATE_NOTES_PER_SESSION_MAX)
        throw conflict('TOO_MANY_NOTES', 'This brainstorm has as many notes as it can hold.')
      await tx.query(
        `INSERT INTO private_notes (id, workspace_id, session_id, author_id, body, color, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $7)`,
        [privateId('pnt'), locked.workspace_id, locked.id, user.id, input.text, input.color, at],
      )
      return locked
    })
    await publish(row)
    return reply.code(201).send(await stateFor(access, user.id))
  })

  app.patch('/api/private-notes/:nid', async (req, reply) => {
    const user = await ctx.requireUser(req)
    const input = parse(UpdatePrivateNoteInput, req.body)
    const { note, access } = await ownNote(req, user.id)
    limitWrites(user.id, reply)
    await db.transaction(async (tx) => {
      const locked = await lockSession(tx, note.session_id)
      if (locked.status !== 'open') throw notOpen()
      await tx.query(
        `UPDATE private_notes SET body = coalesce($3, body), color = coalesce($4, color), updated_at = $5
          WHERE id = $1 AND author_id = $2`,
        [note.id, user.id, input.text ?? null, input.color ?? null, now()],
      )
    })
    // Counts are unchanged: nobody else needs to hear about an edit.
    return stateFor(access, user.id)
  })

  app.delete('/api/private-notes/:nid', async (req, reply) => {
    const user = await ctx.requireUser(req)
    const { note, access } = await ownNote(req, user.id)
    limitWrites(user.id, reply)
    const row = await db.transaction(async (tx) => {
      const locked = await lockSession(tx, note.session_id)
      if (locked.status !== 'open') throw notOpen()
      await tx.query('DELETE FROM private_notes WHERE id = $1 AND author_id = $2', [note.id, user.id])
      return locked
    })
    await publish(row)
    return stateFor(access, user.id)
  })

  // ---- reveal (and place) / cancel -------------------------------------------------------------------

  /**
   * Reveal is idempotent and is also "Place notes": the first call marks the session revealed (one
   * transaction); every call then asks the sync server to place the drafts still waiting (shape ids
   * derived from draft ids, so a doubled or retried call never duplicates a note), and deletes the
   * drafts it confirmed. The session ends ('placed') when none are left.
   */
  app.post('/api/private-brainstorms/:sid/reveal', async (req) => {
    const user = await ctx.requireUser(req)
    const { row: found, access } = await sessionFor(req, user.id, 'edit')
    if (!(await revealRight(db, access, found, user.id, now())).canReveal)
      throw forbidden('Only the person who started this brainstorm or a board owner can reveal it.')
    // From reading the drafts until the result is recorded, this reveal holds the session against a
    // cancel (see `placing`): the hold is taken under the session lock, before the drafts go out.
    let held = false
    try {
      return await revealAndPlace()
    } finally {
      if (held) release(found.id)
    }

    async function revealAndPlace() {
      const marked = await db.transaction(async (tx) => {
        const locked = await lockSession(tx, found.id)
        if (locked.status === 'cancelled')
          throw conflict('PRIVATE_CANCELLED', 'This brainstorm was cancelled.')
        let row = locked
        let changed = false
        if (locked.status === 'open') {
          row = await tx.one<SessionRow>(
            `UPDATE private_brainstorms SET status = 'revealed', revealed_at = $2 WHERE id = $1
           RETURNING ${SESSION_COLUMNS}`,
            [locked.id, now()],
          )
          changed = true
        }
        if (row.status !== 'revealed') return { row, changed, waiting: [] as NoteRow[] }
        const drafts = await tx.query<NoteRow>(
          `SELECT ${NOTE_COLUMNS} FROM private_notes WHERE session_id = $1 ORDER BY seq`,
          [row.id],
        )
        // Drafts of people who left the board (removed, or a guest who signed out) are discarded,
        // never placed (SEAM-07). Someone lowered to a read-only role is still on the board: their
        // drafts, written while they could edit, are placed like everyone's.
        const present = await allowedNow(
          tx,
          row.board_id,
          drafts.rows.map((n) => n.author_id),
          'view',
          now(),
        )
        const dropped = drafts.rows.filter((n) => !present.has(n.author_id)).map((n) => n.id)
        if (dropped.length > 0) {
          await tx.query('DELETE FROM private_notes WHERE session_id = $1 AND id = ANY($2::text[])', [
            row.id,
            dropped,
          ])
          changed = true // the counts everyone sees went down
        }
        if (!held) {
          hold(row.id)
          held = true
        }
        return { row, changed, waiting: drafts.rows.filter((n) => present.has(n.author_id)) }
      })
      if (marked.changed) await publish(marked.row)
      if (marked.row.status === 'placed')
        return { ...(await stateFor(access, user.id)), placed: toSession(marked.row) }

      const waiting = marked.waiting
      let confirmed: string[] = []
      if (waiting.length > 0) {
        const place = ctx.sync.placeNotes?.bind(ctx.sync)
        if (!place) throw placeFailed()
        const body = await placementRequest(db, marked.row, waiting)
        let answer: unknown
        try {
          answer = await place(marked.row.board_id, body)
        } catch {
          // Unreachable, refused or timed out: the session stays revealed and says "Place notes".
          throw placeFailed()
        }
        const parsed = PlaceResult.safeParse(answer)
        if (!parsed.success) throw placeFailed()
        const done = new Set(
          [...parsed.data.placed, ...parsed.data.existing].map((id) => id.replace(/^shape:/, '')),
        )
        confirmed = waiting.map((n) => n.id).filter((id) => done.has(id))
      }

      const at = now()
      const ended = await db.transaction(async (tx) => {
        const locked = await lockSession(tx, marked.row.id)
        if (confirmed.length > 0)
          await tx.query('DELETE FROM private_notes WHERE session_id = $1 AND id = ANY($2::text[])', [
            locked.id,
            confirmed,
          ])
        const left = await tx.one<{ n: number }>(
          'SELECT count(*)::int AS n FROM private_notes WHERE session_id = $1',
          [locked.id],
        )
        if (locked.status !== 'revealed' || left.n > 0) return { row: locked, changed: false }
        // The canvas changed: the dashboard's "Edited" time follows (like apps/sync/src/touch.ts reports).
        if (waiting.length > 0)
          await tx.query(
            `UPDATE boards SET updated_at = $2 WHERE id = $1 AND updated_at < $2 AND status <> 'trashed'`,
            [locked.board_id, at],
          )
        const row = await tx.one<SessionRow>(
          `UPDATE private_brainstorms SET status = 'placed', ended_at = $2, placed_count = $3 WHERE id = $1
         RETURNING ${SESSION_COLUMNS}`,
          [locked.id, at, waiting.length],
        )
        return { row, changed: true }
      })
      if (ended.changed) await publish(ended.row)
      if (ended.row.status !== 'placed') {
        // Some drafts were not confirmed (or someone cancelled meanwhile): the session says what is next.
        if (ended.row.status === 'revealed') throw placeFailed()
        throw conflict('PRIVATE_CANCELLED', 'This brainstorm was cancelled.')
      }
      return { ...(await stateFor(access, user.id)), placed: toSession(ended.row) }
    }
  })

  app.post('/api/private-brainstorms/:sid/cancel', async (req) => {
    const user = await ctx.requireUser(req)
    const { row: found, access } = await sessionFor(req, user.id, 'edit')
    if (!(await revealRight(db, access, found, user.id, now())).canReveal)
      throw forbidden('Only the person who started this brainstorm or a board owner can cancel it.')
    const out = await db.transaction(async (tx) => {
      const locked = await lockSession(tx, found.id)
      if (locked.status === 'cancelled') return { row: locked, changed: false }
      if (locked.status === 'placed')
        throw conflict('PRIVATE_PLACED', 'These notes are already on the board.')
      // A reveal is putting the drafts on the board right now: discarding them would leave notes on
      // the board that everyone was told were discarded. It is over in seconds (or fails, and then
      // cancelling works).
      if (placing.has(locked.id))
        throw conflict(
          'PRIVATE_PLACING',
          'The notes are being put on the board right now. Try again in a moment.',
        )
      await tx.query('DELETE FROM private_notes WHERE session_id = $1', [locked.id])
      const row = await tx.one<SessionRow>(
        `UPDATE private_brainstorms SET status = 'cancelled', ended_at = $2 WHERE id = $1
         RETURNING ${SESSION_COLUMNS}`,
        [locked.id, now()],
      )
      return { row, changed: true }
    })
    if (out.changed) await publish(out.row)
    return stateFor(access, user.id)
  })
}
