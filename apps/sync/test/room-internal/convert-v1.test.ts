// J4 IMPORT-V1-SYNC-BLOCK: the helper that converts a seeded v1 body in a worker thread (room-internal/
// convert-v1.ts), on its own and without the server around it: the answer is the in-process converter's,
// the limits hold (records, bytes, answer, time, heap, places), and the event loop is never held. The
// server-level behaviour (413 / 422 / 503 answers, the server staying responsive) is seed-v1-limits.test.ts.
import { installedServerTextMetrics, installServerTextMetrics } from '@draftroom/canvas-schema/engine'
import { convertBoard, migrateRecords, type TlRecord } from '@draftroom/tldraw-import'
import { draftroomSchema } from '@draftroom/tldraw-import/schema'
import { describe, expect, it, vi } from 'vitest'
import {
  type ConvertV1Limits,
  convertV1InWorker,
  seedRefusalError,
  v1SeedLimits,
  waitForMemory,
  workerHeapMb,
} from '../../src/room-internal/convert-v1.ts'
import { Gate } from '../../src/room-internal/gate.ts'
import { docRecord, nthIndex, pageRecord, note as tlNote } from '../migrate/tl-records.ts'
import { bodyMiB, strokeBoard } from './v1-strokes.ts'

const SCHEMA = draftroomSchema.serialize()
const LIMITS: ConvertV1Limits = {
  maxRecords: 20_000,
  maxBytes: 64 * 1024 * 1024,
  maxResultBytes: 64 * 1024 * 1024,
  timeoutMs: 20_000,
  maxHeapMb: 256,
}
const gate = () => new Gate({ concurrent: 1, maxQueue: 4, maxWaitMs: 5_000 })

const base = () => [docRecord(), pageRecord('page:page', 'Page 1', 'a1')]
/** `n` sticky notes of `chars` characters of words each: about 110 ms a note at 20,000 characters. */
const wordy = (n: number, chars: number) =>
  Array.from({ length: n }, (_, i) =>
    tlNote(
      `w${i}`,
      'page:page',
      nthIndex(i + 1),
      (i % 40) * 300,
      Math.floor(i / 40) * 300,
      'word '.repeat(chars / 5),
    ),
  )
const pathological = () => [...base(), ...wordy(60, 20_000)] // 6.6 s in-process

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

