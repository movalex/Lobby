// Bridge release R0 (docs/EXCALIDRAW-MIGRATION.md §5.9 step 4): a board made on the new canvas shows a
// "New canvas" badge on the dashboard, and the card says in words, on screen, when it opens again (the
// verifier: "after the switch" in a tooltip explained nothing). People only see it during a rollback.
import type { BoardWithRole } from '@draftroom/contracts'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { BoardCard } from './BoardCard.tsx'

const board: BoardWithRole = {
  id: 'b-newcanvas1',
  workspaceId: 'ws_0000000001',
  projectId: null,
  title: 'Moodboard',
  visibility: 'workspace_view',
  status: 'active',
  trashedAt: null,
  createdBy: 'usr_0000000001',
  createdAt: '2026-10-01T10:00:00.000Z',
  updatedAt: '2026-10-01T10:00:00.000Z',
  lastOpenedAt: null,
  role: 'editor',
}

const card = (b: BoardWithRole, layout: 'grid' | 'list' = 'grid') =>
  renderToStaticMarkup(
    createElement(BoardCard, {
      board: b,
      renaming: false,
      busy: false,
      now: new Date('2026-10-02T10:00:00.000Z'),
      layout,
      onAction: () => {},
      onRename: () => {},
      onRenameCancel: () => {},
    }),
  )

describe('a board made on the new canvas, on its dashboard card', () => {
  it('shows the badge and, on the card, when it opens again; no jargon, no tooltip-only meaning', () => {
    for (const layout of ['grid', 'list'] as const) {
      const html = card({ ...board, newCanvas: true }, layout)
      expect(html).toMatch(
        /<span class="dr-bcard__canvas" data-testid="board-card-new-canvas">New canvas<\/span>/,
      )
      expect(html).toContain(
        '<span class="dr-bcard__canvas-note" data-testid="board-card-new-canvas-note">Opens again when Lobby is back on the new canvas.</span>',
      )
      expect(html).not.toMatch(/switch/i)
    }
  })

  it('other boards carry neither', () => {
    const html = card(board)
    expect(html).not.toContain('board-card-new-canvas')
    expect(html).not.toContain('new canvas')
  })
})
