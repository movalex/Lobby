// Wave P (P-042): a board nobody has edited says "Created …", not "Edited just now".
import type { BoardWithRole } from '@draftroom/contracts'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { BoardCard } from './BoardCard.tsx'
import { boardWhen } from './model.ts'

const NOW = new Date('2026-10-02T10:00:30.000Z')
const board: BoardWithRole = {
  id: 'b-whenwhen01',
  workspaceId: 'ws_0000000001',
  projectId: null,
  title: 'Moodboard',
  visibility: 'private',
  status: 'active',
  trashedAt: null,
  createdBy: 'usr_0000000001',
  createdAt: '2026-10-02T10:00:00.000Z',
  updatedAt: '2026-10-02T10:00:00.000Z',
  lastOpenedAt: null,
  role: 'owner',
}

const html = (b: BoardWithRole) =>
  renderToStaticMarkup(
    createElement(BoardCard, {
      board: b,
      renaming: false,
      busy: false,
      now: NOW,
      onAction: () => {},
      onRename: () => {},
      onRenameCancel: () => {},
    }),
  )

describe('what a card says about time', () => {
  it('a board nobody has edited says when it was created', () => {
    expect(boardWhen(board, NOW)).toBe('Created just now')
    expect(html(board)).toContain('<span>Created just now</span>')
    expect(html(board)).not.toContain('Edited')
  })

  it('a board with a later change says when it was edited', () => {
    const edited = { ...board, updatedAt: '2026-10-02T10:00:20.000Z' }
    expect(boardWhen(edited, NOW)).toBe('Edited just now')
    expect(html(edited)).toContain('<span>Edited just now</span>')
  })

  it('the save that comes with making the board (a second or two) is not an edit', () => {
    expect(boardWhen({ ...board, updatedAt: '2026-10-02T10:00:01.500Z' }, NOW)).toBe('Created just now')
  })

  it('a trashed board says when it was trashed', () => {
    const trashed = { ...board, status: 'trashed' as const, trashedAt: '2026-10-02T09:00:00.000Z' }
    expect(boardWhen(trashed, NOW)).toBe('Trashed 1 h ago')
  })
})
