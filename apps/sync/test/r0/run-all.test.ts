// Bridge release R0 gate (docs/EXCALIDRAW-MIGRATION.md §5.10, §7.5 step 4): POST
// /internal/backups/run-all writes a fresh local and offsite backup of EVERY board file (open or not,
// changed or not, tldraw, converted or born on the new canvas) and returns, per board, the object key
// and the recordsSha256 the runbook stores. Its digests equal the board files' own; the files it read
// are unchanged (no room is opened for a board that is not open). The POST answers at once (202 and the
// run's id); the report is read by id once the run is done, as the runbook command does (run-all-cli.ts).
import { join } from 'node:path'
import { createFsBlobStore } from '@draftroom/blob-store'
import type { TLRecord } from '@tldraw/tlschema'
import { describe, expect, it } from 'vitest'
import { inspectBoardDb, readManifest, sha256File } from '../../src/backup/backup.ts'
import { offsiteKeys } from '../../src/backup/offsite-manifest.ts'
import type { RunAllReport } from '../../src/backup/run-all.ts'
import { createRunAll } from '../../src/backup/run-all.ts'
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

    // outside maintenance, --expect-maintenance fails (the report is still printed)
    await callInternal(server.url, 'POST', '/internal/maintenance', { body: { on: false } })
    const outside = await runCli(['--url', server.url, '--interval-ms', '20', '--expect-maintenance'])
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
