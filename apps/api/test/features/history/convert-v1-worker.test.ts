// J4 CONV-1 (wave J): the v1 checkpoint preview's conversion runs in a worker thread, not on the api's event
// loop. A conversion costs by the text inside the records (about 110 ms for ONE sticky note of 20,000
// characters), which neither the record count nor the stored size bounds, so 60 such notes (a 1.2 MiB body)
// held the loop for 6.6 s before J4. The worker has a wall-clock budget, a heap cap and size limits, and
// the places for workers are few and their queue short. Each test here fails on the in-process conversion.

import { installedServerTextMetrics, installServerTextMetrics } from '@draftroom/canvas-schema/engine'
import { CheckpointContent } from '@draftroom/contracts'
import { convertBoard, migrateRecords, type TlRecord } from '@draftroom/tldraw-import'
import type { FastifyServerOptions } from 'fastify'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { previewSettings } from '../../../src/features/history/checkpoint-routes.ts'
import { checkpointSettings } from '../../../src/features/history/checkpoints.ts'
import { type ConvertV1Limits, convertV1InWorker } from '../../../src/features/history/convert-v1.ts'
import { Gate } from '../../../src/features/link-preview/gate.ts'
import { type Client, createBoard, createTestApi, DEV_STUDIO, type TestApi } from '../../helpers.ts'
import { baseRecords, createFakeSync, type FakeSync, noteRec, SCHEMA, strokeRecords } from './helpers.ts'

const LIMITS: ConvertV1Limits = {
  maxRecords: 20_000,
  maxBytes: 64 * 1024 * 1024,
  maxResultBytes: 64 * 1024 * 1024,
  timeoutMs: 20_000,
  maxHeapMb: 256,
}
const gate = () => new Gate({ concurrent: 2, maxQueue: 8, maxWaitMs: 5_000 })

/** `n` sticky notes, each labelled with `chars` characters of words: costs about 110 ms a note at 20,000. */
const wordyNotes = (n: number, chars: number) =>
  Array.from({ length: n }, (_, i) => noteRec(`w${i}`, 'word '.repeat(chars / 5), `a${i + 1}`))
const pathological = () => [...baseRecords(), ...wordyNotes(60, 20_000)] // 6.6 s in-process

/** Samples how long the event loop was held at a time while `during` ran. */
async function lagDuring<T>(during: () => Promise<T>): Promise<{ value: T; maxLagMs: number; ms: number }> {
  let last = performance.now()
  let max = 0
  const t0 = last
  const timer = setInterval(() => {
    const now = performance.now()
    max = Math.max(max, now - last - 10)
    last = now
  }, 10)
  try {
    const value = await during()
    return { value, maxLagMs: max, ms: performance.now() - t0 }
  } finally {
    clearInterval(timer)
  }
}

