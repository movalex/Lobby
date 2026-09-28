import type { BoardCheckpoint } from '@draftroom/contracts'
import { describe, expect, it } from 'vitest'
import {
  AUTOMATIC_EXPLAINED,
  automaticSummary,
  checkpointAccessHint,
  checkpointMeta,
  checkpointPermissions,
  checkpointTime,
  checkpointTitle,
  deletedCheckpointSummary,
  previewCounts,
  previewStoreSnapshot,
  splitCheckpoints,
} from './checkpoints-model.ts'

const now = new Date(2026, 8, 27, 15, 0)
const base: BoardCheckpoint = {
  id: 'snp_aaaaaaaaaaaa',
  boardId: 'b-aaaaaaaaaa',
  name: 'Before the review',
  kind: 'manual',
  reason: null,
  createdBy: { id: 'usr_a', name: 'Ada' },
  createdAt: new Date(2026, 8, 27, 14, 5).toISOString(),
  documentClock: 3,
  recordCount: 4,
  sizeBytes: 100,
}
const auto = (reason: BoardCheckpoint['reason'], name = 'x', id = 'snp_bbbbbbbbbbbb'): BoardCheckpoint => ({
  ...base,
  id,
  kind: 'auto',
  reason,
  name,
  createdBy: null,
})

describe('the checkpoint list', () => {
  it('puts named checkpoints first and automatic ones (and legacy pre_restore) in their own list, order kept', () => {
    const a1 = auto('hourly', 'Hourly checkpoint', 'snp_111111111111')
    const legacy = { ...base, id: 'snp_222222222222', kind: 'pre_restore' as const }
    const a2 = auto('session_end', 'After an editing session', 'snp_333333333333')
    const { manual, automatic } = splitCheckpoints([a1, base, legacy, a2])
    expect(manual.map((c) => c.id)).toEqual([base.id])
    expect(automatic.map((c) => c.id)).toEqual([a1.id, legacy.id, a2.id])
    expect(automaticSummary(automatic.length)).toBe('Automatic (3)')
  })

  it('titles: a named checkpoint by its name, an automatic one by why it was made', () => {
    expect(checkpointTitle(base)).toBe('Before the review')
    expect(checkpointTitle(auto('hourly'))).toBe('Hourly checkpoint')
    expect(checkpointTitle(auto('session_end'))).toBe('After an editing session')
    expect(checkpointTitle(auto('import'))).toBe('As imported')
    expect(checkpointTitle(auto('before_restore', 'Before restoring “Draft”'))).toBe(
      'Before restoring “Draft”',
    )
    expect(checkpointTitle(auto('before_restore', ' '))).toBe('Before a restore')
    expect(deletedCheckpointSummary(auto('hourly'))).toBe('Deleted “Hourly checkpoint”.')
  })

  it('says who saved it (Lobby for automatic ones), how long ago and the exact time', () => {
    expect(checkpointMeta(base, now)).toBe('saved by Ada · 55 min ago · Today 14:05')
    expect(checkpointMeta(auto('hourly'), now)).toBe('saved by Lobby · 55 min ago · Today 14:05')
    expect(checkpointMeta({ ...base, createdBy: null }, now)).toBe('55 min ago · Today 14:05')
    expect(checkpointTime(new Date(2026, 8, 20, 9, 7).toISOString(), now)).toBe('Sep 20, 09:07')
    expect(checkpointTime(new Date(2025, 11, 31, 23, 59).toISOString(), now)).toBe('Dec 31, 2025, 23:59')
    expect(checkpointTime('nonsense', now)).toBe('')
  })

  it('explains the policy with the numbers of CHECKPOINT_RETENTION, and names the product Lobby', () => {
    expect(AUTOMATIC_EXPLAINED).toContain('Lobby saves the board by itself every hour while it changes')
    expect(AUTOMATIC_EXPLAINED).toContain(
      'one an hour for 2 days, one a day for 30 days and one a week for 6 months',
    )
    expect(AUTOMATIC_EXPLAINED).not.toMatch(/Draftroom/i)
  })
})

describe('who may preview and delete (UI hints; the API enforces)', () => {
  it('previews: workspace members who can view the board; never guests', () => {
    for (const role of ['owner', 'editor', 'commenter', 'viewer'] as const)
      expect(checkpointPermissions(role, 'active', 'member').canPreview, role).toBe(true)
    expect(checkpointPermissions('viewer', 'archived', 'member').canPreview).toBe(true)
    expect(checkpointPermissions('editor', 'active', 'guest').canPreview).toBe(false)
    expect(checkpointPermissions('viewer', 'active', null).canPreview).toBe(false)
  })

  it('deletes: the board’s owners (archived boards too), never a guest, never an editor', () => {
    expect(checkpointPermissions('owner', 'active', 'member').canDelete).toBe(true)
    expect(checkpointPermissions('owner', 'archived', 'admin').canDelete).toBe(true)
    expect(checkpointPermissions('owner', 'active', 'guest').canDelete).toBe(false)
    for (const role of ['editor', 'commenter', 'viewer'] as const)
      expect(checkpointPermissions(role, 'active', 'owner').canDelete, role).toBe(false)
  })

  it('people who can neither preview nor restore (guests) are told why, instead of rows that do nothing', () => {
    const guest = checkpointPermissions('editor', 'active', 'guest')
    expect(checkpointAccessHint(guest, false)).toBe(
      'Only members of this workspace can open or restore earlier versions of this board.',
    )
    expect(checkpointAccessHint(checkpointPermissions('viewer', 'active', 'member'), true)).toBeNull()
    expect(checkpointAccessHint(checkpointPermissions('viewer', 'active', 'member'), false)).toBeNull()
  })
})

describe('the preview', () => {
  it('counts objects and pages, and builds a store snapshot keyed by record id', () => {
    const records = [
      { id: 'document:document', typeName: 'document' },
      { id: 'page:a', typeName: 'page' },
      { id: 'page:b', typeName: 'page' },
      { id: 'shape:1', typeName: 'shape' },
      { id: 'shape:2', typeName: 'shape' },
      { id: 'binding:1', typeName: 'binding' },
    ]
    expect(previewCounts(records)).toEqual({ shapes: 2, pages: 2, text: '2 objects · 2 pages' })
    expect(previewCounts(records.slice(0, 2)).text).toBe('0 objects')
    const snap = previewStoreSnapshot({ records, schema: { schemaVersion: 2, sequences: {} } })
    expect(Object.keys(snap.store)).toEqual(records.map((r) => r.id))
    expect(snap.schema).toEqual({ schemaVersion: 2, sequences: {} })
  })
})
