// The restore drill from the offsite store (`backup:restore-drill --from=store`): the newest offsite
// backup is downloaded (streamed to disk), its size and sha256 checked against the offsite manifest,
// restored into a clean data dir and opened through the room registry; every way the store can be
// wrong fails the drill.
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createFsBlobStore } from '@draftroom/blob-store'
import { draftroomSchema } from '@draftroom/canvas-schema'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { BackupEntry } from '../../src/backup/backup.ts'
import { runRestoreDrill, storeBackupSource } from '../../src/backup/drill.ts'
import { OffsiteBackups } from '../../src/backup/offsite.ts'
import { offsiteKeys } from '../../src/backup/offsite-manifest.ts'
import { RoomRegistry } from '../../src/rooms.ts'
import { indexFor, note, RoomClient } from '../deleted/fixtures.ts'
import { AST_A, fileCard, type TempData, tempData, VER_A } from './offsite-fixtures.ts'

const A = 'drill-board-a'
const B = 'drill-board-b'
const PREFIX = 'backups/sync'
const script = fileURLToPath(new URL('../../src/backup/restore-drill.ts', import.meta.url))
let data: TempData

beforeEach(() => {
  data = tempData('dr-drill-store-')
})
afterEach(() => data.cleanup())

/** Two boards backed up and copied offsite through the real path (registry backup -> listener -> upload). */
async function boardsOffsite(): Promise<Record<string, BackupEntry>> {
  const reg = new RoomRegistry({ dataDir: data.rooms, schema: draftroomSchema, idleEvictMs: 60_000 })
  const offsite = new OffsiteBackups({ store: createFsBlobStore(data.blobs), localRoot: data.backups })
  offsite.start()
  const out: Record<string, BackupEntry> = {}
  try {
    for (const board of [A, B]) {
      const c = new RoomClient(reg.getOrCreate(board), 'usr_a')
      await c.connect()
      await c.put(
        note('n1', `${board} one`),
        note('n2', 'two', { index: indexFor(2) }),
        fileCard('f', AST_A, VER_A),
      )
      const entry = await reg.backupNow(board)
      if (!entry) throw new Error('no backup')
      out[board] = entry
    }
    await offsite.idle()
  } finally {
    await offsite.stop()
    reg.closeAll()
  }
  return out
}

const objectPath = (board: string, file: string) => join(data.blobs, ...PREFIX.split('/'), board, file)

describe('restore drill from the store', () => {
  it('drills every board in the offsite index and matches the live boards', async () => {
    const entries = await boardsOffsite()
    const report = await runRestoreDrill({
      dataDir: data.root,
      source: storeBackupSource(createFsBlobStore(data.blobs)),
    })
    expect(report).toMatchObject({ ok: true, source: 'fs' })
    expect(report.boards.map((b) => b.boardId)).toEqual([A, B])
    for (const b of report.boards) {
      const entry = entries[b.boardId]
      expect(b).toMatchObject({ ok: true, backupFile: entry?.file, live: 'identical', problems: [] })
      expect(b.checks).toEqual([
        `downloaded ${PREFIX}/${b.boardId}/${entry?.file} from the fs store (${entry?.sizeBytes} bytes)`,
        'file sha256 matches the manifest',
        'restored into a clean data dir',
        `${entry?.recordCount} records, clock ${entry?.documentClock}, digest matches`,
        'opened through the sync room registry; every record identical',
        'identical to the live board (unchanged since the backup)',
      ])
    }
  })

  it('works on a machine that has only the store (the live data dir is gone)', async () => {
    await boardsOffsite()
    const elsewhere = mkdtempSync(join(tmpdir(), 'dr-drill-clean-'))
    try {
      const report = await runRestoreDrill({
        dataDir: elsewhere,
        source: storeBackupSource(createFsBlobStore(data.blobs)),
        boardIds: [A],
      })
      expect(report.ok).toBe(true)
      expect(report.boards[0]).toMatchObject({ boardId: A, live: 'absent', ok: true })
    } finally {
      rmSync(elsewhere, { recursive: true, force: true })
    }
  })

  it('fails on a changed, truncated or missing object, and on a manifest that lies', async () => {
    const entries = await boardsOffsite()
    const drill = () =>
      runRestoreDrill({
        dataDir: data.root,
        source: storeBackupSource(createFsBlobStore(data.blobs)),
        boardIds: [A],
      })
    const file = objectPath(A, entries[A]?.file ?? '?')
    const original = readFileSync(file)

    const flipped = Buffer.from(original)
    flipped[flipped.length - 10] = (flipped[flipped.length - 10] ?? 0) ^ 0xff
    writeFileSync(file, flipped)
    expect((await drill()).boards[0]?.problems).toEqual(['backup file checksum does not match its manifest'])

    writeFileSync(file, original.subarray(0, original.length - 4096))
    expect((await drill()).boards[0]?.problems).toEqual(['downloaded size does not match the manifest'])

    rmSync(file)
    expect((await drill()).boards[0]?.problems).toEqual(['backup file missing from the store'])
    writeFileSync(file, original)
    expect((await drill()).ok).toBe(true)

    // bytes fine, but the manifest's record digest is not what the file holds
    const manifestFile = objectPath(A, 'manifest.json')
    const manifest = JSON.parse(readFileSync(manifestFile, 'utf8'))
    manifest.backups.at(-1).recordsSha256 = '0'.repeat(64)
    writeFileSync(manifestFile, JSON.stringify(manifest))
    const lied = await drill()
    expect(lied.ok).toBe(false)
    expect(lied.boards[0]?.problems).toContain('restored records differ from the manifest digest')

    rmSync(manifestFile)
    expect((await drill()).boards[0]?.problems).toEqual(['no offsite manifest for this board'])
  })

  it('fails when the store has nothing to drill', async () => {
    const report = await runRestoreDrill({
      dataDir: data.root,
      source: storeBackupSource(createFsBlobStore(data.blobs)),
    })
    expect(report).toMatchObject({ ok: false, boards: [] })
    expect(offsiteKeys.index(PREFIX)).toBe('backups/sync/index.json')
  })
})

