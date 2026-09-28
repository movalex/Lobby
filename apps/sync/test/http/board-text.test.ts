// GET /internal/boards/:bid/text (search across boards): what counts as a board's text, the caps, and
// the endpoint on a real server with a real client writing to the board (what the API's indexer calls).
import { toRichText } from '@tldraw/tlschema'
import { afterEach, describe, expect, it } from 'vitest'
import {
  BOARD_TEXT_MAX_BYTES,
  cleanText,
  ENTRY_MAX_CHARS,
  extractBoardText,
} from '../../src/http/board-text.ts'
import { fileCard, geoShape, noteShape, PAGE_ID, withText } from '../harness/records.ts'
import { NodeSyncClient } from '../harness/sync-client.ts'
import { callInternal, errorCode } from '../harness/tickets.ts'
import { waitFor } from '../harness/wait.ts'
import { startServer, type TestServer } from './helpers.ts'

const BOARD = 'b-boardtext'
const ALICE = 'usr_aliceAAAAAAAAAAAA'

let servers: TestServer[] = []
let clients: NodeSyncClient[] = []
afterEach(async () => {
  for (const c of clients) c.dispose()
  await Promise.all(servers.map((s) => s.stop()))
  servers = []
  clients = []
})

// Plain record objects (the extractor reads stored JSON; shapes that the schema would accept).
const page = (id = PAGE_ID) => ({ id, typeName: 'page', name: 'Page 1', index: 'a1', meta: {} })
const shape = (id: string, type: string, props: Record<string, unknown>, parentId = PAGE_ID) => ({
  id: `shape:${id}`,
  typeName: 'shape',
  type,
  parentId,
  x: 0,
  y: 0,
  props,
})

