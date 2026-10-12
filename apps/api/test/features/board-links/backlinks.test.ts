// Wave N (WS7, N7-4): links between boards indexed by the search indexer from the sync's text route (`?links=1`),
// and GET /api/boards/:bid/backlinks: "Linked from", filtered at query time by search's scope (viewable, not
// trashed, workspace membership), never the board itself, at most BACKLINKS_MAX, guests refused. Also: the rows
// cascade with either board, an older sync's answer (no `links`) keeps them, and the one-time backfill fetches the
// boards indexed before their links were ever scanned, once.

import { BACKLINKS_MAX, BacklinksAnswer } from '@draftroom/contracts'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { replaceBoardLinks } from '../../../src/features/board-links/store.ts'
import { LINKS_BACKFILL_PAUSE_MS } from '../../../src/features/search/indexer.ts'
import { type Client, createBoard, DEV_STUDIO } from '../../helpers.ts'
import { touch } from '../search/support.ts'
import { grant, type LinksWorld, linksWorld } from './support.ts'

let w: LinksWorld
beforeEach(async () => {
  w = await linksWorld()
})
afterEach(() => w.close())

type Requester = { req: Client['req'] }

async function backlinks(c: Requester, boardId: string) {
  const res = await c.req('GET', `/api/boards/${boardId}/backlinks`)
  expect(res.statusCode, res.body).toBe(200)
  return BacklinksAnswer.parse(res.json()).backlinks
}

/** The links the index holds from `boardId` (element → target). */
async function rowsFrom(boardId: string) {
  const r = await w.api.db.query<{ from_element: string; to_board: string; to_element: string | null }>(
    'SELECT from_element, to_board, to_element FROM board_links WHERE from_board = $1 ORDER BY from_element',
    [boardId],
  )
  return r.rows
}

/** Indexes `boardId`'s canvas now (as a pass or a search would), its links included. */
async function index(boardId: string) {
  expect(await w.indexer.refreshCanvas(boardId)).toBe('indexed')
}

