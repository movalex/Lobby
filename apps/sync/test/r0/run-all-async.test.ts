// Bridge release R0 (docs/EXCALIDRAW-MIGRATION.md §7.5 step 4; verifier, run-all timeout): the report of
// POST /internal/backups/run-all used to arrive only when the run ended, in the answer to the one POST.
// Node's fetch gives up after 300 s without response headers, so on a data dir whose run takes longer the
// runbook command lost the answer, and a retry could never get it back (every call gets a run started
// after it). The route now answers at once (202 and the run's id), the run goes on in the server, and
// GET /internal/backups/run-all/<runId> has its progress and, once done, the report; the runbook command
// (backup/run-all-cli.ts) polls it with short requests.
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { draftroomSchema } from '@draftroom/canvas-schema'
import { afterEach, describe, expect, it } from 'vitest'
import type { AccessMonitor } from '../../src/access.ts'
import type { BackupEntry } from '../../src/backup/backup.ts'
import { offsiteOffStatus } from '../../src/backup/offsite.ts'
import {
  createRunAll,
  RUN_ALL_ID_RE,
  RUN_ALL_KEEP_RUNS,
  type RunAllRunView,
} from '../../src/backup/run-all.ts'
import { createRequestHandler } from '../../src/http/router.ts'
import type { RoomRegistry } from '../../src/rooms.ts'
import { callInternal, TEST_INTERNAL_SECRET } from '../harness/tickets.ts'
import { runCli } from './run-all-http.ts'

const tick = () => new Promise((r) => setTimeout(r, 0))

/** A run-all whose backups wait for `release()`; boards b-one and b-two. */
function gated(opts: { boards?: () => string[] } = {}) {
  const gates: Array<() => void> = []
  let seq = 0
  let maintenance = false
  const runAll = createRunAll({
    registry: {
      boardFileIds: opts.boards ?? (() => ['b-one', 'b-two']),
      async backupFresh(boardId, o) {
        await new Promise<void>((r) => gates.push(r))
        const entry: BackupEntry = {
          file: `2026-10-05T12-00-00-000Z-c${++seq}.sqlite`,
          boardId,
          createdAt: new Date().toISOString(),
          documentClock: seq,
          schema: {},
          recordCount: 1,
          recordsSha256: 'a'.repeat(64),
          sha256: 'b'.repeat(64),
          sizeBytes: 1,
          ...(o?.holdUntil ? { holdUntil: o.holdUntil.toISOString() } : {}),
        }
        return entry
      },
    },
    backups: { status: offsiteOffStatus, copyOffsite: async () => null },
    maintenance: () => maintenance,
  })
  return {
    runAll,
    /** Lets the next waiting backup through (after a tick, so it has started). */
    async release(n = 1) {
      for (let i = 0; i < n; i++) {
        while (!gates.length) await tick()
        gates.shift()?.()
        await tick()
      }
    },
    setMaintenance(on: boolean) {
      maintenance = on
    },
  }
}

describe('run-all runs: answered at once, read by id', () => {
  it('request() answers at once; get() shows the progress, then the report', async () => {
    const g = gated()
    const first = g.runAll.request()
    expect(first).toMatchObject({
      status: 'running',
      boardsDone: 0,
      boardsTotal: 2,
      startedAt: expect.any(String),
    })
    expect(first.runId).toMatch(RUN_ALL_ID_RE)
    expect(first).not.toHaveProperty('report')
    await g.release()
    expect(g.runAll.get(first.runId)).toMatchObject({ status: 'running', boardsDone: 1, boardsTotal: 2 })
    await g.release()
    await tick()
    const done = g.runAll.get(first.runId) as RunAllRunView
    expect(done).toMatchObject({ status: 'done', boardsDone: 2, ok: true, inMaintenance: false })
    expect(done.report?.boards.map((b) => [b.boardId, b.ok])).toEqual([
      ['b-one', true],
      ['b-two', true],
    ])
    expect(done.finishedAt).toBe(done.report?.finishedAt)
    expect(g.runAll.get('run_0000000000000000')).toBeNull()
  })

  it('a call during a run gets the next run (queued), shared by every call meanwhile; the list is newest first', async () => {
    const g = gated()
    const first = g.runAll.request()
    await tick()
    g.setMaintenance(true)
    const second = g.runAll.request()
    const third = g.runAll.request()
    const viaRun = g.runAll.run() // the promise API gets the same run
    expect(second.runId).not.toBe(first.runId)
    expect(third.runId).toBe(second.runId)
    expect(second).toMatchObject({ status: 'queued', startedAt: null, boardsTotal: null })
    expect(g.runAll.list().map((r) => [r.runId, r.status])).toEqual([
      [second.runId, 'queued'],
      [first.runId, 'running'],
    ])
    await g.release(4)
    const report = await viaRun
    const a = g.runAll.get(first.runId) as RunAllRunView
    const b = g.runAll.get(second.runId) as RunAllRunView
    expect(b.report).toEqual(report)
    expect(Date.parse(b.startedAt as string)).toBeGreaterThanOrEqual(Date.parse(a.finishedAt as string))
    expect([a.inMaintenance, b.inMaintenance]).toEqual([false, true])
    // the list carries no reports
    expect(g.runAll.list().every((r) => !('report' in r))).toBe(true)
    expect(g.runAll.running()).toBe(false)
  })

  it('a run that stops before its report ends failed, with the reason', async () => {
    const g = gated({
      boards: () => {
        throw new Error('EACCES reading the data dir')
      },
    })
    const run = g.runAll.request()
    await tick()
    expect(g.runAll.get(run.runId)).toMatchObject({
      status: 'failed',
      error: 'the run stopped (Error: EACCES reading the data dir)',
      finishedAt: expect.any(String),
    })
    expect(g.runAll.running()).toBe(false)
  })

  it('stop() (shutdown) ends the run after its current board and never starts the queued one', async () => {
    const g = gated()
    const first = g.runAll.request()
    await tick()
    const queued = g.runAll.request()
    const stopped = g.runAll.stop()
    await g.release() // the board in progress finishes
    await stopped
    expect(g.runAll.get(first.runId)).toMatchObject({
      status: 'failed',
      boardsDone: 1,
      error: 'the run stopped (Error: the sync server shut down after 1 boards)',
    })
    expect(g.runAll.get(queued.runId)).toMatchObject({ status: 'failed', startedAt: null })
    expect(g.runAll.running()).toBe(false)
  })

  it(`keeps the newest ${RUN_ALL_KEEP_RUNS} finished runs`, async () => {
    const g = gated({ boards: () => [] })
    const ids: string[] = []
    for (let i = 0; i < RUN_ALL_KEEP_RUNS + 3; i++) {
      ids.push(g.runAll.request().runId)
      await tick()
    }
    expect(g.runAll.list()).toHaveLength(RUN_ALL_KEEP_RUNS)
    expect(g.runAll.get(ids[0] as string)).toBeNull()
    expect(g.runAll.get(ids.at(-1) as string)?.status).toBe('done')
  })
})

