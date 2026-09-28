import type { BoardCheckpoint } from '@draftroom/contracts'
import { describe, expect, it } from 'vitest'
import { shortTime, timeOfDay } from '../sharing/model.ts'
import {
  AUTOMATIC_EXPLAINED,
  AUTOMATIC_NONE_YET,
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
    // R10: saved by Lobby right before a reveal and before AI regroups notes. R2-09: the server's name
    // says which prompt or which notes, so two of them can be told apart.
    expect(checkpointTitle(auto('before_reveal', 'Before revealing private notes: “What went well?”'))).toBe(
      'Before revealing private notes: “What went well?”',
    )
    expect(
      checkpointTitle(auto('before_ai_themes', 'Before AI grouped 16 notes in 3 · What to improve')),
    ).toBe('Before AI grouped 16 notes in 3 · What to improve')
    expect(checkpointTitle(auto('before_reveal', ' '))).toBe('Before revealing private notes')
    expect(checkpointTitle(auto('before_ai_themes', ''))).toBe('Before AI grouped notes into themes')
    expect(deletedCheckpointSummary(auto('hourly'))).toBe('Deleted “Hourly checkpoint”.')
  })

  it('says who saved it (Lobby for automatic ones), how long ago and the exact time', () => {
    // R2-08: the time of day in the browser's locale and hour cycle, as the link badge shows it.
    const t = timeOfDay(new Date(2026, 8, 27, 14, 5))
    expect(checkpointMeta(base, now)).toBe(`saved by Ada · 55 min ago · Today ${t}`)
    expect(checkpointMeta(auto('hourly'), now)).toBe(`saved by Lobby · 55 min ago · Today ${t}`)
    expect(checkpointMeta({ ...base, createdBy: null }, now)).toBe(`55 min ago · Today ${t}`)
    expect(checkpointTime(base.createdAt, now, 'en-US')).toBe('Today 2:05 PM')
    expect(checkpointTime(base.createdAt, now, 'en-GB')).toBe('Today 14:05')
    expect(checkpointTime(new Date(2026, 8, 20, 9, 7).toISOString(), now, 'en-GB')).toBe('Sep 20, 09:07')
    expect(checkpointTime(new Date(2026, 8, 20, 9, 7).toISOString(), now, 'en-US')).toBe('Sep 20, 9:07 AM')
    expect(checkpointTime(new Date(2025, 11, 31, 23, 59).toISOString(), now, 'en-GB')).toBe(
      'Dec 31, 2025, 23:59',
    )
    // The same formatter as the sharing badge's "until 3:40 PM": one screen, one format.
    expect(checkpointTime(base.createdAt, now)).toBe(`Today ${shortTime(base.createdAt, now)}`)
    expect(checkpointTime('nonsense', now)).toBe('')
  })

  it('explains the policy with the numbers of CHECKPOINT_RETENTION, and names the product Lobby', () => {
    expect(AUTOMATIC_EXPLAINED).toContain('Lobby saves the board by itself every hour while it changes')
    expect(AUTOMATIC_EXPLAINED).toContain(
      'one an hour for 2 days, one a day for 30 days and one a week for 6 months',
    )
    expect(AUTOMATIC_EXPLAINED).not.toMatch(/Draftroom/i)
    expect(AUTOMATIC_EXPLAINED).toContain('before private notes are revealed or AI groups notes into themes')
    // The empty list says when the first one comes (R10).
    expect(AUTOMATIC_NONE_YET).toBe(
      'None yet. Lobby saves one when everyone leaves, or after an hour of changes.',
    )
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
