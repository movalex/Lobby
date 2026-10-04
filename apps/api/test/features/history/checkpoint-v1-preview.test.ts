// PARITY-5.5 (docs/EXCALIDRAW-MIGRATION.md §5.5 "v1 is converted on read"): on the new canvas, the
// preview of a checkpoint saved before the cut-over (a v1 body: tldraw records) answers the elements the
// converter makes of it, as a lobby-elements payload marked `converted`, so History draws it like any
// other (apps/web/src/features/history/ported/CheckpointPreview.tsx). The stored body is never rewritten.
// A body the converter cannot read keeps the v1 answer (the records), and so does an api whose sync is
// the tldraw one (bridge release R0: its tldraw preview reads records). Before the fix every v1 body came
// back as records, which the Excalidraw page cannot draw ("can't be previewed here yet").
import { CheckpointContent } from '@draftroom/contracts'
import { b64Vecs } from '@draftroom/tldraw-import/tldraw'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  labelTextCost,
  labelTextTotal,
  PreviewCache,
  previewSettings,
} from '../../../src/features/history/checkpoint-routes.ts'
import { checkpointSettings } from '../../../src/features/history/checkpoints.ts'
import { type Client, createBoard, createTestApi, DEV_STUDIO, type TestApi } from '../../helpers.ts'
import { baseRecords, createFakeSync, type FakeSync, noteRec, type Rec, SCHEMA } from './helpers.ts'

let api: TestApi | null = null
const saved = { ...checkpointSettings }
afterEach(async () => {
  Object.assign(checkpointSettings, saved)
  await api?.close()
  api = null
})

/** An api on the given canvas, bob signed in, and a board whose sync snapshot is tldraw records. */
async function world(engine: 'excalidraw' | 'tldraw') {
  Object.assign(checkpointSettings, { tickMs: 0, pruneEveryMs: 0 })
  const sync: FakeSync & { engine?: () => Promise<'tldraw' | 'excalidraw'> } = createFakeSync()
  if (engine === 'excalidraw') sync.engine = async () => 'excalidraw'
  api = await createTestApi({ deps: { syncInternal: sync } })
  await api.login('alice')
  const bob: Client = await api.login('bob')
  const board = await createBoard(bob, DEV_STUDIO, 'Pitch')
  // the board as it was on tldraw: a v1 checkpoint body is made from records
  sync.setBoard(board, [...baseRecords(), noteRec('n1', 'Launch plan')])
  return { sync, bob, board, api }
}

async function saveV1(w: Awaited<ReturnType<typeof world>>, name = 'Before the move') {
  const made = await w.bob.req('POST', `/api/boards/${w.board}/snapshots`, { name })
  expect(made.statusCode, made.body).toBe(201)
  const id = made.json().id as string
  const row = await w.api.db.one<{ body_version: number }>(
    'SELECT body_version FROM board_snapshots WHERE id = $1',
    [id],
  )
  expect(Number(row.body_version)).toBe(1)
  return id
}

