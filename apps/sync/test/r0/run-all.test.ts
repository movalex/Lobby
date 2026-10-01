// Bridge release R0 gate (docs/EXCALIDRAW-MIGRATION.md §5.10, §7.5 step 4): POST
// /internal/backups/run-all writes a fresh local and offsite backup of EVERY board file (open or not,
// changed or not, tldraw, converted or born on the new canvas) and returns, per board, the object key
// and the recordsSha256 the runbook stores. Its digests equal the board files' own; the files it read
// are unchanged (no room is opened for a board that is not open). The POST answers at once (202 and the
// run's id); the report is read by id once the run is done, as the runbook command does (run-all-cli.ts).
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createFsBlobStore } from '@draftroom/blob-store'
import type { TLRecord } from '@tldraw/tlschema'
import { describe, expect, it } from 'vitest'
import { inspectBoardDb, readManifest, sha256File } from '../../src/backup/backup.ts'
import { offsiteOffStatus } from '../../src/backup/offsite.ts'
import { offsiteKeys } from '../../src/backup/offsite-manifest.ts'
import type { RunAllReport } from '../../src/backup/run-all.ts'
import { createRunAll, findRecentHeldSet, RecentHeldSetError } from '../../src/backup/run-all.ts'
import { boardDbPath } from '../../src/rooms.ts'
import { useProtocolHarness } from '../harness/fixture.ts'
import { geoShape, noteShape } from '../harness/records.ts'
import { callInternal } from '../harness/tickets.ts'
import { runAllOverHttp, runCli, startRunAll, waitForRun } from './run-all-http.ts'
import {
  fileSha256,
  lbState,
  makeBornAfterFile,
  markConverted,
  seedTldrawBoard,
  tablesOf,
} from './support.ts'

const OPEN = 'b-runall-open'
const CLOSED = 'b-runall-closed'
const CONVERTED = 'b-runall-conv'
const BORN = 'b-runall-born'

