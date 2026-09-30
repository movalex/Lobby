// Bridge release R0, the cut-over's "take a manual checkpoint of every board" (docs/EXCALIDRAW-
// MIGRATION.md §7.5 step 4; runbook docs/DEPLOY.md "R0 at the cut-over and in a rollback"):
// POST /internal/checkpoints/run-all saves a manual, authorless checkpoint of every board of every
// workspace (any status), read from sync's snapshot route (which works in maintenance). It answers at
// once (202 and a run id); GET …/run-all/<runId> has the report once the run is done, and the runbook
// command (checkpoint-all-cli.ts) polls it. Repeating it saves nothing twice; boards made on the new
// canvas are skipped; a board sync cannot read fails the run's `ok`, not the other boards.
import { spawn } from 'node:child_process'
import type { AddressInfo } from 'node:net'
import { fileURLToPath } from 'node:url'
import type { LightMyRequestResponse } from 'fastify'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  CHECKPOINT_ALL_NAME,
  type CheckpointAllReport,
  type CheckpointAllRunView,
  checkpointAllRuns,
} from '../../../src/features/history/checkpoint-all.ts'
import { checkpointSettings } from '../../../src/features/history/checkpoints.ts'
import { checkpointServices } from '../../../src/features/history/index.ts'
import { SyncNewCanvasBoard, SyncUnavailable } from '../../../src/sync-internal.ts'
import {
  type Client,
  createBoard,
  createTestApi,
  DEV_STUDIO,
  INTERNAL_SECRET,
  type TestApi,
} from '../../helpers.ts'
import { baseRecords, createFakeSync, type FakeSync, noteRec } from './helpers.ts'

const CLI = fileURLToPath(new URL('../../../src/features/history/checkpoint-all-cli.ts', import.meta.url))

let api: TestApi
let sync: FakeSync
let alice: Client
let bob: Client
let pitch: string // bob's, Dev Studio
let retro: string // bob's, Dev Studio, in the trash
let plans: string // alice's, her personal workspace, archived
const refusedBySync = new Set<string>()
const failingInSync = new Set<string>()
const gate: { wait: Promise<void> | null } = { wait: null }
const saved = { ...checkpointSettings }

beforeEach(async () => {
  Object.assign(checkpointSettings, { tickMs: 0, pruneEveryMs: 0 })
  sync = createFakeSync()
  const snapshot = sync.snapshot
  sync.snapshot = async (id) => {
    if (gate.wait) await gate.wait
    if (refusedBySync.has(id)) throw new SyncNewCanvasBoard()
    if (failingInSync.has(id)) throw new SyncUnavailable('snapshot failed with 500', 500)
    return snapshot(id)
  }
  refusedBySync.clear()
  failingInSync.clear()
  gate.wait = null
  api = await createTestApi({ deps: { syncInternal: sync } })
  alice = await api.login('alice') // owns Dev Studio
  bob = await api.login('bob')
  pitch = await createBoard(bob, DEV_STUDIO, 'Pitch')
  retro = await createBoard(bob, DEV_STUDIO, 'Retro')
  plans = await createBoard(alice, alice.personalWorkspaceId, 'Plans')
  sync.setBoard(pitch, [...baseRecords(), noteRec('n1', 'hello')])
  sync.setBoard(retro, [...baseRecords(), noteRec('n2', 'went well')])
  sync.setBoard(plans, [...baseRecords(), noteRec('n3', 'q4')])
  await api.db.query("UPDATE boards SET status = 'trashed', trashed_at = now() WHERE id = $1", [retro])
  await api.db.query("UPDATE boards SET status = 'archived' WHERE id = $1", [plans])
})
afterEach(async () => {
  Object.assign(checkpointSettings, saved)
  await api.close()
})

/** Server to server: no Origin, no cookie, the internal secret. */
const internal = (
  method: 'GET' | 'POST',
  url: string,
  secret: string | null = INTERNAL_SECRET,
): Promise<LightMyRequestResponse> =>
  api.app.inject({ method, url, headers: secret === null ? {} : { 'x-draftroom-internal': secret } })

async function start(): Promise<CheckpointAllRunView> {
  const res = await internal('POST', '/internal/checkpoints/run-all')
  expect(res.statusCode, res.body).toBe(202)
  const view = res.json() as CheckpointAllRunView
  expect(res.headers.location).toBe(`/internal/checkpoints/run-all/${view.runId}`)
  expect(view).not.toHaveProperty('report')
  return view
}

async function finished(runId: string): Promise<CheckpointAllRunView> {
  for (let i = 0; i < 500; i++) {
    const res = await internal('GET', `/internal/checkpoints/run-all/${runId}`)
    expect(res.statusCode, res.body).toBe(200)
    const view = res.json() as CheckpointAllRunView
    if (view.status === 'done' || view.status === 'failed') return view
    await new Promise((r) => setTimeout(r, 10))
  }
  throw new Error('the run did not finish')
}

