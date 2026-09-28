// Search across boards: keeping the index current (freshness after an edit, deletions leaving it),
// comment threads, the background pass, sync failures, snippets, limits and caps.
import { rewriteMentionTokens, SEARCH_CANVAS_TEXT_BYTES, SEARCH_HITS_PER_BOARD } from '@draftroom/contracts'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { canvasEntries, searchSettings } from '../../../src/features/search/indexer.ts'
import { type Client, createBoard, DEV_STUDIO } from '../../helpers.ts'
import {
  boardsOf,
  hitsOf,
  marked,
  note,
  type SearchWorld,
  search,
  searchRaw,
  searchWorld,
  touch,
} from './support.ts'

let w: SearchWorld
let bob: Client
let vic: Client
let board: string

async function entriesOf(boardId: string) {
  const r = await w.api.db.query<{ object_id: string; source: string }>(
    'SELECT object_id, source FROM board_search_entries WHERE board_id = $1 ORDER BY object_id',
    [boardId],
  )
  return r.rows.map((x) => `${x.source} ${x.object_id}`)
}

/** Time passes, then the sync server reports a canvas write (as its touch reporter would). */
async function edit(boardId: string, entries: ReturnType<typeof note>[]) {
  w.api.clock.advance(1_000)
  w.sync.setText(boardId, entries)
  await touch(w.api, boardId)
}

beforeEach(async () => {
  w = await searchWorld()
  await w.api.login('alice') // Dev Studio owner
  bob = await w.api.login('bob')
  vic = await w.api.login('vic')
  board = await createBoard(bob, DEV_STUDIO, 'Launch board')
  const grant = await bob.req('PUT', `/api/boards/${board}/members/${vic.userId}`, { role: 'viewer' })
  expect(grant.statusCode).toBe(200)
})

afterEach(async () => {
  await w.close()
})

describe('search: freshness', () => {
  it('finds new text right after an edit, and no longer finds the old text', async () => {
    await edit(board, [note('n1', 'Giraffe crossing plan')])
    expect(hitsOf(await search(vic, DEV_STUDIO, 'giraffe'))).toEqual([`${board} shape:n1`])

    await edit(board, [note('n1', 'Zebra crossing plan')])
    expect(hitsOf(await search(vic, DEV_STUDIO, 'zebra'))).toEqual([`${board} shape:n1`])
    expect(hitsOf(await search(vic, DEV_STUDIO, 'giraffe'))).toEqual([])
  })

  it('re-checks a board edited in the last two minutes by its clock, before the throttled report arrives', async () => {
    await edit(board, [note('n1', 'Giraffe crossing plan')])
    await search(vic, DEV_STUDIO, 'giraffe')
    // A second write inside the sync server's one-minute report window: no touch yet.
    w.sync.setText(board, [note('n1', 'Okapi crossing plan')])
    w.api.clock.advance(searchSettings.recheckMs + 1)
    w.sync.calls.length = 0
    expect(hitsOf(await search(vic, DEV_STUDIO, 'okapi'))).toEqual([`${board} shape:n1`])
    expect(w.sync.calls).toHaveLength(1)
    expect(w.sync.calls[0]?.[1]).toBeTypeOf('number') // asked with `since`: cheap when unchanged

    // Nothing changed: the next search asks again (after recheckMs) and gets `unchanged`.
    w.api.clock.advance(searchSettings.recheckMs + 1)
    await search(vic, DEV_STUDIO, 'okapi')
    expect(await entriesOf(board)).toEqual(['canvas shape:n1'])

    // Long after the last reported edit the board is not re-checked on every search: the next
    // report (touch) makes it stale again.
    w.api.clock.advance(searchSettings.recentMs + 1)
    w.sync.calls.length = 0
    await search(vic, DEV_STUDIO, 'okapi')
    expect(w.sync.calls).toEqual([])
  })

  it('a deleted object leaves the index', async () => {
    await edit(board, [note('n1', 'Zebra one'), note('n2', 'Zebra two')])
    expect(hitsOf(await search(bob, DEV_STUDIO, 'zebra'))).toEqual([`${board} shape:n1`, `${board} shape:n2`])
    await edit(board, [note('n2', 'Zebra two')])
    expect(hitsOf(await search(bob, DEV_STUDIO, 'zebra'))).toEqual([`${board} shape:n2`])
    expect(await entriesOf(board)).toEqual(['canvas shape:n2'])
  })

  it('a trashed board leaves the index at once, and comes back when restored', async () => {
    await edit(board, [note('n1', 'Zebra crossing')])
    expect(boardsOf(await search(bob, DEV_STUDIO, 'zebra'))).toEqual([board])
    expect(await entriesOf(board)).toHaveLength(1)
    expect((await bob.req('POST', `/api/boards/${board}/trash`)).statusCode).toBe(200)
    // The purge runs right after the answer (an onResponse hook). With a real Postgres pool
    // (DRAFTROOM_TEST_DATABASE_URL) this test's next query can run first, on another connection;
    // PGlite's one connection always ran them in order. So wait for it, briefly.
    const stateOf = () => w.api.db.query('SELECT 1 FROM board_search_state WHERE board_id = $1', [board])
    for (
      let i = 0;
      i < 400 && ((await entriesOf(board)).length > 0 || (await stateOf()).rows.length > 0);
      i++
    )
      await new Promise((r) => setTimeout(r, 5))
    expect(await entriesOf(board)).toEqual([])
    const state = await stateOf()
    expect(state.rows).toEqual([])
    expect(boardsOf(await search(bob, DEV_STUDIO, 'zebra'))).toEqual([])
    expect((await bob.req('POST', `/api/boards/${board}/restore`)).statusCode).toBe(200)
    expect(boardsOf(await search(bob, DEV_STUDIO, 'zebra'))).toEqual([board])
  })

  it('the background pass indexes changed boards and sweeps out trashed ones', async () => {
    const other = await createBoard(bob, DEV_STUDIO, 'Other board')
    await edit(board, [note('n1', 'Zebra crossing')])
    await edit(other, [note('m1', 'Zebra stripes')])
    expect(await entriesOf(board)).toEqual([])
    const pass = await w.indexer.runPass()
    expect(pass.canvas).toBeGreaterThanOrEqual(2)
    expect(await entriesOf(board)).toEqual(['canvas shape:n1'])
    expect(await entriesOf(other)).toEqual(['canvas shape:m1'])
    // Nothing changed: the next pass has nothing to do.
    expect(await w.indexer.runPass()).toMatchObject({ canvas: 0, comments: 0, looked: 0 })
    // Trashed behind the api's back (no route, so no hook): the pass still removes it.
    await w.api.db.query(`UPDATE boards SET status = 'trashed', trashed_at = now() WHERE id = $1`, [other])
    expect((await w.indexer.runPass()).purged).toBe(1)
    expect(await entriesOf(other)).toEqual([])
  })
})

