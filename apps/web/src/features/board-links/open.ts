// OWNER: WS7 (wave N, N7-1, N7-5). Opening a board link from Lobby's own UI (a board card's face, "Linked from"):
//  - a plain click goes there in this tab, through the app's router (the board page reads `?el=` and zooms to the
//    element: features/canvas-ux/ported/navigation/start-view.ts);
//  - a link to the board this page already shows (a frame link from "Copy link" pasted back onto its own board) is
//    applied in place instead: the router would only change the address, since the board page neither remounts nor
//    reads `?el=` again, so the element is selected and the camera goes to it (the deep link's own rules,
//    navigateToDeepLink), and a link without `?el=` goes to the board's start view;
//  - Ctrl, Cmd or Shift click, and a middle click, open a new tab without an opener or a referrer;
//  - an Alt click does nothing (and the browser's own Alt click, a download of the link, is prevented).
// Only Lobby-relative board paths are opened (`/b/…`); anything else is ignored. Pure apart from the window, the
// router and the canvas.
import { parseBoardLinkPath } from '@draftroom/contracts'
import type { MouseEvent as ReactMouseEvent } from 'react'
import type { CanvasFeatureContext } from '../../canvas/api/index.ts'
import { navigate } from '../../lib/routing.ts'
import { countUsage } from '../../lib/usage.ts'
import { goToStartView, navigateToDeepLink } from '../canvas-ux/ported/navigation/start-view.ts'

type ClickLike = Pick<
  ReactMouseEvent,
  'button' | 'ctrlKey' | 'metaKey' | 'shiftKey' | 'altKey' | 'preventDefault' | 'stopPropagation'
>

/** How a click opens a link: here (a plain left click), in a new tab (modified or middle), or not at all. */
export function openWay(
  e: Pick<ClickLike, 'button' | 'ctrlKey' | 'metaKey' | 'shiftKey' | 'altKey'>,
): 'here' | 'tab' | null {
  if (e.button === 1) return 'tab'
  if (e.button !== 0) return null
  if (e.ctrlKey || e.metaKey || e.shiftKey) return 'tab'
  return e.altKey ? null : 'here'
}

/** The board page a link is opened from: a link to this board is applied in place (see the top of this file). */
export interface OpenFrom {
  /** the board the page shows */
  readonly boardId: string
  /** goes to `elementId` on it (null: the board's start view) */
  show(elementId: string | null): void
}

/** The board page of `ctx` as an OpenFrom: its own links select the element and move the camera to it. */
export function openFrom(ctx: Pick<CanvasFeatureContext, 'board' | 'canvas'>): OpenFrom {
  return {
    boardId: ctx.board.id,
    show(elementId) {
      if (elementId) navigateToDeepLink(ctx.canvas, { kind: 'elements', ids: [elementId] })
      else goToStartView(ctx.canvas)
      // the link (or the list) had the keyboard: the board gets it back, with the element selected
      try {
        ctx.canvas.focus({ preventScroll: true })
      } catch {}
    },
  }
}

/**
 * Opens a Lobby-relative board path here (the router; in place when it is `from`'s own board) or in a new tab (no
 * opener, no referrer).
 */
export function openBoardPath(path: string, way: 'here' | 'tab', from?: OpenFrom): void {
  if (!path.startsWith('/b/') || path.startsWith('//')) return
  if (way === 'here') {
    const target = parseBoardLinkPath(path)
    if (from && target && target.boardId === from.boardId) {
      from.show(target.elementId)
      return
    }
    navigate(path)
    return
  }
  try {
    window.open(new URL(path, window.location.origin).href, '_blank', 'noopener,noreferrer')
  } catch {}
}

/**
 * onClick / onAuxClick for an <a href={path}> that opens a board link (its own default is prevented, so the tab
 * never opens with an opener or sends a referrer whatever the browser does by default). `from`: the board page it is
 * on (its own links are applied in place).
 */
export function boardLinkHandlers(
  path: string,
  opts: { counted?: 'boardlinks.open' | 'boardlinks.backlinks'; from?: OpenFrom } = {},
) {
  const handle = (e: ClickLike) => {
    const way = openWay(e)
    if (!way) {
      // Alt click: the browser would download the link's target
      if (e.button === 0 && e.altKey) e.preventDefault()
      return
    }
    e.preventDefault()
    e.stopPropagation()
    if (opts.counted) countUsage(opts.counted)
    openBoardPath(path, way, opts.from)
  }
  return { onClick: handle, onAuxClick: handle }
}
