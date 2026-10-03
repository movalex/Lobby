// PARITY-5.5 (docs/EXCALIDRAW-MIGRATION.md §5.5 "v1 is converted on read"): on the new canvas, the
// preview of a checkpoint saved before the cut-over (a v1 body: tldraw records) answers the elements the
// converter makes of it, as a lobby-elements payload marked `converted`, so History draws it like any
// other (apps/web/src/features/history/ported/CheckpointPreview.tsx). The stored body is never rewritten.
// A body the converter cannot read keeps the v1 answer (the records), and so does an api whose sync is
// the tldraw one (bridge release R0: its tldraw preview reads records). Before the fix every v1 body came
// back as records, which the Excalidraw page cannot draw ("can't be previewed here yet").
import { CheckpointContent } from '@draftroom/contracts'
import { afterEach, describe, expect, it } from 'vitest'
import { checkpointSettings } from '../../../src/features/history/checkpoints.ts'
import { type Client, createBoard, createTestApi, DEV_STUDIO, type TestApi } from '../../helpers.ts'
import { baseRecords, createFakeSync, type FakeSync, noteRec, SCHEMA } from './helpers.ts'

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