describe('search: comment threads', () => {
  it('finds live comments for viewers, marks resolved threads, and drops deleted comments', async () => {
    const created = await bob.req('POST', `/api/boards/${board}/threads`, {
      anchor: { kind: 'point', x: 10, y: 20 },
      body: 'The llama section needs a source',
    })
    expect(created.statusCode, created.body).toBe(201)
    const thread = (created.json() as { thread: { id: string; comments: { id: string }[] } }).thread
    const reply = await bob.req('POST', `/api/threads/${thread.id}/comments`, {
      body: 'Alpaca data attached',
    })
    expect(reply.statusCode, reply.body).toBe(201)

    let res = await search(vic, DEV_STUDIO, 'llama')
    expect(res.groups[0]?.hits).toMatchObject([{ kind: 'comment', objectId: thread.id, pageId: null }])
    expect(marked(res.groups[0]?.hits[0] as never)).toContain('[llama]')
    expect(hitsOf(await search(vic, DEV_STUDIO, 'alpaca'))).toEqual([`${board} ${thread.id}`])

    w.api.clock.advance(1_000)
    expect((await bob.req('POST', `/api/threads/${thread.id}/resolve`)).statusCode).toBe(200)
    res = await search(vic, DEV_STUDIO, 'llama')
    expect(res.groups[0]?.hits[0]?.kind).toBe('resolved-comment')

    w.api.clock.advance(1_000)
    const first = thread.comments[0]?.id
    expect((await bob.req('DELETE', `/api/comments/${first}`)).statusCode).toBe(204)
    expect(hitsOf(await search(vic, DEV_STUDIO, 'llama'))).toEqual([])
    expect(hitsOf(await search(vic, DEV_STUDIO, 'alpaca'))).toEqual([`${board} ${thread.id}`])
  })

  it('indexes a mention as the name people read, never the user id behind it', async () => {
    const created = await bob.req('POST', `/api/boards/${board}/threads`, {
      anchor: { kind: 'point', x: 0, y: 0 },
      body: `Ask @[Vic](${vic.userId}) about the zebra budget`,
    })
    expect(created.statusCode, created.body).toBe(201)
    const stored = (created.json() as { thread: { comments: { body: string }[] } }).thread.comments[0]?.body
    expect(stored).toContain(vic.userId) // the comment keeps its mention token
    // What the thread shows: "@Name".
    const shown = rewriteMentionTokens(stored ?? '', () => null)
    const hit = (await search(vic, DEV_STUDIO, 'zebra')).groups[0]?.hits[0]
    expect(marked(hit as never)).toBe(shown.replace('zebra', '[zebra]'))
    for (const q of [vic.userId, 'usr']) expect(hitsOf(await search(vic, DEV_STUDIO, q)), q).toEqual([])
    const name = /@(\p{L}+)/u.exec(shown)?.[1] ?? 'missing'
    expect(hitsOf(await search(vic, DEV_STUDIO, `${name} zebra`))).toEqual([`${board} ${hit?.objectId}`])
  })
})

