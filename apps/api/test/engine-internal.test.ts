// Spike B, O5: the api half of the Excalidraw engine's internal contracts (docs/EXCALIDRAW-MIGRATION.md
// §1 A1-A3, §2.10.2; @draftroom/contracts sync-internal.ts): A1 file-refs, A2 workshop-state (the sync
// pull), and A3 the ticket's `guest` claim. Every error body is the contract's, and every failure is
// one sync treats as "unavailable" or a refusal, never as an answer.

import { verifyTicket } from '@draftroom/auth-tickets'
import {
  FILE_REFS_MAX_IDS,
  FileRefsResponse,
  fileRefsPath,
  GuestJoined,
  ReviewLinkCreated,
  SyncInternalErrorBody,
  TicketResponse,
  WorkshopStateBody,
  workshopStatePath,
} from '@draftroom/contracts'
import type { LightMyRequestResponse } from 'fastify'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  type Client,
  createBoard,
  createTestApi,
  DEV_STUDIO,
  INTERNAL_SECRET,
  ORIGIN,
  type TestApi,
  TICKET_SECRET,
} from './helpers.ts'

let api: TestApi
let alice: Client // Dev Studio owner
let bob: Client // Dev Studio member
let boardId: string // bob's board in Dev Studio

beforeEach(async () => {
  api = await createTestApi()
  alice = await api.login('alice')
  bob = await api.login('bob', 'Bob B')
  boardId = await createBoard(bob, DEV_STUDIO, 'Files')
})
afterEach(() => api.close())

const get = (url: string, secret: string | null = INTERNAL_SECRET, extra: Record<string, string> = {}) =>
  api.app.inject({
    method: 'GET',
    url,
    headers: { ...(secret === null ? {} : { 'x-draftroom-internal': secret }), ...extra },
  })

function expectError(res: LightMyRequestResponse, status: number, code: string) {
  expect(res.statusCode, res.body).toBe(status)
  const body = SyncInternalErrorBody.parse(res.json())
  expect(body.error.code).toBe(code)
}

let seq = 0
const id20 = (prefix: string) => `${prefix}_${String(++seq).padStart(4, '0')}${'Ab1'.repeat(6)}`

/** A version row on `board` (workspace read from the board), as an upload would store it. */
async function addVersion(
  board: string,
  opts: { kind?: 'image' | 'pdf' | 'video' | 'other'; pages?: number; name?: string; uploader?: string } = {},
) {
  const b = await api.db.one<{ workspace_id: string }>('SELECT workspace_id FROM boards WHERE id = $1', [
    board,
  ])
  const versionId = id20('ver')
  const assetId = id20('ast')
  const kind = opts.kind ?? 'image'
  const mime =
    kind === 'pdf' ? 'application/pdf' : kind === 'image' ? 'image/png' : 'application/octet-stream'
  await api.db.query(
    `INSERT INTO asset_versions (id, asset_id, workspace_id, board_id, name, declared_mime_type, mime_type, kind,
       size_bytes, sha256, uploaded_by, status, probe)
     VALUES ($1, $2, $3, $4, $5, $6, $6, $7, $8, $9, $10, 'ready', $11::jsonb)`,
    [
      versionId,
      assetId,
      b.workspace_id,
      board,
      opts.name ?? `${kind}.bin`,
      mime,
      kind,
      1234,
      'a'.repeat(64),
      opts.uploader ?? bob.userId,
      JSON.stringify(opts.pages === undefined ? {} : { pageCount: opts.pages }),
    ],
  )
  return { versionId, assetId, workspaceId: b.workspace_id }
}

