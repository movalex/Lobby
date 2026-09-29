// Test support for O4's conversion, roll-forward and R0 stand-in suites (apps/sync/test/migrate/**).
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { draftroomSchema } from '@draftroom/canvas-schema'
import type { TLRecord } from '@tldraw/tlschema'
import { afterEach } from 'vitest'
import { ensureLbSchema, LB_PRAGMAS, serializeGclock } from '../../src/room/schema.ts'
import { boardDbPath, RoomRegistry } from '../../src/rooms.ts'

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
})

/** A temp dir removed after the test. */
export function tempDir(prefix = 'dr-migrate-'): string {
  const d = mkdtempSync(join(tmpdir(), prefix))
  dirs.push(d)
  return d
}

export const fileSha256 = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex')

/** Size of the file's WAL (0 when absent): a read-only reader must never add frames. */
export const walBytes = (path: string) => (existsSync(`${path}-wal`) ? statSync(`${path}-wal`).size : 0)

/**
 * A board born on the new canvas, as O1's store writes one (the frozen §2.6 DDL, LB_PRAGMAS, lb_meta
 * without `converted_from`, one element). WAL-checkpointed and closed.
 */
export function makeBornAfterFile(path: string): void {
  const db = new DatabaseSync(path)
  try {
    for (const p of LB_PRAGMAS) db.exec(p)
    db.exec('BEGIN IMMEDIATE')
    ensureLbSchema(db)
    const meta = db.prepare('INSERT INTO lb_meta (key, value) VALUES (?, ?)')
    meta.run('clock', '1')
    meta.run('horizon', '0')
    meta.run('epoch', 'e-born-after')
    meta.run('schemaVersion', '1')
    db.prepare(
      'INSERT INTO lb_elements (id, clock, idx, deleted, type, version, gclock, data) VALUES (?, ?, ?, 0, ?, 1, ?, ?)',
    ).run('r1', 1, 'a0', 'rectangle', serializeGclock({}), JSON.stringify({ id: 'r1', type: 'rectangle' }))
    db.exec('COMMIT')
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
  } finally {
    db.close()
  }
}

/** A tldraw board written by today's RoomRegistry (the current build's code), then closed. */
export function seedTldrawBoard(dataDir: string, boardId: string, records: readonly TLRecord[] = []): string {
  const reg = new RoomRegistry({ dataDir, schema: draftroomSchema, backup: false })
  try {
    reg.seed(boardId, {
      documentClock: 0,
      tombstoneHistoryStartsAtClock: 0,
      tombstones: {},
      schema: draftroomSchema.serialize(),
      documents: [
        {
          state: {
            id: 'document:document',
            typeName: 'document',
            gridSize: 10,
            name: '',
            meta: {},
          } as unknown as TLRecord,
          lastChangedClock: 0,
        },
        {
          state: {
            id: 'page:page',
            typeName: 'page',
            name: 'Page 1',
            index: 'a1',
            meta: {},
          } as unknown as TLRecord,
          lastChangedClock: 0,
        },
        ...records.map((state) => ({ state, lastChangedClock: 0 })),
      ],
    })
  } finally {
    reg.closeAll()
  }
  return boardDbPath(dataDir, boardId)
}

/** Every table name of a board file (read-only). */
export function tablesOf(path: string): string[] {
  const db = new DatabaseSync(path, { readOnly: true })
  try {
    return (
      db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as Array<{
        name: string
      }>
    ).map((r) => r.name)
  } finally {
    db.close()
  }
}