describe('previewing a v1 checkpoint (PARITY-5.5)', () => {
  it('on the new canvas: the converter’s elements, marked converted, that the web contract keeps', async () => {
    const w = await world('excalidraw')
    const sid = await saveV1(w)
    const res = await w.bob.req('GET', `/api/snapshots/${sid}/content`)
    expect(res.statusCode, res.body).toBe(200)
    const body = res.json() as Record<string, unknown>
    expect(body).toMatchObject({ format: 'lobby-elements', converted: true, records: [], schema: 1 })
    const parsed = CheckpointContent.parse(body)
    expect(parsed.converted).toBe(true)
    const els = parsed.elements ?? []
    // the note and its label, as the board conversion makes them
    expect(els.find((e) => e.id === 'n1')).toMatchObject({ type: 'stickynote' })
    const label = els.find((e) => e.type === 'text' && (e as { containerId?: unknown }).containerId === 'n1')
    expect(label).toMatchObject({ text: 'Launch plan' })
    expect(parsed.snapshot).toMatchObject({ id: sid, name: 'Before the move' })
    expect(parsed.snapshot).not.toHaveProperty('newCanvas')
    // the stored body is unchanged (still v1 records), and restoring it as a new board still works
    const restored = await w.bob.req('POST', `/api/snapshots/${sid}/restore-as-new`, {})
    expect(restored.statusCode, restored.body).toBe(201)
    const seeded = w.sync.seeds.at(-1)?.snapshot as { documents?: unknown[] } | undefined
    expect(seeded?.documents?.length).toBeGreaterThan(0)
  })

  it('a body the converter cannot read keeps the v1 answer (records), never an error', async () => {
    const w = await world('excalidraw')
    // stored under a tldraw schema newer than the converter knows
    const snap = w.sync.boards.get(w.board) as { schema: { sequences: Record<string, number> } }
    snap.schema = { ...SCHEMA, sequences: { ...SCHEMA.sequences, 'com.tldraw.shape.note': 999 } } as never
    const sid = await saveV1(w)
    const res = await w.bob.req('GET', `/api/snapshots/${sid}/content`)
    expect(res.statusCode, res.body).toBe(200)
    const body = res.json() as Record<string, unknown>
    expect(body).not.toHaveProperty('format')
    expect(body).not.toHaveProperty('converted')
    expect((body.records as { id: string }[]).map((r) => r.id)).toContain('shape:n1')
  })

  it('on the tldraw sync (bridge release R0): the records, as before', async () => {
    const w = await world('tldraw')
    const sid = await saveV1(w)
    const res = await w.bob.req('GET', `/api/snapshots/${sid}/content`)
    expect(res.statusCode, res.body).toBe(200)
    const body = res.json() as Record<string, unknown>
    expect(body).not.toHaveProperty('format')
    expect(body).not.toHaveProperty('converted')
    expect((body.records as { id: string }[]).map((r) => r.id)).toContain('shape:n1')
  })
})