describe('search: when the sync server cannot answer', () => {
  it('says the board is pending, still finds comments, backs off, and catches up', async () => {
    w.sync.failing = true
    w.sync.setText(board, [note('n1', 'Zebra crossing')])
    await touch(w.api, board)
    const thread = await bob.req('POST', `/api/boards/${board}/threads`, {
      anchor: { kind: 'point', x: 0, y: 0 },
      body: 'Zebra comment',
    })
    expect(thread.statusCode).toBe(201)
    const res = await search(bob, DEV_STUDIO, 'zebra')
    expect(res.pendingBoards).toBe(1)
    expect(res.groups[0]?.hits.map((h) => h.kind)).toEqual(['comment'])
    const state = await w.api.db.one<{ failures: number; retry_at: Date }>(
      'SELECT failures, retry_at FROM board_search_state WHERE board_id = $1',
      [board],
    )
    expect(state.failures).toBe(1)
    expect(state.retry_at.getTime()).toBeGreaterThan(w.api.clock.now().getTime())

    // Back up, but still inside the back-off: no call yet.
    w.sync.failing = false
    w.sync.calls.length = 0
    expect((await search(bob, DEV_STUDIO, 'zebra')).pendingBoards).toBe(1)
    expect(w.sync.calls).toEqual([])
    w.api.clock.advance(16_000)
    const later = await search(bob, DEV_STUDIO, 'zebra')
    expect(later.pendingBoards).toBe(0)
    expect(later.groups[0]?.hits.map((h) => h.kind).sort()).toEqual(['comment', 'note'])
  })

  it('answers after waitMs even when the sync server hangs, and finishes the refresh later', async () => {
    await w.close()
    w = await searchWorld({ waitMs: 200 })
    bob = await w.api.login('bob')
    board = await createBoard(bob, DEV_STUDIO, 'Slow board')
    let release = () => {}
    w.sync.gate = new Promise<void>((r) => {
      release = r
    })
    w.sync.setText(board, [note('n1', 'Zebra crossing')])
    const t0 = Date.now()
    const res = await search(bob, DEV_STUDIO, 'zebra')
    expect(Date.now() - t0).toBeLessThan(5_000)
    expect(res).toMatchObject({ pendingBoards: 1, groups: [] })
    release()
    w.sync.gate = null
    await w.indexer.idle()
    expect(boardsOf(await search(bob, DEV_STUDIO, 'zebra'))).toEqual([board])
  })
})