describe('POST /internal/backups/run-all in the real sync process', () => {
  const h = useProtocolHarness()

  it('backs up every board locally and offsite, with digests equal to the files', async () => {
    const dataDir = h.dataDir()
    const rooms = join(dataDir, 'rooms')
    seedTldrawBoard(rooms, OPEN)
    const closed = seedTldrawBoard(rooms, CLOSED, [noteShape('n1', 'x') as unknown as TLRecord])
    const conv = seedTldrawBoard(rooms, CONVERTED, [geoShape('g1') as unknown as TLRecord])
    markConverted(conv)
    const born = boardDbPath(rooms, BORN)
    makeBornAfterFile(born)
    const untouched = {
      [CLOSED]: fileSha256(closed),
      [CONVERTED]: fileSha256(conv),
      [BORN]: fileSha256(born),
    }
    const convLb = lbState(conv)
    const server = await h.server({ dataDir, env: { DRAFTROOM_BACKUP_STORE: 'fs' } })
    const a = await h.connected(server, { boardId: OPEN, user: 'usr_alice' })
    a.put(geoShape('live1'))
    await a.waitForAcked()

    // Both answered at once (202); the reports are read by run id once the runs are done.
    const [first, second] = await Promise.all([startRunAll(server.url), startRunAll(server.url)])
    const report = (await waitForRun(server.url, first.runId)).report as RunAllReport
    // a second call while one runs waits for it and gets a run of its own, started after it
    // (run-all-fresh.test.ts): never a report older than the call
    expect(second.runId).not.toBe(first.runId)
    const later = (await waitForRun(server.url, second.runId)).report as RunAllReport
    expect(later.ok).toBe(true)
    expect(Date.parse(later.startedAt)).toBeGreaterThanOrEqual(Date.parse(report.finishedAt))
    expect(later.boards.map((b) => b.boardId)).toEqual(report.boards.map((b) => b.boardId))
    expect(report.ok).toBe(true)
    expect(report.inMaintenance).toBe(false)
    expect(report.offsite).toBe('fs')
    expect(report.boards.map((b) => b.boardId)).toEqual([BORN, CLOSED, CONVERTED, OPEN].sort())
    a.dispose()
    await server.kill('SIGINT')

    const store = createFsBlobStore(join(dataDir, 'blobs'))
    for (const row of report.boards) {
      const live = boardDbPath(rooms, row.boardId)
      const entry = readManifest(join(dataDir, 'backups'), row.boardId)?.backups.find(
        (b) => b.file === row.file,
      )
      expect(entry?.file).toBe(row.file)
      // held 90 days outside retention (final-backup-hold.test.ts)
      expect(entry?.holdUntil).toBe(row.holdUntil)
      expect(Date.parse(row.holdUntil as string) - Date.parse(report.startedAt)).toBe(90 * 86_400_000)
      const copy = join(dataDir, 'backups', row.boardId, row.file as string)
      expect(row.ok).toBe(true)
      // the digests the runbook stores are the board file's own and the backup file's own
      expect(row.recordsSha256).toBe(inspectBoardDb(live).recordsSha256)
      expect(row.recordsSha256).toBe(inspectBoardDb(copy).recordsSha256)
      expect(row.documentClock).toBe(inspectBoardDb(live).documentClock)
      expect(row.sha256).toBe(await sha256File(copy))
      expect(row.offsiteKey).toBe(offsiteKeys.file('backups/sync', row.boardId, row.file as string))
      const obj = await store.get(row.offsiteKey as string)
      expect(obj).not.toBeNull()
      ;(obj?.body as { destroy?: () => void } | undefined)?.destroy?.()
    }
    const bornRow = report.boards.find((b) => b.boardId === BORN)
    expect(bornRow?.format).toBe('lobby-elements')
    expect(report.boards.filter((b) => b.format).map((b) => b.boardId)).toEqual([BORN])
    // the open board's backup holds the edit made just before
    expect(
      inspectBoardDb(
        join(dataDir, 'backups', OPEN, report.boards.find((b) => b.boardId === OPEN)?.file as string),
      ).recordCount,
    ).toBe(3)
    // files that were not open were read, never written
    expect(fileSha256(closed)).toBe(untouched[CLOSED])
    expect(fileSha256(conv)).toBe(untouched[CONVERTED])
    expect(fileSha256(born)).toBe(untouched[BORN])
    expect(lbState(conv)).toEqual(convLb)
    expect(tablesOf(born).some((t) => t === 'documents' || t === 'metadata')).toBe(false)
  })

  it('with offsite backups off: every board backed up locally, no object keys, ok', async () => {
    const dataDir = h.dataDir()
    const rooms = join(dataDir, 'rooms')
    seedTldrawBoard(rooms, CLOSED)
    makeBornAfterFile(boardDbPath(rooms, BORN))
    const server = await h.server({ dataDir })
    const report = await runAllOverHttp(server.url)
    expect(report).toMatchObject({ ok: true, offsite: 'off' })
    expect(report.boards.map((b) => [b.boardId, b.ok, b.offsiteKey, typeof b.file])).toEqual([
      [BORN, true, null, 'string'],
      [CLOSED, true, null, 'string'],
    ])
  })

  it('the runbook command (run-all-cli.ts) waits for the report and prints it; the run stays readable', async () => {
    const dataDir = h.dataDir()
    const rooms = join(dataDir, 'rooms')
    const closed = seedTldrawBoard(rooms, CLOSED, [noteShape('n1', 'x') as unknown as TLRecord])
    const server = await h.server({ dataDir, env: { DRAFTROOM_BACKUP_STORE: 'fs' } })
    await callInternal(server.url, 'POST', '/internal/maintenance', { body: { on: true } })

    const cli = await runCli(['--url', server.url, '--interval-ms', '20', '--expect-maintenance'])
    expect(cli.code, cli.stderr).toBe(0)
    const report = JSON.parse(cli.stdout) as RunAllReport
    expect(report).toMatchObject({ ok: true, offsite: 'fs', inMaintenance: true })
    expect(report.boards.map((b) => [b.boardId, b.ok])).toEqual([[CLOSED, true]])
    expect(report.boards[0]?.recordsSha256).toBe(inspectBoardDb(closed).recordsSha256)
    const runId = /run-all (run_[0-9a-f]{16}): /.exec(cli.stderr)?.[1] as string
    expect(cli.stderr).toContain(`--run ${runId}`)
    expect(cli.stderr).toContain('ok: 1 of 1 boards backed up; offsite fs; maintenance on from start to end')

    // the same report stays readable by id, and in the list, until the process ends
    const again = await waitForRun(server.url, runId)
    expect(again.report).toEqual(report)
    const listed = (await (await callInternal(server.url, 'GET', '/internal/backups/run-all')).json()) as {
      runs: Array<Record<string, unknown>>
    }
    expect(listed.runs.map((r) => [r.runId, r.status, r.ok, r.inMaintenance, 'report' in r])).toEqual([
      [runId, 'done', true, true, false],
    ])
    // following it again prints the same report
    const follow = await runCli(['--url', server.url, '--run', runId, '--expect-maintenance'])
    expect(follow.code, follow.stderr).toBe(0)
    expect(JSON.parse(follow.stdout)).toEqual(report)

    // outside maintenance, --expect-maintenance fails (the report is still printed); --force, because the
    // run above left a held set of every board less than 30 minutes old (audit L6, the test below)
    await callInternal(server.url, 'POST', '/internal/maintenance', { body: { on: false } })
    const outside = await runCli([
      '--url',
      server.url,
      '--interval-ms',
      '20',
      '--expect-maintenance',
      '--force',
    ])
    expect(outside.code).toBe(1)
    expect((JSON.parse(outside.stdout) as RunAllReport).inMaintenance).toBe(false)
    expect(outside.stderr).toContain('this is not the final backup set')

    // after a restart the runs are gone (and maintenance is off): the CLI says so and fails
    await server.kill('SIGINT')
    await server.restart()
    const gone = await runCli(['--url', server.url, '--run', runId])
    expect(gone.code).toBe(1)
    expect(gone.stderr).toContain('does not know this run')
  })

  // Security audit L6 (wave 4b): every run adds a 90-day copy of every board to the rooms' own disk, so a
  // run while a recent held set exists is refused unless forced. On 747d41d the second POST started a run.
  it('refuses a new run while a held set of every board from the last 30 minutes exists, unless forced', async () => {
    const dataDir = h.dataDir()
    const rooms = join(dataDir, 'rooms')
    seedTldrawBoard(rooms, CLOSED, [noteShape('n1', 'x') as unknown as TLRecord])
    const server = await h.server({ dataDir })
    const first = await runAllOverHttp(server.url)
    expect(first.ok).toBe(true)
    const heldAt = first.boards[0]?.holdUntil

    // the set is on the disk, so a restart forgets nothing: the refusal survives it
    await server.kill('SIGINT')
    await server.restart()
    const refused = await callInternal(server.url, 'POST', '/internal/backups/run-all')
    expect(refused.status).toBe(409)
    const body = (await refused.json()) as { error: { code: string; message: string } }
    expect(body.error.code).toBe('RECENT_HELD_SET')
    expect(body.error.message).toContain('a held backup set of every board (1 boards) was made at')
    expect(body.error.message).toContain('{"force": true}')
    expect(heldAt).toBeDefined()
    // a malformed body never starts a run
    for (const bad of [{ force: 'yes' }, { other: true }, [true]]) {
      const res = await callInternal(server.url, 'POST', '/internal/backups/run-all', { body: bad })
      expect(res.status).toBe(400)
    }
    const listed = (await (await callInternal(server.url, 'GET', '/internal/backups/run-all')).json()) as {
      runs: unknown[]
    }
    expect(listed.runs).toEqual([])
    // the runbook command says why and exits 1; with --force it writes another set
    const cli = await runCli(['--url', server.url, '--interval-ms', '20'])
    expect(cli.code).toBe(1)
    expect(cli.stderr).toContain('refused (HTTP 409, RECENT_HELD_SET: a held backup set of every board')
    const forcedCli = await runCli(['--url', server.url, '--interval-ms', '20', '--force'])
    expect(forcedCli.code, forcedCli.stderr).toBe(0)
    expect((JSON.parse(forcedCli.stdout) as RunAllReport).ok).toBe(true)
    const forced = await callInternal(server.url, 'POST', '/internal/backups/run-all', {
      body: { force: true },
    })
    expect(forced.status).toBe(202)
    const forcedRun = await waitForRun(server.url, ((await forced.json()) as { runId: string }).runId)
    expect(forcedRun.status).toBe('done')
    expect(readManifest(join(dataDir, 'backups'), CLOSED)?.backups).toHaveLength(3)

    // a board file the set does not cover (a new board): the set is not complete, so a run is wanted
    seedTldrawBoard(rooms, OPEN, [noteShape('n2', 'y') as unknown as TLRecord])
    const partial = await runAllOverHttp(server.url)
    expect(partial.boards.map((b) => b.boardId)).toEqual([CLOSED, OPEN].sort())
    expect((await callInternal(server.url, 'POST', '/internal/backups/run-all')).status).toBe(409)
    // --force does not go with --run (following a run never writes one)
    expect((await runCli(['--url', server.url, '--run', 'run_0123456789abcdef', '--force'])).code).toBe(2)
  })
})