describe('the indexer stores the links of a board', () => {
  it('replaces a board’s rows on each changed answer; skips links to itself and to boards that do not exist', async () => {
    const { b } = w
    w.sync.setLinks(b.A, [
      { el: 'card-1', to: b.D },
      { el: 'card-2', to: b.B, toEl: 'frame-1' },
      { el: 'self', to: b.A },
      { el: 'ghost', to: 'b-nowhere0001' },
    ])
    await index(b.A)
    expect(await rowsFrom(b.A)).toEqual([
      { from_element: 'card-1', to_board: b.D, to_element: null },
      { from_element: 'card-2', to_board: b.B, to_element: 'frame-1' },
    ])
    const scan = await w.api.db.one<{ n: number }>(
      'SELECT links_clock::int AS n FROM board_link_scans WHERE board_id = $1',
      [b.A],
    )
    expect(scan.n).toBeGreaterThan(0)
    w.sync.setLinks(b.A, [{ el: 'card-3', to: b.C }])
    await index(b.A)
    expect(await rowsFrom(b.A)).toEqual([{ from_element: 'card-3', to_board: b.C, to_element: null }])
    // every request asked for the links
    expect(w.sync.asked.every((a) => a.links)).toBe(true)
  })

  it('an older sync’s answer (no `links` field) keeps the rows; an unchanged answer keeps them too', async () => {
    const { b } = w
    w.sync.setLinks(b.A, [{ el: 'card-1', to: b.D }])
    await index(b.A)
    // the sync is rolled back to a build before wave N: it ignores ?links=1
    w.sync.linksSupported = false
    w.sync.setText(b.A, [{ id: 'shape:n1', type: 'note', text: 'new words' }])
    w.sync.setLinks(b.A, [])
    await index(b.A)
    expect(await rowsFrom(b.A)).toEqual([{ from_element: 'card-1', to_board: b.D, to_element: null }])
    // and an unchanged answer (since = the clock) keeps them as well
    w.sync.linksSupported = true
    const state = await w.api.db.one<{ c: number }>(
      'SELECT canvas_clock::int AS c FROM board_search_state WHERE board_id = $1',
      [b.A],
    )
    expect(await w.indexer.refreshCanvas(b.A, { since: state.c })).toBe('unchanged')
    expect(await rowsFrom(b.A)).toHaveLength(1)
  })

  it('a links write that fails leaves the board stale with the failure backoff; a later pass fetches it again and writes them', async () => {
    const { b } = w
    w.sync.setLinks(b.A, [{ el: 'card-1', to: b.D }])
    await index(b.A)
    // A's links transaction fails (a dropped connection) for its next `failing` writes
    let failing = 2
    const db = w.api.db as { transaction: typeof w.api.db.transaction }
    const transaction = db.transaction.bind(w.api.db)
    db.transaction = (fn) =>
      transaction((tx) =>
        fn({
          ...tx,
          query: (sql, params) => {
            if (failing > 0 && String(sql).startsWith('DELETE FROM board_links') && params?.[0] === b.A) {
              failing--
              throw new Error('connection reset')
            }
            return tx.query(sql, params)
          },
        }),
      )
    const state = () =>
      w.api.db.one<{ source: Date | null; failures: number; retry: Date | null }>(
        `SELECT canvas_source_at AS source, failures, retry_at AS retry FROM board_search_state WHERE board_id = $1`,
        [b.A],
      )
    // the backoff in whole seconds from now (the test clock also moves with real time)
    const backoff = (retry: Date | null) =>
      retry ? Math.round((retry.getTime() - w.api.clock.now().getTime()) / 1_000) : null
    w.sync.setLinks(b.A, [{ el: 'card-3', to: b.C }])
    // the text is indexed all the same; the links keep their rows, and the board is stale again, backing off
    await index(b.A)
    expect(await rowsFrom(b.A)).toEqual([{ from_element: 'card-1', to_board: b.D, to_element: null }])
    const s1 = await state()
    expect(s1.source).toBeNull()
    expect(s1.failures).toBe(1)
    expect(backoff(s1.retry)).toBe(15)
    // within the backoff: not fetched; after it: fetched again (without since), and it fails once more (doubling)
    w.sync.asked.length = 0
    await w.indexer.runPass()
    expect(w.sync.asked.filter((a) => a.boardId === b.A)).toEqual([])
    w.api.clock.advance(15_001)
    await w.indexer.runPass()
    expect(w.sync.asked.filter((a) => a.boardId === b.A)).toEqual([
      { boardId: b.A, since: undefined, links: true },
    ])
    const s2 = await state()
    expect(s2.failures).toBe(2)
    expect(backoff(s2.retry)).toBe(30)
    // the database is fine again: the next pass after the backoff writes the links and the board is fresh
    w.sync.asked.length = 0
    w.api.clock.advance(30_001)
    await w.indexer.runPass()
    expect(w.sync.asked.filter((a) => a.boardId === b.A)).toHaveLength(1)
    expect(await rowsFrom(b.A)).toEqual([{ from_element: 'card-3', to_board: b.C, to_element: null }])
    const s3 = await state()
    const board = await w.api.db.one<{ updated_at: Date }>('SELECT updated_at FROM boards WHERE id = $1', [
      b.A,
    ])
    expect(s3).toEqual({ source: board.updated_at, failures: 0, retry: null })
    w.sync.asked.length = 0
    await w.indexer.runPass()
    expect(w.sync.asked.filter((a) => a.boardId === b.A)).toEqual([])
  })

  it('an older answer never replaces a newer one recorded after it was asked (two api processes during a deploy)', async () => {
    const { b } = w
    const links = async () => (await rowsFrom(b.A)).map((r) => r.from_element)
    const replace = (el: string, clock: number, at: number, askedAt: number) =>
      w.api.db.transaction((tx) =>
        replaceBoardLinks(tx, b.A, [{ el, to: b.D }], clock, new Date(at), new Date(askedAt)),
      )
    const t0 = Date.parse('2026-10-11T10:00:00Z')
    // the faster process records clock 20 at t0
    expect(await replace('newer', 20, t0, t0 - 2_000)).toBe(1)
    // the slower one asked before that (its answer is clock 10): nothing is written
    expect(await replace('older', 10, t0 + 1_000, t0 - 5_000)).toBeNull()
    expect(await links()).toEqual(['newer'])
    // the same clock, or a newer one, replaces as usual
    expect(await replace('same', 20, t0 + 2_000, t0 - 5_000)).toBe(1)
    expect(await links()).toEqual(['same'])
    // a lower clock asked after the higher one was recorded (a board file restored from a backup): replaced
    expect(await replace('restored', 5, t0 + 60_000, t0 + 30_000)).toBe(1)
    expect(await links()).toEqual(['restored'])
    const scan = await w.api.db.one<{ n: number }>(
      'SELECT links_clock::int AS n FROM board_link_scans WHERE board_id = $1',
      [b.A],
    )
    expect(scan.n).toBe(5)
  })

  it('cascades: deleting either board for good takes its links out and in', async () => {
    const { b } = w
    w.sync.setLinks(b.A, [{ el: 'card-1', to: b.D }])
    w.sync.setLinks(b.D, [{ el: 'back', to: b.A }])
    await index(b.A)
    await index(b.D)
    await w.api.db.query('DELETE FROM boards WHERE id = $1', [b.D])
    expect(await rowsFrom(b.A)).toEqual([])
    expect(await rowsFrom(b.D)).toEqual([])
    const scans = await w.api.db.query('SELECT 1 FROM board_link_scans WHERE board_id = $1', [b.D])
    expect(scans.rows).toEqual([])
  })
})

