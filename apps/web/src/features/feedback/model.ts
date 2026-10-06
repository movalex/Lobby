// The pure part of the "Send feedback" button (wave J5): the context block the dialog shows and sends, the
// limits it enforces before the api does, and the words for what can go wrong. No DOM, no network.

import { FEEDBACK_TEXT_MAX, type FeedbackContext } from '@draftroom/contracts'
import { ApiError } from '../../api/client.ts'

export { FEEDBACK_TEXT_MAX }

/** The board the feedback is about, when it is sent from one. */
export interface FeedbackBoard {
  id: string
  title: string
}

/** What the page knows about itself (injected, so tests need no browser). */
export interface ContextSources {
  pathname: string
  userAgent: string
  width: number
  height: number
  build: string
  now: Date
  board: FeedbackBoard | null
}

/**
 * The block attached to every message, which the person sees before sending: the page path (never a query
 * string or fragment: they can hold tokens), the board's id and title when on a board, browser and OS (the
 * user agent), the viewport, the app build and the time. The api validates it again field by field.
 */
export function buildContext(s: ContextSources): FeedbackContext {
  const path = s.pathname.split(/[?#]/, 1)[0] || '/'
  return {
    path,
    boardId: s.board?.id ?? null,
    boardTitle: s.board?.title ?? null,
    userAgent: s.userAgent,
    viewport: { width: Math.round(s.width), height: Math.round(s.height) },
    build: s.build,
    at: s.now.toISOString(),
  }
}

export interface ContextRow {
  key: 'page' | 'board' | 'browser' | 'viewport' | 'build' | 'time'
  label: string
  value: string
}

/** The rows the dialog lists under "Sent with your message", in the order they read best. */
export function contextRows(c: FeedbackContext, formatTime: (iso: string) => string): ContextRow[] {
  const rows: ContextRow[] = [{ key: 'page', label: 'Page', value: c.path }]
  if (c.boardId)
    rows.push({
      key: 'board',
      label: 'Board',
      value: c.boardTitle ? `${c.boardTitle} (${c.boardId})` : c.boardId,
    })
  rows.push(
    { key: 'browser', label: 'Browser', value: c.userAgent || 'unknown' },
    { key: 'viewport', label: 'Window', value: `${c.viewport.width} × ${c.viewport.height}` },
    { key: 'build', label: 'App build', value: c.build },
    { key: 'time', label: 'Time', value: formatTime(c.at) || c.at },
  )
  return rows
}

/** Characters as the api counts them (code points: an emoji is one). */
export const countChars = (s: string): number => {
  let n = 0
  for (const _ of s) n++
  return n
}

/** Whether the message can be sent: something to say, and nothing over the limit. */
export function canSend(text: string, expected: string): boolean {
  return (
    text.trim().length > 0 &&
    countChars(text.trim()) <= FEEDBACK_TEXT_MAX &&
    countChars(expected.trim()) <= FEEDBACK_TEXT_MAX
  )
}

/** The body of POST /api/feedback. */
export function toInput(text: string, expected: string, context: FeedbackContext) {
  const e = expected.trim()
  return { text: text.trim(), ...(e ? { expected: e } : {}), context }
}

/** What to tell the person when sending failed (the server's own words when it has some for them). */
export function sendErrorMessage(e: unknown): string {
  if (e instanceof ApiError) {
    switch (e.kind) {
      case 'network':
        return 'Can’t reach Lobby. Check your connection, then send it again: what you wrote is still here.'
      case 'unauthorized':
        return 'Your session has ended. Sign in again, then send it: what you wrote is still here.'
      case 'not-found':
        // an api that does not have the route yet (the web deploys after it, so only a rollback gets here)
        return 'Feedback is not available right now. Try again in a few minutes: what you wrote is still here.'
      case 'rate-limited':
        return e.message
      case 'server':
        return 'Lobby had a problem saving that. Try again in a moment: what you wrote is still here.'
      default:
        return e.message
    }
  }
  return 'That was not sent. Try again: what you wrote is still here.'
}