describe('A1 GET /internal/boards/:bid/file-refs', () => {
  it('refuses a missing, wrong or non-internal credential with 401 bad-secret, before reading anything', async () => {
    const v = await addVersion(boardId)
    const url = fileRefsPath(boardId, [v.versionId])
    expectError(await get(url, null), 401, 'bad-secret')
    expectError(await get(url, 'x'.repeat(INTERNAL_SECRET.length)), 401, 'bad-secret')
    expectError(await get(url, TICKET_SECRET), 401, 'bad-secret')
    // A browser session is not an internal credential.
    expectError(await get(url, null, { cookie: bob.cookie }), 401, 'bad-secret')
    // Even malformed input and unknown boards answer 401 first (nothing is probed without the secret).
    expectError(await get(`/internal/boards/nope/file-refs?ids=x`, null), 401, 'bad-secret')
  })

  it('answers ok / foreign / missing, each asked id exactly once, in the contract shape', async () => {
    const own = await addVersion(boardId, { name: 'photo.png' })
    const pdf = await addVersion(boardId, { kind: 'pdf', pages: 12, name: 'deck.pdf' })
    // Another board of the same workspace: not servable here without a history link.
    const sibling = await createBoard(bob, DEV_STUDIO, 'Sibling')
    const unlinked = await addVersion(sibling)
    const linked = await addVersion(sibling)
    await api.db.query(
      'INSERT INTO board_asset_links (workspace_id, board_id, asset_id, version_id) VALUES ($1, $2, $3, $4)',
      [linked.workspaceId, boardId, linked.assetId, linked.versionId],
    )
    // Another workspace (alice's personal one), even with a forged link row pointing at it.
    const elsewhere = await createBoard(alice, alice.personalWorkspaceId, 'Private')
    const foreign = await addVersion(elsewhere, { uploader: alice.userId })
    const missing = id20('ver')
    const asked = [
      own.versionId,
      pdf.versionId,
      unlinked.versionId,
      linked.versionId,
      foreign.versionId,
      missing,
      own.versionId, // asked twice, answered once
    ]
    const res = await get(fileRefsPath(boardId, asked))
    expect(res.statusCode, res.body).toBe(200)
    const body = FileRefsResponse.parse(res.json())
    expect(body.ok.map((r) => r.versionId).sort()).toEqual(
      [own.versionId, pdf.versionId, linked.versionId].sort(),
    )
    expect(body.foreign.sort()).toEqual([unlinked.versionId, foreign.versionId].sort())
    expect(body.missing).toEqual([missing])
    const byId = new Map(body.ok.map((r) => [r.versionId, r]))
    expect(byId.get(own.versionId)).toEqual({
      versionId: own.versionId,
      assetId: own.assetId,
      kind: 'image',
      name: 'photo.png',
      mimeType: 'image/png',
      sizeBytes: 1234,
      pageCount: null,
    })
    expect(byId.get(pdf.versionId)?.pageCount).toBe(12)
    expect(byId.get(pdf.versionId)?.kind).toBe('pdf')
  })

  it('400 bad-request: no ids, empty, over 100, a malformed id, a page suffix, a repeated parameter', async () => {
    const v = await addVersion(boardId)
    const base = `/internal/boards/${boardId}/file-refs`
    expectError(await get(base), 400, 'bad-request')
    expectError(await get(`${base}?ids=`), 400, 'bad-request')
    const many = Array.from({ length: FILE_REFS_MAX_IDS + 1 }, () => id20('ver'))
    expectError(await get(fileRefsPath(boardId, many)), 400, 'bad-request')
    expectError(await get(`${base}?ids=ver_short`), 400, 'bad-request')
    expectError(await get(`${base}?ids=${v.versionId}.p2`), 400, 'bad-request') // bare ids only
    expectError(await get(`${base}?ids=${v.versionId},`), 400, 'bad-request')
    expectError(await get(`${base}?ids=${v.versionId}&ids=${v.versionId}`), 400, 'bad-request')
    // Exactly 100 is fine.
    const hundred = Array.from({ length: FILE_REFS_MAX_IDS }, () => id20('ver'))
    const ok = await get(fileRefsPath(boardId, hundred))
    expect(ok.statusCode, ok.body).toBe(200)
    expect(FileRefsResponse.parse(ok.json()).missing).toHaveLength(FILE_REFS_MAX_IDS)
  })

  it('404 board-not-found for an unknown or malformed board', async () => {
    const v = await addVersion(boardId)
    expectError(await get(fileRefsPath('b-0000000000', [v.versionId])), 404, 'board-not-found')
    expectError(await get(fileRefsPath('NOT A BOARD', [v.versionId])), 404, 'board-not-found')
  })

  it('503 unavailable when the database fails (sync fails closed on it)', async () => {
    const v = await addVersion(boardId)
    await api.db.query('ALTER TABLE asset_versions RENAME TO asset_versions_gone')
    try {
      expectError(await get(fileRefsPath(boardId, [v.versionId])), 503, 'unavailable')
    } finally {
      await api.db.query('ALTER TABLE asset_versions_gone RENAME TO asset_versions')
    }
  })

  it('is a GET only (no POST route: the CSRF hook would refuse it anyway)', async () => {
    const v = await addVersion(boardId)
    const res = await api.app.inject({
      method: 'POST',
      url: fileRefsPath(boardId, [v.versionId]),
      headers: { 'x-draftroom-internal': INTERNAL_SECRET, origin: ORIGIN },
    })
    expect(res.statusCode).toBe(404)
  })
})