// PARITY-5.5 follow-up (wave B follow-up 5; wave E adds the size and text bounds): the conversion runs on
// the api's event loop (about 90 microseconds a note, about 65 ms per MiB of strokes, about 5 ms per
// thousand characters of a note's label), so a v1 preview is bounded (by records, by stored size and by
// label text) and cached.
describe('a v1 preview is bounded and cached', () => {
  const settings = { ...previewSettings }
  afterEach(() => Object.assign(previewSettings, settings))

  const notes = (n: number) => Array.from({ length: n }, (_, i) => noteRec(`n${i}`, `Note ${i}`, `a${i + 1}`))
  /** A freehand stroke of `points` points (tldraw's draw shape, its points base64-packed as stored). */
  const stroke = (i: number, points: number): Rec => ({
    id: `shape:d${i}`,
    typeName: 'shape',
    type: 'draw',
    x: i,
    y: i,
    rotation: 0,
    index: `a${i + 1}`,
    parentId: 'page:page',
    isLocked: false,
    opacity: 1,
    meta: {},
    props: {
      color: 'black',
      fill: 'none',
      dash: 'draw',
      size: 'm',
      isComplete: true,
      isClosed: false,
      isPen: false,
      scale: 1,
      scaleX: 1,
      scaleY: 1,
      segments: [
        {
          type: 'free',
          path: b64Vecs.encodePoints(
            Array.from({ length: points }, (_, k) => ({
              x: k * 1.37,
              y: Math.sin(k / 5) * 20 + k * 0.11 + i,
              z: 0.5,
            })),
          ),
        },
      ],
    },
  })
  /** Saves the board's current records as a v1 checkpoint. */
  async function saveBoard(w: Awaited<ReturnType<typeof world>>, records: Rec[], name: string) {
    w.sync.setBoard(w.board, records)
    return saveV1(w, name)
  }
  const preview = (w: Awaited<ReturnType<typeof world>>, sid: string, c: Client = w.bob) =>
    c.req('GET', `/api/snapshots/${sid}/content`)

  it('past the cap it is not converted: "too large to preview", the shape the web already shows, decided before the body is read', async () => {
    previewSettings.maxRecords = 5
    const w = await world('excalidraw')
    const small = await saveBoard(w, [...baseRecords(), ...notes(3)], 'Fits') // 5 records: at the cap
    const big = await saveBoard(w, [...baseRecords(), ...notes(4)], 'Too big') // 6 records
    const read = vi.spyOn(w.api.blobs, 'get')

    const fits = await preview(w, small)
    expect(fits.statusCode, fits.body).toBe(200)
    expect(fits.json()).toMatchObject({ format: 'lobby-elements', converted: true })
    expect(read).toHaveBeenCalledTimes(1)

    read.mockClear()
    const res = await preview(w, big)
    expect(res.statusCode, res.body).toBe(200)
    const body = CheckpointContent.parse(res.json())
    // the v1 shape with nothing in it: no format and no `converted` (the web's "can't be previewed here
    // yet; restoring it as a new board still works"), no records to ship, and the snapshot's own facts
    expect(body).toMatchObject({
      records: [],
      schema: null,
      snapshot: { id: big, name: 'Too big', recordCount: 6 },
    })
    expect(body).not.toHaveProperty('format')
    expect(body).not.toHaveProperty('converted')
    expect(body).not.toHaveProperty('elements')
    expect(read).not.toHaveBeenCalled() // the row's record count decided: the body was not even read
    // the answer is remembered (nothing is read the second time either), and restoring still works
    expect((await preview(w, big)).statusCode).toBe(200)
    expect(read).not.toHaveBeenCalled()
    const restored = await w.bob.req('POST', `/api/snapshots/${big}/restore-as-new`, {})
    expect(restored.statusCode, restored.body).toBe(201)
    const seeded = w.sync.seeds.at(-1)?.snapshot as { documents?: unknown[] } | undefined
    expect(seeded?.documents).toHaveLength(6)
  })

  it('a row that understates its size is caught by the body’s own count (read once, then remembered)', async () => {
    previewSettings.maxRecords = 5
    const w = await world('excalidraw')
    const sid = await saveBoard(w, [...baseRecords(), ...notes(5)], 'Understated')
    await w.api.db.query('UPDATE board_snapshots SET record_count = 1 WHERE id = $1', [sid])
    const read = vi.spyOn(w.api.blobs, 'get')
    for (let i = 0; i < 3; i++) {
      const res = await preview(w, sid)
      expect(res.statusCode, res.body).toBe(200)
      expect(res.json()).not.toHaveProperty('format')
      expect((res.json() as { records: unknown[] }).records).toEqual([])
    }
    expect(read).toHaveBeenCalledTimes(1)
  })

  // wave E (the wave-D review's measurements): conversion cost grows with the points and text inside the
  // records, so a body with few records can still hold the loop. The stored size bounds it as well.
  it('the bounds as shipped: 1,000 records, 2.5 MiB of stored body and 35,000 characters of label text', () => {
    expect(settings.maxRecords).toBe(1_000)
    expect(settings.maxBodyBytes).toBe(2.5 * 1024 * 1024)
    expect(settings.maxTextChars).toBe(35_000)
  })

  it('past the size bound it is not converted either, though the record count fits: decided from the row’s size_bytes before the body is read', async () => {
    const w = await world('excalidraw')
    const small = await saveBoard(w, [...baseRecords(), ...notes(2)], 'Small')
    const big = await saveBoard(
      w,
      [...baseRecords(), ...notes(2), noteRec('long', 'words '.repeat(4_000), 'a9')],
      'Heavy',
    )
    const size = async (id: string) =>
      Number(
        (
          await w.api.db.one<{ size_bytes: number }>('SELECT size_bytes FROM board_snapshots WHERE id = $1', [
            id,
          ])
        ).size_bytes,
      )
    expect(await size(big)).toBeGreaterThan((await size(small)) + 20_000)
    previewSettings.maxBodyBytes = await size(small) // the small one is exactly at the bound: it fits
    const read = vi.spyOn(w.api.blobs, 'get')

    const fits = await preview(w, small)
    expect(fits.json()).toMatchObject({ format: 'lobby-elements', converted: true })
    expect(read).toHaveBeenCalledTimes(1)

    read.mockClear()
    const res = await preview(w, big)
    expect(res.statusCode, res.body).toBe(200)
    const body = CheckpointContent.parse(res.json())
    expect(body).toMatchObject({
      records: [],
      schema: null,
      snapshot: { id: big, name: 'Heavy', recordCount: 5 },
    })
    expect(body).not.toHaveProperty('format')
    expect(body).not.toHaveProperty('converted')
    expect(read).not.toHaveBeenCalled() // the row's size decided: the body was not even read
    expect((await preview(w, big)).statusCode).toBe(200) // remembered
    expect(read).not.toHaveBeenCalled()
    // restoring it as a new board still works
    const restored = await w.bob.req('POST', `/api/snapshots/${big}/restore-as-new`, {})
    expect(restored.statusCode, restored.body).toBe(201)
  })

  it('a row that understates its size is caught by the body’s own size, before it is parsed (read once, then remembered)', async () => {
    const w = await world('excalidraw')
    const sid = await saveBoard(w, [...baseRecords(), noteRec('long', 'words '.repeat(4_000))], 'Understated')
    previewSettings.maxBodyBytes = 10_000 // the body is about 24 kB
    await w.api.db.query('UPDATE board_snapshots SET size_bytes = 100 WHERE id = $1', [sid])
    const read = vi.spyOn(w.api.blobs, 'get')
    for (let i = 0; i < 3; i++) {
      const res = await preview(w, sid)
      expect(res.statusCode, res.body).toBe(200)
      expect(res.json()).not.toHaveProperty('format')
      expect((res.json() as { records: unknown[] }).records).toEqual([])
    }
    expect(read).toHaveBeenCalledTimes(1)
  })

  it('at the shipped bounds a stroke-heavy board with few records is too large by its size; a lighter one converts', async () => {
    const w = await world('excalidraw')
    // 1,000 points a stroke (about 8 kB of stored body each): 300 strokes fit, 400 do not, at 2.5 MiB
    const strokes = (n: number) => [
      ...baseRecords(),
      ...Array.from({ length: n }, (_, i) => stroke(i, 1_000)),
    ]
    const light = await saveBoard(w, strokes(150), 'Light strokes')
    const heavy = await saveBoard(w, strokes(400), 'Heavy strokes')
    const sizes = await w.api.db.query<{ id: string; size_bytes: number; record_count: number }>(
      'SELECT id, size_bytes, record_count FROM board_snapshots WHERE id = ANY($1)',
      [[light, heavy]],
    )
    const of = (id: string) => sizes.rows.find((r) => r.id === id)
    expect(Number(of(light)?.size_bytes)).toBeLessThan(previewSettings.maxBodyBytes)
    expect(Number(of(heavy)?.size_bytes)).toBeGreaterThan(previewSettings.maxBodyBytes)
    expect(Number(of(heavy)?.record_count)).toBeLessThan(previewSettings.maxRecords) // the count alone would convert it
    expect((await preview(w, light)).json()).toMatchObject({ format: 'lobby-elements', converted: true })
    const res = await preview(w, heavy)
    expect(res.statusCode, res.body).toBe(200)
    expect(res.json()).not.toHaveProperty('format')
    expect((res.json() as { records: unknown[] }).records).toEqual([])
  })

  // wave E (the wave-E review): label text costs about 5 ms per thousand characters of a sticky note, so
  // a board small by records and by bytes (100 notes of 4 kB: 0.4 MB, 102 records) can still hold the loop
  // for a second. The text is summed from the parsed body, which no row column holds.
  const wordyNotes = (n: number, words: number) =>
    Array.from({ length: n }, (_, i) => noteRec(`w${i}`, 'word '.repeat(words), `a${i + 1}`))

  it('past the text bound it is not converted, though records and bytes fit: summed from the parsed body (read once, then remembered)', async () => {
    const w = await world('excalidraw')
    const wordy = await saveBoard(w, [...baseRecords(), ...wordyNotes(100, 800)], 'Wordy') // 100 notes of 4 kB
    const row = await w.api.db.one<{ size_bytes: number; record_count: number }>(
      'SELECT size_bytes, record_count FROM board_snapshots WHERE id = $1',
      [wordy],
    )
    // small by the two bounds that were there before: only the text is past the third
    expect(Number(row.record_count)).toBe(102)
    expect(Number(row.record_count)).toBeLessThan(previewSettings.maxRecords)
    expect(Number(row.size_bytes)).toBeLessThan(previewSettings.maxBodyBytes / 4)
    expect(100 * 'word '.repeat(800).length).toBeGreaterThan(previewSettings.maxTextChars)

    const read = vi.spyOn(w.api.blobs, 'get')
    const res = await preview(w, wordy)
    expect(res.statusCode, res.body).toBe(200)
    const body = CheckpointContent.parse(res.json())
    expect(body).toMatchObject({
      records: [],
      schema: null,
      snapshot: { id: wordy, name: 'Wordy', recordCount: 102 },
    })
    expect(body).not.toHaveProperty('format')
    expect(body).not.toHaveProperty('converted')
    expect(body).not.toHaveProperty('elements')
    expect(read).toHaveBeenCalledTimes(1) // the body had to be read to count its text
    for (let i = 0; i < 2; i++) expect((await preview(w, wordy)).json()).toMatchObject({ records: [] })
    expect(read).toHaveBeenCalledTimes(1) // remembered: not read again
    // restoring it as a new board still works
    const restored = await w.bob.req('POST', `/api/snapshots/${wordy}/restore-as-new`, {})
    expect(restored.statusCode, restored.body).toBe(201)
  })

  it('at the text bound it converts, one character past it does not (the characters of every label, however many notes)', async () => {
    const w = await world('excalidraw')
    const label = (n: number, chars: number) =>
      noteRec(`b${n}`, 'abcdefghijk'.repeat(4).slice(0, chars), `a${n + 1}`)
    const fits = await saveBoard(
      w,
      [...baseRecords(), ...Array.from({ length: 4 }, (_, i) => label(i, 10))],
      'Forty',
    )
    const over = await saveBoard(
      w,
      [...baseRecords(), label(0, 11), ...Array.from({ length: 3 }, (_, i) => label(i + 1, 10))],
      'Forty-one',
    )
    previewSettings.maxTextChars = 40
    expect((await preview(w, fits)).json()).toMatchObject({ format: 'lobby-elements', converted: true })
    const res = await preview(w, over)
    expect(res.statusCode, res.body).toBe(200)
    expect(res.json()).not.toHaveProperty('format')
    expect((res.json() as { records: unknown[] }).records).toEqual([])
  })

  it('a board of short stickies well inside the text bound still converts (the shipped bound)', async () => {
    const w = await world('excalidraw')
    // 300 notes of 60 characters: 18,000 characters, about half the shipped bound
    const sid = await saveBoard(w, [...baseRecords(), ...wordyNotes(300, 12)], 'Retro')
    expect(300 * 'word '.repeat(12).length).toBeLessThan(previewSettings.maxTextChars)
    const res = await preview(w, sid)
    expect(res.statusCode, res.body).toBe(200)
    expect(res.json()).toMatchObject({ format: 'lobby-elements', converted: true })
    const els = CheckpointContent.parse(res.json()).elements ?? []
    expect(els.filter((e) => e.type === 'stickynote')).toHaveLength(300)
  })

  it('a converted preview is made once per checkpoint, for whoever may open it, and the answer is the same', async () => {
    const w = await world('excalidraw')
    const sid = await saveV1(w)
    const read = vi.spyOn(w.api.blobs, 'get')
    const first = await preview(w, sid)
    expect(first.json()).toMatchObject({ format: 'lobby-elements', converted: true })
    expect(read).toHaveBeenCalledTimes(1)
    const alice = await w.api.login('alice') // the workspace's owner
    const second = await preview(w, sid, alice)
    const third = await preview(w, sid)
    expect(read).toHaveBeenCalledTimes(1) // converted (and read) once
    for (const res of [second, third]) {
      expect(res.statusCode, res.body).toBe(200)
      expect(res.json()).toEqual(first.json())
      expect(res.headers['cache-control']).toBe('private, no-store')
    }
  })

  it('the cache never serves someone who may not open the checkpoint', async () => {
    const w = await world('excalidraw')
    const sid = await saveV1(w)
    expect((await preview(w, sid)).statusCode).toBe(200) // cached now
    // a workspace guest with a grant on the board: 403, as before (a checkpoint can hold removed content)
    const carol = await w.api.login('carol')
    expect(
      (await w.bob.req('PUT', `/api/boards/${w.board}/members/${carol.userId}`, { role: 'viewer' }))
        .statusCode,
    ).toBe(200)
    await w.api.db.query(
      "UPDATE workspace_members SET role = 'guest' WHERE workspace_id = $1 AND user_id = $2",
      [DEV_STUDIO, carol.userId],
    )
    expect((await preview(w, sid, carol)).statusCode).toBe(403)
    // someone outside the workspace: 404 (the checkpoint stays invisible), and signed out: 401
    const erin = await w.api.login('erin')
    await w.api.db.query('DELETE FROM workspace_members WHERE workspace_id = $1 AND user_id = $2', [
      DEV_STUDIO,
      erin.userId,
    ])
    expect((await preview(w, sid, erin)).statusCode).toBe(404)
    expect((await w.api.anon('GET', `/api/snapshots/${sid}/content`)).statusCode).toBe(401)
    // and a deleted checkpoint is gone, cache or not
    expect((await w.bob.req('DELETE', `/api/snapshots/${sid}`)).statusCode).toBe(204)
    expect((await preview(w, sid)).statusCode).toBe(404)
  })

  it('on the tldraw sync nothing changes: the records, whatever their number', async () => {
    previewSettings.maxRecords = 1
    const w = await world('tldraw')
    const sid = await saveBoard(w, [...baseRecords(), ...notes(3)], 'Records')
    const res = await preview(w, sid)
    expect(res.statusCode, res.body).toBe(200)
    expect((res.json() as { records: unknown[] }).records).toHaveLength(5)
  })
})

