// Wave L foundation (W7, L7-2): the selective restore's public route types (history.ts) and the api -> sync
// internal route (sync-internal.ts). W7 implements both ends; these pin the shapes the foundation froze.
import { describe, expect, it } from 'vitest'
import {
  RESTORE_ELEMENTS_ERROR_CODES,
  RESTORE_ELEMENTS_MAX_ELEMENTS,
  RESTORE_ELEMENTS_MAX_IDS,
  RESTORE_ELEMENTS_ROUTE,
  RestoreElementsAnswer,
  RestoreElementsBody,
  RestoreElementsInput,
  RestoreElementsResult,
  restoreElementsInternalPath,
  restoreElementsPath,
} from './index.ts'

const ids = (n: number) => Array.from({ length: n }, (_, i) => `el-${i}`)

describe('POST /api/boards/:bid/snapshots/:sid/restore-elements', () => {
  it('names the route (the element id pattern is canvas-schema’s: its limits.test.ts checks)', () => {
    expect(RESTORE_ELEMENTS_ROUTE).toBe('/api/boards/:bid/snapshots/:sid/restore-elements')
    expect(restoreElementsPath('b-abc1234567', 'snp_0123456789ab')).toBe(
      '/api/boards/b-abc1234567/snapshots/snp_0123456789ab/restore-elements',
    )
    expect(RESTORE_ELEMENTS_ERROR_CODES).toEqual({
      unavailable: 'RESTORE_UNAVAILABLE',
      elementLimit: 'ELEMENT_LIMIT',
    })
  })

  it('takes 1 to 200 element ids', () => {
    expect(RestoreElementsInput.safeParse({ ids: ids(1) }).success).toBe(true)
    expect(RestoreElementsInput.safeParse({ ids: ids(RESTORE_ELEMENTS_MAX_IDS) }).success).toBe(true)
    expect(RestoreElementsInput.safeParse({ ids: ids(RESTORE_ELEMENTS_MAX_IDS + 1) }).success).toBe(false)
    expect(RestoreElementsInput.safeParse({ ids: [] }).success).toBe(false)
    expect(RestoreElementsInput.safeParse({ ids: ['has space'] }).success).toBe(false)
  })

  it('"Undo restore" names the clock of the restore it undoes (round 1: an undo, not a wholesale restore)', () => {
    expect(RestoreElementsInput.safeParse({ ids: ids(1), removeAbsent: true }).success).toBe(false)
    expect(
      RestoreElementsInput.safeParse({ ids: ids(1), removeAbsent: true, restoreClock: 12 }).success,
    ).toBe(true)
    expect(
      RestoreElementsInput.safeParse({ ids: ids(1), removeAbsent: true, restoreClock: -1 }).success,
    ).toBe(false)
    const r = {
      restored: [],
      skipped: [{ id: 'b', code: 'CHANGED' }],
      clock: 3,
      checkpointId: 'snp_0123456789ab',
    }
    expect(RestoreElementsResult.parse(r)).toEqual(r)
  })

  it('answers what was restored, what was skipped and why, the commit clock and the checkpoint made first', () => {
    const r = {
      restored: ['a', 'a-label'],
      skipped: [
        { id: 'b', code: 'LEASED' },
        { id: 'c', code: 'MISSING' },
      ],
      clock: 41,
      checkpointId: 'snp_0123456789ab',
    }
    expect(RestoreElementsResult.parse(r)).toEqual(r)
    expect(RestoreElementsResult.safeParse({ ...r, skipped: [{ id: 'b', code: 'LOCKED' }] }).success).toBe(
      false,
    )
    expect(RestoreElementsResult.safeParse({ ...r, checkpointId: 'x' }).success).toBe(false)
  })
})

describe('POST <sync>/internal/boards/:bid/restore-elements', () => {
  const body = {
    actor: { uid: 'usr_0123456789', name: 'Dana' },
    ids: ['a'],
    elements: [{ id: 'a', type: 'rectangle', x: 0, y: 0, width: 10, height: 10 }],
  }
  it('names the path; the body is strict and keeps each element as stored', () => {
    expect(restoreElementsInternalPath('b-abc1234567')).toBe('/internal/boards/b-abc1234567/restore-elements')
    expect(RestoreElementsBody.parse(body).elements[0]).toEqual(body.elements[0])
    expect(RestoreElementsBody.safeParse({ ...body, extra: 1 }).success).toBe(false)
    expect(RestoreElementsBody.safeParse({ ...body, ids: [] }).success).toBe(false)
    expect(RestoreElementsBody.safeParse({ ...body, elements: [] }).success).toBe(false)
    const many = Array.from({ length: RESTORE_ELEMENTS_MAX_ELEMENTS + 1 }, (_, i) => ({
      id: `e${i}`,
      type: 'text',
    }))
    expect(RestoreElementsBody.safeParse({ ...body, elements: many }).success).toBe(false)
    expect(RestoreElementsBody.safeParse({ ...body, actor: { uid: '', name: 'x' } }).success).toBe(false)
  })

  it('answers restored, skipped and the clock', () => {
    const a = { restored: ['a'], skipped: [{ id: 'b', code: 'INVALID' }], clock: 7 }
    expect(RestoreElementsAnswer.parse(a)).toEqual(a)
    expect(RestoreElementsAnswer.safeParse({ ...a, checkpointId: 'snp_0123456789ab' }).success).toBe(false)
    expect(RestoreElementsAnswer.safeParse({ ...a, skipped: [{ id: 'b', code: 'CHANGED' }] }).success).toBe(
      true,
    )
  })

  it('an undo (removeAbsent) carries the undone restore’s clock', () => {
    const undo = { ...body, elements: [], removeAbsent: true }
    expect(RestoreElementsBody.safeParse(undo).success).toBe(false)
    expect(RestoreElementsBody.safeParse({ ...undo, restoreClock: 9 }).success).toBe(true)
  })
})