describe('convertV1InWorker (sync)', () => {
  it('makes the elements the in-process converter makes', async () => {
    const records = [...base(), tlNote('n1', 'page:page', 'a1', 100, 100, 'converted text'), ...wordy(2, 200)]
    const out = await convertV1InWorker({ records, schema: SCHEMA, now: 1_700_000_000_000 }, LIMITS, gate())
    if (!out.ok) throw new Error(`refused: ${out.reason}`)
    const migrated = migrateRecords(records, SCHEMA)
    if (!migrated.ok) throw new Error('unreadable')
    const direct = convertBoard(migrated.records as TlRecord[], {
      updatedAt: 1_700_000_000_000,
      metrics: installedServerTextMetrics() ?? installServerTextMetrics(),
    })
    expect(out.converted.elements).toEqual(JSON.parse(JSON.stringify(direct.elements)))
    expect(out.converted.legacyIds).toEqual(direct.legacyIds)
    expect(Object.keys(out.converted.legacyPages)).toEqual(Object.keys(direct.legacyPages))
    expect(out.converted.elements.some((e) => e.id === 'n1' && e.type === 'stickynote')).toBe(true)
  })

  it('past its time budget the worker is stopped though it spins in synchronous code: `time`, and the loop is never held', async () => {
    const run = await lagDuring(() =>
      convertV1InWorker(
        { records: pathological(), schema: SCHEMA, now: 1 },
        { ...LIMITS, timeoutMs: 1_500 },
        gate(),
      ),
    )
    expect(run.value).toEqual({ ok: false, reason: 'time' })
    expect(run.ms).toBeGreaterThanOrEqual(1_400)
    expect(run.ms).toBeLessThan(3_000) // 6.6 s of work, cut at the budget
    expect(run.maxLagMs).toBeLessThan(400) // in-process the loop was held for all 6.6 s
  })

  it('a heavy body inside its budget completes with the loop free', async () => {
    const run = await lagDuring(() =>
      convertV1InWorker(
        { records: [...base(), ...wordy(8, 20_000)], schema: SCHEMA, now: 1 },
        LIMITS,
        gate(),
      ),
    )
    if (!run.value.ok) throw new Error(`refused: ${run.value.reason}`)
    expect(run.value.converted.elements.filter((e) => e.type === 'stickynote')).toHaveLength(8)
    expect(run.maxLagMs).toBeLessThan(400)
  })

  it('refuses past the record, byte and answer limits and a heap cap, each with its own reason (no worker for the first two)', async () => {
    const records = [...base(), ...wordy(3, 100)]
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
    expect(
      await convertV1InWorker({ records, schema: SCHEMA, now: 1 }, { ...LIMITS, maxHeapMb: 4 }, gate()),
    ).toEqual({ ok: false, reason: 'memory' })
  })

  it('records it cannot read are `unreadable` with the migration’s reason; a record with no id too', async () => {
    const newer = { schemaVersion: 99, sequences: {} }
    expect(
      await convertV1InWorker(
        { records: [{ id: 'x', typeName: 'shape' }], schema: newer, now: 1 },
        LIMITS,
        gate(),
      ),
    ).toMatchObject({ ok: false, reason: 'unreadable' })
    expect(
      await convertV1InWorker({ records: [{ typeName: 'shape' }], schema: SCHEMA, now: 1 }, LIMITS, gate()),
    ).toMatchObject({ ok: false, reason: 'unreadable', detail: 'a record has no id' })
  })

  it('one place and no queue: a second conversion is `busy` at once, and the place comes back', async () => {
    const one = new Gate({ concurrent: 1, maxQueue: 0 })
    const slow = convertV1InWorker(
      { records: pathological(), schema: SCHEMA, now: 1 },
      { ...LIMITS, timeoutMs: 1_200 },
      one,
    )
    await vi.waitFor(() => expect(one.running).toBe(1))
    const t0 = performance.now()
    expect(await convertV1InWorker({ records: base(), schema: SCHEMA, now: 1 }, LIMITS, one)).toEqual({
      ok: false,
      reason: 'busy',
    })
    expect(performance.now() - t0).toBeLessThan(100)
    expect(await slow).toEqual({ ok: false, reason: 'time' })
    expect(one.running).toBe(0)
    expect((await convertV1InWorker({ records: base(), schema: SCHEMA, now: 1 }, LIMITS, one)).ok).toBe(true)
  })
})