describe('the CLI: backup:restore-drill --from=store', () => {
  const run = (args: string[], env: Record<string, string | undefined> = {}) => {
    const clean: NodeJS.ProcessEnv = { ...process.env }
    for (const k of Object.keys(clean)) if (k.startsWith('DRAFTROOM_') || k.startsWith('R2_')) delete clean[k]
    return spawnSync(process.execPath, [script, ...args], {
      encoding: 'utf8',
      timeout: 60_000,
      env: { ...clean, ...env },
    })
  }

  it('drills the fs store under <DATA>/blobs when DRAFTROOM_BACKUP_STORE=fs', async () => {
    const entries = await boardsOffsite()
    const r = run(['--from=store', '--data-dir', data.root, '--board', A], { DRAFTROOM_BACKUP_STORE: 'fs' })
    expect(r.stdout).toContain(`PASS ${A} ${entries[A]?.file}`)
    expect(r.stdout).toContain(`downloaded ${PREFIX}/${A}/${entries[A]?.file} from the fs store`)
    expect(r.stdout).toContain('restore drill passed')
    expect(r.stdout).not.toContain(B)
    expect(r.status).toBe(0)
    // `--from store` (space) works too, and without --board it takes the index
    const all = run(['--from', 'store', `--data-dir=${data.root}`], { DRAFTROOM_BACKUP_STORE: 'fs' })
    expect(all.stdout).toContain(`PASS ${A}`)
    expect(all.stdout).toContain(`PASS ${B}`)
    expect(all.status).toBe(0)
  })

  it('refuses without a store, with --backup-first, and with a bad --from', () => {
    const off = run(['--from=store', '--data-dir', data.root])
    expect(off.status).toBe(1)
    expect(off.stderr).toContain('DRAFTROOM_BACKUP_STORE is off')
    const both = run(['--from=store', '--backup-first', '--data-dir', data.root], {
      DRAFTROOM_BACKUP_STORE: 'fs',
    })
    expect(both.status).toBe(1)
    expect(both.stderr).toContain('--backup-first only applies to --from=local')
    const bad = run(['--from=s3', '--data-dir', data.root])
    expect(bad.status).toBe(1)
    expect(bad.stderr).toContain('--from must be local or store')
    const empty = run(['--from=store', '--data-dir', data.root], { DRAFTROOM_BACKUP_STORE: 'fs' })
    expect(empty.status).toBe(1)
    expect(empty.stdout).toContain('no backups found in the offsite fs store')
  })

  it('names R2 settings, never their values, when they are wrong', () => {
    const secret = 'not a valid secret value!'
    const r = run(['--from=store', '--data-dir', data.root], {
      DRAFTROOM_BACKUP_STORE: 'r2',
      R2_ACCOUNT_ID: '0123456789abcdef0123456789abcdef',
      R2_ACCESS_KEY_ID: 'AKIAFAKEACCESSKEY0001',
      R2_SECRET_ACCESS_KEY: secret,
      R2_BUCKET: 'draftroom-test',
    })
    expect(r.status).toBe(1)
    expect(r.stderr).toContain('R2_SECRET_ACCESS_KEY is malformed')
    expect(`${r.stdout}${r.stderr}`).not.toContain(secret)
  })
})
