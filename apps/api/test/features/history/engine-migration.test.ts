// The cut-over's restore point per converted board (docs/EXCALIDRAW-MIGRATION.md §5.5, migration 0022;
// the runbook's gap G5, step C12): POST /internal/checkpoints/engine-migration saves ONE automatic
// `engine_migration` checkpoint ("Moved to the new canvas", body_version 2) of every converted board,
// read from the Excalidraw sync's snapshot; a board born on the new canvas, one that had no file before
// the move (no conversion record) and one whose snapshot is still a tldraw body are skipped; a board that
// already has its restore point is unchanged, whatever it looks like now (a repeated run saves nothing);
// the run is refused (409 WRONG_CANVAS) while the api's sync is a tldraw one. checkpoint-all-cli.ts
// --engine-migration is the runbook command. Fails on 5caee00: the route is unknown (404) and the
// service has no captureEngineMigration.
import { spawn } from 'node:child_process'
import type { AddressInfo } from 'node:net'
import { fileURLToPath } from 'node:url'
import type { LightMyRequestResponse } from 'fastify'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  CHECKPOINT_ALL_NAME,
  type CheckpointAllReport,
  type CheckpointAllRunView,
  ENGINE_MIGRATION_ROUTE,
  engineMigrationRuns,
  WRONG_CANVAS_ERROR,
} from '../../../src/features/history/checkpoint-all.ts'
import { checkpointSettings } from '../../../src/features/history/checkpoints.ts'
import { checkpointServices } from '../../../src/features/history/index.ts'
import { type RoomSnapshotJson, SyncUnavailable } from '../../../src/sync-internal.ts'
import {
  type Client,
  createBoard,
  createTestApi,
  DEV_STUDIO,
  INTERNAL_SECRET,
  type TestApi,
} from '../../helpers.ts'
import { createFakeSync, type FakeSync } from './helpers.ts'

const CLI = fileURLToPath(new URL('../../../src/features/history/checkpoint-all-cli.ts', import.meta.url))
const NAME = 'Moved to the new canvas'

let api: TestApi
let sync: FakeSync & { engine?: () => Promise<'tldraw' | 'excalidraw'> }
let alice: Client
let bob: Client
let pitch: string // converted, bob's, Dev Studio
let retro: string // converted, bob's, in the trash
let fresh: string // born on the new canvas (new_canvas)
let blank: string // alice's, had no file before the move: an empty board with no conversion record
const v2 = new Map<string, RoomSnapshotJson>()
const failing = new Set<string>()
const saved = { ...checkpointSettings }

/** What the converter leaves in the board document (canvas-schema doc.ts ImportDocValue). */
const importRecord = {
  from: 'tldraw-5.4.2',
  converterVersion: '2',
  at: 1_700_000_000_000,
  legacyPages: {},
  legacyIds: {},
  lossy: {},
}

/** The Excalidraw sync's snapshot answer: `converted` boards carry the conversion record. */
const lobbyBoard = (clock: number, words: string, converted: boolean) =>
  ({
    format: 'lobby-elements',
    schema: 1,
    clock,
    elements: words ? [{ id: 'r1', type: 'rectangle', isDeleted: false, label: words }] : [],
    doc: converted ? { import: importRecord } : {},
  }) as unknown as RoomSnapshotJson