describe('search: matching and snippets', () => {
  it('matches word prefixes, stems and accents; every word must match', async () => {
    await edit(board, [
      note('n1', 'The zebras were running across the Café crossing'),
      note('n2', 'Budget for Q3 launch'),
    ])
    for (const q of ['zeb', 'Zebra', 'run', 'runs', 'cafe', 'CAFÉ', 'zebra café', 'q3 launch']) {
      expect(boardsOf(await search(bob, DEV_STUDIO, q)), q).toEqual([board])
    }
    expect(boardsOf(await search(bob, DEV_STUDIO, 'zebra budget'))).toEqual([])
    const res = await search(bob, DEV_STUDIO, 'zebra cafe')
    expect(res.terms).toEqual(['zebra', 'cafe'])
    expect(marked(res.groups[0]?.hits[0] as never)).toMatch(/\[zebras\].*\[Café\]/)
  })

  it('cuts long texts around the match and says so', async () => {
    const long = `${'filler words here '.repeat(40)}the zebra is here ${'more trailing words '.repeat(40)}`
    await edit(board, [note('n1', long)])
    const hit = (await search(bob, DEV_STUDIO, 'zebra')).groups[0]?.hits[0]
    expect(hit).toMatchObject({ cutStart: true, cutEnd: true })
    const text = marked(hit as never)
    expect(text).toContain('[zebra]')
    expect(text.length).toBeLessThan(260)
  })

  it('shows the match in the snippet when only folding finds it, deep inside a long text', async () => {
    const filler = (w: string) => `${w} `.repeat(60)
    await edit(board, [
      note('n1', `${filler('opening')}we met at the Café Zoë downtown ${filler('closing')}`),
      note('n2', `${filler('intro')}attached: brief.pdf for the zebra ${filler('outro')}`),
    ])
    const res = await search(bob, DEV_STUDIO, 'cafe zoe')
    const cafe = marked(res.groups[0]?.hits[0] as never)
    expect(cafe).toContain('[Café] [Zoë]')
    expect(cafe).toMatch(/^….*…$/)
    expect(cafe.length).toBeLessThan(260)
    const pdf = marked((await search(bob, DEV_STUDIO, 'pdf zebra')).groups[0]?.hits[0] as never)
    expect(pdf).toContain('brief.[pdf] for the [zebra]')
  })

  it('names the kind of each object', async () => {
    await edit(board, [
      note('n1', 'Zebra note'),
      { id: 'shape:t1', type: 'text', text: 'Zebra text' },
      { id: 'shape:g1', type: 'geo', text: 'Zebra box' },
      { id: 'shape:a1', type: 'arrow', text: 'Zebra arrow' },
      { id: 'shape:f1', type: 'frame', text: 'Zebra frame' },
      { id: 'shape:c1', type: 'dr-file-card', text: 'zebra.pdf' },
      { id: 'shape:i1', type: 'image', text: 'Zebra photo · zebra.png' },
      { id: 'shape:x1', type: 'mystery', text: 'Zebra thing' },
    ])
    const res = await search(bob, DEV_STUDIO, 'zebra', { limit: '50' })
    const g = res.groups[0]
    expect(g?.hits).toHaveLength(SEARCH_HITS_PER_BOARD)
    expect(g?.more).toBe(8 - SEARCH_HITS_PER_BOARD)
    expect(res.totalHits).toBe(8)
    const kinds = new Map<string, string>()
    for (const q of ['note', 'text', 'box', 'arrow', 'frame', 'pdf', 'photo', 'thing']) {
      const h = (await search(bob, DEV_STUDIO, `zebra ${q}`)).groups[0]?.hits[0]
      kinds.set(q, h?.kind ?? '')
    }
    expect(Object.fromEntries(kinds)).toEqual({
      note: 'note',
      text: 'text',
      box: 'shape',
      arrow: 'arrow',
      frame: 'frame',
      pdf: 'file',
      photo: 'image',
      thing: 'other',
    })
  })

  it('orders boards by their best match and limits the groups', async () => {
    const second = await createBoard(bob, DEV_STUDIO, 'Second board')
    await edit(board, [note('n1', 'zebra zebra zebra crossing')])
    await edit(second, [
      note('m1', `a long note that mentions a zebra once ${'and many other words '.repeat(30)}`),
    ])
    const res = await search(bob, DEV_STUDIO, 'zebra')
    expect(res.groups.map((g) => g.board.id)).toEqual([board, second])
    expect(res.groups[0]?.board).toEqual({
      id: board,
      title: 'Launch board',
      projectId: null,
      status: 'active',
    })
    const one = await search(bob, DEV_STUDIO, 'zebra', { limit: '1' })
    expect(one.groups).toHaveLength(1)
    expect(one.totalBoards).toBe(2)
  })

  it('a board with hundreds of matches does not crowd the other matching boards out', async () => {
    const second = await createBoard(bob, DEV_STUDIO, 'Second board')
    await edit(
      board,
      Array.from({ length: 450 }, (_, i) => note(`n${i}`, `zebra zebra ${i}`)),
    )
    await edit(second, [note('m1', `one zebra in a long note ${'with many other words '.repeat(20)}`)])
    const res = await search(bob, DEV_STUDIO, 'zebra')
    expect(res.groups.map((g) => g.board.id)).toEqual([board, second])
    expect(res).toMatchObject({ totalBoards: 2, totalHits: 451, capped: false })
    expect(res.groups.map((g) => [g.hits.length, g.more])).toEqual([
      [SEARCH_HITS_PER_BOARD, 450 - SEARCH_HITS_PER_BOARD],
      [1, 0],
    ])
  })

  it('treats hostile queries as words (never a server error)', async () => {
    await edit(board, [note('n1', 'Drop the tables from the zebra report')])
    for (const q of [
      "'",
      '"',
      '&|!():*',
      "zebra':* | 'x",
      '\\',
      "'; DROP TABLE boards; --",
      '<script>alert(1)</script>',
      '🎉',
      'a',
      '',
      '   ',
    ]) {
      const res = await searchRaw(bob, DEV_STUDIO, q)
      expect(res.statusCode, q).toBe(200)
    }
    expect(boardsOf(await search(bob, DEV_STUDIO, "'; DROP TABLE"))).toEqual([board])
    expect((await search(bob, DEV_STUDIO, 'a')).terms).toEqual([])
    expect((await w.api.db.query('SELECT 1 FROM boards')).rows.length).toBeGreaterThan(0)
  })
})