describe('extractBoardText', () => {
  it('reads notes, text, labels, arrows, frames, file cards, image/video alt text and asset names', () => {
    const out = extractBoardText([
      page(),
      shape('n1', 'note', { richText: toRichText('Launch plan\nfor Q3') }),
      shape('t1', 'text', { richText: toRichText('Budget review') }),
      shape('g1', 'geo', { richText: toRichText('Decision box') }),
      shape('a1', 'arrow', { richText: toRichText('depends on') }),
      shape('f1', 'frame', { name: 'Research' }),
      shape('c1', 'dr-file-card', { name: 'brief.pdf' }),
      { id: 'asset:img1', typeName: 'asset', type: 'image', props: { name: 'moodboard.png' } },
      shape('i1', 'image', { altText: 'Team photo', assetId: 'asset:img1' }),
      shape('i2', 'image', { altText: '', assetId: 'asset:img1' }),
      shape('v1', 'video', { altText: 'Demo reel', assetId: 'asset:missing' }),
      shape('x1', 'custom-thing', { richText: toRichText('Custom label') }),
      shape('d1', 'draw', { segments: [] }),
      shape('e1', 'note', { richText: toRichText('   ') }),
    ])
    const byId = Object.fromEntries(out.entries.map((e) => [e.id, e]))
    // Frames come first (then id order).
    expect(out.entries[0]?.id).toBe('shape:f1')
    expect(byId['shape:n1']).toEqual({
      id: 'shape:n1',
      type: 'note',
      pageId: PAGE_ID,
      text: 'Launch plan for Q3',
    })
    expect(byId['shape:t1']?.text).toBe('Budget review')
    expect(byId['shape:g1']?.text).toBe('Decision box')
    expect(byId['shape:a1']?.text).toBe('depends on')
    expect(byId['shape:f1']?.text).toBe('Research')
    expect(byId['shape:c1']).toMatchObject({ type: 'dr-file-card', text: 'brief.pdf' })
    expect(byId['shape:i1']?.text).toBe('Team photo · moodboard.png')
    expect(byId['shape:i2']?.text).toBe('moodboard.png')
    expect(byId['shape:v1']?.text).toBe('Demo reel')
    expect(byId['shape:x1']?.text).toBe('Custom label')
    expect(byId['shape:d1']).toBeUndefined() // no text
    expect(byId['shape:e1']).toBeUndefined() // blank
    expect(out.truncated).toBe(false)
    expect(out.bytes).toBe(out.entries.reduce((n, e) => n + Buffer.byteLength(e.text), 0))
  })

  it('finds the page through frames and groups, and leaves orphans and malformed records out', () => {
    const out = extractBoardText([
      page(),
      page('page:two'),
      shape('frame', 'frame', { name: 'Outer' }, 'page:two'),
      shape('group', 'group', {}, 'shape:frame'),
      shape('inner', 'note', { richText: toRichText('Nested idea') }, 'shape:group'),
      shape('orphan', 'note', { richText: toRichText('Lost') }, 'shape:nowhere'),
      shape('loop1', 'note', { richText: toRichText('Loop') }, 'shape:loop2'),
      shape('loop2', 'note', { richText: toRichText('Loop') }, 'shape:loop1'),
      { id: 'shape:bad', typeName: 'shape', type: 'note', props: { richText: 'not a doc' } }, // no parent
      { id: 'shape:bad2', typeName: 'shape', type: 'note', parentId: PAGE_ID, props: { richText: 42 } },
      { id: 'shape:bad3', typeName: 'shape', type: '<script>', parentId: PAGE_ID, props: {} },
      null,
      'nonsense',
      { typeName: 'shape' },
    ])
    expect(out.entries.map((e) => [e.id, e.pageId])).toEqual([
      ['shape:frame', 'page:two'],
      ['shape:inner', 'page:two'],
    ])
  })

  it('removes control characters, collapses whitespace and cuts one entry at ENTRY_MAX_CHARS', () => {
    expect(cleanText('a\u0000b\u0002c\u0003 d\n\n\te\u2028f\u0085g')).toBe('a b c d e f g')
    const long = 'word '.repeat(ENTRY_MAX_CHARS)
    const out = extractBoardText([page(), shape('n', 'note', { richText: toRichText(long) })])
    expect(out.entries[0]?.text.length).toBeLessThanOrEqual(ENTRY_MAX_CHARS)
    // never half a surrogate pair
    const emoji = cleanText('😀'.repeat(10), 5)
    expect(emoji).toBe('😀😀')
  })

  it('stops at maxBytes and maxEntries, and says it was truncated', () => {
    const records = [
      page(),
      ...Array.from({ length: 50 }, (_, i) =>
        shape(`n${String(i).padStart(2, '0')}`, 'note', { richText: toRichText(`note number ${i}`) }),
      ),
    ]
    const all = extractBoardText(records)
    expect(all.entries).toHaveLength(50)
    const capped = extractBoardText(records, { maxBytes: 100 })
    expect(capped.truncated).toBe(true)
    expect(capped.bytes).toBeLessThanOrEqual(100)
    expect(capped.entries.length).toBeGreaterThan(0)
    expect(capped.entries).toEqual(all.entries.slice(0, capped.entries.length)) // a stable prefix
    expect(extractBoardText(records, { maxEntries: 7 })).toMatchObject({ truncated: true })
    expect(extractBoardText(records, { maxEntries: 7 }).entries).toHaveLength(7)
  })

  it('stays fast on a large board (5,000 notes)', () => {
    const records = [
      page(),
      ...Array.from({ length: 5_000 }, (_, i) =>
        shape(`n${i}`, 'note', {
          richText: toRichText(`Idea ${i}: a fairly ordinary sticky note about the launch plan`),
        }),
      ),
    ]
    const t0 = performance.now()
    const out = extractBoardText(records, { maxBytes: BOARD_TEXT_MAX_BYTES })
    const ms = performance.now() - t0
    expect(out.entries).toHaveLength(5_000)
    // Recorded for the report; generous bound so a slow CI box does not flake.
    console.info(`[board-text] 5,000 notes extracted in ${ms.toFixed(1)} ms`)
    expect(ms).toBeLessThan(2_000)
  })
})

async function setup() {
  const t = await startServer({ config: { idleEvictMs: 200 } })
  servers.push(t)
  const connect = async () => {
    const c = new NodeSyncClient({ wsUrl: t.wsUrl, boardId: BOARD, user: ALICE })
    clients.push(c)
    await c.waitForSynced()
    return c
  }
  return { t, connect }
}

const text = (t: { url: string }, qs = '', board = BOARD) =>
  callInternal(t.url, 'GET', `/internal/boards/${board}/text${qs}`)

