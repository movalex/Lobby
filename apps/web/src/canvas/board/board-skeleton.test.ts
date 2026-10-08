// K1-5 (wave K): the board skeleton (./BoardSkeleton.tsx), rendered as the page would: the board's title
// from the board's own answer or a hint (a link the person reached: lib/prefetch-board.ts), a neutral
// placeholder otherwise, the workspace named from the session, the read-only toolbar's shape, and never
// "Saved" or "Live" (nothing is synced yet).
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { rememberBoardTitle } from '../../lib/prefetch-board.ts'
import {
  BoardSkeleton,
  type BoardSkeletonProps,
  boardSkeletonView,
  SkeletonToolbar,
} from './BoardSkeleton.tsx'

const render = (p: BoardSkeletonProps) => renderToStaticMarkup(createElement(BoardSkeleton, p))
const text = (html: string) =>
  html
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
const WORKSPACES = [
  { id: 'wsp_0123456789ab', name: 'Dev Studio' },
  { id: 'wsp_ba9876543210', name: 'Client work' },
]

describe('the board skeleton', () => {
  it('a hint (the link the person reached) names the board and, through the session, its workspace', () => {
    rememberBoardTitle('b-skel000001', 'Launch plan', 'wsp_ba9876543210')
    const html = render({ boardId: 'b-skel000001', workspaces: WORKSPACES })
    expect(html).toContain('data-testid="board-skeleton"')
    expect(html).toMatch(
      /<h1 class="dr-topbar__title" data-testid="board-skeleton-title"[^>]*>Launch plan<\/h1>/,
    )
    expect(html).toContain('<span class="dr-topbar__ws">Client work</span>')
    expect(html).not.toContain('data-placeholder')
  })

  it('the board’s own answer wins over a hint', () => {
    rememberBoardTitle('b-skel000002', 'Old name', 'wsp_0123456789ab')
    const html = render({
      boardId: 'b-skel000002',
      title: 'New name',
      workspace: { id: 'wsp_0123456789ab', name: 'Dev Studio' },
    })
    expect(text(html)).toContain('New name')
    expect(text(html)).not.toContain('Old name')
  })

  it('nothing known: a neutral placeholder for the title and the workspace, and the words for a screen reader', () => {
    const html = render({ boardId: 'b-skel000003' })
    expect(html).toMatch(/data-testid="board-skeleton-title" data-placeholder="true"/)
    expect(html).toContain('lobby-skeleton__bone--ws')
    expect(text(html)).toBe('/ Opening board…')
    // a hint for a workspace this person is not in: the board's title, no workspace name
    rememberBoardTitle('b-skel000004', 'Shared with me', 'wsp_notmine0000')
    expect(boardSkeletonView({ boardId: 'b-skel000004', workspaces: WORKSPACES })).toMatchObject({
      title: 'Shared with me',
      workspaceName: null,
    })
  })

  it('never says Saved or Live, in any state', () => {
    for (const p of [
      { boardId: 'b-skel000006' },
      { boardId: 'b-skel000006', readonly: true },
      { boardId: 'b-skel000006', title: 'Board', workspace: WORKSPACES[0] },
    ] satisfies BoardSkeletonProps[]) {
      const words = text(render(p))
      expect(words).not.toMatch(/\bSaved\b|\bLive\b|Saving|Offline/)
      expect(render(p)).not.toContain('save-status')
      expect(render(p)).not.toContain('conn-status')
    }
  })

  it('the greyed toolbar: the editor’s shape, or the read-only one; never a button to press', () => {
    const editor = renderToStaticMarkup(createElement(SkeletonToolbar, {}))
    const viewer = renderToStaticMarkup(createElement(SkeletonToolbar, { readonly: true }))
    expect(editor.match(/lobby-skeleton__bone--tool/g)?.length).toBe(9)
    expect(viewer.match(/lobby-skeleton__bone--tool/g)?.length).toBe(2)
    expect(viewer).toContain('data-readonly="true"')
    expect(editor).toContain('aria-hidden="true"')
    expect(render({ boardId: 'b-skel000007' })).not.toMatch(/<button|<a /)
  })
})