const runOnce = async () => (await finished((await start()).runId)).report as CheckpointAllReport

const rowsOf = (boardId: string) =>
  api.db.query<{ id: string; name: string; kind: string; reason: string | null; created_by: string | null }>(
    'SELECT id, name, kind, reason, created_by FROM board_snapshots WHERE board_id = $1 ORDER BY created_at, id',
    [boardId],
  )

describe('a manual checkpoint of every board', () => {
  it('saves one per board, any workspace and status: manual, no author, named, as sync has it', async () => {
    const report = await runOnce()
    expect(report).toMatchObject({
      ok: true,
      name: CHECKPOINT_ALL_NAME,
      saved: 3,
      unchanged: 0,
      skipped: 0,
      failed: 0,
    })
    expect(new Set(report.boards.map((b) => b.boardId))).toEqual(new Set([pitch, retro, plans]))
    for (const b of report.boards) {
      expect(b).toMatchObject({ ok: true, outcome: 'saved', documentClock: 42 })
      const rows = (await rowsOf(b.boardId)).rows
      expect(rows).toEqual([
        { id: b.snapshotId, name: CHECKPOINT_ALL_NAME, kind: 'manual', reason: null, created_by: null },
      ])
    }
    expect(report.boards.find((b) => b.boardId === plans)?.workspaceId).toBe(alice.personalWorkspaceId)
    // the History panel lists it with the board's own checkpoints; it previews like any v1 checkpoint
    const list = await bob.req('GET', `/api/boards/${pitch}/snapshots`)
    const [row] = (list.json() as { snapshots: Array<Record<string, unknown>> }).snapshots
    expect(row).toMatchObject({ name: CHECKPOINT_ALL_NAME, kind: 'manual', reason: null, createdBy: null })
    expect(row).not.toHaveProperty('newCanvas')
    const preview = await bob.req('GET', `/api/snapshots/${row?.id}/content`)
    expect(preview.statusCode, preview.body).toBe(200)
    expect((preview.json() as { records: Array<{ id: string }> }).records.map((r) => r.id)).toContain(
      'shape:n1',
    )
    // retention never removes a manual checkpoint
    await checkpointServices.get(api.app)?.pruneAll()
    expect((await rowsOf(pitch)).rows).toHaveLength(1)
  })

  it('repeating it saves nothing twice; a board changed since gets a new one', async () => {
    const first = await runOnce()
    const planned = sync.boards.get(plans)
    if (planned) planned.documentClock = 43
    sync.setBoard(pitch, [...baseRecords(), noteRec('n1', 'hello, edited')])
    const second = await runOnce()
    expect(second).toMatchObject({ ok: true, saved: 2, unchanged: 1 })
    const byBoard = (r: CheckpointAllReport) => new Map(r.boards.map((b) => [b.boardId, b]))
    expect(byBoard(second).get(retro)).toMatchObject({
      outcome: 'unchanged',
      snapshotId: byBoard(first).get(retro)?.snapshotId,
    })
    // a new clock is saved too, so that every report's clock is the board's (run-all's) clock
    expect(byBoard(second).get(plans)).toMatchObject({ outcome: 'saved', documentClock: 43 })
    expect(byBoard(second).get(pitch)?.outcome).toBe('saved')
    expect((await rowsOf(pitch)).rows).toHaveLength(2)
    expect((await rowsOf(retro)).rows).toHaveLength(1)
    // a person's own checkpoint with the same content and name is not the operator's: saved again
    const mine = await bob.req('POST', `/api/boards/${pitch}/snapshots`, { name: CHECKPOINT_ALL_NAME })
    expect(mine.statusCode, mine.body).toBe(201)
    const third = await runOnce()
    expect(byBoard(third).get(pitch)?.outcome).toBe('saved')
  })

  it('skips boards made on the new canvas; a board sync cannot read fails only itself', async () => {
    await api.db.query('UPDATE boards SET new_canvas = true WHERE id = $1', [plans])
    refusedBySync.add(retro) // sync's own 409 new-canvas
    failingInSync.add(pitch)
    const report = await runOnce()
    expect(report).toMatchObject({ ok: false, saved: 0, skipped: 2, failed: 1 })
    const byBoard = new Map(report.boards.map((b) => [b.boardId, b]))
    expect(byBoard.get(plans)).toMatchObject({
      ok: true,
      outcome: 'skipped',
      why: 'new-canvas',
      snapshotId: null,
    })
    expect(byBoard.get(retro)).toMatchObject({ ok: true, outcome: 'skipped', why: 'new-canvas' })
    expect(byBoard.get(pitch)).toMatchObject({
      ok: false,
      outcome: 'failed',
      error: 'Error: snapshot failed with 500',
    })
    expect(sync.snapshots).not.toContain(plans) // the row says so: sync is never asked
    for (const b of [pitch, retro, plans]) expect((await rowsOf(b)).rows).toEqual([])
  })
})

