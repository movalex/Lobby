// The worker as a real process: `node apps/worker/src/worker.ts` against a fake API (no data dir, no
// database, no storage credentials: only DRAFTROOM_API_URL + DRAFTROOM_WORKER_TOKEN).
import { type ChildProcess, spawn } from 'node:child_process'
import { readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { type FakeApi, startFakeApi } from './fake-api.ts'
import { ensureFixtures } from './helpers.ts'
import { cleanupRoots, tmpRoot, waitFor } from './remote-helpers.ts'

const WORKER = fileURLToPath(new URL('../src/worker.ts', import.meta.url))

let child: ChildProcess | null = null
let fake: FakeApi | null = null

/** The parent's environment minus anything Draftroom-specific, so only what a test passes is seen. */
function cleanEnv(extra: Record<string, string>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env }
  for (const k of Object.keys(env)) {
    if (/^(DRAFTROOM_|WORKER_|R2_)/.test(k) || ['NODE_ENV', 'DATABASE_URL', 'NODE_OPTIONS'].includes(k))
      delete env[k]
  }
  return { ...env, ...extra }
}

function start(env: Record<string, string>) {
  const c = spawn(process.execPath, [WORKER], {
    env: cleanEnv(env),
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    windowsHide: true,
  })
  child = c
  const out = { text: '' }
  c.stdout?.on('data', (b) => {
    out.text += String(b)
  })
  c.stderr?.on('data', (b) => {
    out.text += String(b)
  })
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) =>
    c.on('exit', (code, signal) => resolve({ code, signal })),
  )
  return { c, out, exited }
}

/**
 * Graceful stop. POSIX gets a real SIGINT. On Windows child.kill('SIGINT') terminates the process
 * outright (no handler runs; verified on this machine), so the worker's IPC 'shutdown' message,
 * which calls the same handler, stands in for Ctrl+C.
 */
function interrupt(c: ChildProcess) {
  if (process.platform === 'win32') c.send('shutdown')
  else c.kill('SIGINT')
}

beforeAll(async () => {
  await ensureFixtures()
})
afterEach(async () => {
  if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
  child = null
  await fake?.close()
  fake = null
})
afterAll(cleanupRoots)