describe('search: limits and caps', () => {
  it('refuses queries over 200 characters and a missing q', async () => {
    const long = await searchRaw(bob, DEV_STUDIO, 'z'.repeat(201))
    expect(long.statusCode).toBe(400)
    expect((long.json() as { error: { code: string } }).error.code).toBe('QUERY_TOO_LONG')
    expect((await searchRaw(bob, DEV_STUDIO, 'z'.repeat(200))).statusCode).toBe(200)
    expect((await bob.req('GET', `/api/workspaces/${DEV_STUDIO}/search`)).statusCode).toBe(400)
  })

  it('limits searches per person (429 with Retry-After), not per workspace', async () => {
    for (let i = 0; i < 40; i++) expect((await searchRaw(bob, DEV_STUDIO, `q${i}`)).statusCode).toBe(200)
    const limited = await searchRaw(bob, DEV_STUDIO, 'one more')
    expect(limited.statusCode).toBe(429)
    expect(Number(limited.headers['retry-after'])).toBeGreaterThanOrEqual(1)
    // someone else is not affected
    expect((await searchRaw(vic, DEV_STUDIO, 'zebra')).statusCode).toBe(200)
    w.api.clock.advance(20_001)
    expect((await searchRaw(bob, DEV_STUDIO, 'again')).statusCode).toBe(200)
  })

  it('caps the canvas text of a board and says the board was searched in part', async () => {
    const big = 'x'.repeat(3_900)
    const entries = Array.from({ length: 400 }, (_, i) => ({
      id: `shape:n${i}`,
      type: 'note',
      pageId: 'page:page',
      text: `${big} ${i}`,
    }))
    const capped = canvasEntries({
      boardId: board,
      clock: 1,
      unchanged: false,
      truncated: false,
      bytes: 0,
      entries,
    })
    expect(capped.truncated).toBe(true)
    expect(capped.bytes).toBeLessThanOrEqual(SEARCH_CANVAS_TEXT_BYTES)
    expect(capped.entries.length).toBe(Math.floor(SEARCH_CANVAS_TEXT_BYTES / 3_904))

    await edit(board, [note('n1', 'Zebra first'), ...entries.map((e) => ({ ...e, text: `zebra ${e.text}` }))])
    const res = await search(bob, DEV_STUDIO, 'zebra')
    expect(res.groups[0]?.truncated).toBe(false) // the state is read before this search's refresh
    expect((await search(bob, DEV_STUDIO, 'zebra')).groups[0]?.truncated).toBe(true)
  })

  it('indexes and searches a 5,000-note board in reasonable time', async () => {
    const notes = Array.from({ length: 5_000 }, (_, i) =>
      note(
        `n${i}`,
        `Idea ${i}: a fairly ordinary sticky note about the launch plan ${i % 7 === 0 ? 'zebra' : ''}`,
      ),
    )
    w.api.clock.advance(1_000)
    w.sync.setText(board, notes)
    await touch(w.api, board)
    const t0 = performance.now()
    expect(await w.indexer.refreshCanvas(board)).toBe('indexed')
    const indexMs = performance.now() - t0
    const t1 = performance.now()
    const res = await search(bob, DEV_STUDIO, 'zebra')
    const searchMs = performance.now() - t1
    console.info(
      `[search] 5,000 notes indexed in ${indexMs.toFixed(0)} ms (PGlite); search ${searchMs.toFixed(0)} ms`,
    )
    // 715 notes match (i % 7 === 0), every one of them counted.
    expect(res).toMatchObject({ totalHits: 715, capped: false, totalBoards: 1 })
    expect(res.groups[0]?.more).toBe(715 - SEARCH_HITS_PER_BOARD)
    expect(indexMs).toBeLessThan(60_000)
  })
})
