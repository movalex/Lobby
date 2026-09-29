// Bridge release R0 gate (docs/EXCALIDRAW-MIGRATION.md §5.10, §7.5 step 4): POST
// /internal/backups/run-all writes a fresh local and offsite backup of EVERY board file (open or not,
// changed or not, tldraw, converted or born on the new canvas) and returns, per board, the object key
// and the recordsSha256 the runbook stores. Its digests equal the board files' own; the files it read
// are unchanged (no room is opened for a board that is not open).
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

    const [res, second] = await Promise.all([
      callInternal(server.url, 'POST', '/internal/backups/run-all'),
      callInternal(server.url, 'POST', '/internal/backups/run-all'),
    ])
    expect(res.status).toBe(200)
    const report = (await res.json()) as RunAllReport
    // a second call while one runs waits for it and gets a run of its own, started after it
    // (run-all-fresh.test.ts): never a report older than the call
    const later = (await second.json()) as RunAllReport
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
    const res = await callInternal(server.url, 'POST', '/internal/backups/run-all')
    const report = (await res.json()) as RunAllReport
    expect(report).toMatchObject({ ok: true, offsite: 'off' })
    expect(report.boards.map((b) => [b.boardId, b.ok, b.offsiteKey, typeof b.file])).toEqual([
      [BORN, true, null, 'string'],
      [CLOSED, true, null, 'string'],
    ])
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
