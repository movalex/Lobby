// Restoring one board from a backup on a host whose disk is only reachable while the server runs
// (docs/DEPLOY.md "Restoring a board"): `backup:restore-board` verifies and stages next to a running
// server, and the next server start applies it before it listens.
import { spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createFsBlobStore } from '@draftroom/blob-store'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createSyncServer, type SyncServer } from '../../src/app.ts'
import { type BackupEntry, describeBoardDb } from '../../src/backup/backup.ts'
import {
  DrillProblem,
  fileBackupSource,
  localBackupSource,
  storeBackupSource,
} from '../../src/backup/drill.ts'
import { backupSigningKey } from '../../src/backup/signing.ts'
import {
  applyStagedRestores,
  cancelStagedRestore,
  listStagedRestores,
  stageRestore,
} from '../../src/backup/staged-restore.ts'
import { boardDbPath } from '../../src/rooms.ts'
import { indexFor, note, RoomClient } from '../deleted/fixtures.ts'
import { TEST_INTERNAL_SECRET } from '../harness/tickets.ts'
import { testConfig } from '../http/helpers.ts'
import { type TempData, tempData } from './offsite-fixtures.ts'

const BOARD = 'restore-board'
const script = fileURLToPath(new URL('../../src/backup/restore-board.ts', import.meta.url))
// The test server (testConfig) signs with TEST_INTERNAL_SECRET, as a real one with its own.
const storeSource = () =>
  storeBackupSource(createFsBlobStore(data.blobs), { signingKey: backupSigningKey(TEST_INTERNAL_SECRET) })
let data: TempData
let servers: SyncServer[] = []
let logs: string[] = []

beforeEach(() => {
  data = tempData('dr-restore-board-')
  logs = []
})
afterEach(async () => {
  for (const s of servers) await s.close()
  servers = []
  data.cleanup()
})

/** A real sync server on the temp data dir, with the fs offsite store under it. */
async function startSync(): Promise<SyncServer> {
  const s = createSyncServer(
    testConfig(data.root, { idleEvictMs: 60_000, backupStore: { kind: 'fs', root: data.blobs } }),
    { log: (...a) => logs.push(a.map(String).join(' ')) },
  )
  servers.push(s)
  await s.listen()
  return s
}

/**
 * The disaster: a board is backed up (and copied offsite), then keeps changing ("ghost" work a tab
 * saw), and needs to go back to the backup.
 */
async function backedUpThenChanged(): Promise<{ entry: BackupEntry; liveClock: number }> {
  const s = await startSync()
  const a = new RoomClient(s.registry.getOrCreate(BOARD), 'usr_a')
  await a.connect()
  await a.put(note('n1', 'in the backup'), note('n2', 'also', { index: indexFor(2) }))
  const entry = await s.registry.backupNow(BOARD)
  if (!entry) throw new Error('no backup')
  for (let i = 0; i < 5; i++) await a.put(note(`ghost${i}`, 'after the backup', { index: indexFor(10 + i) }))
  const liveClock = s.registry.roomIfOpen(BOARD)?.getCurrentDocumentClock() ?? 0
  // let the offsite copy of the backup finish before the server goes away
  for (let i = 0; i < 400 && s.backups.status().boards[0]?.lastSuccessFile !== entry.file; i++)
    await new Promise((r) => setTimeout(r, 10))
  await s.close()
  servers = servers.filter((x) => x !== s)
  return { entry, liveClock }
}