describe('the one-time links backfill', () => {
  it('fetches the boards indexed before their links were scanned (without since), once, and never again', async () => {
    const { b } = w
    // indexed by a sync older than wave N: text, but no links and no scan
    w.sync.linksSupported = false
    for (const id of [b.A, b.B, b.D]) w.sync.setText(id, [{ id: 'shape:n', type: 'note', text: 'words' }])
    w.sync.setLinks(b.A, [{ el: 'card-1', to: b.D }])
    for (const id of [b.A, b.B, b.D]) await index(id)
    expect(await w.api.db.query('SELECT 1 FROM board_link_scans')).toMatchObject({ rows: [] })
    // the sync now speaks wave N; nothing is stale, so only the backfill asks
    w.sync.linksSupported = true
    w.sync.asked.length = 0
    await w.indexer.runPass()
    const fetched = w.sync.asked.map((a) => a.boardId).sort()
    expect(fetched).toEqual([b.A, b.B, b.D].sort())
    expect(w.sync.asked.every((a) => a.since === undefined && a.links)).toBe(true)
    expect(await rowsFrom(b.A)).toEqual([{ from_element: 'card-1', to_board: b.D, to_element: null }])
    // the next pass finds nothing left and finishes it; later passes never ask again
    w.sync.asked.length = 0
    await w.indexer.runPass()
    expect(w.indexer.linksBackfillFinished()).toBe(true)
    await w.indexer.runPass()
    await w.indexer.runPass()
    expect(w.sync.asked).toEqual([])
  })

  it('pauses while the sync answers without links (an older sync), then goes on once it answers them', async () => {
    const { b } = w
    w.sync.linksSupported = false
    for (const id of [b.A, b.B, b.D]) {
      w.sync.setText(id, [{ id: 'shape:n', type: 'note', text: 'words' }])
      await index(id)
    }
    w.sync.asked.length = 0
    await w.indexer.runPass()
    // one board asked, no links in the answer: the backfill stops there
    expect(w.sync.asked).toHaveLength(1)
    w.sync.asked.length = 0
    await w.indexer.runPass()
    expect(w.sync.asked).toEqual([])
    // the sync is upgraded; after the pause the backfill does the rest
    w.sync.linksSupported = true
    w.api.clock.advance(LINKS_BACKFILL_PAUSE_MS + 1_000)
    await w.indexer.runPass()
    expect(w.sync.asked.map((a) => a.boardId).sort()).toEqual([b.A, b.B, b.D].sort())
    expect(w.indexer.linksBackfillFinished()).toBe(false)
    await w.indexer.runPass()
    expect(w.indexer.linksBackfillFinished()).toBe(true)
  })

  it('a stale board is indexed by the normal pass, links included (never twice in one pass)', async () => {
    const { b } = w
    w.sync.setLinks(b.A, [{ el: 'card-1', to: b.D }])
    await touch(w.api, b.A)
    w.sync.asked.length = 0
    await w.indexer.runPass()
    expect(w.sync.asked.filter((a) => a.boardId === b.A)).toHaveLength(1)
    expect(await rowsFrom(b.A)).toHaveLength(1)
  })
})