describe('convertV1InWorker', () => {
  it('converts what the in-process converter converts, to the same elements', async () => {
    const records = [...baseRecords(), noteRec('n1', 'Launch plan'), noteRec('n2', 'Second', 'a2')]
    const out = await convertV1InWorker({ records, schema: SCHEMA, now: 1_700_000_000_000 }, LIMITS, gate())
    if (!out.ok) throw new Error(`refused: ${out.reason}`)
    const migrated = migrateRecords(records, SCHEMA)
    if (!migrated.ok) throw new Error('unreadable')
    const direct = convertBoard(migrated.records as TlRecord[], {
      updatedAt: 1_700_000_000_000,
      metrics: installedServerTextMetrics() ?? installServerTextMetrics(),
    })
    expect(out.converted.elements).toEqual(JSON.parse(JSON.stringify(direct.elements)))
    expect(out.converted.doc.tagDefs).toEqual(direct.doc.tagDefs)
    expect(out.converted.legacyIds).toEqual(direct.legacyIds)
    expect(out.converted.elements.filter((e) => e.type === 'stickynote')).toHaveLength(2)
    expect(out.conversionMs).toBeGreaterThanOrEqual(0)
  })

  it('past its time budget the worker is stopped (it was spinning in synchronous code): refused `time`, the loop never held', async () => {
    const run = await lagDuring(() =>
      convertV1InWorker(
        { records: pathological(), schema: SCHEMA, now: 1 },
        { ...LIMITS, timeoutMs: 1_500 },
        gate(),
      ),
    )
    expect(run.value).toEqual({ ok: false, reason: 'time' })
    expect(run.ms).toBeGreaterThanOrEqual(1_400)
    expect(run.ms).toBeLessThan(3_000) // 6.6 s of work was cut at the budget
    expect(run.maxLagMs).toBeLessThan(400) // in-process: the loop was held for the whole 6.6 s
  })

  it('a heavy body that fits its budget completes, off the loop', async () => {
    const records = [...baseRecords(), ...wordyNotes(8, 20_000)] // about 0.9 s of conversion
    const run = await lagDuring(() => convertV1InWorker({ records, schema: SCHEMA, now: 1 }, LIMITS, gate()))
    if (!run.value.ok) throw new Error(`refused: ${run.value.reason}`)
    expect(run.value.converted.elements.filter((e) => e.type === 'stickynote')).toHaveLength(8)
    expect(run.value.conversionMs).toBeGreaterThan(300)
    expect(run.maxLagMs).toBeLessThan(400)
  })

  it('refuses past the record, byte and answer limits, and a heap cap, each with its own reason', async () => {
    const records = [...baseRecords(), ...wordyNotes(3, 100)]
    // no worker at all for the first two: a worker file that does not exist would answer `failed`
    const nowhere = new URL('file:///nonexistent/worker.ts')
    expect(
      await convertV1InWorker(
        { records, schema: SCHEMA, now: 1 },
        { ...LIMITS, maxRecords: 4 },
        gate(),
        nowhere,
      ),
    ).toEqual({ ok: false, reason: 'too-many-records' })
    expect(
      await convertV1InWorker(
        { records, schema: SCHEMA, now: 1 },
        { ...LIMITS, maxBytes: 1_000 },
        gate(),
        nowhere,
      ),
    ).toEqual({ ok: false, reason: 'too-large' })
    expect(
      await convertV1InWorker(
        { records, schema: SCHEMA, now: 1 },
        { ...LIMITS, maxResultBytes: 500 },
        gate(),
      ),
    ).toEqual({ ok: false, reason: 'result-too-large' })
    // a heap the converter cannot even load into
    expect(
      await convertV1InWorker({ records, schema: SCHEMA, now: 1 }, { ...LIMITS, maxHeapMb: 4 }, gate()),
    ).toEqual({ ok: false, reason: 'memory' })
  })

  it('a worker that cannot start is `failed` with a code to log (never a message), and its place comes back', async () => {
    const one = new Gate({ concurrent: 1, maxQueue: 0 })
    const out = await convertV1InWorker(
      { records: baseRecords(), schema: SCHEMA, now: 1 },
      LIMITS,
      one,
      new URL('file:///nonexistent/worker.ts'),
    )
    expect(out).toMatchObject({ ok: false, reason: 'failed' })
    if (out.ok) throw new Error('unexpected')
    expect(out.cause).toMatch(/^[A-Za-z0-9_ ]{1,64}$/)
    expect(one.running).toBe(0)
  })

  it('records the converter cannot read are `unreadable`, never an exception', async () => {
    const newer = { ...SCHEMA, sequences: { ...SCHEMA.sequences, 'com.tldraw.shape.note': 999 } }
    const out = await convertV1InWorker(
      { records: [...baseRecords(), noteRec('n1', 'x')], schema: newer, now: 1 },
      LIMITS,
      gate(),
    )
    expect(out).toMatchObject({ ok: false, reason: 'unreadable' })
    const noId = await convertV1InWorker(
      { records: [{ typeName: 'shape' }], schema: SCHEMA, now: 1 },
      LIMITS,
      gate(),
    )
    expect(noId).toMatchObject({ ok: false, reason: 'unreadable' })
  })

  it('with every place taken and no queue it is `busy` at once; the place comes back when the worker is done', async () => {
    const one = new Gate({ concurrent: 1, maxQueue: 0 })
    const slow = convertV1InWorker(
      { records: pathological(), schema: SCHEMA, now: 1 },
      { ...LIMITS, timeoutMs: 1_200 },
      one,
    )
    await vi.waitFor(() => expect(one.running).toBe(1))
    const t0 = performance.now()
    const refused = await convertV1InWorker({ records: baseRecords(), schema: SCHEMA, now: 1 }, LIMITS, one)
    expect(refused).toEqual({ ok: false, reason: 'busy' })
    expect(performance.now() - t0).toBeLessThan(100)
    expect(await slow).toEqual({ ok: false, reason: 'time' })
    expect(one.running).toBe(0)
    const after = await convertV1InWorker(
      { records: [...baseRecords(), noteRec('n', 'ok')], schema: SCHEMA, now: 1 },
      LIMITS,
      one,
    )
    expect(after.ok).toBe(true)
  })
})

// ---- the preview route ---------------------------------------------------------------------------------

let api: TestApi | null = null
const savedCheckpoints = { ...checkpointSettings }
const savedPreview = { ...previewSettings }
afterEach(async () => {
  Object.assign(checkpointSettings, savedCheckpoints)
  Object.assign(previewSettings, savedPreview)
  await api?.close()
  api = null
})