describe('the label text a v1 preview weighs', () => {
  const rich = (...paragraphs: string[][]) => ({
    type: 'doc',
    content: paragraphs.map((leaves) => ({
      type: 'paragraph',
      content: leaves.map((text) => ({ type: 'text', text, marks: [{ type: 'bold' }] })),
    })),
  })
  const shape = (type: string, props: Record<string, unknown>) => ({
    id: `shape:${type}`,
    typeName: 'shape',
    type,
    props,
  })

  it('counts the characters of every text leaf of the rich text, nested and marked, and of the older plain text', () => {
    expect(labelTextCost(shape('note', { richText: rich(['ab', 'cde'], ['f']) }))).toBe(6)
    const item = {
      type: 'paragraph',
      content: [{ type: 'text', text: 'item' }, { type: 'hardBreak' }, { type: 'text', text: 'two' }],
    }
    const list = {
      type: 'doc',
      content: [{ type: 'bulletList', content: [{ type: 'listItem', content: [item] }] }],
    }
    expect(labelTextCost(shape('geo', { richText: list }))).toBe(7)
    expect(labelTextCost(shape('arrow', { text: 'plain' }))).toBe(5) // before tldraw's rich text
    expect(labelTextCost(shape('note', { text: 'ab', richText: rich(['cd']) }))).toBe(4)
  })

  it('counts free text at an eighth, and a frame’s name, other records and anything unreadable as nothing', () => {
    expect(labelTextCost(shape('text', { richText: rich(['x'.repeat(80)]) }))).toBe(10)
    expect(labelTextCost(shape('frame', { name: 'x'.repeat(80), w: 1, h: 1 }))).toBe(0)
    expect(labelTextCost({ id: 'page:p', typeName: 'page', name: 'x'.repeat(80) })).toBe(0)
    expect(labelTextCost({ id: 'asset:a', typeName: 'asset', props: { text: 'x'.repeat(80) } })).toBe(0)
    expect(labelTextCost({ id: 'shape:n', typeName: 'shape', type: 'note' })).toBe(0)
    for (const richText of [null, undefined, 7, 'abc', [], { content: 'abc' }, { content: [null, 4, 'x'] }])
      expect(labelTextCost(shape('note', { richText })), JSON.stringify(richText)).toBe(0)
    expect(labelTextCost(shape('note', { text: 12, richText: { type: 'text', text: 9 } }))).toBe(0)
  })

  it('stops descending a hostile document at a fixed depth instead of overflowing the stack', () => {
    let deep: Record<string, unknown> = { type: 'text', text: 'deep' }
    for (let i = 0; i < 20_000; i++) deep = { type: 'paragraph', content: [deep] }
    expect(labelTextCost(shape('note', { richText: deep }))).toBe(0) // its text is below the depth limit
    let near: Record<string, unknown> = { type: 'text', text: 'near' }
    for (let i = 0; i < 20; i++) near = { type: 'paragraph', content: [near] }
    expect(labelTextCost(shape('note', { richText: near }))).toBe(4)
  })

  it('sums a body’s records, and stops reading once it is past the bound', () => {
    const records = [
      shape('note', { text: 'x'.repeat(100) }),
      shape('geo', { text: 'x'.repeat(100) }),
      shape('note', { text: 'x'.repeat(100) }),
      shape('text', { text: 'x'.repeat(80) }),
    ]
    expect(labelTextTotal(records, Number.POSITIVE_INFINITY)).toBe(310)
    expect(labelTextTotal(records, 310)).toBe(310)
    expect(labelTextTotal(records, 150)).toBe(200) // stopped after the second record
    expect(labelTextTotal([], 0)).toBe(0)
  })
})

