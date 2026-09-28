import { HistoryBoardCreated } from '@draftroom/contracts'
import { describe, expect, it } from 'vitest'
import {
  archiveFileName,
  checkpointNameToSave,
  createdSummary,
  defaultCheckpointName,
  deletedDetail,
  deletedTitle,
  historyPermissions,
  restoredOnBoard,
  restoreSummary,
  shapeTypeLabel,
  touchesDeleted,
} from './model.ts'

const at = new Date(2026, 8, 27, 9, 5)

describe('labels', () => {
  it('names deleted objects by their text, else by what they were', () => {
    expect(deletedTitle({ label: 'Buy milk', type: 'note' })).toBe('Buy milk')
    expect(deletedTitle({ label: '  ', type: 'note' })).toBe('Sticky note')
    expect(deletedTitle({ label: '', type: 'dr-file-card' })).toBe('File')
    expect(deletedTitle({ label: '', type: 'custom-thing' })).toBe('Object')
    expect(shapeTypeLabel('arrow')).toBe('Connector')
  })

  it('details the kind (when the title is text) and the content deleted with it', () => {
    expect(deletedDetail({ label: 'Ideas', type: 'frame', childCount: 3 })).toBe('Frame · 3 objects inside')
    expect(deletedDetail({ label: '', type: 'frame', childCount: 1 })).toBe('1 object inside')
    expect(deletedDetail({ label: '', type: 'geo', childCount: 0 })).toBe('')
  })
})

describe('checkpoint names', () => {
  it('defaults to a dated name and caps typed names at 120 characters', () => {
    expect(defaultCheckpointName(at)).toBe('Checkpoint Sep 27, 09:05')
    expect(checkpointNameToSave('   ', at)).toBe('Checkpoint Sep 27, 09:05')
    expect(checkpointNameToSave('  Before   review ', at)).toBe('Before review')
    expect(checkpointNameToSave('x'.repeat(200), at)).toHaveLength(120)
  })
})

describe('permissions (UI hints)', () => {
  it('editors of active boards save and restore; viewers and archived boards do not', () => {
    expect(historyPermissions('editor', 'active', 'member')).toEqual({
      canEdit: true,
      canCreateBoards: true,
      canKeepSharing: false,
    })
    expect(historyPermissions('viewer', 'active', 'member')).toEqual({
      canEdit: false,
      canCreateBoards: true, // may restore/duplicate into a board of their own
      canKeepSharing: false,
    })
    expect(historyPermissions('owner', 'archived', 'owner')).toMatchObject({
      canEdit: false,
      canKeepSharing: true,
    })
    expect(historyPermissions('owner', 'active', 'owner').canKeepSharing).toBe(true)
  })

  it('guests and callers without a workspace role cannot create boards', () => {
    expect(historyPermissions('editor', 'active', 'guest').canCreateBoards).toBe(false)
    expect(historyPermissions('editor', 'active', null).canCreateBoards).toBe(false)
  })
})

describe('messages', () => {
  it('summarizes a restore of deleted objects', () => {
    expect(restoreSummary({ restored: ['a', 'b'], skipped: [], bindings: 1, reparented: 0 })).toBe(
      'Restored 2 objects, reconnected 1 connection.',
    )
    // One connector restored with both of its ends bound is two connections, not "2 connectors".
    expect(restoreSummary({ restored: ['a', 'arrow'], skipped: [], bindings: 2, reparented: 0 })).toBe(
      'Restored 2 objects, reconnected 2 connections.',
    )
    expect(restoreSummary({ restored: ['a'], skipped: [], bindings: 0, reparented: 1 })).toBe(
      'Restored 1 object, 1 object placed on the board (the frame is gone).',
    )
    expect(
      restoreSummary({ restored: [], skipped: [{ id: 'a', reason: 'exists' }], bindings: 0, reparented: 0 }),
    ).toBe('That object is already back on the board.')
    expect(
      restoreSummary({
        restored: [],
        skipped: [{ id: 'a', reason: 'not-found' }],
        bindings: 0,
        reparented: 0,
      }),
    ).toMatch(/Nothing could be restored/)
  })

  it('says a restored or duplicated board is private, and counts files left behind', () => {
    const created = HistoryBoardCreated.parse({
      board: {
        id: 'b-0123456789',
        workspaceId: 'wsp_0123456789abcdefghij',
        projectId: null,
        title: 'Pitch (v1)',
        visibility: 'private',
        status: 'active',
        role: 'owner',
        createdAt: '2026-09-27T00:00:00.000Z',
        extra: 'ignored',
      },
      warnings: [],
      linkedFiles: 2,
      droppedFiles: 1,
    })
    expect(createdSummary('restore', created)).toBe(
      'Restored as “Pitch (v1)”, a new board only you can see. 1 file could not be carried over.',
    )
    expect(createdSummary('duplicate', { ...created, droppedFiles: 0 })).toBe(
      'Made “Pitch (v1)”, a private copy only you can see.',
    )
    expect(
      createdSummary('duplicate', {
        ...created,
        droppedFiles: 0,
        board: { ...created.board, visibility: 'workspace_view' },
      }),
    ).toBe('Made “Pitch (v1)”.')
  })
})

describe('files and changes', () => {
  it('builds a safe archive file name from the board title', () => {
    expect(archiveFileName('Pitch / v2: "final"')).toBe('Pitch - v2- -final-.lobby.json')
    expect(archiveFileName('...hidden')).toBe('hidden.lobby.json')
    expect(archiveFileName('   ')).toBe('board.lobby.json')
    expect(archiveFileName('x'.repeat(300))).toHaveLength(100 + '.lobby.json'.length)
  })

  it('selects only restored shapes that arrived', () => {
    const on = new Set(['shape:a', 'shape:c'])
    expect(restoredOnBoard(['shape:a', 'shape:b', 'shape:c'], (id) => on.has(id))).toEqual([
      'shape:a',
      'shape:c',
    ])
  })

  it('refreshes the list on shape deletes and on listed shapes coming back, not on other edits', () => {
    const listed = new Set(['shape:gone'])
    const shape = { typeName: 'shape' }
    expect(touchesDeleted({ added: {}, removed: { 'shape:x': shape } }, listed)).toBe(true)
    expect(touchesDeleted({ added: { 'shape:gone': shape }, removed: {} }, listed)).toBe(true)
    expect(touchesDeleted({ added: { 'shape:new': shape }, removed: {} }, listed)).toBe(false)
    expect(touchesDeleted({ added: {}, removed: { 'binding:x': { typeName: 'binding' } } }, listed)).toBe(
      false,
    )
  })
})
