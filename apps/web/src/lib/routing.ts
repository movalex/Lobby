import { useSyncExternalStore } from 'react'

/** Which list the dashboard shows. `recent` is the landing view of /w/:wid. */
export type DashboardSection =
  | { kind: 'recent' }
  | { kind: 'all' }
  | { kind: 'project'; projectId: string }
  | { kind: 'archived' }
  | { kind: 'trash' }

export type Route =
  | { name: 'root' }
  | { name: 'signin' }
  | { name: 'workspace'; workspaceId: string; section: DashboardSection }
  | { name: 'board'; boardId: string }
  | { name: 'invite'; token: string }
  | { name: 'invalid-board'; raw: string }
  | { name: 'not-found' }

// Mirrors packages/contracts (BOARD_ID_PATTERN and the prefixed id format). Checked here so a bad
// link shows a clear screen instead of a request the API would reject anyway.
const BOARD_ID_RE = /^[a-z0-9][a-z0-9_-]{2,63}$/
const WORKSPACE_ID_RE = /^wsp_[0-9A-Za-z]{10,40}$/
const PROJECT_ID_RE = /^prj_[0-9A-Za-z]{10,40}$/
const MAX_TOKEN = 512

export const isBoardId = (v: unknown): v is string => typeof v === 'string' && BOARD_ID_RE.test(v)
export const isWorkspaceId = (v: unknown): v is string => typeof v === 'string' && WORKSPACE_ID_RE.test(v)

function decode(segment: string): string | null {
  try {
    return decodeURIComponent(segment)
  } catch {
    return null
  }
}

export function matchRoute(pathname: string): Route {
  const path = pathname.length > 1 ? pathname.replace(/\/+$/, '') : pathname
  if (path === '/' || path === '') return { name: 'root' }
  if (path === '/signin') return { name: 'signin' }

  const parts = path.split('/').slice(1)
  const [head, a, b, c] = parts

  if (head === 'b' && a !== undefined && parts.length === 2) {
    const raw = decode(a)
    if (raw === null) return { name: 'invalid-board', raw: a }
    return isBoardId(raw) ? { name: 'board', boardId: raw } : { name: 'invalid-board', raw }
  }

  if (head === 'invite' && a !== undefined && parts.length === 2) {
    const token = decode(a)
    if (!token || token.length > MAX_TOKEN) return { name: 'not-found' }
    return { name: 'invite', token }
  }

  if (head === 'w' && a !== undefined && isWorkspaceId(a)) {
    const workspaceId = a
    if (parts.length === 2) return { name: 'workspace', workspaceId, section: { kind: 'recent' } }
    if (parts.length === 3 && b === 'all') return { name: 'workspace', workspaceId, section: { kind: 'all' } }
    if (parts.length === 3 && b === 'archived')
      return { name: 'workspace', workspaceId, section: { kind: 'archived' } }
    if (parts.length === 3 && b === 'trash')
      return { name: 'workspace', workspaceId, section: { kind: 'trash' } }
    if (parts.length === 4 && b === 'p' && c !== undefined && PROJECT_ID_RE.test(c))
      return { name: 'workspace', workspaceId, section: { kind: 'project', projectId: c } }
  }
  return { name: 'not-found' }
}

export const boardPath = (boardId: string) => `/b/${encodeURIComponent(boardId)}`
export const invitePath = (token: string) => `/invite/${encodeURIComponent(token)}`

export function workspacePath(workspaceId: string, section: DashboardSection = { kind: 'recent' }): string {
  const base = `/w/${encodeURIComponent(workspaceId)}`
  switch (section.kind) {
    case 'recent':
      return base
    case 'project':
      return `${base}/p/${encodeURIComponent(section.projectId)}`
    default:
      return `${base}/${section.kind}`
  }
}

/**
 * Where to go after signing in. Only same-origin paths: a `returnTo` that could leave the site
 * (`//evil.example`, `/\evil`, `https://…`) or loop back to the sign-in page is dropped.
 */
export function safeReturnTo(raw: string | null | undefined): string | null {
  if (!raw || raw.length > 2048 || !raw.startsWith('/') || raw.startsWith('//') || raw.includes('\\'))
    return null
  let url: URL
  try {
    url = new URL(raw, 'http://draftroom.invalid')
  } catch {
    return null
  }
  if (url.origin !== 'http://draftroom.invalid' || url.pathname === '/signin') return null
  return `${url.pathname}${url.search}${url.hash}`
}

export function signInPath(returnTo?: string | null): string {
  const safe = safeReturnTo(returnTo)
  return safe && safe !== '/' ? `/signin?${new URLSearchParams({ returnTo: safe })}` : '/signin'
}

// A tiny history-API router: a handful of routes does not justify a dependency.
const listeners = new Set<() => void>()
const notify = () => {
  for (const l of listeners) l()
}
if (typeof window !== 'undefined') window.addEventListener('popstate', notify)

export function navigate(to: string, opts: { replace?: boolean } = {}) {
  if (`${location.pathname}${location.search}${location.hash}` === to && !opts.replace) return
  if (opts.replace) history.replaceState(null, '', to)
  else history.pushState(null, '', to)
  notify()
}

/** onClick for internal <a href> links: client-side navigation, but modified clicks open new tabs. */
export function linkClick(to: string) {
  return (e: {
    metaKey: boolean
    ctrlKey: boolean
    shiftKey: boolean
    altKey: boolean
    button: number
    preventDefault(): void
  }) => {
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return
    e.preventDefault()
    navigate(to)
  }
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
