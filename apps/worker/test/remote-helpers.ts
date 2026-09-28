// Harness for the remote worker: an in-process worker (the real loop, client and processors) pointed at
// a fake API, with its own temporary directory so every test can assert that nothing is left behind.
import { mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createWorkerApi } from '../src/api-client.ts'
import type { RemoteOutcome } from '../src/remote-job.ts'
import { type RemoteWorkerHandle, type RemoteWorkerOptions, startRemoteWorker } from '../src/remote-loop.ts'
import type { FakeApi } from './fake-api.ts'

export const WORKER_ID = 'test-worker-1'

const roots: string[] = []

/** A short temp root (os.tmpdir(), not a deep scratch path): Windows MAX_PATH bit Skia in research. */
export function tmpRoot(): string {
  const r = mkdtempSync(join(tmpdir(), 'drwt-'))
  roots.push(r)
  return r
}

export function cleanupRoots() {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true, maxRetries: 5 })
}

export interface TestWorker {
  handle: RemoteWorkerHandle
  logs: string[]
  /** Last outcome per version. */
  outcomes: Map<string, RemoteOutcome>
  /** Every outcome in order (a retried job appears once per attempt). */
  history: { versionId: string; outcome: RemoteOutcome }[]
  tmpDir: string
}

export function runWorker(
  fake: FakeApi,
  o: Partial<Omit<RemoteWorkerOptions, 'api'>> & { token?: string; apiUrl?: string; workerId?: string } = {},
): TestWorker {
  const logs: string[] = []
  const outcomes = new Map<string, RemoteOutcome>()
  const history: TestWorker['history'] = []
  const tmpDir = o.tmpDir ?? tmpRoot()
  const api = createWorkerApi({
    baseUrl: o.apiUrl ?? fake.api,
    token: o.token ?? fake.token,
    workerId: o.workerId ?? WORKER_ID,
    requestTimeoutMs: 5_000,
  })
  const handle = startRemoteWorker({
    pollMs: 20,
    pollMaxMs: 100,
    ...o,
    tmpDir,
    api,
    log: (s) => logs.push(s),
    onOutcome: (v, out) => {
      outcomes.set(v, out)
      history.push({ versionId: v, outcome: out })
      o.onOutcome?.(v, out)
    },
  })
  return { handle, logs, outcomes, history, tmpDir }
}

export async function waitFor(cond: () => boolean, timeoutMs: number, what: string, stepMs = 25) {
  const deadline = Date.now() + timeoutMs
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await new Promise((r) => setTimeout(r, stepMs))
  }
}

/** Depth-first search for a file name under `root` (e.g. the hang child's child.pid). */
export function findFile(root: string, name: string): string | null {
  let entries: string[]
  try {
    entries = readdirSync(root)
  } catch {
    return null
  }
  for (const e of entries) {
    const p = join(root, e)
    if (e === name) return p
    try {
      if (statSync(p).isDirectory()) {
        const hit = findFile(p, name)
        if (hit) return hit
      }
    } catch {}
  }
  return null
}

export const alive = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}