describe('the worker’s heap is sized by the body (a stroke-heavy board that the in-process conversion imported)', () => {
  it('48 MB plus 64 MB a MiB, 64 MB at least, never over the ceiling', () => {
    const MiB = 1024 * 1024
    expect(workerHeapMb(1_000, 256)).toBe(64)
    expect(workerHeapMb(MiB, 256)).toBe(112)
    expect(workerHeapMb(2.4 * MiB, 256)).toBe(202)
    expect(workerHeapMb(3 * MiB, 256)).toBe(240)
    expect(workerHeapMb(4 * MiB, 256)).toBe(256) // the ceiling
    expect(workerHeapMb(40 * MiB, 512)).toBe(512)
    expect(workerHeapMb(1_000, 4)).toBe(4) // a ceiling under the floor still wins
  })

  it('300 strokes of 1,500 points (2.4 MiB, 302 records, about 0.3 s of work) convert; the flat 128 MB cap the first version shipped refused them as out of memory', async () => {
    const records = strokeBoard(300, 1_500)
    expect(bodyMiB(records, SCHEMA)).toBeGreaterThan(2.3)
    const ceiling = v1SeedLimits({}).maxHeapMb
    const out = await convertV1InWorker(
      { records, schema: SCHEMA, now: 1 },
      { ...LIMITS, maxHeapMb: ceiling },
      gate(),
    )
    if (!out.ok) throw new Error(`refused: ${out.reason}`)
    expect(out.converted.elements.filter((e) => e.type === 'freedraw')).toHaveLength(300)
    // what it needs is over the 128 MB a flat cap gave it: with that ceiling it still runs out
    expect(
      await convertV1InWorker({ records, schema: SCHEMA, now: 1 }, { ...LIMITS, maxHeapMb: 128 }, gate()),
    ).toEqual({ ok: false, reason: 'memory' })
  }, 60_000)

  it('500 strokes of 1,500 points (4.0 MiB) convert at the shipped ceiling', async () => {
    const records = strokeBoard(500, 1_500)
    expect(bodyMiB(records, SCHEMA)).toBeGreaterThan(3.9)
    const out = await convertV1InWorker(
      { records, schema: SCHEMA, now: 1 },
      { ...LIMITS, maxHeapMb: v1SeedLimits({}).maxHeapMb },
      gate(),
    )
    expect(out.ok, JSON.stringify(out.ok ? '' : out)).toBe(true)
  }, 60_000)

  it('a worker is started only if `admit` says so, with the heap it would get: `busy` otherwise, and the place comes back', async () => {
    const nowhere = new URL('file:///nonexistent/worker.ts')
    const records = [...base(), ...wordy(3, 100)]
    const asked: number[] = []
    const one = new Gate({ concurrent: 1, maxQueue: 0 })
    expect(
      await convertV1InWorker({ records, schema: SCHEMA, now: 1 }, LIMITS, one, nowhere, async (heapMb) => {
        asked.push(heapMb)
        return false
      }),
    ).toEqual({ ok: false, reason: 'busy' })
    expect(asked).toEqual([64])
    expect(one.running).toBe(0)
    const yes = await convertV1InWorker(
      { records, schema: SCHEMA, now: 1 },
      LIMITS,
      one,
      undefined,
      async () => true,
    )
    expect(yes.ok).toBe(true)
  })

  it('a worker that cannot start, or dies, is `failed` with a code to log (never a message), and the place comes back', async () => {
    const one = new Gate({ concurrent: 1, maxQueue: 0 })
    const out = await convertV1InWorker(
      { records: base(), schema: SCHEMA, now: 1 },
      LIMITS,
      one,
      new URL('file:///nonexistent/worker.ts'),
    )
    expect(out).toMatchObject({ ok: false, reason: 'failed' })
    if (out.ok) throw new Error('unexpected')
    expect(out.cause).toMatch(/^[A-Za-z0-9_ ]{1,64}$/)
    expect(one.running).toBe(0)
  })
})

describe('waitForMemory (the seed’s worker waits while the process has no memory to spare)', () => {
  const MiB = 1024 * 1024
  it('goes at once when RSS plus the heap fits under the limit', async () => {
    const t0 = performance.now()
    expect(await waitForMemory(100, { rssLimitMb: 440, waitMs: 2_000, rss: () => 300 * MiB })).toBe(true)
    expect(performance.now() - t0).toBeLessThan(100)
  })

  it('waits for memory to come free, and goes as soon as it does', async () => {
    let rss = 400 * MiB
    setTimeout(() => {
      rss = 200 * MiB
    }, 120)
    const t0 = performance.now()
    expect(await waitForMemory(100, { rssLimitMb: 440, waitMs: 3_000, pollMs: 20, rss: () => rss })).toBe(
      true,
    )
    expect(performance.now() - t0).toBeGreaterThanOrEqual(100)
    expect(performance.now() - t0).toBeLessThan(1_500)
  })

  it('gives up when none comes within the wait (the seed then answers busy)', async () => {
    const t0 = performance.now()
    expect(await waitForMemory(100, { rssLimitMb: 440, waitMs: 150, pollMs: 20, rss: () => 400 * MiB })).toBe(
      false,
    )
    expect(performance.now() - t0).toBeGreaterThanOrEqual(140)
    expect(performance.now() - t0).toBeLessThan(1_000)
  })
})