describe('the routes', () => {
  it('answers at once; a call during a run gets the next run; the list is newest first', async () => {
    let open!: () => void
    gate.wait = new Promise<void>((r) => {
      open = r
    })
    const first = await start()
    expect(first).toMatchObject({ status: 'running', boardsDone: 0 })
    const second = await start()
    const third = await start()
    expect(second.runId).not.toBe(first.runId)
    expect(third.runId).toBe(second.runId)
    expect(second.status).toBe('queued')
    const list = (await internal('GET', '/internal/checkpoints/run-all')).json() as {
      runs: CheckpointAllRunView[]
    }
    expect(list.runs.map((r) => [r.runId, r.status])).toEqual([
      [second.runId, 'queued'],
      [first.runId, 'running'],
    ])
    gate.wait = null
    open()
    const a = await finished(first.runId)
    const b = await finished(second.runId)
    expect(a.report?.saved).toBe(3)
    expect(b.report).toMatchObject({ ok: true, unchanged: 3 })
    expect(Date.parse(b.startedAt as string)).toBeGreaterThanOrEqual(Date.parse(a.finishedAt as string))
  })

  it('needs the internal secret; unknown runs are 404; the CSRF exemption is this route only', async () => {
    for (const secret of [null, 'wrong-secret-0123456789abcdefghijklmn']) {
      for (const [method, url] of [
        ['POST', '/internal/checkpoints/run-all'],
        ['GET', '/internal/checkpoints/run-all'],
        ['GET', '/internal/checkpoints/run-all/run_0123456789abcdef'],
      ] as const) {
        const res = await internal(method, url, secret)
        expect({ url, status: res.statusCode }).toEqual({ url, status: 401 })
      }
    }
    expect(checkpointAllRuns.get(api.app)?.list()).toEqual([]) // nothing started
    for (const id of ['run_0123456789abcdef', 'run_x']) {
      const res = await internal('GET', `/internal/checkpoints/run-all/${id}`)
      expect(res.statusCode).toBe(404)
      expect((res.json() as { error: { code: string } }).error.code).toBe('RUN_NOT_FOUND')
    }
    // other mutations still need the web Origin, the secret notwithstanding
    const other = await api.app.inject({
      method: 'POST',
      url: `/api/boards/${pitch}/snapshots`,
      headers: { 'x-draftroom-internal': INTERNAL_SECRET, cookie: bob.cookie },
      payload: { name: 'x' },
    })
    expect(other.statusCode).toBe(403)
    const cross = await api.app.inject({
      method: 'POST',
      url: '/internal/checkpoints/run-all',
      headers: { origin: 'https://evil.example', cookie: bob.cookie },
    })
    expect(cross.statusCode).toBe(401) // exempt from the Origin check, never from the secret
  })

  it('the runbook command (checkpoint-all-cli.ts) waits for the report and prints it', async () => {
    await api.app.listen({ host: '127.0.0.1', port: 0 })
    const url = `http://127.0.0.1:${(api.app.server.address() as AddressInfo).port}`
    failingInSync.add(retro)
    const bad = await cli(['--url', url, '--interval-ms', '20'])
    expect(bad.code, bad.stderr).toBe(1)
    expect((JSON.parse(bad.stdout) as CheckpointAllReport).failed).toBe(1)
    expect(bad.stderr).toContain(`FAIL ${retro}: Error: snapshot failed with 500`)
    failingInSync.clear()
    const good = await cli(['--url', url, '--interval-ms', '20'])
    expect(good.code, good.stderr).toBe(0)
    const report = JSON.parse(good.stdout) as CheckpointAllReport
    expect(report).toMatchObject({ ok: true, saved: 1, unchanged: 2, failed: 0 })
    expect(good.stderr).toContain('ok: 3 boards: 1 saved, 2 unchanged, 0 skipped, 0 failed')
    const runId = /checkpoints (run_[0-9a-f]{16}): /.exec(good.stderr)?.[1] as string
    const follow = await cli(['--url', url, '--run', runId])
    expect(follow.code, follow.stderr).toBe(0)
    expect(JSON.parse(follow.stdout)).toEqual(report)
    const gone = await cli(['--url', url, '--run', 'run_0123456789abcdef'])
    expect(gone.code).toBe(1)
    expect(gone.stderr).toContain('does not know this run')
    const noSecret = await cli(['--url', url], { DRAFTROOM_INTERNAL_SECRET: '' })
    expect(noSecret.code).toBe(2)
  })
})

function cli(
  args: string[],
  env: Record<string, string> = {},
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const { PORT: _port, ...rest } = process.env
  const child = spawn(process.execPath, [CLI, ...args], {
    env: { ...rest, DRAFTROOM_INTERNAL_SECRET: INTERNAL_SECRET, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stdout = ''
  let stderr = ''
  child.stdout.setEncoding('utf8').on('data', (d: string) => {
    stdout += d
  })
  child.stderr.setEncoding('utf8').on('data', (d: string) => {
    stderr += d
  })
  return new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('close', (code) => resolve({ code, stdout, stderr }))
  })
}
