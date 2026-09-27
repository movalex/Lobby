import { useSyncExternalStore } from 'react'

export type Route =
  | { name: 'home' }
  | { name: 'board'; boardId: string }
  | { name: 'invalid-board'; raw: string }
  | { name: 'not-found' }

const BOARD_PATH_RE = /^\/b\/([^/]+)\/?$/

export function matchRoute(pathname: string, isBoardId: (id: string) => boolean): Route {
  if (pathname === '/' || pathname === '') return { name: 'home' }
  const m = BOARD_PATH_RE.exec(pathname)
  if (m?.[1] !== undefined) {
    let raw: string
    try {
      raw = decodeURIComponent(m[1])
    } catch {
      return { name: 'invalid-board', raw: m[1] }
    }
    return isBoardId(raw) ? { name: 'board', boardId: raw } : { name: 'invalid-board', raw }
  }
  return { name: 'not-found' }
}

export const boardPath = (boardId: string) => `/b/${encodeURIComponent(boardId)}`

// A tiny history-API router: the app has two routes, which does not justify a dependency.
const listeners = new Set<() => void>()
const notify = () => {
  for (const l of listeners) l()
}
if (typeof window !== 'undefined') window.addEventListener('popstate', notify)

export function navigate(to: string, opts: { replace?: boolean } = {}) {
  if (opts.replace) history.replaceState(null, '', to)
  else history.pushState(null, '', to)
  notify()
}

function subscribe(cb: () => void) {
  listeners.add(cb)
  return () => {
    listeners.delete(cb)
  }
}
const snapshot = () => `${location.pathname}${location.search}`

/** Re-renders on navigate()/back/forward. Returns `pathname + search`. */
export function useLocationKey(): string {
  return useSyncExternalStore(subscribe, snapshot, snapshot)
}
