// What the chat notification settings say (wave R, WS2): the words for kinds, providers, a hook's state and the
// answers of the api, and the pure steps behind the two panels. Nothing here touches the network or the DOM.
import {
  CHAT_HOOK_KINDS,
  type ChatHook,
  type ChatHookDisableReason,
  type ChatHookKind,
  type ChatHookProvider,
  type ChatPrefsResponse,
  type PutChatPrefsInput,
  type TestChatHookResponse,
} from '@draftroom/contracts'
import { formatRelativeTime } from '../../lib/format.ts'
import type { ChatHookRequestError } from './client.ts'

export const PROVIDER_LABEL: Readonly<Record<ChatHookProvider, string>> = {
  slack: 'Slack',
  teams: 'Microsoft Teams',
}

/** A kind, as a person chooses it (all off until chosen). */
export const KIND_LABEL: Readonly<Record<ChatHookKind, string>> = {
  mention: 'Someone mentions me',
  reply: 'Someone replies in a thread I follow',
  new_comment: 'Someone starts a comment thread on a board I own',
  access_request: 'Someone asks for access to a board I manage',
  outsider_joined: 'Someone from outside opens a board I manage',
}

export const MY_NOTIFICATIONS_INTRO =
  'Get a message in a Slack or Teams channel when one of these happens to you in Lobby. Everything is off until you choose it, and you can change your mind any time.'

export const CHANNEL_NOTE =
  'Everyone in the channel sees the message, including people from outside your team who were added to that channel. It names the board (not for a private board, unless an admin allowed it) and links back to Lobby, where signing in is still needed.'

export const ADMIN_WARNING =
  'Everyone in a channel sees these messages, including guests of that channel. A message names what happened, the people involved by display name, the board and a link back to Lobby (sign-in needed). It never carries files or emails. Comment text and the names of private boards stay out of the channel unless you turn the switch on for that channel.'

export const SNIPPET_SWITCH_LABEL = 'Include comment text and private board titles'
export const SNIPPET_SWITCH_HELP =
  'Off: only the event and a link, and a private board is called “a private board”. On: the first 140 characters of a comment (never from a team-only thread) and the real title of a private board.'

export const OFF_TEXT = 'Chat notifications are not switched on for this Lobby yet.'

export const HOW_TO: Readonly<Record<ChatHookProvider, readonly string[]>> = {
  slack: [
    'Open api.slack.com/apps and choose Create New App, then From scratch.',
    'Choose Incoming Webhooks and turn it on.',
    'Choose Add New Webhook to Workspace, pick the channel, and allow it.',
    'Copy the webhook URL (it starts with https://hooks.slack.com/services/) and paste it here.',
  ],
  teams: [
    'In Teams, open the channel’s ⋯ menu and choose Workflows.',
    'Pick “Post to a channel when a webhook request is received” and finish the steps.',
    'Copy the URL it gives you and paste it here. Messages appear from the Workflows bot.',
  ],
}

/** A hook's last answer, in words (a code only is ever stored: an HTTP status, `timeout`, `network`…). */
export function errorCodeText(code: string): string {
  if (code === 'timeout') return 'it did not answer in time'
  if (code === 'network' || code === 'blocked') return 'Lobby could not reach it'
  if (code === 'unsealed') return 'Lobby can no longer read the saved URL: paste it again'
  if (code === 'redirect') return 'it tried to send Lobby somewhere else'
  if (code === '429') return 'it asked Lobby to slow down'
  if (/^5\d\d$/.test(code)) return `it had a problem (${code})`
  return `it answered ${code}`
}

export const DISABLED_TEXT: Readonly<Record<ChatHookDisableReason, string>> = {
  forbidden: 'refused the messages (the URL was revoked or is not allowed)',
  'not-found': 'could not find the channel or webhook (was it deleted?)',
  gone: 'says the webhook is gone',
  retired: 'uses an address that is no longer accepted',
}

/** "Last sent 5 min ago" / "Switched off: …" / "Not used yet", for one line under a hook. */
export function hookStatusLine(hook: ChatHook, now: Date = new Date()): string {
  const provider = PROVIDER_LABEL[hook.provider]
  if (hook.disabledAt && hook.disabledReason)
    return `Switched off: ${provider} ${DISABLED_TEXT[hook.disabledReason]}.`
  const failed = hook.lastErrorCode ? ` Last try failed: ${errorCodeText(hook.lastErrorCode)}.` : ''
  if (hook.lastOkAt) return `Last sent ${formatRelativeTime(hook.lastOkAt, now)}.${failed}`
  return `Not used yet.${failed}`
}

/** After "Send test message": "sent" means the receiver accepted it, never "delivered". */
export function testResultText(r: TestChatHookResponse, provider: ChatHookProvider): string {
  if (r.status === 'sent')
    return provider === 'teams'
      ? 'Test message sent. Teams can take a minute to show it in the channel.'
      : 'Test message sent. Look for it in the channel.'
  return `The test message was not accepted: ${errorCodeText(r.code ?? 'network')}.`
}

/** The text for a request that failed, from the api’s own user-safe message when it gave one. */
export function requestErrorText(e: ChatHookRequestError, fallback: string): string {
  if (e.code === 'unavailable' || e.code === 'CHAT_HOOKS_OFF') return OFF_TEXT
  if (e.code === 'CREATOR_REQUIRED') return e.detail ?? 'Only creators who manage this workspace can do that.'
  return e.detail ?? fallback
}

// ---- "My notifications": the chosen kinds per hook ----------------------------------------------------------------

export type Chosen = Readonly<Record<string, readonly ChatHookKind[]>>

export function chosenFrom(prefs: ChatPrefsResponse): Chosen {
  return Object.fromEntries(prefs.prefs.map((p) => [p.hookId, p.kinds]))
}

/** The kinds with `kind` turned on or off for a hook, in the contract's order. */
export function toggled(chosen: Chosen, hookId: string, kind: ChatHookKind, on: boolean): Chosen {
  const now = new Set(chosen[hookId] ?? [])
  if (on) now.add(kind)
  else now.delete(kind)
  return { ...chosen, [hookId]: CHAT_HOOK_KINDS.filter((k) => now.has(k)) }
}

/** The whole choice for a workspace, as the api takes it (a hook with no kinds is left out). */
export function prefsInput(workspaceId: string, hookIds: readonly string[], chosen: Chosen): PutChatPrefsInput {
  return {
    workspaceId,
    prefs: hookIds.flatMap((hookId) => {
      const kinds = chosen[hookId] ?? []
      return kinds.length > 0 ? [{ hookId, kinds: [...kinds] }] : []
    }),
  }
}

export const sameChoice = (a: Chosen, b: Chosen, hookIds: readonly string[]) =>
  hookIds.every((id) => (a[id] ?? []).join(',') === (b[id] ?? []).join(','))
