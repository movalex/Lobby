// Leases, reclaiming, retries and concurrency of the preview job queue (docs/M3-STORAGE-CONTRACTS.md
// §2, §4). Time is the api's clock (createTestApi's `clock.advance`), never real waiting.

import { LIMITS } from '@draftroom/dev-assets'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { derivativeKey } from '../../src/files/blobs.ts'
import { backoffMs, LEASE_MS } from '../../src/worker/protocol.ts'
import { claim, putBlob, reserve, type WorkerEnv, workerEnv } from './helpers.ts'

let env: WorkerEnv
beforeEach(async () => {
  env = await workerEnv()
})
afterEach(() => env.close())

const call = (
  op: 'heartbeat' | 'complete' | 'retry' | 'derivatives',
  versionId: string,
  body: Record<string, unknown>,
) => env.worker('POST', `/api/worker/jobs/${versionId}/${op}`, body)

const jobRow = (versionId: string) =>
  env.api.db.one<{
    status: string
    attempts: number
    lease_owner: string | null
    run_after: Date
    last_error: string | null
  }>('SELECT status, attempts, lease_owner, run_after, last_error FROM preview_jobs WHERE version_id = $1', [
    versionId,
  ])

describe('two concurrent claimers', () => {
  it('never get the same job', async () => {
    // PGlite runs one transaction at a time, so this checks the claim is atomic at the API level;
    // FOR UPDATE SKIP LOCKED under real contention is covered by skip-locked.pg.test.ts (DATABASE_URL).
    const uploads = []
    for (let i = 0; i < 8; i++) uploads.push(await env.upload(`f${i}.png`))
    const results = await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        env.worker('POST', '/api/worker/claim', { workerId: i % 2 ? 'nas-1' : 'render-1' }),
      ),
    )
    const claimed = results.filter((r) => r.statusCode === 200).map((r) => r.json().job.versionId as string)
    expect(results.filter((r) => r.statusCode === 204)).toHaveLength(12)
    expect(new Set(claimed).size).toBe(8)
    expect([...claimed].sort()).toEqual(uploads.map((u) => u.versionId).sort())
  })
})

describe('leases', () => {
  it('heartbeat extends the lease; an expired lease is reclaimed by the next claimer', async () => {
    const m = await env.upload()
    await claim(env, 'worker-a')
    env.api.clock.advance(100_000)
    expect((await call('heartbeat', m.versionId, { workerId: 'worker-a' })).json()).toEqual({
      leaseMs: LEASE_MS,
    })
    env.api.clock.advance(100_000) // 200 s after the claim, 100 s after the heartbeat: still leased
    expect(await claim(env, 'worker-b')).toBeNull()
    env.api.clock.advance(LEASE_MS - 100_000 + 1) // lease over
    const reclaimed = await claim(env, 'worker-b')
    expect(reclaimed?.job).toMatchObject({ versionId: m.versionId, attempt: 2 })
    expect(await jobRow(m.versionId)).toMatchObject({
      status: 'running',
      attempts: 2,
      lease_owner: 'worker-b',
    })
    expect((await env.meta(m)).attempts).toBe(2)
  })

  it('the worker that lost its lease gets 409 on heartbeat, derivatives, complete and retry', async () => {
    const m = await env.upload()
    await claim(env, 'worker-a')
    const early = await reserve(env, m.versionId, { bytes: 16 })
    await putBlob(env, early, Buffer.alloc(16))
    env.api.clock.advance(LEASE_MS + 1)
    await claim(env, 'worker-b')
    for (const op of ['heartbeat', 'derivatives', 'complete', 'retry'] as const) {
      const res = await call(op, m.versionId, {
        workerId: 'worker-a',
        status: 'ready',
        derivatives: [early.derivativeId],
        role: 'thumb',
        mimeType: 'image/webp',
        width: 1,
        height: 1,
        bytes: 1,
      })
      expect(res.statusCode, op).toBe(409)
      expect(res.json().error.code, op).toBe('LEASE_LOST')
    }
    // what worker-a reserved and uploaded before losing the lease is gone with its reservation
    expect(
      await env.api.blobs.head(derivativeKey(m.assetId, m.versionId, early.derivativeId, 'webp')),
    ).toBeNull()
    // worker-b finishes normally
    const done = await call('complete', m.versionId, {
      workerId: 'worker-b',
      status: 'ready',
      derivatives: [],
    })
    expect(done.statusCode).toBe(200)
    expect((await env.meta(m)).status).toBe('ready')
  })

  it('an expired lease that nobody reclaimed yet can still be completed by its holder', async () => {
    const m = await env.upload()
    await claim(env, 'worker-a')
    env.api.clock.advance(LEASE_MS + 5_000) // e.g. a long GC pause on the NAS
    const done = await call('complete', m.versionId, { workerId: 'worker-a', status: 'ready' })
    expect(done.statusCode).toBe(200)
    expect(await claim(env, 'worker-b')).toBeNull()
  })

  it('attempt tells two slots of one worker apart: a stale slot cannot touch the reclaimed job', async () => {
    const m = await env.upload()
    const first = await claim(env, 'nas-1')
    env.api.clock.advance(LEASE_MS + 1)
    const second = await claim(env, 'nas-1') // the same worker id, another slot
    expect(first?.job.attempt).toBe(1)
    expect(second?.job.attempt).toBe(2)
    expect((await call('heartbeat', m.versionId, { workerId: 'nas-1', attempt: 1 })).statusCode).toBe(409)
    expect(
      (await call('complete', m.versionId, { workerId: 'nas-1', attempt: 1, status: 'ready' })).statusCode,
    ).toBe(409)
    expect((await call('heartbeat', m.versionId, { workerId: 'nas-1', attempt: 2 })).statusCode).toBe(200)
    expect(
      (await call('complete', m.versionId, { workerId: 'nas-1', attempt: 2, status: 'ready' })).statusCode,
    ).toBe(200)
  })

  it('unknown or malformed version ids are 404/409, never another job', async () => {
    const m = await env.upload()
    await claim(env, 'worker-a')
    expect((await call('heartbeat', 'ver_ZZZZZZZZZZZZZZZZZZZZ', { workerId: 'worker-a' })).statusCode).toBe(
      409,
    )
    expect((await call('heartbeat', 'not-a-version', { workerId: 'worker-a' })).statusCode).toBe(404)
    expect((await call('heartbeat', m.versionId, { workerId: 'worker-b' })).statusCode).toBe(409)
  })
})

