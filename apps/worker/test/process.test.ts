// The worker as a real process: `node apps/worker/src/worker.ts` against a temp data dir.
import { type ChildProcess, spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { cleanupLayouts, ensureFixtures, ingest, jobsIn, metaOf, tempLayout, waitFor } from './helpers.ts'

const WORKER = fileURLToPath(new URL('../src/worker.ts', import.meta.url))

let child: ChildProcess | null = null

function start(env: Record<string, string>) {
  const c = spawn(process.execPath, [WORKER], {
    env: { ...process.env, ...env },
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
afterEach(() => {
  if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
  child = null
})
afterAll(cleanupLayouts)

describe('worker process', () => {
  it('picks up two uploads, makes both ready, and exits cleanly on interrupt', async () => {
    const l = tempLayout()
    const w = start({ DRAFTROOM_DATA_DIR: l.root, WORKER_POLL_MS: '100' })
    await waitFor(() => w.out.text.includes('started'), 15_000, 'worker start')
    const pdf = ingest(l, 'document.pdf', { name: 'Private Board Plan.pdf', mimeType: 'application/pdf' })
    const video = ingest(l, 'video.mp4', { name: 'Private Board Clip.mp4', mimeType: 'video/mp4' })
    await waitFor(
      () => metaOf(l, pdf).status === 'ready' && metaOf(l, video).status === 'ready',
      60_000,
      'both jobs ready',
    )
    expect(metaOf(l, pdf).probe.pageCount).toBe(4)
    expect(metaOf(l, video).probe.videoCodec).toBe('h264')
    expect(jobsIn(l, 'done').sort()).toEqual(
      [`${pdf.meta.versionId}.json`, `${video.meta.versionId}.json`].sort(),
    )

    const t0 = Date.now()
    interrupt(w.c)
    const { code, signal } = await w.exited
    expect({ code, signal }).toEqual({ code: 0, signal: null })
    expect(Date.now() - t0).toBeLessThan(10_000)
    expect(w.out.text).toContain('stopped')
    expect(jobsIn(l, 'processing')).toEqual([])
    // Logs name versions, never user file names.
    expect(w.out.text).not.toContain('Private Board')
  })

  it.skipIf(process.platform === 'win32')('handles a real SIGINT (POSIX)', async () => {
    const l = tempLayout()
    const w = start({ DRAFTROOM_DATA_DIR: l.root, WORKER_POLL_MS: '100' })
    await waitFor(() => w.out.text.includes('started'), 15_000, 'worker start')
    w.c.kill('SIGINT')
    expect(await w.exited).toEqual({ code: 0, signal: null })
    expect(w.out.text).toContain('SIGINT')
  })

  it('refuses to start without DRAFTROOM_DATA_DIR', async () => {
    const env: Record<string, string> = { ...(process.env as Record<string, string>) }
    delete env.DRAFTROOM_DATA_DIR
    const c = spawn(process.execPath, [WORKER], { env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
    child = c
    let err = ''
    c.stderr.on('data', (b) => {
      err += String(b)
    })
    const code = await new Promise<number | null>((r) => c.on('exit', (x) => r(x)))
    expect(code).not.toBe(0)
    expect(err).toContain('DRAFTROOM_DATA_DIR is not set')
  })
})
