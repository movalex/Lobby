// P-022 (wave P): "Board link": who can open it with the link and Copy board link are one section (they were "Workspace
// access" under the people and a "Copy board link" footer). Markup only; the order in the dialog and the clicks are
// e2e/excalidraw/k5-share.spec.ts.
import type { Board } from '@draftroom/contracts'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BoardLink } from './ShareDialog.tsx'

const board = (visibility: Board['visibility']): Board => ({ id: 'b-abc1234567', visibility }) as Board

const render = (visibility: Board['visibility'], over: { editable?: boolean; linkNote?: string | null } = {}) =>
  renderToStaticMarkup(
    createElement(BoardLink, {
      board: board(visibility),
      workspaceName: 'Dev Studio',
      editable: over.editable ?? true,
      canRaise: true,
      linkNote: over.linkNote ?? null,
      onChange: async () => {},
    }),
  )

beforeEach(() => vi.stubGlobal('location', { origin: 'https://lobby.example.test' }))
afterEach(() => vi.unstubAllGlobals())

describe('the board link section', () => {
  it('is one section: its heading, who can open it, and the copy button', () => {
    const html = render('private')
    expect(html.split('<section').length - 1).toBe(1)
    expect(html).toContain('data-testid="share-link"')
    expect(html).toContain('>Board link</h3>')
    expect(html).toContain('data-testid="visibility-select"')
    expect(html).toContain('data-testid="share-copy-link"')
    expect(html).toContain('Copy board link')
    // the old section's name is gone
    expect(html).not.toContain('Workspace access')
  })

  it('says what the link lets people do, and that anyone else can ask', () => {
    expect(render('private')).toContain(
      'Only the people listed above can open this board. Anyone else who opens the link can request access.',
    )
    expect(render('workspace_edit')).toContain('Everyone in Dev Studio can open and edit this board.')
  })

  it('a person who may not change it sees the setting, disabled, and an open link named', () => {
    const html = render('workspace_view', { editable: false, linkNote: 'A client link is open until 3 Nov.' })
    expect(html).toMatch(/<select[^>]*disabled/)
    expect(html).toContain('data-testid="share-link-note"')
    expect(html).toContain('A client link is open until 3 Nov.')
  })
})