describe('the seed’s limits and answers', () => {
  it('the shipped limits, and an environment variable only inside its range', () => {
    expect(v1SeedLimits({})).toEqual({
      maxRecords: 20_000,
      maxBytes: 32 * 1024 * 1024,
      maxResultBytes: 64 * 1024 * 1024,
      timeoutMs: 8_000,
      maxHeapMb: 256,
      concurrent: 1,
      maxQueue: 4,
      queueWaitMs: 3_000,
      rssLimitMb: 440, // the migration queue's runtime limit
      memoryWaitMs: 2_000,
    })
    expect(
      v1SeedLimits({
        DRAFTROOM_V1_SEED_TIMEOUT_MS: '1500',
        DRAFTROOM_V1_SEED_HEAP_MB: '64',
        DRAFTROOM_V1_SEED_RSS_LIMIT_MB: '1000',
        DRAFTROOM_V1_SEED_MAX_RECORDS: '50',
        DRAFTROOM_V1_SEED_MAX_BYTES: '5000',
        DRAFTROOM_V1_SEED_MAX_QUEUE: '0',
      }),
    ).toMatchObject({
      timeoutMs: 1_500,
      maxHeapMb: 64,
      rssLimitMb: 1_000,
      maxRecords: 50,
      maxBytes: 5_000,
      maxQueue: 0,
    })
    // the heap ceiling can be raised past the default, up to 512 MB (with the RSS limit, on a bigger plan)
    expect(v1SeedLimits({ DRAFTROOM_V1_SEED_HEAP_MB: '512' }).maxHeapMb).toBe(512)
    // out of range, or not a whole number: the default
    expect(
      v1SeedLimits({
        DRAFTROOM_V1_SEED_TIMEOUT_MS: '100000',
        DRAFTROOM_V1_SEED_HEAP_MB: '1024',
        DRAFTROOM_V1_SEED_RSS_LIMIT_MB: '10',
        DRAFTROOM_V1_SEED_MAX_RECORDS: '0',
        DRAFTROOM_V1_SEED_MAX_BYTES: '12x',
        DRAFTROOM_V1_SEED_MAX_QUEUE: '-1',
      }),
    ).toMatchObject({
      timeoutMs: 8_000,
      maxHeapMb: 256,
      rssLimitMb: 440,
      maxRecords: 20_000,
      maxBytes: 32 * 1024 * 1024,
      maxQueue: 4,
    })
  })

  it('413 past a size limit or the heap (too large or complex), 422 past the time budget, 503 busy, 400 for what cannot be read', () => {
    for (const r of ['too-many-records', 'too-large', 'result-too-large', 'memory'] as const)
      expect(seedRefusalError(r)).toMatchObject({
        status: 413,
        code: 'IMPORT_TOO_LARGE',
        message: 'This board is too large or complex to convert.',
      })
    // running out of memory is not "takes too long"
    expect(seedRefusalError('time')).toMatchObject({
      status: 422,
      code: 'IMPORT_TOO_COMPLEX',
      message: 'This board takes too long to convert.',
    })
    expect(seedRefusalError('busy')).toMatchObject({ status: 503, code: 'BUSY' })
    expect(seedRefusalError('unreadable', 'a record has no id')).toMatchObject({
      status: 400,
      message: 'The tldraw records cannot be read (a record has no id).',
    })
    expect(seedRefusalError('failed', 'unknown-shape')).toMatchObject({
      status: 400,
      message: 'The board cannot be converted (unknown-shape).',
    })
    expect(seedRefusalError('failed')).toMatchObject({ status: 500, code: 'CONVERT_FAILED' })
  })
})
