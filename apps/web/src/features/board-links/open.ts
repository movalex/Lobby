// OWNER: WS7 (wave N, N7-1, N7-5). Opening a board link from Lobby's own UI (a board card's face, "Linked from"):
//  - a plain click goes there in this tab, through the app's router (the board page reads `?el=` and zooms to the
//    element: features/canvas-ux/ported/navigation/start-view.ts);
//  - Ctrl, Cmd or Shift click, and a middle click, open a new tab without an opener or a referrer.
// Only Lobby-relative board paths are opened (`/b/…`); anything else is ignored. Pure apart from the window and
// the router.
import type { MouseEvent as ReactMouseEvent } from 'react'
import { navigate } from '../../lib/routing.ts'
import { countUsage } from '../../lib/usage.ts'

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

/** Opens a Lobby-relative board path here (the router) or in a new tab (no opener, no referrer). */
export function openBoardPath(path: string, way: 'here' | 'tab'): void {
  if (!path.startsWith('/b/') || path.startsWith('//')) return
  if (way === 'here') {
    navigate(path)
    return
  }
  try {
    window.open(new URL(path, window.location.origin).href, '_blank', 'noopener,noreferrer')
  } catch {}
}

/**
 * onClick / onAuxClick for an <a href={path}> that opens a board link (its own default is prevented, so the tab
 * never opens with an opener or sends a referrer whatever the browser does by default).
 */
export function boardLinkHandlers(
  path: string,
  opts: { counted?: 'boardlinks.open' | 'boardlinks.backlinks' } = {},
) {
  const handle = (e: ClickLike) => {
    const way = openWay(e)
    if (!way) return
    e.preventDefault()
    e.stopPropagation()
    if (opts.counted) countUsage(opts.counted)
    openBoardPath(path, way)
  }
  return { onClick: handle, onAuxClick: handle }
}