describe('internal board text endpoint', () => {
  it('answers with the text a client wrote, and `unchanged` for the clock it already has', async () => {
    const { t, connect } = await setup()
    // A board nobody opened: no storage is created just to answer.
    const none = await text(t)
    expect(none.status).toBe(200)
    expect(await none.json()).toEqual({
      boardId: BOARD,
      clock: 0,
      unchanged: false,
      entries: [],
      truncated: false,
      bytes: 0,
    })

    const alice = await connect()
    alice.put(
      noteShape('n1', 'Zebra crossing plan'),
      geoShape('g1', { text: 'Budget box' }),
      fileCard('c1', { name: 'brief.pdf' }),
    )
    await alice.waitForAcked()
    const first = await text(t)
    expect(first.headers.get('cache-control')).toBe('no-store')
    const body = (await first.json()) as {
      clock: number
      unchanged: boolean
      entries: { id: string; text: string }[]
    }
    expect(body.unchanged).toBe(false)
    expect(body.clock).toBeGreaterThan(0)
    expect(body.entries.map((e) => [e.id, e.text]).sort()).toEqual([
      ['shape:c1', 'brief.pdf'],
      ['shape:g1', 'Budget box'],
      ['shape:n1', 'Zebra crossing plan'],
    ])

    // Same clock: nothing is extracted.
    const same = await text(t, `?since=${body.clock}`)
    expect(await same.json()).toEqual({ boardId: BOARD, clock: body.clock, unchanged: true })

    // An edit moves the clock: the new text comes back.
    alice.update('shape:n1', (s) => withText(s, 'Giraffe crossing plan', ALICE)) // stamped like a real client (SEAM-01)
    await alice.waitForAcked()
    const after = (await (await text(t, `?since=${body.clock}`)).json()) as typeof body
    expect(after.unchanged).toBe(false)
    expect(after.clock).toBeGreaterThan(body.clock)
    expect(after.entries.find((e) => e.id === 'shape:n1')?.text).toBe('Giraffe crossing plan')

    // A deleted shape is gone from the answer.
    alice.remove('shape:g1')
    await alice.waitForAcked()
    const removed = (await (await text(t)).json()) as typeof body
    expect(removed.entries.map((e) => e.id).sort()).toEqual(['shape:c1', 'shape:n1'])

    // After everyone left and the room was evicted, the stored clock still answers `unchanged`.
    alice.dispose()
    // (tldraw keeps a closed socket's session for ~5 s; then the idle room is evicted)
    await waitFor(() => !t.server.registry.roomIfOpen(BOARD), { timeoutMs: 20_000 })
    const closed = await text(t, `?since=${removed.clock}`)
    expect(await closed.json()).toEqual({ boardId: BOARD, clock: removed.clock, unchanged: true })
  })

  it('honours maxBytes', async () => {
    const { t, connect } = await setup()
    const alice = await connect()
    alice.put(...Array.from({ length: 20 }, (_, i) => noteShape(`n${i}`, `Note number ${i} with some words`)))
    await alice.waitForAcked()
    const body = (await (await text(t, '?maxBytes=100')).json()) as { truncated: boolean; bytes: number }
    expect(body.truncated).toBe(true)
    expect(body.bytes).toBeLessThanOrEqual(100)
  })

  it('refuses bad input and callers without the internal secret', async () => {
    const { t } = await setup()
    const noSecret = await callInternal(t.url, 'GET', `/internal/boards/${BOARD}/text`, { secret: null })
    expect(noSecret.status).toBe(401)
    const wrong = await callInternal(t.url, 'GET', `/internal/boards/${BOARD}/text`, {
      secret: 'x'.repeat(40),
    })
    expect(wrong.status).toBe(401)
    const badId = await text(t, '', 'Bad..Id')
    expect(badId.status).toBe(400)
    expect(await errorCode(badId)).toBe('INVALID_BOARD_ID')
    for (const qs of [
      '?since=-1',
      '?since=abc',
      '?maxBytes=0',
      `?maxBytes=${BOARD_TEXT_MAX_BYTES + 1}`,
      '?since=1e3',
    ]) {
      const res = await text(t, qs)
      expect(res.status, qs).toBe(400)
      await res.body?.cancel()
    }
    const post = await callInternal(t.url, 'POST', `/internal/boards/${BOARD}/text`, { body: {} })
    expect(post.status).toBe(405)
    await post.body?.cancel()
  })
})
