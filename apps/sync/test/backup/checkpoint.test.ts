// A board file is complete only with its WAL (backup/checkpoint.ts; V3's R0 runbook note, wave 5): a board
// born on the Excalidraw build whose sync was killed before its first checkpoint keeps its whole lb_*
// schema in `board-<id>.sqlite-wal`, so a raw copy of the `.sqlite` is an empty file. On 747d41d there was
// no checkpoint helper or command, and restoreBackupFile copied a backup file without the WAL next to it
// (the restored board was empty).
import { spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { checkpointBoardFile, copyBoardFileSelfContained } from '../../src/backup/checkpoint.ts'
import { restoreBackupFile } from '../../src/backup/restore.ts'
import { boardDbPath } from '../../src/rooms.ts'
import { fileSha256, LB_DDL, tablesOf, walBytes } from '../r0/support.ts'

const cli = fileURLToPath(new URL('../../src/backup/checkpoint-board.ts', import.meta.url))
const BOARD = 'b-walonly001'

let dir: string
let writer: DatabaseSync | null = null
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'dr-checkpoint-'))
  mkdirSync(join(dir, 'rooms'))
})
afterEach(() => {
  writer?.close()
  writer = null
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
})

/**
 * A board whose lb_* schema and rows live only in the WAL: the writing connection stays open (like a sync
 * process killed before a checkpoint), autocheckpoint off, so the main file holds nothing but its header.
 */
function walOnlyBoard(): string {
  const path = boardDbPath(join(dir, 'rooms'), BOARD)
  writer = new DatabaseSync(path)
  writer.exec('PRAGMA journal_mode = WAL')
  writer.exec('PRAGMA wal_autocheckpoint = 0')
  for (const ddl of LB_DDL) writer.exec(ddl)
  writer.prepare('INSERT INTO lb_meta (key, value) VALUES (?, ?)').run('clock', '7')
  writer.prepare('INSERT INTO lb_meta (key, value) VALUES (?, ?)').run('epoch', 'e-wal-0001')
  writer
    .prepare(
      "INSERT INTO lb_elements (id, clock, idx, deleted, type, version, gclock, data) VALUES ('r1', 7, 'a0', 0, 'rectangle', 1, '{}', '{\"id\":\"r1\",\"type\":\"rectangle\"}')",
    )
    .run()
  expect(walBytes(path)).toBeGreaterThan(0)
  return path
}

const tablesOfCopy = (path: string) => {
  const db = new DatabaseSync(path, { readOnly: true })
  try {
    return (
      db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as {
        name: string
      }[]
    ).map((r) => r.name)
  } finally {
    db.close()
  }
}

describe('a board file whose schema is only in its WAL', () => {
  it('a raw copy of the .sqlite alone is an empty file (the hazard the runbook step and the tools answer)', () => {
    const path = walOnlyBoard()
    const copy = join(dir, 'raw.sqlite')
    copyFileSync(path, copy)
    expect(tablesOfCopy(copy)).toEqual([])
  })

  it('copyBoardFileSelfContained carries the WAL into the copy and checkpoints the copy, never the source', () => {
    const path = walOnlyBoard()
    const before = { sha: fileSha256(path), wal: walBytes(path) }
    const copy = join(dir, 'self-contained.sqlite')
    const result = copyBoardFileSelfContained(path, copy)
    expect(result).toMatchObject({ checkpointed: true, busy: false })
    expect(result.walBytesBefore).toBe(before.wal)
    // self-contained: no -wal or -shm next to the copy (checked before any connection opens it again: a
    // read-only reader leaves an empty WAL behind on close)
    expect(existsSync(`${copy}-wal`)).toBe(false)
    expect(existsSync(`${copy}-shm`)).toBe(false)
    expect(tablesOfCopy(copy)).toEqual(expect.arrayContaining(['lb_elements', 'lb_meta']))
    expect(walBytes(copy)).toBe(0)
    // the source is as it was: its bytes and its WAL
    expect(fileSha256(path)).toBe(before.sha)
    expect(walBytes(path)).toBe(before.wal)
    // a source without a WAL is copied byte for byte (no connection is opened on the copy)
    const plain = join(dir, 'plain.sqlite')
    const again = copyBoardFileSelfContained(copy, plain)
    expect(again).toEqual({ walBytesBefore: 0, checkpointed: false, busy: false })
    expect(fileSha256(plain)).toBe(fileSha256(copy))
  })

  it('checkpointBoardFile folds the WAL into the file, so a raw copy is complete afterwards', () => {
    const path = walOnlyBoard()
    const result = checkpointBoardFile(path)
    expect(result).toMatchObject({ checkpointed: true, busy: false })
    expect(result.walBytesBefore).toBeGreaterThan(0)
    const copy = join(dir, 'after.sqlite')
    copyFileSync(path, copy)
    expect(tablesOfCopy(copy)).toEqual(expect.arrayContaining(['lb_elements', 'lb_meta']))
    expect(checkpointBoardFile(path)).toEqual({ walBytesBefore: 0, checkpointed: false, busy: false })
    expect(() => checkpointBoardFile(join(dir, 'missing.sqlite'))).toThrow('no such board file')
  })

  it('restoreBackupFile puts back a backup file with the WAL next to it (a --from=file restore of a raw copy)', () => {
    const path = walOnlyBoard()
    const target = join(dir, 'target-rooms')
    const result = restoreBackupFile({ file: path, roomsDir: target, boardId: BOARD, bumpClockBy: 0 })
    expect(result.documentClock).toBe(7)
    expect(tablesOf(result.path)).toEqual(expect.arrayContaining(['lb_elements', 'lb_meta']))
    expect(walBytes(result.path)).toBe(0)
  })

  it('the runbook command checkpoints by --path or --board, and says when there is nothing to do', () => {
    const path = walOnlyBoard()
    const run = (args: string[]) =>
      spawnSync(process.execPath, [cli, ...args], {
        encoding: 'utf8',
        timeout: 60_000,
        env: { ...process.env, DRAFTROOM_DATA_DIR: dir },
      })
    const bad = run(['--board', BOARD, '--path', path])
    expect(bad.status).toBe(2)
    const byBoard = run(['--board', BOARD])
    expect(byBoard.stdout).toContain(`${BOARD}: checkpointed (`)
    expect(byBoard.status).toBe(0)
    expect(walBytes(path)).toBe(0)
    expect(statSync(path).size).toBeGreaterThan(4096)
    const nothing = run(['--path', path])
    expect(nothing.stdout).toContain('nothing to do (no WAL next to the file)')
    expect(nothing.status).toBe(0)
    const missing = run(['--path', join(dir, 'rooms', 'board-b-nothere001.sqlite')])
    expect(missing.status).toBe(1)
    expect(missing.stderr).toContain('no such board file')
  })
})