async function world(logger?: FastifyServerOptions['logger']) {
  Object.assign(checkpointSettings, { tickMs: 0, pruneEveryMs: 0 })
  const sync: FakeSync & { engine?: () => Promise<'tldraw' | 'excalidraw'> } = createFakeSync()
  sync.engine = async () => 'excalidraw'
  api = await createTestApi({ deps: { syncInternal: sync, ...(logger ? { logger } : {}) } })
  await api.login('alice')
  const bob: Client = await api.login('bob')
  const board = await createBoard(bob, DEV_STUDIO, 'Pitch')
  const save = async (records: ReturnType<typeof baseRecords>, name: string) => {
    sync.setBoard(board, records)
    const made = await bob.req('POST', `/api/boards/${board}/snapshots`, { name })
    expect(made.statusCode, made.body).toBe(201)
    return made.json().id as string
  }
  return {
    sync,
    bob,
    board,
    api,
    save,
    preview: (sid: string) => bob.req('GET', `/api/snapshots/${sid}/content`),
  }
}

describe('a v1 preview whose conversion is too costly or too busy (the route)', () => {
  it('past the worker’s time budget: "too large to preview", within the budget, the loop never held', async () => {
    // the bounds that would refuse it before any conversion are lifted: this is what the worker is for
    previewSettings.maxTextChars = Number.MAX_SAFE_INTEGER
    previewSettings.workerTimeoutMs = 1_500
    const w = await world()
    const sid = await w.save(pathological(), 'Wordy')
    const read = vi.spyOn(w.api.blobs, 'get')

    const run = await lagDuring(() => w.preview(sid))
    expect(run.value.statusCode, run.value.body).toBe(200)
    const body = CheckpointContent.parse(run.value.json())
    expect(body).toMatchObject({ records: [], schema: null, snapshot: { id: sid, name: 'Wordy' } })
    expect(body).not.toHaveProperty('format')
    expect(body).not.toHaveProperty('converted')
    expect(run.ms).toBeLessThan(4_000) // converted in-process it was 6.6 s, held on the loop
    expect(run.maxLagMs).toBeLessThan(400)
    expect(read).toHaveBeenCalled()
    // and restoring it as a new board still works
    const restored = await w.bob.req('POST', `/api/snapshots/${sid}/restore-as-new`, {})
    expect(restored.statusCode, restored.body).toBe(201)
  })

  it('a refusal for TIME is not remembered (a slow machine, not the body): asked again with time to spare it converts; one for memory is remembered', async () => {
    previewSettings.maxTextChars = Number.MAX_SAFE_INTEGER
    previewSettings.workerTimeoutMs = 600 // the worker's start alone is 0.25 s and 8 notes of 20,000 characters take 0.9 s
    const w = await world()
    const sid = await w.save([...baseRecords(), ...wordyNotes(8, 20_000)], 'Heavy')
    const slow = await w.preview(sid)
    expect(slow.statusCode, slow.body).toBe(200)
    expect(slow.json()).not.toHaveProperty('format') // too large to preview, this time
    previewSettings.workerTimeoutMs = 20_000
    const again = await w.preview(sid)
    expect(again.statusCode, again.body).toBe(200)
    expect(again.json()).toMatchObject({ format: 'lobby-elements', converted: true })

    // out of memory is the body's own doing: remembered, so the next request does not even read it
    previewSettings.workerHeapMb = 4
    const big = await w.save([...baseRecords(), noteRec('n1', 'Launch plan')], 'Small')
    const read = vi.spyOn(w.api.blobs, 'get')
    expect((await w.preview(big)).json()).not.toHaveProperty('format')
    expect(read).toHaveBeenCalledTimes(1)
    previewSettings.workerHeapMb = 256
    expect((await w.preview(big)).json()).not.toHaveProperty('format') // remembered, though the heap would now do
    expect(read).toHaveBeenCalledTimes(1)
  })

  it('a stroke-heavy body inside every preview bound converts (heap grows with stroke points, which the bounds do not count; the flat 128 MB the first version gave the worker refused it)', async () => {
    // freehand strokes: 8 KB of body and 1,500 points each. Fill the stored-size bound to within a few percent.
    const perStroke = Buffer.byteLength(JSON.stringify(strokeRecords(10, 1_500))) / 10
    const strokes = Math.floor((previewSettings.maxBodyBytes * 0.97 - 3_000) / perStroke)
    const records = [...baseRecords(), ...strokeRecords(strokes, 1_500)]
    expect(records.length).toBeLessThan(previewSettings.maxRecords) // inside the record bound too
    const w = await world()
    const sid = await w.save(records, 'Strokes')
    const read = vi.spyOn(w.api.blobs, 'get')
    const res = await w.preview(sid)
    expect(res.statusCode, res.body.slice(0, 300)).toBe(200)
    const first = read.mock.results[0]
    if (!first) throw new Error('the body was not read')
    const stored = ((await first.value) as { contentLength: number }).contentLength
    expect(stored).toBeLessThanOrEqual(previewSettings.maxBodyBytes)
    expect(stored).toBeGreaterThan(previewSettings.maxBodyBytes * 0.9)
    // converted, not "too large": the worker's heap fits what the bounds let through
    const body = res.json()
    expect(body).toMatchObject({ format: 'lobby-elements', converted: true })
    expect((body.elements as { type: string }[]).filter((e) => e.type === 'freedraw')).toHaveLength(strokes)

    // the ceiling is what keeps that true: at the flat 128 MB the body does not fit (the body is heavy enough)
    previewSettings.workerHeapMb = 128
    const sid2 = await w.save(records.slice(0, -1), 'Strokes again')
    const refused = await w.preview(sid2)
    expect(refused.statusCode).toBe(200)
    expect(refused.json()).not.toHaveProperty('format')
  }, 60_000)

  it('a worker that cannot convert is logged (the reason and codes, never the board) and the records are answered', async () => {
    const lines: string[] = []
    const stream = { write: (chunk: string) => void lines.push(chunk) }
    const newer = { ...SCHEMA, sequences: { ...SCHEMA.sequences, 'com.tldraw.shape.note': 999 } }
    const w = await world({ level: 'info', stream })
    const sid = await w.save([...baseRecords(), noteRec('n1', 'a secret launch plan')], 'Secret')
    // a stored body whose schema is newer than the converter's
    const stored = w.sync.boards.get(w.board)
    if (!stored) throw new Error('no board')
    stored.schema = newer
    const sid2 = (await w.bob.req('POST', `/api/boards/${w.board}/snapshots`, { name: 'Newer' })).json()
      .id as string
    expect(sid2).not.toBe(sid)
    const res = await w.preview(sid2)
    expect(res.statusCode, res.body).toBe(200)
    expect(res.json()).toMatchObject({ records: expect.any(Array) }) // the v1 records answer
    expect(res.json()).not.toHaveProperty('format')
    const logged = lines
      .map((l) => JSON.parse(l) as Record<string, unknown>)
      .filter((l) => l.evt === 'checkpoint.preview.worker_failed')
    expect(logged).toHaveLength(1)
    expect(logged[0]).toMatchObject({
      level: 40,
      reason: 'unreadable',
      detail: 'the stored schema is newer than this converter',
      records: 3,
    })
    expect(lines.join('')).not.toContain('secret launch plan')
  })

  it('a heavy body that fits the budget is converted, and the loop stays free meanwhile', async () => {
    previewSettings.maxTextChars = Number.MAX_SAFE_INTEGER
    const w = await world()
    const sid = await w.save([...baseRecords(), ...wordyNotes(8, 20_000)], 'Heavy')
    const run = await lagDuring(() => w.preview(sid))
    expect(run.value.statusCode, run.value.body).toBe(200)
    expect(run.value.json()).toMatchObject({ format: 'lobby-elements', converted: true })
    expect(run.maxLagMs).toBeLessThan(400)
  })

  it('with every conversion place taken and no queue: 503 PREVIEW_BUSY at once, nothing remembered', async () => {
    previewSettings.maxTextChars = Number.MAX_SAFE_INTEGER
    previewSettings.maxConcurrent = 1
    previewSettings.maxQueue = 0
    previewSettings.workerTimeoutMs = 1_500
    const w = await world()
    const slow = await w.save(pathological(), 'Slow')
    const quick = await w.save([...baseRecords(), noteRec('n1', 'Launch plan')], 'Quick')
    const read = vi.spyOn(w.api.blobs, 'get')
    const first = w.preview(slow)
    // the first request has read its body and is converting (its worker holds the only place for 1.5 s)
    await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(1))
    await new Promise((r) => setTimeout(r, 300))
    const t0 = performance.now()
    const probe = await w.preview(quick)
    expect(probe.statusCode, probe.body).toBe(503)
    expect(probe.json().error.code).toBe('PREVIEW_BUSY')
    expect(performance.now() - t0).toBeLessThan(500)
    expect((await first).statusCode).toBe(200)
    // the refusal was not remembered: with a free place the same checkpoint converts
    const ok = await w.preview(quick)
    expect(ok.statusCode, ok.body).toBe(200)
    expect(ok.json()).toMatchObject({ format: 'lobby-elements', converted: true })
  })
})
