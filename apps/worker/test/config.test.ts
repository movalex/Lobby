// Worker configuration, the idle backoff, the leftover-directory sweep and the client's URL/credential
// rules: pure functions, no network.
import { mkdirSync, mkdtempSync, readdirSync, rmSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { newId } from '@draftroom/dev-assets'
import { afterAll, describe, expect, it } from 'vitest'
import { createWorkerApi, parseClaim, WorkerApiError } from '../src/api-client.ts'
import { defaultWorkerId, isPrivateHost, loadWorkerEnv } from '../src/env.ts'
import { heartbeatInterval } from '../src/remote-job.ts'
import { idleDelay, sweepTmp } from '../src/remote-loop.ts'

const TOKEN = 'k'.repeat(48)
const base = { DRAFTROOM_API_URL: 'http://127.0.0.1:5859', DRAFTROOM_WORKER_TOKEN: TOKEN }
const refusal = (env: Record<string, string | undefined>) => {
  try {
    loadWorkerEnv(env)
    return 'OK'
  } catch (e) {
    return (e as Error).message
  }
}

describe('loadWorkerEnv', () => {
  it('has the contract defaults', () => {
    const c = loadWorkerEnv(base)
    expect(c).toMatchObject({
      production: false,
      apiUrl: 'http://127.0.0.1:5859',
      token: TOKEN,
      workerId: defaultWorkerId(),
      concurrency: 1,
      pollMs: 2_000,
      pollMaxMs: 15_000,
      pdfHeapMb: 384,
      pdfRssMb: 768,
      shutdownGraceMs: 10_000,
      tmpDir: tmpdir(),
      unusedSecrets: [],
    })
  })

  it('refuses an unknown NODE_ENV (security audit M2): staging accepted the dev-only token placeholder', () => {
    for (const v of ['staging', 'prod', 'Production', 'dev'])
      expect(refusal({ ...base, NODE_ENV: v, DRAFTROOM_WORKER_TOKEN: `dev-only-${'x'.repeat(40)}` })).toMatch(
        /NODE_ENV must be production, development or test/,
      )
    expect(refusal({ ...base, NODE_ENV: 'staging' })).toContain('"staging"')
    expect(loadWorkerEnv({ ...base, NODE_ENV: '' }).nodeEnv).toBe('development')
    expect(loadWorkerEnv({ ...base, NODE_ENV: 'test' }).nodeEnv).toBe('test')
    expect(
      loadWorkerEnv({ ...base, NODE_ENV: 'production', DRAFTROOM_API_URL: 'https://api.test' }).nodeEnv,
    ).toBe('production')
  })

  it('reads every knob', () => {
    const c = loadWorkerEnv({
      ...base,
      DRAFTROOM_API_URL: 'https://api.example.com/',
      WORKER_ID: 'nas-1',
      WORKER_CONCURRENCY: '2',
      WORKER_POLL_MS: '100',
      WORKER_POLL_MAX_MS: '500',
      WORKER_PDF_HEAP_MB: '256',
      WORKER_PDF_RSS_MB: '400',
      WORKER_SHUTDOWN_GRACE_MS: '0',
      FFMPEG_PATH: '/usr/bin/ffmpeg',
      FFPROBE_PATH: '/usr/bin/ffprobe',
    })
    expect(c).toMatchObject({
      apiUrl: 'https://api.example.com',
      workerId: 'nas-1',
      concurrency: 2,
      pollMs: 100,
      pollMaxMs: 500,
      pdfHeapMb: 256,
      pdfRssMb: 400,
      shutdownGraceMs: 0,
      ffmpegPath: '/usr/bin/ffmpeg',
      ffprobePath: '/usr/bin/ffprobe',
    })
  })

  it('accepts host:port (what a Render Blueprint can inject) as plain http on the private network', () => {
    expect(
      loadWorkerEnv({ ...base, DRAFTROOM_API_URL: 'draftroom-api:10000', NODE_ENV: 'production' }).apiUrl,
    ).toBe('http://draftroom-api:10000')
  })

  it('refuses a missing or malformed api url, credentials, a path or a query', () => {
    expect(refusal({ DRAFTROOM_WORKER_TOKEN: TOKEN })).toMatch(/DRAFTROOM_API_URL is required/)
    expect(refusal({ ...base, DRAFTROOM_API_URL: 'ftp://x' })).toMatch(/http\(s\)/)
    expect(refusal({ ...base, DRAFTROOM_API_URL: 'not a url' })).toMatch(/absolute/)
    const creds = refusal({ ...base, DRAFTROOM_API_URL: 'https://user:hunter2@api.example.com' })
    expect(creds).toMatch(/must not contain credentials/)
    expect(creds).not.toContain('hunter2')
    expect(refusal({ ...base, DRAFTROOM_API_URL: 'https://api.example.com/api' })).toMatch(/origin only/)
    expect(refusal({ ...base, DRAFTROOM_API_URL: 'https://api.example.com/?a=1' })).toMatch(/origin only/)
  })

  it('in production: https unless the api is on a private network', () => {
    const prod = { ...base, NODE_ENV: 'production' }
    expect(refusal({ ...prod, DRAFTROOM_API_URL: 'http://api.example.com' })).toMatch(/must use https/)
    for (const ok of [
      'https://api.example.com',
      'http://192.168.10.20:5859',
      'http://10.0.0.5',
      'http://172.20.1.1',
      'http://127.0.0.1:5859',
      'http://draftroom-api:10000',
      'http://[fd00::1]:80',
    ]) {
      expect(refusal({ ...prod, DRAFTROOM_API_URL: ok })).toBe('OK')
    }
    expect(isPrivateHost('172.32.0.1')).toBe(false)
    expect(isPrivateHost('8.8.8.8')).toBe(false)
    expect(isPrivateHost('evil.com')).toBe(false)
  })

  it('refuses a short token, whitespace, and the dev placeholder in production (never echoing the value)', () => {
    expect(refusal({ ...base, DRAFTROOM_WORKER_TOKEN: undefined })).toMatch(/at least 32 characters/)
    expect(refusal({ ...base, DRAFTROOM_WORKER_TOKEN: 'short-secret' })).toMatch(/at least 32/)
    expect(refusal({ ...base, DRAFTROOM_WORKER_TOKEN: `${TOKEN} x` })).toMatch(/whitespace/)
    const dev = 'dev-only-worker-token-change-me-0123456789'
    expect(refusal({ ...base, DRAFTROOM_WORKER_TOKEN: dev })).toBe('OK')
    const msg = refusal({ ...base, DRAFTROOM_WORKER_TOKEN: dev, NODE_ENV: 'production' })
    expect(msg).toMatch(/development placeholder/)
    expect(msg).not.toContain(dev)
  })

  it('validates ids, numbers and paths', () => {
    expect(refusal({ ...base, WORKER_ID: 'has space' })).toMatch(/WORKER_ID/)
    expect(refusal({ ...base, WORKER_ID: 'x'.repeat(65) })).toMatch(/WORKER_ID/)
    expect(refusal({ ...base, WORKER_CONCURRENCY: '0' })).toMatch(/WORKER_CONCURRENCY must be between 1/)
    expect(refusal({ ...base, WORKER_POLL_MS: '5' })).toMatch(/WORKER_POLL_MS/)
    expect(refusal({ ...base, WORKER_POLL_MS: '-1' })).toMatch(/non-negative integer/)
    expect(refusal({ ...base, WORKER_POLL_MS: '3000', WORKER_POLL_MAX_MS: '1000' })).toMatch(
      /WORKER_POLL_MAX_MS/,
    )
    expect(refusal({ ...base, WORKER_PDF_HEAP_MB: '16' })).toMatch(/WORKER_PDF_HEAP_MB/)
    expect(refusal({ ...base, WORKER_PDF_RSS_MB: '64' })).toMatch(/WORKER_PDF_RSS_MB/)
    expect(refusal({ ...base, WORKER_TMP_DIR: 'relative/dir' })).toMatch(/absolute/)
    expect(loadWorkerEnv({ ...base, WORKER_POLL_MS: '20000' }).pollMaxMs).toBe(20_000) // cap never below poll
  })

  it('names (never shows) foreign credentials it was given but never uses', () => {
    const c = loadWorkerEnv({ ...base, DATABASE_URL: 'postgres://u:p@h/db', R2_SECRET_ACCESS_KEY: 'abc' })
    expect(c.unusedSecrets).toEqual(['DATABASE_URL', 'R2_SECRET_ACCESS_KEY'])
  })

  it('derives a valid default id from any hostname', () => {
    expect(defaultWorkerId('DESKTOP-ABC123')).toBe('DESKTOP-ABC123')
    expect(defaultWorkerId('3f2a9c1b7d4e')).toBe('3f2a9c1b7d4e')
    expect(defaultWorkerId('bad host!')).toBe('bad-host-')
    expect(defaultWorkerId('...')).toBe('worker')
  })
})

describe('heartbeat interval', () => {
  it('beats every quarter lease, at most 30 s apart (the api lease is 120 s), at least every 250 ms', () => {
    expect(heartbeatInterval(120_000)).toBe(30_000)
    expect(heartbeatInterval(600_000)).toBe(30_000)
    expect(heartbeatInterval(60_000)).toBe(15_000)
    expect(heartbeatInterval(1_200)).toBe(300)
    expect(heartbeatInterval(100)).toBe(250)
  })
})

describe('idle backoff', () => {
  it('doubles from pollMs to the cap, with ±20 % jitter that never exceeds the cap', () => {
    const mid = () => 0.5
    expect([0, 1, 2, 3, 4, 5].map((s) => idleDelay(s, 2_000, 15_000, mid))).toEqual([
      2_000, 4_000, 8_000, 15_000, 15_000, 15_000,
    ])
    expect(idleDelay(0, 2_000, 15_000, () => 0)).toBe(1_600)
    expect(idleDelay(0, 2_000, 15_000, () => 0.9999)).toBe(2_400)
    expect(idleDelay(10, 2_000, 15_000, () => 0.9999)).toBe(15_000)
    expect(idleDelay(10, 2_000, 15_000, () => 0)).toBe(12_000)
    expect(idleDelay(1_000, 100, 500, mid)).toBe(500) // no overflow on a long idle streak
    expect(idleDelay(0, 20_000, 15_000, mid)).toBe(20_000) // a poll above the cap is kept
  })
})

describe('sweepTmp', () => {
  const dirs: string[] = []
  afterAll(() => {
    for (const d of dirs) rmSync(d, { recursive: true, force: true })
  })

  it('removes only old drw-job-XXXXXX directories', () => {
    const d = mkdtempSync(join(tmpdir(), 'drwt-'))
    dirs.push(d)
    const old = new Date(Date.now() - 2 * 60 * 60_000)
    for (const n of [
      'drw-job-aaaaaa',
      'drw-job-bbbbbb',
      'drw-job-cccccc',
      'other-dir',
      'drw-job-too-long-name',
    ]) {
      mkdirSync(join(d, n, 'assets'), { recursive: true })
    }
    for (const n of ['drw-job-aaaaaa', 'drw-job-bbbbbb', 'other-dir', 'drw-job-too-long-name']) {
      utimesSync(join(d, n), old, old)
    }
    expect(sweepTmp(d, 60 * 60_000)).toBe(2)
    expect(readdirSync(d).sort()).toEqual(['drw-job-cccccc', 'drw-job-too-long-name', 'other-dir'])
    expect(sweepTmp(join(d, 'missing'), 0)).toBe(0)
  })
})

describe('api client', () => {
  const api = createWorkerApi({
    baseUrl: 'https://api.example.com',
    token: TOKEN,
    workerId: 'w1',
    requestTimeoutMs: 1_000,
    requireHttpsBlobs: true,
  })

  it('sends the bearer token only to the api origin', () => {
    expect(api.blobRequest({ url: '/api/worker/blobs/abc', headers: {} })).toEqual({
      url: 'https://api.example.com/api/worker/blobs/abc',
      headers: { authorization: `Bearer ${TOKEN}` },
    })
    expect(
      api.blobRequest({
        url: 'https://api.example.com/api/worker/blobs/abc',
        headers: { authorization: 'x' },
      }).headers,
    ).toEqual({ authorization: `Bearer ${TOKEN}` }) // cannot be overridden
    const r2 = api.blobRequest({
      url: 'https://acc.r2.cloudflarestorage.com/b/k?X-Amz-Signature=s',
      headers: { 'content-type': 'image/webp', host: 'evil', cookie: 'a=b', 'content-length': '1' },
    })
    expect(r2).toEqual({
      url: 'https://acc.r2.cloudflarestorage.com/b/k?X-Amz-Signature=s',
      headers: { 'content-type': 'image/webp' },
    })
  })

  it('refuses blob urls that are not http(s), carry credentials, or are plain http elsewhere in production', () => {
    const bad = (url: string) => {
      try {
        api.blobRequest({ url, headers: {} })
        return 'OK'
      } catch (e) {
        return (e as WorkerApiError).kind
      }
    }
    expect(bad('file:///etc/passwd')).toBe('protocol')
    expect(bad('https://u:p@store.example.com/k')).toBe('protocol')
    expect(bad('http://store.example.com/k')).toBe('protocol')
    expect(bad('https://store.example.com/k')).toBe('OK')
  })

  it('validates a claim and keeps the version id of an invalid one so it can be handed back', () => {
    const job = {
      versionId: newId('ver'),
      assetId: newId('ast'),
      boardId: 'b-1',
      kind: 'image',
      name: 'x.png',
      declaredMimeType: 'image/png',
      sizeBytes: 10,
      attempt: 1,
      leaseMs: 120_000,
    }
    const ok = parseClaim({ job, original: { url: 'https://s/k' } })
    expect(ok).toEqual({ job, original: { url: 'https://s/k', headers: {} } })
    for (const broken of [
      { ...job, kind: 'exe' },
      { ...job, sizeBytes: -1 },
      { ...job, attempt: 0 },
      { ...job, assetId: '../x' },
    ]) {
      try {
        parseClaim({ job: broken, original: { url: 'https://s/k' } })
        throw new Error('accepted')
      } catch (e) {
        expect(e).toBeInstanceOf(WorkerApiError)
        expect((e as WorkerApiError).kind).toBe('protocol')
        expect((e as WorkerApiError).versionId).toBe(job.versionId)
      }
    }
    expect(() => parseClaim({ job, original: {} })).toThrow(/original has no url/)
    try {
      parseClaim({ job: { ...job, versionId: '../../etc' } })
    } catch (e) {
      expect((e as WorkerApiError).versionId).toBeNull()
    }
  })
})