beforeEach(async () => {
  Object.assign(checkpointSettings, { tickMs: 0, pruneEveryMs: 0 })
  sync = createFakeSync()
  sync.engine = async () => 'excalidraw'
  const tldrawSnapshot = sync.snapshot
  sync.snapshot = async (id) => {
    if (failing.has(id)) throw new SyncUnavailable('snapshot failed with 500', 500)
    if (sync.boards.has(id)) return tldrawSnapshot(id) // a tldraw body (the fake's setBoard)
    sync.snapshots.push(id)
    return structuredClone(v2.get(id) ?? lobbyBoard(0, '', false))
  }
  v2.clear()
  failing.clear()
  api = await createTestApi({ deps: { syncInternal: sync } })
  alice = await api.login('alice') // owns Dev Studio
  bob = await api.login('bob')
  pitch = await createBoard(bob, DEV_STUDIO, 'Pitch')
  retro = await createBoard(bob, DEV_STUDIO, 'Retro')
  fresh = await createBoard(bob, DEV_STUDIO, 'Fresh')
  blank = await createBoard(alice, alice.personalWorkspaceId, 'Blank')
  // made before the move (R0's api wrote them): converted at the cut-over, or never had a file
  await api.db.query('UPDATE boards SET new_canvas = false WHERE id = ANY($1::text[])', [
    [pitch, retro, blank],
  ])
  await api.db.query("UPDATE boards SET status = 'trashed', trashed_at = now() WHERE id = $1", [retro])
  v2.set(pitch, lobbyBoard(7, 'hello', true))
  v2.set(retro, lobbyBoard(3, 'went well', true))
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
  app = api.app,
): Promise<LightMyRequestResponse> =>
  app.inject({ method, url, headers: secret === null ? {} : { 'x-draftroom-internal': secret } })

async function start(): Promise<CheckpointAllRunView> {
  const res = await internal('POST', ENGINE_MIGRATION_ROUTE)
  expect(res.statusCode, res.body).toBe(202)
  const view = res.json() as CheckpointAllRunView
  expect(res.headers.location).toBe(`${ENGINE_MIGRATION_ROUTE}/${view.runId}`)
  return view
}

async function finished(runId: string): Promise<CheckpointAllRunView> {
  for (let i = 0; i < 500; i++) {
    const res = await internal('GET', `${ENGINE_MIGRATION_ROUTE}/${runId}`)
    expect(res.statusCode, res.body).toBe(200)
    const view = res.json() as CheckpointAllRunView
    if (view.status === 'done' || view.status === 'failed') return view
    await new Promise((r) => setTimeout(r, 10))
  }
  throw new Error('the run did not finish')
}

const runOnce = async () => (await finished((await start()).runId)).report as CheckpointAllReport
const byBoard = (r: CheckpointAllReport) => new Map(r.boards.map((b) => [b.boardId, b]))

const rowsOf = (boardId: string) =>
  api.db.query<{
    id: string
    name: string
    kind: string
    reason: string | null
    created_by: string | null
    body_version: number
    document_clock: number
  }>(
    `SELECT id, name, kind, reason, created_by, body_version, document_clock::float8 AS document_clock
       FROM board_snapshots WHERE board_id = $1 ORDER BY created_at, id`,
    [boardId],
  )

describe('the restore point after the move', () => {
  it('saves one automatic engine_migration checkpoint per converted board, any status; skips the others', async () => {
    const report = await runOnce()
    expect(report).toMatchObject({ ok: true, name: NAME, saved: 2, unchanged: 0, skipped: 2, failed: 0 })
    expect(new Set(report.boards.map((b) => b.boardId))).toEqual(new Set([pitch, retro, fresh, blank]))
    const rows = byBoard(report)
    expect(rows.get(pitch)).toMatchObject({ ok: true, outcome: 'saved', documentClock: 7, recordCount: 1 })
    expect(rows.get(retro)).toMatchObject({ ok: true, outcome: 'saved', documentClock: 3 })
    // born on the new canvas: the row says so, sync is never asked
    expect(rows.get(fresh)).toMatchObject({
      ok: true,
      outcome: 'skipped',
      why: 'new-canvas',
      snapshotId: null,
    })
    expect(sync.snapshots).not.toContain(fresh)
    // made before the move but never edited (no file, so nothing was converted): no restore point
    expect(rows.get(blank)).toMatchObject({ ok: true, outcome: 'skipped', why: 'not-converted' })
    for (const id of [pitch, retro]) {
      const [row, ...more] = (await rowsOf(id)).rows
      expect(more).toEqual([])
      expect(row).toMatchObject({
        id: rows.get(id)?.snapshotId,
        name: NAME,
        kind: 'auto',
        reason: 'engine_migration',
        created_by: null,
      })
      expect(Number(row?.body_version)).toBe(2)
    }
    for (const id of [fresh, blank]) expect((await rowsOf(id)).rows).toEqual([])
    // the History panel lists it as this build's own (no R0 mark), and previews it as elements
    const list = await bob.req('GET', `/api/boards/${pitch}/snapshots`)
    const [listed] = (list.json() as { snapshots: Array<Record<string, unknown>> }).snapshots
    expect(listed).toMatchObject({ name: NAME, kind: 'auto', reason: 'engine_migration', createdBy: null })
    expect(listed).not.toHaveProperty('newCanvas')
    const preview = await bob.req('GET', `/api/snapshots/${listed?.id}/content`)
    expect(preview.statusCode, preview.body).toBe(200)
    expect(preview.json()).toMatchObject({ format: 'lobby-elements', elements: [{ id: 'r1' }] })
    // a safety checkpoint: retention keeps it
    await checkpointServices.get(api.app)?.pruneAll()
    expect((await rowsOf(pitch)).rows).toHaveLength(1)
  })

  it('is idempotent: a board keeps its one restore point, whatever it looks like now', async () => {
    // an equal manual checkpoint does not stand in for the restore point: the reason is what matters
    const mine = await bob.req('POST', `/api/boards/${pitch}/snapshots`, { name: 'Mine' })
    expect(mine.statusCode, mine.body).toBe(201)
    const first = await runOnce()
    expect(byBoard(first).get(pitch)?.outcome).toBe('saved')
    expect((await rowsOf(pitch)).rows.map((r) => r.reason)).toEqual([null, 'engine_migration'])
    // the board moves on, and the run is repeated (step C12 run twice, or after a roll-forward)
    v2.set(pitch, lobbyBoard(9, 'hello, edited', true))
    v2.set(retro, lobbyBoard(4, 'went well, edited', true))
    const asked = sync.snapshots.length
    const second = await runOnce()
    expect(second).toMatchObject({ ok: true, saved: 0, unchanged: 2, skipped: 2 })
    for (const id of [pitch, retro]) {
      expect(byBoard(second).get(id)).toMatchObject({
        outcome: 'unchanged',
        snapshotId: byBoard(first).get(id)?.snapshotId,
        documentClock: byBoard(first).get(id)?.documentClock,
      })
      expect((await rowsOf(id)).rows.filter((r) => r.reason === 'engine_migration')).toHaveLength(1)
    }
    // a board with its restore point is not read from sync again (only `blank` was asked once more)
    expect(sync.snapshots.length).toBe(asked + 1)
    // meanwhile an hourly checkpoint of the edited board still saves (a different reason, new content)
    const service = checkpointServices.get(api.app)
    expect((await service?.capture(pitch, 'hourly'))?.status).toBe('saved')
  })

  it('is refused while sync runs tldraw; a tldraw snapshot is skipped; a board sync cannot read fails itself', async () => {
    // R0's sync (no GET /internal/canvas): nothing starts, the operator is told why
    const r0 = await createTestApi({ deps: { syncInternal: createFakeSync() } })
    try {
      const refused = await internal('POST', ENGINE_MIGRATION_ROUTE, INTERNAL_SECRET, r0.app)
      expect(refused.statusCode, refused.body).toBe(409)
      expect((refused.json() as { error: { code: string; message: string } }).error).toMatchObject({
        code: WRONG_CANVAS_ERROR,
        message: expect.stringContaining('tldraw canvas'),
      })
      expect(engineMigrationRuns.get(r0.app)?.list()).toEqual([])
    } finally {
      await r0.close()
    }
    // on the Excalidraw build: one board still answers a tldraw body, one cannot be read
    sync.setBoard(retro, [])
    failing.add(pitch)
    const report = await runOnce()
    expect(report).toMatchObject({ ok: false, saved: 0, unchanged: 0, skipped: 3, failed: 1 })
    expect(byBoard(report).get(retro)).toMatchObject({ ok: true, outcome: 'skipped', why: 'tldraw' })
    expect(byBoard(report).get(pitch)).toMatchObject({
      ok: false,
      outcome: 'failed',
      error: 'Error: snapshot failed with 500',
    })
    for (const b of [pitch, retro, fresh, blank]) expect((await rowsOf(b)).rows).toEqual([])
  })
})

describe('the routes and the runbook command', () => {
  it('needs the internal secret, is exempt from the Origin check, 404 on unknown runs; run-all is unchanged', async () => {
    for (const secret of [null, 'wrong-secret-0123456789abcdefghijklmn']) {
      for (const [method, url] of [
        ['POST', ENGINE_MIGRATION_ROUTE],
        ['GET', ENGINE_MIGRATION_ROUTE],
        ['GET', `${ENGINE_MIGRATION_ROUTE}/run_0123456789abcdef`],
      ] as const) {
        const res = await internal(method, url, secret)
        expect({ url, status: res.statusCode }).toEqual({ url, status: 401 })
      }
    }
    expect(engineMigrationRuns.get(api.app)?.list()).toEqual([])
    const cross = await api.app.inject({
      method: 'POST',
      url: ENGINE_MIGRATION_ROUTE,
      headers: { origin: 'https://evil.example', cookie: bob.cookie },
    })
    expect(cross.statusCode).toBe(401) // exempt from the Origin check, never from the secret
    const gone = await internal('GET', `${ENGINE_MIGRATION_ROUTE}/run_0123456789abcdef`)
    expect(gone.statusCode).toBe(404)
    expect((gone.json() as { error: { code: string } }).error.code).toBe('RUN_NOT_FOUND')
    // the two runs are separate: a run-all run is listed under its own route only, with its own name
    const all = await internal('POST', '/internal/checkpoints/run-all')
    expect(all.statusCode, all.body).toBe(202)
    const allRun = all.json() as CheckpointAllRunView
    for (let i = 0; i < 500; i++) {
      const res = await internal('GET', `/internal/checkpoints/run-all/${allRun.runId}`)
      const view = res.json() as CheckpointAllRunView
      if (view.status === 'done') {
        expect(view.report?.name).toBe(CHECKPOINT_ALL_NAME)
        break
      }
      await new Promise((r) => setTimeout(r, 10))
    }
    expect((await internal('GET', `${ENGINE_MIGRATION_ROUTE}/${allRun.runId}`)).statusCode).toBe(404)
    expect(((await internal('GET', ENGINE_MIGRATION_ROUTE)).json() as { runs: unknown[] }).runs).toEqual([])
  })

  it('checkpoint-all-cli.ts --engine-migration waits for the report and prints it', async () => {
    await api.app.listen({ host: '127.0.0.1', port: 0 })
    const url = `http://127.0.0.1:${(api.app.server.address() as AddressInfo).port}`
    const good = await cli(['--url', url, '--interval-ms', '20', '--engine-migration'])
    expect(good.code, good.stderr).toBe(0)
    const report = JSON.parse(good.stdout) as CheckpointAllReport
    expect(report).toMatchObject({ ok: true, name: NAME, saved: 2, unchanged: 0, skipped: 2, failed: 0 })
    expect(good.stderr).toContain(`ok: 4 boards: 2 saved, 0 unchanged, 2 skipped, 0 failed ("${NAME}")`)
    expect(good.stderr).toContain(`skipped ${fresh}: new-canvas`)
    expect(good.stderr).toContain(`skipped ${blank}: not-converted`)
    const runId = /checkpoints (run_[0-9a-f]{16}): /.exec(good.stderr)?.[1] as string
    const follow = await cli(['--url', url, '--run', runId, '--engine-migration'])
    expect(follow.code, follow.stderr).toBe(0)
    expect(JSON.parse(follow.stdout)).toEqual(report)
    const again = await cli(['--url', url, '--interval-ms', '20', '--engine-migration'])
    expect(again.code, again.stderr).toBe(0)
    expect(JSON.parse(again.stdout) as CheckpointAllReport).toMatchObject({
      saved: 0,
      unchanged: 2,
      skipped: 2,
    })
    const bad = await cli(['--url', url, '--engine-migration=yes'])
    expect(bad.code).toBe(2)
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