describe('A2 GET /internal/boards/:bid/workshop-state', () => {
  const startVote = (c: Client, extra: Record<string, unknown> = {}) =>
    c.req('POST', `/api/boards/${boardId}/votes`, {
      votesPerPerson: 3,
      onePerObject: false,
      scope: 'board',
      ...extra,
    })
  const state = async () => {
    const res = await get(workshopStatePath(boardId))
    expect(res.statusCode, res.body).toBe(200)
    return WorkshopStateBody.parse(res.json())
  }

  it('follows the open vote: none, open, closed, and an open vote past its end time', async () => {
    expect(await state()).toEqual({ voteOpen: false, anonymous: false })
    const started = await startVote(bob)
    expect(started.statusCode, started.body).toBe(201)
    const vid = (started.json() as { session: { id: string } }).session.id
    expect(await state()).toEqual({ voteOpen: true, anonymous: true })
    expect((await bob.req('POST', `/api/votes/${vid}/close`)).statusCode).toBe(200)
    expect(await state()).toEqual({ voteOpen: false, anonymous: false })
    // A timed vote is over at its end time, with no request in between.
    const timed = await startVote(bob, { durationMs: 60_000 })
    expect(timed.statusCode, timed.body).toBe(201)
    expect((await state()).voteOpen).toBe(true)
    api.clock.advance(61_000)
    expect(await state()).toEqual({ voteOpen: false, anonymous: false })
  })

  it('401 bad-secret and 404 board-not-found, in the contract shape', async () => {
    expectError(await get(workshopStatePath(boardId), null), 401, 'bad-secret')
    expectError(await get(workshopStatePath(boardId), TICKET_SECRET), 401, 'bad-secret')
    expectError(await get(workshopStatePath('b-0000000000')), 404, 'board-not-found')
    expectError(await get(workshopStatePath('../x')), 404, 'board-not-found')
  })
})

describe('A3 the ticket guest claim', () => {
  async function ticketOf(c: { req: Client['req'] }, bid = boardId, body?: unknown) {
    const res = await c.req('POST', `/api/boards/${bid}/ticket`, body)
    expect(res.statusCode, res.body).toBe(200)
    const t = TicketResponse.parse(res.json())
    const v = verifyTicket(TICKET_SECRET, t.ticket, { boardId: bid })
    if (!v.ok) throw new Error(`ticket does not verify: ${v.reason}`)
    return v.claims
  }

  it('an account never gets the claim, and cannot ask for it', async () => {
    const claims = await ticketOf(bob)
    expect(claims.guest).toBeUndefined()
    expect('guest' in claims).toBe(false)
    const asked = await ticketOf(bob, boardId, { guest: true, role: 'viewer' })
    expect(asked.guest).toBeUndefined()
    expect(asked.role).toBe('owner')
  })

  it('a name-only guest always gets `guest: true`, with the role its link grants and nothing more', async () => {
    const link = await bob.req('POST', `/api/boards/${boardId}/review-links`, {
      role: 'editor',
      allowGuests: true,
    })
    expect(link.statusCode, link.body).toBe(201)
    const url = ReviewLinkCreated.parse(link.json()).url
    const token = url.slice(url.lastIndexOf('/') + 1)
    const joined = await api.app.inject({
      method: 'POST',
      url: `/api/invitations/${token}/guest`,
      payload: { name: 'Sam' },
      headers: { origin: ORIGIN },
      remoteAddress: '10.77.0.1',
    })
    expect(joined.statusCode, joined.body).toBe(201)
    const cookie = joined.cookies.find((c) => c.name === 'dr_session')
    if (!cookie) throw new Error('no session cookie')
    const guestUser = GuestJoined.parse(joined.json()).user
    const guest = {
      req: (method: 'POST', url: string, body?: unknown) =>
        api.app.inject({
          method,
          url,
          ...(body === undefined ? {} : { payload: body as object }),
          headers: { origin: ORIGIN, cookie: `dr_session=${cookie.value}` },
        }),
    }
    const claims = await ticketOf(guest as unknown as Client)
    expect(claims.guest).toBe(true)
    expect(claims.uid).toBe(guestUser.id)
    expect(claims.role).toBe('editor') // a workshop link's role; the claim adds sync's guest limits
    expect(claims.name).toContain('(guest)')
    // The same guest asking for "no claim" or an owner's role still gets the claim and its own role.
    const forged = await ticketOf(guest as unknown as Client, boardId, { guest: false, role: 'owner' })
    expect(forged.guest).toBe(true)
    expect(forged.role).toBe('editor')
  })
})
