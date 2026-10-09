// The time-travel dialog's pure parts (wave L, L7-1/L7-2; ./time-travel.ts).
import type { BoardCheckpoint } from '@draftroom/contracts'
import { describe, expect, it } from 'vitest'
import {
  canRestoreElements,
  restoreElementsSummary,
  restoreIdsOf,
  tickForKey,
  tickText,
  timelineOrder,
  undoRestoreIds,
  undoRestoreInput,
  undoRestoreSummary,
} from './time-travel.ts'

const cp = (id: string, createdAt: string, o: Partial<BoardCheckpoint> = {}): BoardCheckpoint => ({
  id,
  boardId: 'b-board00001',
  name: 'Hourly checkpoint',
  kind: 'auto',
  reason: 'hourly',
  createdBy: null,
  createdAt,
  documentClock: 1,
  recordCount: 1,
  sizeBytes: 1,
  ...o,
})

describe('the timeline', () => {
  it('runs oldest to newest; keys move along it and stop at its ends', () => {
    const list = [
      cp('snp_c', '2026-10-09T10:00:00Z'),
      cp('snp_a', '2026-10-09T08:00:00Z'),
      cp('snp_b', '2026-10-09T09:00:00Z'),
    ]
    expect(timelineOrder(list).map((c) => c.id)).toEqual(['snp_a', 'snp_b', 'snp_c'])
    expect(tickForKey('ArrowLeft', 0, 3)).toBe(0)
    expect(tickForKey('ArrowRight', 0, 3)).toBe(1)
    expect(tickForKey('ArrowUp', 2, 3)).toBe(2)
    expect(tickForKey('ArrowDown', 2, 3)).toBe(1)
    expect(tickForKey('Home', 2, 3)).toBe(0)
    expect(tickForKey('End', 0, 3)).toBe(2)
    expect(tickForKey('PageUp', 0, 12)).toBe(5)
    expect(tickForKey('a', 0, 3)).toBeNull()
    expect(tickText(list[0] as BoardCheckpoint, 2, 3, new Date('2026-10-09T12:00:00Z'))).toMatch(
      /^Hourly checkpoint, .+ \(3 of 3\)$/,
    )
  })
})

describe('Restore these', () => {
  it('is offered to editors with an account who may preview, in a room at rev 12 or later', () => {
    const ok = { canEdit: true, isAccount: true, canPreview: true, contractsRev: 12 }
    expect(canRestoreElements(ok)).toBe(true)
    expect(canRestoreElements({ ...ok, contractsRev: 11 })).toBe(false)
    expect(canRestoreElements({ ...ok, contractsRev: null })).toBe(false)
    expect(canRestoreElements({ ...ok, canEdit: false })).toBe(false)
    expect(canRestoreElements({ ...ok, isAccount: false })).toBe(false)
    expect(canRestoreElements({ ...ok, canPreview: false })).toBe(false)
  })

  it('sends the picked ids and what a picked frame held; never more than 200', () => {
    const els = [
      { id: 'F', type: 'frame' },
      { id: 'n1', type: 'stickynote', frameId: 'F' },
      { id: 'n1.t', type: 'text', containerId: 'n1', frameId: 'F' },
      { id: 'n2', type: 'stickynote', frameId: null },
      { id: 'gone', type: 'stickynote', isDeleted: true },
    ]
    expect(restoreIdsOf(['F'], els)).toEqual({ ids: ['F', 'n1'], tooMany: false })
    expect(restoreIdsOf(['n2', 'gone', 'nope'], els)).toEqual({ ids: ['n2'], tooMany: false })
    const many = Array.from({ length: 205 }, (_, i) => ({ id: `e${i}`, type: 'rectangle' }))
    const r = restoreIdsOf(
      many.map((e) => e.id),
      many,
    )
    expect(r.ids).toHaveLength(200)
    expect(r.tooMany).toBe(true)
  })

  it('says what came back and why the rest did not', () => {
    expect(restoreElementsSummary(['a', 'b', 'c'], { skipped: [] })).toBe('Restored 3 objects for everyone.')
    expect(
      restoreElementsSummary(['a', 'b', 'c'], {
        skipped: [
          { id: 'b', code: 'LEASED' },
          { id: 'c', code: 'MISSING' },
        ],
      }),
    ).toBe(
      'Restored 1 object for everyone; 1 object left as it is: someone is typing in it; 1 object not in that checkpoint.',
    )
    expect(restoreElementsSummary(['a'], { skipped: [{ id: 'a', code: 'INVALID' }] })).toBe(
      'Nothing was restored; 1 object could not be restored (locked, or no longer valid on this board).',
    )
    expect(undoRestoreSummary({ skipped: [] })).toBe('Restore undone: the board is as it was before.')
    expect(undoRestoreSummary({ skipped: [{ id: 'a', code: 'LEASED' }] })).toBe(
      'Restore undone, except 1 object someone is typing in.',
    )
    expect(
      undoRestoreSummary({
        skipped: [
          { id: 'a', code: 'LEASED' },
          { id: 'b', code: 'INVALID' },
          { id: 'c', code: 'INVALID' },
        ],
      }),
    ).toBe(
      'Restore undone, except 1 object someone is typing in and 2 objects that are locked or could not be changed back.',
    )
  })

  it('"Undo restore" sends the asked ids the restore did not skip, never more than were asked', () => {
    // the review's case: N1 was being typed in (LEASED), so the restore left it; undoing must leave it too
    expect(
      undoRestoreIds(['N1', 'R', 'N2', 'R'], {
        skipped: [
          { id: 'N1', code: 'LEASED' },
          { id: 'N2', code: 'MISSING' },
        ],
      }),
    ).toEqual(['R'])
    // a label asked for: its unit's skip is named by the asked id
    expect(undoRestoreIds(['N1.t', 'T'], { skipped: [{ id: 'N1.t', code: 'INVALID' }] })).toEqual(['T'])
    // all skipped: nothing to undo (the notice offers no Undo)
    expect(undoRestoreIds(['a'], { skipped: [{ id: 'a', code: 'LEASED' }] })).toEqual([])
    // within the asked ids, so within the 200 the api takes (the bound labels in `restored` are not sent)
    const asked = Array.from({ length: 200 }, (_, i) => `n${i}`)
    expect(undoRestoreIds(asked, { skipped: [] })).toEqual(asked)
  })

  it('"Undo restore" names the restore it undoes (round 1), and says what others changed since', () => {
    expect(undoRestoreInput(['N1', 'R'], { skipped: [{ id: 'R', code: 'LEASED' }], clock: 41 })).toEqual({
      ids: ['N1'],
      removeAbsent: true,
      restoreClock: 41,
    })
    expect(undoRestoreInput(['R'], { skipped: [{ id: 'R', code: 'LEASED' }], clock: 41 })).toBeNull()
    expect(
      undoRestoreSummary({
        skipped: [
          { id: 'a', code: 'CHANGED' },
          { id: 'b', code: 'CHANGED' },
          { id: 'c', code: 'INVALID' },
        ],
      }),
    ).toBe(
      'Restore undone, except 2 objects someone changed since and 1 object that is locked or could not be changed back.',
    )
  })
})