describe('worker process', () => {
  it('processes jobs from the api, exits cleanly on interrupt, and logs no secrets or names', async () => {
    const f = await startFakeApi()
    fake = f
    const tmp = tmpRoot()
    const w = start({
      DRAFTROOM_API_URL: f.api,
      DRAFTROOM_WORKER_TOKEN: f.token,
      WORKER_ID: 'proc-worker',
      WORKER_POLL_MS: '100',
      WORKER_POLL_MAX_MS: '200',
      WORKER_TMP_DIR: tmp,
    })
    await waitFor(() => w.out.text.includes('[worker] id '), 15_000, 'worker start')
    expect(w.out.text).toContain(`[worker] started (api: ${f.api}, poll 100 ms)\n`)
    expect(w.out.text).toContain('[worker] id proc-worker, concurrency 1, pdf heap 384 MB')
    const pdf = f.add({
      fixture: 'document.pdf',
      name: 'Private Board Plan.pdf',
      declaredMimeType: 'application/pdf',
    })
    const video = f.add({
      fixture: 'video.mp4',
      name: 'Private Board Clip.mp4',
      declaredMimeType: 'video/mp4',
    })
    await waitFor(() => pdf.status === 'done' && video.status === 'done', 60_000, 'both jobs done')
    expect(pdf.result?.probe.pageCount).toBe(4)
    expect(video.result?.probe.videoCodec).toBe('h264')
    expect(pdf.result?.workerId).toBe('proc-worker')

    const t0 = Date.now()
    interrupt(w.c)
    const { code, signal } = await w.exited
    expect({ code, signal }).toEqual({ code: 0, signal: null })
    expect(Date.now() - t0).toBeLessThan(10_000)
    expect(w.out.text).toContain('[worker] stopped')
    expect(readdirSync(tmp)).toEqual([])
    // Logs name versions, never user file names, the token, blob URLs or their signatures.
    expect(w.out.text).toContain(pdf.versionId)
    expect(w.out.text).not.toContain('Private Board')
    expect(w.out.text).not.toContain(f.token)
    expect(w.out.text).not.toContain(f.store)
    expect(w.out.text).not.toMatch(/X-Amz|\/bucket\/|\/api\/worker\/blobs/)
    for (const s of f.secrets) expect(w.out.text).not.toContain(s)
    // Every api call carried the token; the store never saw it.
    expect(f.requests.filter((r) => r.server === 'store').every((r) => !r.headers.authorization)).toBe(true)
  })

  it('shutdown with WORKER_SHUTDOWN_GRACE_MS=0 releases a job whose download is in progress', async () => {
    const f = await startFakeApi()
    fake = f
    f.hooks.original = (job, _req, res) => {
      res.writeHead(200, { 'content-length': job.sizeBytes })
      res.write((job.body() as Buffer).subarray(0, 100)) // then hold the connection open
      return true
    }
    const tmp = tmpRoot()
    const w = start({
      DRAFTROOM_API_URL: f.api,
      DRAFTROOM_WORKER_TOKEN: f.token,
      WORKER_POLL_MS: '50',
      WORKER_SHUTDOWN_GRACE_MS: '0',
      WORKER_TMP_DIR: tmp,
    })
    await waitFor(() => w.out.text.includes('[worker] started'), 15_000, 'worker start')
    const j = f.add({ fixture: 'image.png', declaredMimeType: 'image/png' })
    await waitFor(() => j.originalGets === 1, 15_000, 'download started')
    interrupt(w.c)
    expect(await w.exited).toEqual({ code: 0, signal: null })
    expect(j.retries).toHaveLength(1)
    expect(j.retries[0]).toMatchObject({
      release: true,
      error: { code: 'RELEASED', message: 'worker shutting down' },
    })
    expect(j.attempts).toBe(0)
    expect(j.status).toBe('queued')
    expect(readdirSync(tmp)).toEqual([])
  })

  it.skipIf(process.platform === 'win32')('handles a real SIGINT (POSIX)', async () => {
    const f = await startFakeApi()
    fake = f
    const w = start({ DRAFTROOM_API_URL: f.api, DRAFTROOM_WORKER_TOKEN: f.token, WORKER_POLL_MS: '100' })
    await waitFor(() => w.out.text.includes('started'), 15_000, 'worker start')
    w.c.kill('SIGINT')
    expect(await w.exited).toEqual({ code: 0, signal: null })
    expect(w.out.text).toContain('SIGINT')
  })

  it.each([
    [{}, 'DRAFTROOM_API_URL is required'],
    [{ DRAFTROOM_API_URL: 'http://127.0.0.1:1' }, 'DRAFTROOM_WORKER_TOKEN is required'],
    [
      {
        DRAFTROOM_API_URL: 'https://api.example.com',
        DRAFTROOM_WORKER_TOKEN: 'dev-only-worker-token-change-me-0123456789',
        NODE_ENV: 'production',
      },
      'development placeholder',
    ],
    [
      {
        DRAFTROOM_API_URL: 'http://api.example.com',
        DRAFTROOM_WORKER_TOKEN: 'z'.repeat(40),
        NODE_ENV: 'production',
      },
      'must use https',
    ],
  ])('refuses to start with %o', async (env, message) => {
    const w = start(env as Record<string, string>)
    const { code } = await w.exited
    expect(code).toBe(1)
    expect(w.out.text).toContain(`[worker] refusing to start: `)
    expect(w.out.text).toContain(message)
    const token = (env as Record<string, string>).DRAFTROOM_WORKER_TOKEN
    if (token) expect(w.out.text).not.toContain(token)
    expect(w.out.text).not.toContain('started')
  })
})