describe('stage, then apply at the next start', () => {
  it('puts the backup back, past every clock a client saw, and keeps the previous database', async () => {
    const { entry, liveClock } = await backedUpThenChanged()
    // staging happens next to a running server (it touches nothing live)
    const running = await startSync()
    const { request, checks, warnings } = await stageRestore({
      dataDir: data.root,
      source: storeSource(),
      boardId: BOARD,
    })
    expect(request).toMatchObject({ boardId: BOARD, file: entry.file, source: 'fs', sha256: entry.sha256 })
    expect(checks).toContain('manifest entry signature verified')
    expect(checks).toContain('opened through the sync room registry; every record identical')
    expect(warnings).toEqual([])
    expect(listStagedRestores(data.root).map((r) => r.id)).toEqual([request.id])
    expect(describeBoardDb(boardDbPath(data.rooms, BOARD)).records.has('shape:ghost0')).toBe(true)
    await running.close()
    servers = []

    const s = await startSync()
    expect(
      logs.some((l) => l.includes(`[restore] board ${BOARD}: restored from fs backup ${entry.file}`)),
    ).toBe(true)
    expect(listStagedRestores(data.root)).toEqual([])
    const kept = readdirSync(data.rooms).filter((f) => f.startsWith(`board-${BOARD}.sqlite.pre-restore-`))
    expect(kept).toHaveLength(1)
    expect(describeBoardDb(join(data.rooms, kept[0] ?? '?')).records.has('shape:ghost0')).toBe(true)

    // the board serves the backup's records, and its clock is past what the stale tab saw
    const stale = new RoomClient(s.registry.getOrCreate(BOARD), 'usr_stale', { tab: 'stale' })
    const connect = await stale.connect(liveClock)
    expect(connect.hydrationType).toBe('wipe_all')
    const text = JSON.stringify(connect)
    expect(text).toContain('shape:n1')
    expect(text).not.toContain('shape:ghost0')
    const restoredClock = s.registry.roomIfOpen(BOARD)?.getCurrentDocumentClock() ?? 0
    expect(restoredClock).toBeGreaterThan(liveClock)

    // undo: the kept copy goes back the same way (--from=file), again past every clock seen
    const undo = await stageRestore({
      dataDir: data.root,
      source: fileBackupSource(join(data.rooms, kept[0] ?? '?')),
      boardId: BOARD,
    })
    expect(undo.request.source).toBe('file')
    await s.close()
    servers = []
    const back = await startSync()
    const tab = new RoomClient(back.registry.getOrCreate(BOARD), 'usr_b', { tab: 'undo' })
    const after = await tab.connect(restoredClock)
    expect(after.hydrationType).toBe('wipe_all')
    expect(JSON.stringify(after)).toContain('shape:ghost4')
  })

  it('applies a request once, even if its files could not be removed', async () => {
    await backedUpThenChanged()
    await stageRestore({ dataDir: data.root, source: localBackupSource(data.backups), boardId: BOARD })
    const dir = join(data.root, 'restore')
    const saved = readdirSync(dir).map((f) => [f, readFileSync(join(dir, f))] as const)
    expect((await applyStagedRestores({ dataDir: data.root })).map((r) => r.ok)).toEqual([true])
    for (const [f, bytes] of saved) writeFileSync(join(dir, f), bytes) // as if the deletes had failed
    const again = await applyStagedRestores({ dataDir: data.root })
    expect(again).toEqual([
      {
        boardId: BOARD,
        ok: false,
        message: 'this staged restore was already applied; remove it with restore-board --cancel',
      },
    ])
    expect(cancelStagedRestore(data.root, BOARD)).toBe(true)
    expect(listStagedRestores(data.root)).toEqual([])
  })

  it('stages nothing when the backup does not verify, and refuses a changed staged file', async () => {
    const { entry } = await backedUpThenChanged()
    const object = join(data.blobs, 'backups', 'sync', BOARD, entry.file)
    const bytes = readFileSync(object)
    bytes[bytes.length - 10] = (bytes[bytes.length - 10] ?? 0) ^ 0xff
    writeFileSync(object, bytes)
    const err = await stageRestore({
      dataDir: data.root,
      source: storeSource(),
      boardId: BOARD,
    }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(DrillProblem)
    expect((err as DrillProblem).problems).toEqual(['backup file checksum does not match its manifest'])
    expect(listStagedRestores(data.root)).toEqual([])
    expect(readdirSync(join(data.root, 'restore'))).toEqual([]) // no scratch left behind

    // a staged file changed after staging is not applied, and the live board is untouched
    await stageRestore({ dataDir: data.root, source: localBackupSource(data.backups), boardId: BOARD })
    const staged = join(data.root, 'restore', `board-${BOARD}.sqlite`)
    copyFileSync(boardDbPath(data.rooms, BOARD), staged)
    const before = describeBoardDb(boardDbPath(data.rooms, BOARD)).recordsSha256
    const [result] = await applyStagedRestores({ dataDir: data.root })
    expect(result).toMatchObject({ ok: false })
    expect(result?.message).toContain('does not match its request')
    expect(describeBoardDb(boardDbPath(data.rooms, BOARD)).recordsSha256).toBe(before)
    expect(existsSync(join(data.root, 'restore', `board-${BOARD}.failed.json`))).toBe(true)
  })
})

describe('the CLI: backup:restore-board', () => {
  const run = (args: string[], env: Record<string, string> = {}) => {
    const clean: NodeJS.ProcessEnv = { ...process.env }
    for (const k of Object.keys(clean)) if (k.startsWith('DRAFTROOM_') || k.startsWith('R2_')) delete clean[k]
    return spawnSync(process.execPath, [script, ...args], {
      encoding: 'utf8',
      timeout: 60_000,
      env: { ...clean, ...env },
    })
  }

  it('stages from the store, lists and cancels', async () => {
    const { entry } = await backedUpThenChanged()
    const staged = run(['--from=store', '--board', BOARD, '--data-dir', data.root], {
      DRAFTROOM_BACKUP_STORE: 'fs',
      DRAFTROOM_INTERNAL_SECRET: TEST_INTERNAL_SECRET,
    })
    expect(staged.stdout).toContain('  ok   offsite manifest signature verified')
    expect(staged.stdout).toContain(`staged ${BOARD} from fs backup ${entry.file}\n`)
    expect(staged.stdout).toContain('restart the sync server to apply it')
    expect(staged.status).toBe(0)
    const list = run(['--list', '--data-dir', data.root])
    expect(list.stdout).toContain(`${BOARD} ${entry.file} (from fs,`)
    const cancel = run(['--board', BOARD, '--cancel', '--data-dir', data.root])
    expect(cancel.stdout).toContain(`cancelled the staged restore of ${BOARD}`)
    expect(listStagedRestores(data.root)).toEqual([])
  })

  it('needs --from and a valid board id, and names a missing backup', async () => {
    await backedUpThenChanged()
    expect(run(['--board', BOARD, '--data-dir', data.root]).stderr).toContain(
      '--from=store, --from=local or --from=file is required',
    )
    expect(run(['--from=file', '--board', BOARD, '--data-dir', data.root]).stderr).toContain(
      '--from=file needs --path',
    )
    const notABoard = run(['--from=file', '--path', script, '--board', BOARD, '--data-dir', data.root])
    expect(notABoard.stdout).toContain('FAIL not a readable board database')
    expect(notABoard.status).toBe(1)
    expect(run(['--from=local', '--board', '../x', '--data-dir', data.root]).stderr).toContain(
      'invalid board id',
    )
    const missing = run([
      '--from=local',
      '--board',
      BOARD,
      '--file',
      '2020-01-01T00-00-00-000Z-c1.sqlite',
      '--data-dir',
      data.root,
    ])
    expect(missing.stdout).toContain(
      'backup 2020-01-01T00-00-00-000Z-c1.sqlite is not listed in the manifest',
    )
    expect(missing.stdout).toContain(`nothing staged for ${BOARD}`)
    expect(missing.status).toBe(1)
  })
})