describe('retry', () => {
  it('backs off, then fails the version (INTERNAL) after LIMITS.maxAttempts attempts', async () => {
    const m = await env.upload()
    expect(LIMITS.maxAttempts).toBe(3)
    for (let attempt = 1; attempt <= 3; attempt++) {
      const c = await claim(env, 'worker-a')
      expect(c?.job.attempt, `attempt ${attempt}`).toBe(attempt)
      const before = env.api.clock.now().getTime()
      const res = await call('retry', m.versionId, {
        workerId: 'worker-a',
        error: { code: 'CHILD_CRASHED', message: 'pdf child exited with SIGKILL' },
      })
      const after = env.api.clock.now().getTime()
      expect(res.statusCode).toBe(200)
      if (attempt < 3) {
        expect(res.json()).toMatchObject({ versionId: m.versionId, status: 'queued' })
        const runAfter = Date.parse(res.json().runAfter)
        expect(runAfter).toBeGreaterThanOrEqual(before + backoffMs(attempt))
        expect(runAfter).toBeLessThanOrEqual(after + backoffMs(attempt))
        expect(await jobRow(m.versionId)).toMatchObject({
          status: 'queued',
          attempts: attempt,
          lease_owner: null,
          last_error: 'CHILD_CRASHED: pdf child exited with SIGKILL',
        })
        expect((await env.meta(m)).status).toBe('queued')
        // not before the backoff is over (the test clock also moves with real time: keep a margin)
        env.api.clock.advance(runAfter - env.api.clock.now().getTime() - 2_000)
        expect(await claim(env, 'worker-a')).toBeNull()
        env.api.clock.advance(2_001)
      } else {
        expect(res.json()).toMatchObject({ status: 'failed', runAfter: null })
      }
    }
    const meta = await env.meta(m)
    expect(meta).toMatchObject({ status: 'failed', attempts: 3 })
    expect(meta.error).toEqual({
      code: 'INTERNAL',
      message: 'The preview could not be made. Try uploading the file again.',
    })
    expect(JSON.stringify(meta)).not.toContain('SIGKILL') // worker detail never reaches users
    expect((await jobRow(m.versionId)).status).toBe('failed')
    expect(await claim(env, 'worker-a')).toBeNull()
    expect(
      env.events.filter((e) => e.type === 'assets.version').map((e) => (e.data as { status: string }).status),
    ).toEqual(['queued', 'queued', 'failed'])
  })

  it('backoff grows and is capped', () => {
    expect([1, 2, 3, 4, 5, 10].map(backoffMs)).toEqual([15_000, 60_000, 240_000, 900_000, 900_000, 900_000])
  })

  it('release (worker shutdown) requeues at once and does not count the attempt', async () => {
    const m = await env.upload()
    await claim(env, 'worker-a')
    const r = await reserve(env, m.versionId, { bytes: 16 })
    await putBlob(env, r, Buffer.alloc(16))
    const res = await call('retry', m.versionId, { workerId: 'worker-a', release: true })
    expect(res.json()).toMatchObject({ status: 'queued' })
    expect(await jobRow(m.versionId)).toMatchObject({ status: 'queued', attempts: 0 })
    expect(await env.api.blobs.head(derivativeKey(m.assetId, m.versionId, r.derivativeId, 'webp'))).toBeNull()
    expect((await claim(env, 'worker-b'))?.job.attempt).toBe(1)
  })

  it('a job whose worker keeps dying (leases expire every time) is failed after LIMITS.maxAttempts', async () => {
    const m = await env.upload()
    env.api.clock.advance(10) // strictly older than the next upload
    const other = await env.upload('fine.png')
    for (let i = 0; i < 3; i++) {
      // claim m (the oldest due job) and let the lease run out, as if the file crashed the process
      const c = await claim(env, `worker-${i}`)
      expect(c?.job.versionId).toBe(m.versionId)
      env.api.clock.advance(LEASE_MS + 1)
    }
    // the next claim gives up on m (poison pill) and hands out the other job instead
    const next = await claim(env, 'worker-9')
    expect(next?.job.versionId).toBe(other.versionId)
    expect(await env.meta(m)).toMatchObject({ status: 'failed', error: { code: 'INTERNAL' } })
    // the last holder waking up late cannot claim that result as its own
    const late = await call('complete', m.versionId, { workerId: 'worker-2', status: 'ready' })
    expect(late.statusCode).toBe(409)
    expect(
      env.events.some(
        (e) => e.type === 'assets.version' && (e.data as { status: string }).status === 'failed',
      ),
    ).toBe(true)
  })
})