describe('GET /api/boards/:bid/backlinks', () => {
  it('lists only boards the caller can view, in the board’s workspace, never trashed, never the board itself', async () => {
    const { b, bob, carol } = w
    // the target T, viewed by carol; boards linking to it:
    const T = await createBoard(bob, DEV_STUDIO, 'Target T')
    await grant(bob, T, carol.userId, 'viewer')
    const forbidden = b.B // carol has no grant
    const trashed = await createBoard(bob, DEV_STUDIO, 'Trashed Y')
    await grant(bob, trashed, carol.userId, 'viewer')
    const shared = await createBoard(bob, DEV_STUDIO, 'Shared S')
    expect(
      (await bob.req('PATCH', `/api/boards/${shared}`, { visibility: 'workspace_view' })).statusCode,
    ).toBe(200)
    const foreign = await createBoard(bob, bob.personalWorkspaceId, 'Foreign X') // another workspace
    for (const [id, el] of [
      [b.A, 'a-card'],
      [forbidden, 'b-card'],
      [trashed, 'y-card'],
      [shared, 's-card'],
      [foreign, 'x-card'],
      [T, 't-self'],
    ] as const) {
      w.sync.setLinks(id, [{ el, to: T }])
      await index(id)
    }
    // the second link on A: one entry per board, its first element
    w.sync.setLinks(b.A, [
      { el: 'a-card', to: T },
      { el: 'a-another', to: T, toEl: 'frame-1' },
    ])
    await index(b.A)
    expect((await bob.req('POST', `/api/boards/${trashed}/trash`)).statusCode).toBe(200)

    const seenBy = async (c: Requester) =>
      (await backlinks(c, T)).map((l) => `${l.title} ${l.elementId}`).sort()
    // carol: A (her grant) and S (shared with the workspace); not B, Y (trashed), X (another workspace), nor T
    expect(await seenBy(carol)).toEqual(['Roadmap A a-another', 'Shared S s-card'])
    // bob owns B too, and X is his, but X is in another workspace
    expect(await seenBy(bob)).toEqual(['Roadmap A a-another', 'Secret B b-card', 'Shared S s-card'])
    // alice owns the workspace: every board of it
    expect(await seenBy(w.alice)).toEqual(['Roadmap A a-another', 'Secret B b-card', 'Shared S s-card'])
    const one = (await backlinks(carol, T)).find((l) => l.boardId === b.A)
    expect(one).toEqual({ boardId: b.A, title: 'Roadmap A', elementId: 'a-another' })
  })

  it('a name-only guest gets 403; a caller who cannot view the board 404; anonymous 401', async () => {
    const { b } = w
    const res = await w.sam.req('GET', `/api/boards/${b.A}/backlinks`)
    expect(res.statusCode, res.body).toBe(403)
    expect((res.json() as { error: { code: string } }).error.code).toBe('GUEST_ACCOUNT_REQUIRED')
    expect((await w.carol.req('GET', `/api/boards/${b.B}/backlinks`)).statusCode).toBe(404)
    expect((await w.erin.req('GET', `/api/boards/${b.A}/backlinks`)).statusCode).toBe(404)
    // a trashed board: nobody can open it, so nobody asks what links to it
    expect((await w.bob.req('GET', `/api/boards/${b.C}/backlinks`)).statusCode).toBe(404)
    expect((await w.api.anon('GET', `/api/boards/${b.A}/backlinks`)).statusCode).toBe(401)
  })

  it(`answers at most ${BACKLINKS_MAX} boards`, async () => {
    const { b } = w
    const from: string[] = []
    for (let i = 0; i < BACKLINKS_MAX + 3; i++) from.push(await createBoard(w.bob, DEV_STUDIO, `From ${i}`))
    for (const id of from) {
      w.sync.setLinks(id, [{ el: 'card', to: b.D }])
      await index(id)
    }
    expect(await backlinks(w.bob, b.D)).toHaveLength(BACKLINKS_MAX)
    // carol has none of them: nothing
    expect(await backlinks(w.carol, b.D)).toEqual([])
  })
})