describe('findRecentHeldSet', () => {
  const now = new Date('2026-10-05T12:00:00.000Z')
  const entry = (file: string, createdAt: string, holdUntil?: string) => ({
    file,
    boardId: 'x',
    createdAt,
    documentClock: 1,
    schema: {},
    recordCount: 1,
    recordsSha256: 'a'.repeat(64),
    sha256: 'b'.repeat(64),
    sizeBytes: 1,
    ...(holdUntil ? { holdUntil } : {}),
  })
  const manifest = (dir: string, boardId: string, backups: unknown[]) => {
    mkdirSync(join(dir, boardId), { recursive: true })
    writeFileSync(
      join(dir, boardId, 'manifest.json'),
      JSON.stringify({ format: 'draftroom-board-backups', version: 1, boardId, backups }),
    )
  }
  const held = '2027-01-03T12:00:00.000Z'

  it('is the newest time of a held entry per board when every board has one from the window', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dr-heldset-'))
    try {
      manifest(dir, 'b-a', [
        entry('2026-10-05T11-50-00-000Z-c1.sqlite', '2026-10-05T11:50:00.000Z', held),
        entry('2026-10-05T11-55-00-000Z-c2.sqlite', '2026-10-05T11:55:00.000Z'), // ordinary: not held
      ])
      manifest(dir, 'b-b', [entry('2026-10-05T11-40-00-000Z-c1.sqlite', '2026-10-05T11:40:00.000Z', held)])
      expect(findRecentHeldSet(dir, ['b-a', 'b-b'], now)).toEqual({
        at: '2026-10-05T11:50:00.000Z',
        boards: 2,
      })
      // a board without a held entry in the window: no set (a new board, a failed board)
      manifest(dir, 'b-c', [entry('2026-10-05T11-00-00-000Z-c1.sqlite', '2026-10-05T11:00:00.000Z', held)])
      expect(findRecentHeldSet(dir, ['b-a', 'b-b', 'b-c'], now)).toBeNull()
      expect(findRecentHeldSet(dir, ['b-a', 'b-missing'], now)).toBeNull()
      // a hold that is over does not count; a shorter window excludes b-b
      manifest(dir, 'b-d', [
        entry('2026-10-05T11-50-00-000Z-c1.sqlite', '2026-10-05T11:50:00.000Z', '2026-10-05T11:59:00.000Z'),
      ])
      expect(findRecentHeldSet(dir, ['b-d'], now)).toBeNull()
      expect(findRecentHeldSet(dir, ['b-a', 'b-b'], now, 15 * 60_000)).toBeNull()
      expect(findRecentHeldSet(dir, [], now)).toBeNull()
      // an unreadable manifest counts as no entry
      writeFileSync(join(dir, 'b-a', 'manifest.json'), 'not json')
      expect(findRecentHeldSet(dir, ['b-a'], now)).toBeNull()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('createRunAll consults it before a run, never while one is in progress, and force skips it', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dr-heldset-run-'))
    try {
      manifest(dir, 'b-a', [entry('2026-10-05T11-50-00-000Z-c1.sqlite', '2026-10-05T11:50:00.000Z', held)])
      let t = now.getTime()
      const made = () => ({
        file: `2026-10-05T12-00-00-000Z-c${t}.sqlite`,
        boardId: 'b-a',
        createdAt: new Date(t).toISOString(),
        documentClock: 1,
        schema: {},
        recordCount: 1,
        recordsSha256: 'a'.repeat(64),
        sha256: 'b'.repeat(64),
        sizeBytes: 1,
      })
      const runAll = createRunAll({
        registry: { boardFileIds: () => ['b-a'], backupFresh: async () => made() },
        backups: { status: offsiteOffStatus, copyOffsite: async () => null },
        backupsDir: () => dir,
        now: () => {
          t += 1000
          return new Date(t)
        },
      })
      await expect(runAll.run()).rejects.toBeInstanceOf(RecentHeldSetError)
      expect(() => runAll.request()).toThrow(RecentHeldSetError)
      expect(runAll.list()).toEqual([])
      const forced = await runAll.run({ force: true })
      expect(forced.ok).toBe(true)
      // 31 minutes later the set is no longer recent (the stand-in writes no manifest, so the disk still
      // says 11:50)
      t = now.getTime() + 31 * 60_000
      expect((await runAll.run()).ok).toBe(true)
      // backupsDir absent: never refused (registry stand-ins in tests)
      const plain = createRunAll({
        registry: { boardFileIds: () => ['b-a'], backupFresh: async () => made() },
        backups: { status: offsiteOffStatus, copyOffsite: async () => null },
        now: () => new Date(now.getTime()),
      })
      expect((await plain.run()).ok).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('createRunAll', () => {
  it('reports a board whose backup or offsite copy failed, and ok false', async () => {
    const entry = (boardId: string) => ({
      file: `2026-09-29T00-00-00-000Z-c1.sqlite`,
      boardId,
      createdAt: '2026-09-29T00:00:00.000Z',
      documentClock: 1,
      schema: {},
      recordCount: 1,
      recordsSha256: 'a'.repeat(64),
      sha256: 'b'.repeat(64),
      sizeBytes: 10,
    })
    const runAll = createRunAll({
      registry: {
        boardFileIds: () => ['b-ok0000001', 'b-local0001', 'b-remote001'],
        backupFresh: async (id) => {
          if (id === 'b-local0001') throw new Error('disk full')
          return entry(id)
        },
      },
      backups: {
        status: () => ({
          store: 'r2',
          prefix: 'p',
          running: true,
          lastPassAt: null,
          failuresTotal: 0,
          boards: [],
        }),
        copyOffsite: async (id, file) => (id === 'b-remote001' ? null : `p/${id}/${file}`),
      },
    })
    const report = await runAll.run()
    expect(report.ok).toBe(false)
    expect(report.boards.map((b) => [b.boardId, b.ok, b.offsiteKey, b.error ?? null])).toEqual([
      ['b-ok0000001', true, 'p/b-ok0000001/2026-09-29T00-00-00-000Z-c1.sqlite', null],
      ['b-local0001', false, null, 'local backup failed (Error: disk full)'],
      ['b-remote001', false, null, 'offsite copy did not complete (see GET /internal/backups/status)'],
    ])
    expect(runAll.running()).toBe(false)
  })
})
