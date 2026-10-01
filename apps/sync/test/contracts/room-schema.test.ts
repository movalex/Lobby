// Spike B contracts step C0: the board file's DDL, the gclock shape and the lb_prev naming
// (apps/sync/src/room/schema.ts; docs/EXCALIDRAW-MIGRATION.md §2.6, §5.9).
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import {
  ensureLbSchema,
  LB_PRAGMAS,
  LB_PREV_TABLE_PATTERN,
  LB_TABLES,
  lbPrevTable,
  parseGclock,
  serializeGclock,
} from '../../src/room/schema.ts'

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

describe('room/schema.ts', () => {
  it('creates exactly the lb_* tables and indexes of §2.6, idempotently, next to tldraw tables', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dr-lb-schema-'))
    dirs.push(dir)
    const db = new DatabaseSync(join(dir, 'board-b-schema.sqlite'))
    for (const p of LB_PRAGMAS) db.exec(p)
    db.exec(
      'CREATE TABLE documents (id TEXT PRIMARY KEY, state BLOB NOT NULL, lastChangedClock INTEGER NOT NULL)',
    )
    ensureLbSchema(db)
    ensureLbSchema(db) // a second open changes nothing
    const rows = db
      .prepare("SELECT type, name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY name")
      .all() as {
      type: string
      name: string
    }[]
    expect(rows.filter((r) => r.type === 'table').map((r) => r.name)).toEqual(
      [...LB_TABLES, 'documents'].sort(),
    )
    expect(rows.filter((r) => r.type === 'index').map((r) => r.name)).toEqual([
      'lb_deleted_batch',
      'lb_deleted_element',
      'lb_elements_clock',
      'lb_elements_order',
    ])
    const cols = (t: string) =>
      (db.prepare(`PRAGMA table_info(${t})`).all() as { name: string }[]).map((c) => c.name)
    expect(cols('lb_elements')).toEqual([
      'id',
      'clock',
      'idx',
      'deleted',
      'deleted_clock',
      'deleted_at',
      'type',
      'version',
      'gclock',
      'data',
    ])
    expect(cols('lb_doc')).toEqual(['key', 'clock', 'value'])
    expect(cols('lb_deleted')).toEqual([
      'seq',
      'batch',
      'element_id',
      'type',
      'container_id',
      'frame_id',
      'data',
      'deleted_by',
      'deleted_by_name',
      'deleted_at',
      'epoch',
      'origin',
    ])
    expect(cols('lb_source')).toEqual(['id', 'state'])
    expect((db.prepare('PRAGMA journal_mode').get() as { journal_mode: string }).journal_mode).toBe('wal')
    db.close()
  })

  it('gclock: known slots only, clocks as non-negative integers, serialized with sorted keys', () => {
    const g = parseGclock('{"shape":4,"pos":7,"c:tag:research":9,"fit":11}')
    expect(serializeGclock(g)).toBe('{"c:tag:research":9,"fit":11,"pos":7,"shape":4}')
    for (const bad of ['[]', '{"colour":1}', '{"pos":-1}', '{"pos":1.5}', '{"pos":"1"}', 'null'])
      expect(() => parseGclock(bad), bad).toThrow()
  })

  it('lb_prev_<cycle>_* naming', () => {
    expect(lbPrevTable(1, 'lb_elements')).toBe('lb_prev_1_elements')
    expect(lbPrevTable(12, 'lb_source')).toBe('lb_prev_12_source')
    expect(() => lbPrevTable(0, 'lb_doc')).toThrow()
    expect(LB_PREV_TABLE_PATTERN.test('lb_prev_3_meta')).toBe(true)
    expect(LB_PREV_TABLE_PATTERN.test('lb_prev_0_meta')).toBe(false)
    expect(LB_PREV_TABLE_PATTERN.test('lb_elements')).toBe(false)
  })
})
