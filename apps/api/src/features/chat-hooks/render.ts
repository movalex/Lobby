// A delivery's message, rendered at send time from current rows (wave R, WS2; docs/WAVE-R-CONTRACTS.md §4.4): the event,
// display names (cleanDisplayText), the board title (≤ 80), the link back to Lobby and, only when the hook's admin turned
// the switch on, a comment snippet (≤ 140 characters, never from a team-only thread). Never element data, file names or
// contents, emails or signed URLs. The strings are escaped per provider by the contracts' payload builders (a
// `<!channel>` in a name stays text in Slack; Teams' markdown characters are backslash-escaped).
//
// A private board's title is shown in a channel only when the hook's switch (include_snippets, the admin's "Include
// comment text and private board titles") is on: a hook the admin did not opt in this way says "a private board".

import {
  CHAT_HIDDEN_BOARD_TITLE,
  CHAT_HOOK_KINDS,
  type ChatHookKind,
  type ChatHookProvider,
  type ChatMessage,
  type ChatNotice,
  type ChatReview,
  cleanDisplayText,
  slackNoticePayload,
  slackPayload,
  teamsNoticePayload,
  teamsPayload,
} from '@draftroom/contracts'
import { type NotificationRow, reviewOf, snippetOf } from '../comments/notifications.ts'

const SNIPPET_KINDS: ReadonlySet<string> = new Set(['mention', 'reply', 'new_comment'])

export const isChatKind = (kind: string): kind is ChatHookKind =>
  (CHAT_HOOK_KINDS as readonly string[]).includes(kind)

/** The board's title as this hook may show it. */
export function titleFor(
  r: Pick<NotificationRow, 'board_title' | 'visibility'>,
  includeText: boolean,
): string {
  if (r.visibility === 'private' && !includeText) return CHAT_HIDDEN_BOARD_TITLE
  return cleanDisplayText(r.board_title) || 'Untitled'
}

/** `https://<web origin>/b/<bid>?thread=<tid>`: Lobby sign-in and board access still needed to open it. */
export function boardLink(origin: string, boardId: string, threadId: string | null): string {
  const base = `${origin}/b/${encodeURIComponent(boardId)}`
  return threadId ? `${base}?thread=${encodeURIComponent(threadId)}` : base
}

export const workspaceLink = (origin: string, workspaceId: string) =>
  `${origin}/w/${encodeURIComponent(workspaceId)}`

export interface RenderInput {
  row: NotificationRow
  /** the recipient's display name (the target of a mention or a reply) */
  recipientName: string
  workspaceName: string
  /** the hook's "include comment text and private board titles" switch */
  includeText: boolean
  origin: string
}

/**
 * Wave S (WS1): a review_status message's facts. The item's label (or the round's title) is the board's own words,
 * like a snippet: only under the hook's switch, cut to CHAT_HOOK_LIMITS.reviewLabelChars by the sentence. It never
 * comes from the status's note (a note is a comment thread; its text is never in a review message).
 */
export function chatReviewOf(r: NotificationRow, includeText: boolean): ChatReview | undefined {
  const facts = reviewOf(r)
  if (!facts) return undefined
  if (facts.event === 'round_opened') {
    const label = includeText && facts.roundTitle ? facts.roundTitle : undefined
    return { event: 'round_opened', itemCount: facts.itemCount ?? 0, ...(label ? { label } : {}) }
  }
  if (!facts.status || !facts.reason) return undefined
  const label = includeText && facts.label ? facts.label : undefined
  return { event: 'status', status: facts.status, reason: facts.reason, ...(label ? { label } : {}) }
}

/** The event as a ChatMessage, or null for a kind that never goes to a channel. */
export function messageFor(i: RenderInput): ChatMessage | null {
  const { row: r } = i
  if (!isChatKind(r.kind)) return null
  const actor =
    r.kind === 'outsider_joined'
      ? (r.actor_domain ?? 'unknown')
      : cleanDisplayText(r.actor_name ?? '') || 'Someone'
  const teamOnly = r.thread_visibility !== 'everyone'
  const review = r.kind === 'review_status' ? chatReviewOf(r, i.includeText) : undefined
  const snippet =
    i.includeText && SNIPPET_KINDS.has(r.kind) && !teamOnly
      ? (snippetOf(r.comment_body) ?? undefined)
      : undefined
  return {
    kind: r.kind,
    actor,
    ...(r.kind === 'mention' || r.kind === 'reply'
      ? { target: cleanDisplayText(i.recipientName) || 'you' }
      : {}),
    boardTitle: titleFor(r, i.includeText),
    link: boardLink(i.origin, r.board_id, r.thread_id),
    workspaceName: i.workspaceName,
    ...(snippet ? { snippet } : {}),
    ...(r.kind === 'access_request' && r.request_role ? { role: r.request_role } : {}),
    ...(review ? { review } : {}),
  }
}

/** The JSON body for `provider`. */
export function payloadFor(provider: ChatHookProvider, m: ChatMessage): Record<string, unknown> {
  return provider === 'slack' ? slackPayload(m) : teamsPayload(m)
}

export function noticePayloadFor(provider: ChatHookProvider, n: ChatNotice): Record<string, unknown> {
  return provider === 'slack' ? slackNoticePayload(n) : teamsNoticePayload(n)
}