describe('over HTTP, with a run longer than the client waits', () => {
  let server: Server | null = null
  afterEach(async () => {
    const s = server
    server = null
    if (s) await new Promise<void>((r) => s.close(() => r()))
  })

  async function serve(runAll: ReturnType<typeof gated>['runAll'], backupsDir: string | null = '/backups') {
    const handle = createRequestHandler({
      internalSecret: TEST_INTERNAL_SECRET,
      registry: { backupsDir: () => backupsDir } as unknown as RoomRegistry,
      schema: draftroomSchema,
      monitor: {} as unknown as AccessMonitor,
      isClosing: () => false,
      log: () => {},
      runAll,
    })
    const s = createServer((req, res) => void handle(req, res))
    server = s
    await new Promise<void>((r) => s.listen(0, '127.0.0.1', () => r()))
    return `http://127.0.0.1:${(s.address() as AddressInfo).port}`
  }

  it('the POST answers 202 before the run ends; the runbook command waits for the report', async () => {
    const g = gated()
    const url = await serve(g.runAll)
    // A client that gives up after 300 ms (Node's fetch: 300 s) still gets the answer: the run's id.
    const res = await fetch(`${url}/internal/backups/run-all`, {
      method: 'POST',
      headers: { 'x-draftroom-internal': TEST_INTERNAL_SECRET },
      signal: AbortSignal.timeout(300),
    })
    expect(res.status).toBe(202)
    const started = (await res.json()) as RunAllRunView
    expect(res.headers.get('location')).toBe(`/internal/backups/run-all/${started.runId}`)
    expect(started).toMatchObject({ status: 'running', boardsDone: 0, boardsTotal: 2 })

    // the CLI follows the run past the client's 300 ms, while the backups take 600 ms
    const cli = runCli(['--url', url, '--run', started.runId, '--interval-ms', '20'])
    await new Promise((r) => setTimeout(r, 600))
    const mid = (await (
      await callInternal(url, 'GET', `/internal/backups/run-all/${started.runId}`)
    ).json()) as RunAllRunView
    expect(mid).toMatchObject({ status: 'running', boardsDone: 0 })
    await g.release(2)
    const out = await cli
    expect(out.code, out.stderr).toBe(0)
    expect(JSON.parse(out.stdout)).toMatchObject({
      ok: true,
      boards: [{ boardId: 'b-one' }, { boardId: 'b-two' }],
    })
    expect(out.stderr).toContain(`run-all ${started.runId}: running: 0 of 2 boards`)
    expect(out.stderr).toContain('ok: 2 of 2 boards backed up; offsite off')
  })

  it('unknown and malformed run ids are 404 RUN_NOT_FOUND; local backups off is 409 before any run', async () => {
    const g = gated()
    const url = await serve(g.runAll)
    for (const id of ['run_0123456789abcdef', 'run_x', '..%2Fstatus']) {
      const res = await callInternal(url, 'GET', `/internal/backups/run-all/${id}`)
      expect(res.status).toBe(404)
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe('RUN_NOT_FOUND')
    }
    await new Promise<void>((r) => (server as Server).close(() => r()))
    server = null
    const off = await serve(g.runAll, null)
    const res = await callInternal(off, 'POST', '/internal/backups/run-all')
    expect(res.status).toBe(409)
    expect(g.runAll.list()).toEqual([])
  })

  it('the CLI: no secret is exit 2; a refused POST and a run the server does not know are exit 1', async () => {
    const g = gated()
    const url = await serve(g.runAll)
    const noSecret = await runCli(['--url', url], { DRAFTROOM_INTERNAL_SECRET: '' })
    expect(noSecret.code).toBe(2)
    expect(noSecret.stderr).toContain('DRAFTROOM_INTERNAL_SECRET is not set')
    const wrong = await runCli(['--url', url], {
      DRAFTROOM_INTERNAL_SECRET: 'not-the-secret-0123456789abcdefgh',
    })
    expect(wrong.code).toBe(1)
    expect(wrong.stderr).toContain('refused (HTTP 401')
    const unknown = await runCli(['--url', url, '--run', 'run_0123456789abcdef'])
    expect(unknown.code).toBe(1)
    expect(unknown.stderr).toContain('does not know this run')
    const bad = await runCli(['--url', url, '--run', 'nope'])
    expect(bad.code).toBe(2)
    expect(g.runAll.list()).toEqual([])
  })
})
