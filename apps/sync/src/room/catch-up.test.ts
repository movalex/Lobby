// catch-up.ts: the catch-up ops built from stored row strings are exactly what parsing and
// re-stringifying would give (tombstones redacted, W5-02), the welcome splice parses to the welcome
// object, and the per-clock cache returns the same bytes for the same `since` until the clock moves.

import { redactTombstone } from '@draftroom/canvas-schema/elements'
import { ServerOp } from '@draftroom/canvas-schema/protocol'
import { describe, expect, it } from 'vitest'
import { rect } from '../../test/element-room/support/elements.ts'
import {
  CATCH_UP_CACHE_ENTRIES,
  CatchUpCache,
  catchUpChangesJson,
  catchUpOpsJson,
  catchUpWelcomeJson,
  type RawRow,
} from './catch-up.ts'

const el = (id: string, extra: Record<string, unknown> = {}) =>
  rect(id, {
    version: 3,
    versionNonce: 7,
    index: 'a1',
    updated: 5,
    customData: { lobby: { alt: 'the words "quoted", {braces}' } },
    ...extra,
  })
const row = (e: Record<string, unknown>): RawRow => ({
  data: JSON.stringify(e),
  deleted: e.isDeleted === true,
})

/** The reference: what element-room.ts did before (parse every row, redact tombstones, stringify the ops). */
const reference = (rows: readonly RawRow[]) =>
  JSON.stringify(
    rows.map((r) => {
      const e = JSON.parse(r.data) as Record<string, unknown> & { type: string }
      return { k: 'c', el: r.deleted || e.isDeleted ? redactTombstone(e) : e }
    }),
  )

describe('catch-up ops from stored rows', () => {
  it('live rows travel as stored, a tombstone redacted; the same JSON as parsing and re-stringifying', () => {
    const rows = [
      row(el('a')),
      row(el('dead', { isDeleted: true, customData: { lobby: { alt: 'never on the wire' } } })),
      row(el('b', { customData: { lobby: { alt: '"isDeleted":true inside a string' } } })),
    ]
    const json = catchUpOpsJson(rows)
    expect(json).toBe(reference(rows))
    const ops = JSON.parse(json) as unknown[]
    expect(ops).toHaveLength(3)
    for (const op of ops) expect(ServerOp.safeParse(op).success).toBe(true)
    expect(json).not.toContain('never on the wire')
    expect((ops[1] as { el: { isDeleted: boolean } }).el.isDeleted).toBe(true)
    expect((ops[2] as { el: { isDeleted: boolean } }).el.isDeleted).toBe(false)
  })

  it('a row flagged deleted whose JSON still says live is redacted too (the flag is the store’s truth)', () => {
    const r: RawRow = { data: JSON.stringify(el('x')), deleted: true }
    const op = JSON.parse(catchUpOpsJson([r])) as [{ el: { isDeleted: boolean; customData?: unknown } }]
    expect(op[0].el.isDeleted).toBe(true)
    expect(op[0].el.customData).toBeUndefined()
  })

  it('no rows: an empty array', () => {
    expect(catchUpOpsJson([])).toBe('[]')
  })

  it('the welcome splice and the changes frame parse to the objects', () => {
    const head = { type: 'welcome', clock: 9, reset: false, snapshot: null, roster: [{ sid: 'a}' }] }
    const ops = catchUpOpsJson([row(el('a'))])
    expect(JSON.parse(catchUpWelcomeJson(head, ops))).toEqual({ ...head, catchUp: JSON.parse(ops) })
    expect(JSON.parse(catchUpChangesJson(9, ops))).toEqual({
      type: 'changes',
      clock: 9,
      ops: JSON.parse(ops),
    })
  })
})

describe('the per-clock catch-up cache', () => {
  it('the same since at the same clock is the same string, built once; a new clock rebuilds', () => {
    const c = new CatchUpCache()
    let built = 0
    const rows = () => {
      built++
      return [row(el('a'))]
    }
    const first = c.get(3, 10, rows)
    expect(c.get(3, 10, rows)).toBe(first)
    expect(built).toBe(1)
    expect(c.hits).toBe(1)
    // another since: another entry
    c.get(4, 10, rows)
    expect(built).toBe(2)
    expect(c.size).toBe(2)
    // the clock moved: everything is rebuilt
    c.get(3, 11, rows)
    expect(built).toBe(3)
    expect(c.size).toBe(1)
    c.clear()
    c.get(3, 11, rows)
    expect(built).toBe(4)
  })

  it('holds at most CATCH_UP_CACHE_ENTRIES since values, the oldest dropped first', () => {
    const c = new CatchUpCache()
    for (let s = 0; s < CATCH_UP_CACHE_ENTRIES + 3; s++) c.get(s, 1, () => [])
    expect(c.size).toBe(CATCH_UP_CACHE_ENTRIES)
    let built = 0
    c.get(0, 1, () => {
      built++
      return []
    })
    expect(built).toBe(1) // 0 was the oldest and is gone
    c.get(CATCH_UP_CACHE_ENTRIES + 2, 1, () => {
      built++
      return []
    })
    expect(built).toBe(1) // the newest is still there
  })
})