describe('PreviewCache', () => {
  const settings = { ...previewSettings }
  afterEach(() => Object.assign(previewSettings, settings))
  const converted = (tag: string) => ({
    kind: 'converted' as const,
    elements: [{ id: tag, type: 'text' }],
    doc: {},
  })
  const held = (cache: PreviewCache, ...ids: string[]) => ids.map((id) => cache.get(id, 'k') !== null)

  it('evicts the least recently used entry past the entry limit, and a read counts as a use', () => {
    previewSettings.cacheEntries = 2
    const cache = new PreviewCache()
    cache.set('a', 'k', 10, converted('a'))
    cache.set('b', 'k', 10, converted('b'))
    expect(cache.get('a', 'k')).not.toBeNull() // a is now the most recent
    cache.set('c', 'k', 10, converted('c')) // b goes
    expect(held(cache, 'a', 'b', 'c')).toEqual([true, false, true])
    expect(cache.size).toBe(2)
  })

  it('is bounded by the summed cost, never evicts what it just stored, and skips what alone is too big', () => {
    previewSettings.cacheEntries = 10
    previewSettings.cacheBytes = 100
    const cache = new PreviewCache()
    cache.set('a', 'k', 40, converted('a'))
    cache.set('b', 'k', 40, converted('b'))
    cache.set('c', 'k', 40, converted('c')) // 120 > 100: a goes
    expect(held(cache, 'a', 'b', 'c')).toEqual([false, true, true])
    cache.set('huge', 'k', 51, converted('huge')) // more than half the budget: not kept
    expect(held(cache, 'huge')).toEqual([false])
    expect(cache.size).toBe(2)
    cache.set('b', 'k', 10, converted('b2')) // replaced, its old cost released
    cache.set('d', 'k', 50, converted('d')) // 40 + 10 + 50 = 100: all fit
    expect(held(cache, 'b', 'c', 'd')).toEqual([true, true, true])
  })

  it('drops an entry whose row now points at another body, and keeps nothing when the cache is off', () => {
    const cache = new PreviewCache()
    cache.set('a', 'old.json', 1, converted('a'))
    expect(cache.get('a', 'new.json')).toBeNull()
    expect(cache.size).toBe(0)
    previewSettings.cacheEntries = 0
    cache.set('b', 'k', 1, converted('b'))
    expect(cache.get('b', 'k')).toBeNull()
  })
})
