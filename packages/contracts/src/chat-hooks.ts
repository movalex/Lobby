// Notifications to Slack and Teams (wave R, WS2; docs/WAVE-R-CONTRACTS.md §4; the reviewed egress exception in
// AGENTS.md "Server egress exception: chat notifications"). OWNER: WS2 after the wave R foundation. Frozen by it.
//
//   GET    /api/workspaces/:wid/chat-hooks            → 200 ListChatHooksResponse   (owners/admins who are creators)
//   POST   /api/workspaces/:wid/chat-hooks            CreateChatHookInput → 201 ChatHook (the same)
//   PATCH  /api/workspaces/:wid/chat-hooks/:hid       PatchChatHookInput  → 200 ChatHook (the same)
//   DELETE /api/workspaces/:wid/chat-hooks/:hid       → 204                 (any owner or admin: removing is lowering)
//   POST   /api/workspaces/:wid/chat-hooks/:hid/test  → 200 TestChatHookResponse (owners/admins who are creators)
//   GET    /api/me/chat-prefs?workspace=:wid           → 200 ChatPrefsResponse  (any member; never a guest)
//   PUT    /api/me/chat-prefs                          PutChatPrefsInput → 200 ChatPrefsResponse
//
// A hook is a workspace's incoming-webhook URL for one channel, pasted by an owner or admin who is a creator. The URL
// is a secret (whoever has it can post to the channel): it is checked with checkChatHookUrl (CHAT_HOOK_RULES), sealed
// with AES-256-GCM under DRAFTROOM_WEBHOOK_SECRET (apps/api/src/crypto/sealed.ts; AAD `workspaceId:hookId`), and only
// its hint ever leaves the server. With the secret unset, hooks are switched off (every route above answers 404
// CHAT_HOOKS_OFF: fail closed). A person's events go to a hook only after that person opted in for that hook and
// kind (all off by default); each send re-checks their access to the board.
//
// A message carries only the event, display names (cleanDisplayText), the board title (≤ 80 characters), a link back
// to Lobby (which needs Lobby sign-in and board access) and, only when the hook's admin turned `includeSnippets` on, a
// comment snippet of at most 140 characters, never from a team-only thread. The same switch decides whether a PRIVATE
// board's title may be named in the channel (else the message says CHAT_HIDDEN_BOARD_TITLE): a channel's audience is wider
// than a private board's. Never element data, file names or contents, emails or signed URLs. Slack payloads switch
// unfurling off.
//
// Do not import values from ./index.ts here: index.ts re-exports this module.

import { z } from 'zod'
import { cleanDisplayText } from './outside.ts'
import { parseUrl, type WhatwgUrl } from './whatwg-url.ts'

const UserIdLike = z.string().regex(/^usr_[0-9A-Za-z]{10,40}$/)
const WorkspaceIdLike = z.string().regex(/^wsp_[0-9A-Za-z]{10,40}$/)

// ---- ids, providers, kinds, limits ----------------------------------------------------------------------------------

export const CHAT_HOOK_ID_PATTERN = /^chk_[0-9A-Za-z]{10,40}$/
export const ChatHookId = z.string().regex(CHAT_HOOK_ID_PATTERN)

export const CHAT_HOOK_PROVIDERS = ['slack', 'teams'] as const
export const ChatHookProvider = z.enum(CHAT_HOOK_PROVIDERS)
export type ChatHookProvider = z.infer<typeof ChatHookProvider>

/**
 * The notification kinds a person may send to a hook (contracts comments.ts NotificationKind): `resolved` and
 * `access_granted` stay bell-only. The 0036 CHECK holds chat_hook_prefs.kinds to this list.
 */
export const CHAT_HOOK_KINDS = [
  'mention',
  'reply',
  'new_comment',
  'access_request',
  'outsider_joined',
] as const
export const ChatHookKind = z.enum(CHAT_HOOK_KINDS)
export type ChatHookKind = z.infer<typeof ChatHookKind>

export const CHAT_HOOK_LIMITS = {
  hooksPerWorkspace: 20,
  nameChars: 80,
  /** a pasted URL, UTF-8 bytes */
  urlBytes: 2048,
  /** a comment snippet (only with includeSnippets) */
  snippetChars: 140,
  /** the board title in a message */
  titleChars: 80,
  /** a display name in a message */
  nameInMessageChars: 80,
  /** Slack: one section's text */
  slackSectionChars: 3_000,
  /** Teams: the whole card (Teams refuses about 28 KB) */
  teamsCardBytes: 25_000,
  /** one POST: the whole request */
  requestTimeoutMs: 5_000,
  /** bytes of the answer read (and then dropped) */
  answerBytes: 4_096,
} as const

/** Delivery pacing (the api's outbox loop, apps/api/src/features/chat-hooks). */
export const CHAT_DELIVERY = {
  loopMs: 2_000,
  /** rows claimed per pass (FOR UPDATE SKIP LOCKED) */
  batch: 20,
  /** a claimed row's lease */
  leaseMs: 60_000,
  /** Slack's documented incoming-webhook rate; the same for Teams */
  perHookPerSecond: 1,
  perRecipientPerHour: 30,
  perWorkspacePerHour: 600,
  /** 5xx, network errors and timeouts: wait this long before each next try, then `failed` */
  backoffMs: [30_000, 120_000, 600_000, 1_800_000, 7_200_000],
  /** a 429's Retry-After is honoured up to this */
  maxRetryAfterMs: 600_000,
  /** outbox rows are purged after this many days */
  retentionDays: 14,
} as const

export const CHAT_DELIVERY_STATUSES = ['queued', 'sending', 'sent', 'failed', 'dropped', 'coalesced'] as const
export type ChatDeliveryStatus = (typeof CHAT_DELIVERY_STATUSES)[number]

/** Why a hook was switched off by a delivery's answer (an admin sees it in settings and can re-enable it). */
export const CHAT_HOOK_DISABLE_REASONS = ['forbidden', 'not-found', 'gone', 'retired'] as const
export type ChatHookDisableReason = (typeof CHAT_HOOK_DISABLE_REASONS)[number]

export const CHAT_HOOK_CODES = {
  /** 400: not a URL the provider's rules accept */
  urlInvalid: 'CHAT_HOOK_URL_INVALID',
  /** 400: an Office 365 connector or an old Workflows URL (retired by Microsoft) */
  urlRetired: 'CHAT_HOOK_URL_RETIRED',
  /** 409: the workspace holds CHAT_HOOK_LIMITS.hooksPerWorkspace hooks */
  full: 'CHAT_HOOKS_FULL',
  /** 404: DRAFTROOM_WEBHOOK_SECRET is not set on this server, so hooks are off */
  off: 'CHAT_HOOKS_OFF',
} as const

// ---- URL rules (SSRF; pure, no DNS: the api's egress module vets and pins the address after these) ------------------

export interface ChatHookRule {
  readonly provider: ChatHookProvider
  /** exact lower-case host, or a pattern for providers whose host carries a tenant */
  readonly host: string | RegExp
  readonly path: RegExp
  /** the query keys the URL must have, each exactly once, and no others (empty: no query at all) */
  readonly query: readonly string[]
}

/**
 * The accepted URLs. The Teams host and path are UNVERIFIED (third-party write-ups of the Workflows "Post to a channel
 * when a webhook request is received" template): the foundation's lead confirms them with one real URL from the owner
 * (one paste, no message sent) before WS2 ships, and changes only this table.
 */
export const CHAT_HOOK_RULES: readonly ChatHookRule[] = [
  {
    provider: 'slack',
    host: 'hooks.slack.com',
    path: /^\/services\/T[A-Z0-9]+\/B[A-Z0-9]+\/[A-Za-z0-9]+$/,
    query: [],
  },
  {
    provider: 'teams',
    host: /^[a-z0-9-]+\.[a-z0-9]{2}\.environment\.api\.powerplatform\.com$/,
    path: /^\/powerautomate\/automations\/direct\/workflows\/[0-9a-f]+\/triggers\/manual\/paths\/invoke$/,
    query: ['api-version', 'sp', 'sv', 'sig'],
  },
]

/** Hosts Microsoft switched off: refused with a message that says what to use instead. */
export const RETIRED_CHAT_HOOK_HOSTS: readonly { readonly host: RegExp; readonly message: string }[] = [
  {
    host: /(^|\.)webhook\.office\.com$/,
    message:
      'Office 365 connector webhooks were switched off by Microsoft in May 2026. In Teams, use Workflows: "Post to a channel when a webhook request is received".',
  },
  {
    host: /^outlook\.office\.com$/,
    message:
      'Office 365 connector webhooks were switched off by Microsoft in May 2026. In Teams, use Workflows: "Post to a channel when a webhook request is received".',
  },
  {
    host: /(^|\.)logic\.azure\.com$/,
    message:
      'This older Workflows address stopped working in November 2025. Open the workflow in Teams again and copy its new URL.',
  },
]

export type ChatHookUrlCheck =
  | { ok: true; provider: ChatHookProvider; url: WhatwgUrl; hint: string }
  | { ok: false; code: (typeof CHAT_HOOK_CODES)['urlInvalid' | 'urlRetired']; message: string }

const INVALID_URL_MESSAGE =
  'That is not a Slack incoming-webhook URL (https://hooks.slack.com/services/…) or a Teams Workflows URL.'

const hostMatches = (rule: ChatHookRule, host: string) =>
  typeof rule.host === 'string' ? rule.host === host : rule.host.test(host)

/**
 * Whether `raw` is a hook URL Lobby may post to (and for which provider): WHATWG-parsed, `https:`, no port (or 443),
 * no user or password, no fragment, a lower-case host with no trailing dot that is no IP literal, matched exactly (no
 * suffix rule), and the provider's path and query. `provider`, when given, must be the URL's. The hint is what may be
 * shown again: never the secret part of the URL.
 */
export function checkChatHookUrl(raw: unknown, provider?: ChatHookProvider): ChatHookUrlCheck {
  const invalid = { ok: false as const, code: CHAT_HOOK_CODES.urlInvalid, message: INVALID_URL_MESSAGE }
  if (typeof raw !== 'string') return invalid
  const text = raw.trim()
  // printable ASCII only (a webhook URL never needs more), so its length is its size in bytes
  if (!text || text.length > CHAT_HOOK_LIMITS.urlBytes || !/^[\x21-\x7e]+$/.test(text)) return invalid
  if (/[<>"'\\]/.test(text)) return invalid
  const url = parseUrl(text)
  if (!url) return invalid
  if (url.protocol !== 'https:' || url.username || url.password || url.hash) return invalid
  if (url.port !== '' && url.port !== '443') return invalid
  const host = url.hostname
  if (!host || host.endsWith('.') || host.startsWith('[') || /^[\d.]+$/.test(host)) return invalid
  for (const retired of RETIRED_CHAT_HOOK_HOSTS)
    if (retired.host.test(host))
      return { ok: false, code: CHAT_HOOK_CODES.urlRetired, message: retired.message }
  const rule = CHAT_HOOK_RULES.find((r) => hostMatches(r, host))
  if (!rule || (provider && rule.provider !== provider)) return invalid
  if (!rule.path.test(url.pathname)) return invalid
  const keys = [...url.searchParams.keys()]
  if (keys.length !== rule.query.length || new Set(keys).size !== keys.length) return invalid
  if (!rule.query.every((k) => url.searchParams.has(k) && url.searchParams.get(k) !== '')) return invalid
  return { ok: true, provider: rule.provider, url, hint: chatHookHint(rule.provider, url) }
}

/** What a browser may see of a hook URL: the provider's host and the last 4 characters of its secret part. */
export function chatHookHint(provider: ChatHookProvider, url: WhatwgUrl): string {
  if (provider === 'slack') {
    const last = url.pathname.split('/').pop() ?? ''
    return `hooks.slack.com/…/•••${last.slice(-4)}`
  }
  return `….environment.api.powerplatform.com/…/•••${(url.searchParams.get('sig') ?? '').slice(-4)}`
}

// ---- hooks and preferences (requests and answers) -----------------------------------------------------------------

const HookName = z
  .string()
  .transform(cleanDisplayText)
  .pipe(z.string().min(1).max(CHAT_HOOK_LIMITS.nameChars))
/** The URL: a string only; checkChatHookUrl decides (its message never repeats the URL). */
const HookUrl = z.string().max(CHAT_HOOK_LIMITS.urlBytes)

export const ChatHook = z.object({
  id: ChatHookId,
  name: z.string(),
  provider: ChatHookProvider,
  /** chatHookHint: never the URL itself */
  hint: z.string().max(120),
  /** comment text AND the real title of a private board in the channel (both stay out unless the admin turned this on) */
  includeSnippets: z.boolean(),
  createdBy: z.object({ id: UserIdLike, name: z.string() }).nullable(),
  createdAt: z.string(),
  disabledAt: z.string().nullable(),
  disabledReason: z.enum(CHAT_HOOK_DISABLE_REASONS).nullable(),
  lastOkAt: z.string().nullable(),
  /** the last failure's code (an HTTP status as text, `timeout`, `network`), never the receiver's words */
  lastErrorCode: z.string().max(32).nullable(),
})
export type ChatHook = z.infer<typeof ChatHook>

export const ListChatHooksResponse = z.object({
  hooks: z.array(ChatHook).max(CHAT_HOOK_LIMITS.hooksPerWorkspace),
})
export type ListChatHooksResponse = z.infer<typeof ListChatHooksResponse>

export const CreateChatHookInput = z.strictObject({
  name: HookName,
  provider: ChatHookProvider,
  url: HookUrl,
  includeSnippets: z.boolean().default(false),
})
export type CreateChatHookInput = z.infer<typeof CreateChatHookInput>

/** `url` replaces the URL (checked and sealed again); `enabled: true` re-enables a hook a delivery switched off. */
export const PatchChatHookInput = z
  .strictObject({
    name: HookName,
    url: HookUrl,
    includeSnippets: z.boolean(),
    enabled: z.literal(true),
  })
  .partial()
  .refine((v) => Object.keys(v).length > 0, 'nothing to update')
export type PatchChatHookInput = z.infer<typeof PatchChatHookInput>

/** "Sent" means the receiver accepted it (Slack `ok`, Teams 202 = queued there): never "delivered". */
export const TestChatHookResponse = z.object({
  status: z.enum(['sent', 'failed']),
  code: z.string().max(32).nullable(),
})
export type TestChatHookResponse = z.infer<typeof TestChatHookResponse>

export const ChatPrefsQuery = z.strictObject({ workspace: WorkspaceIdLike })

/** The hooks a member may pick (no hint, no URL: a name and a provider) and their own choices. */
export const ChatPrefsResponse = z.object({
  hooks: z.array(
    z.object({ id: ChatHookId, name: z.string(), provider: ChatHookProvider, disabled: z.boolean() }),
  ),
  prefs: z.array(z.object({ hookId: ChatHookId, kinds: z.array(ChatHookKind) })),
})
export type ChatPrefsResponse = z.infer<typeof ChatPrefsResponse>

/** The caller's whole choice for one workspace (a hook left out, or with no kinds, sends nothing). */
export const PutChatPrefsInput = z.strictObject({
  workspaceId: WorkspaceIdLike,
  prefs: z
    .array(
      z.strictObject({
        hookId: ChatHookId,
        kinds: z
          .array(ChatHookKind)
          .max(CHAT_HOOK_KINDS.length)
          .refine((k) => new Set(k).size === k.length, 'each kind once'),
      }),
    )
    .max(CHAT_HOOK_LIMITS.hooksPerWorkspace)
    .refine((p) => new Set(p.map((x) => x.hookId)).size === p.length, 'each hook once'),
})
export type PutChatPrefsInput = z.infer<typeof PutChatPrefsInput>

// ---- messages (pure: the api renders them at send time from current rows) -------------------------------------------

/** What one message says. Every string is shown as text (escaped per provider), never as markup. */
export interface ChatMessage {
  readonly kind: ChatHookKind
  /** who did it (a display name), or for outsider_joined the outsider's email domain (`agency.com`) */
  readonly actor: string
  /** whom it concerns (the mentioned or replied-to person), when the sentence names them */
  readonly target?: string
  readonly boardTitle: string
  /** `https://<web origin>/b/<bid>?thread=<tid>`: Lobby sign-in and board access still needed */
  readonly link: string
  readonly workspaceName: string
  /** only when the hook's includeSnippets is on and the thread is not team-only */
  readonly snippet?: string
  /** for access_request: the role asked for */
  readonly role?: 'editor' | 'commenter' | 'viewer'
}

const cap = (s: string, n: number) => {
  const chars = [...cleanDisplayText(s)]
  return chars.length > n ? `${chars.slice(0, n - 1).join('')}…` : chars.join('')
}

/** The message's one sentence, plain (the Slack fallback `text`, the Teams card's title). */
export function chatMessageSentence(m: ChatMessage): string {
  const actor = cap(m.actor, CHAT_HOOK_LIMITS.nameInMessageChars)
  const target = cap(m.target ?? '', CHAT_HOOK_LIMITS.nameInMessageChars)
  const board = cap(m.boardTitle, CHAT_HOOK_LIMITS.titleChars)
  switch (m.kind) {
    case 'mention':
      return target ? `${actor} mentioned ${target} on ${board}` : `${actor} mentioned you on ${board}`
    case 'reply':
      return target ? `${actor} replied to ${target} on ${board}` : `${actor} replied on ${board}`
    case 'new_comment':
      return `${actor} commented on ${board}`
    case 'access_request':
      return `${actor} asked for ${m.role ?? 'edit'} access to ${board}`
    case 'outsider_joined':
      return `Someone from @${actor} opened ${board}`
  }
}

/** Slack mrkdwn: `&`, `<`, `>` escaped (this also defuses `<!channel>` and `<url|label>`); `*_~\`` stay as typed. */
export const slackEscape = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

/**
 * Teams TextBlock markdown: every ASCII punctuation character that markdown reads backslash-escaped (CommonMark
 * renders an escaped character as itself), so names render as text. How Teams' own renderer shows `\-` is UNVERIFIED:
 * WS2 checks it in the live Teams test.
 */
export const teamsEscape = (s: string) => s.replace(/[\\`*_{}[\]()#+\-.!|<>~]/g, (c) => `\\${c}`)

const snippetOf = (m: ChatMessage) =>
  m.snippet === undefined ? null : cap(m.snippet, CHAT_HOOK_LIMITS.snippetChars) || null

/** What a message says in place of a private board's title (a hook that did not opt in to titles). */
export const CHAT_HIDDEN_BOARD_TITLE = 'a private board'

/**
 * A message that is not one event: the test message, or the roll-up of what a cap held back. Its text is one plain
 * sentence (escaped per provider like every other string); the link and workspace name are the event messages'.
 */
export interface ChatNotice {
  readonly text: string
  readonly link: string
  readonly workspaceName: string
}

/** "and 12 more on Pitch wall" (one board, title allowed to show) or "and 12 more notifications". */
export function chatRollupSentence(count: number, boardTitle: string | null): string {
  const n = Math.max(1, Math.floor(count))
  if (boardTitle) return `and ${n} more on ${cap(boardTitle, CHAT_HOOK_LIMITS.titleChars)}`
  return n === 1 ? 'and 1 more notification' : `and ${n} more notifications`
}

function slackBody(
  sentence: string,
  link: string,
  workspaceName: string,
  snippet: string | null,
): Record<string, unknown> {
  const quote = snippet
    ? `
>${slackEscape(snippet)}`
    : ''
  const text = `${slackEscape(sentence)} · <${slackEscape(link)}|Open in Lobby>${quote}`
  const workspace = cap(workspaceName, CHAT_HOOK_LIMITS.titleChars)
  return {
    // the notification's fallback text is mrkdwn too: escaped like the blocks (a `<!channel>` name stays text)
    text: slackEscape(sentence),
    unfurl_links: false,
    unfurl_media: false,
    blocks: [
      {
        type: 'section',
        text: { type: 'mrkdwn', text: [...text].slice(0, CHAT_HOOK_LIMITS.slackSectionChars).join('') },
      },
      { type: 'context', elements: [{ type: 'mrkdwn', text: slackEscape(`Lobby · ${workspace}`) }] },
    ],
  }
}

function teamsBody(
  sentence: string,
  link: string,
  workspaceName: string,
  snippet: string | null,
): Record<string, unknown> {
  const body: Record<string, unknown>[] = [
    { type: 'TextBlock', text: teamsEscape(sentence), wrap: true, weight: 'Bolder' },
  ]
  if (snippet) body.push({ type: 'TextBlock', text: teamsEscape(snippet), wrap: true })
  body.push({
    type: 'TextBlock',
    text: teamsEscape(`Lobby · ${cap(workspaceName, CHAT_HOOK_LIMITS.titleChars)}`),
    isSubtle: true,
    spacing: 'None',
  })
  return {
    type: 'message',
    attachments: [
      {
        contentType: 'application/vnd.microsoft.card.adaptive',
        contentUrl: null,
        content: {
          $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
          type: 'AdaptiveCard',
          version: '1.4',
          body,
          actions: [{ type: 'Action.OpenUrl', title: 'Open in Lobby', url: link }],
        },
      },
    ],
  }
}

/** The JSON body Slack's incoming webhook receives. */
export function slackPayload(m: ChatMessage): Record<string, unknown> {
  return slackBody(chatMessageSentence(m), m.link, m.workspaceName, snippetOf(m))
}

/** The JSON body a Teams Workflows webhook receives (an Adaptive Card 1.4; only Action.OpenUrl). */
export function teamsPayload(m: ChatMessage): Record<string, unknown> {
  return teamsBody(chatMessageSentence(m), m.link, m.workspaceName, snippetOf(m))
}

const noticeSentence = (n: ChatNotice) => cap(n.text, CHAT_HOOK_LIMITS.titleChars * 2)

/** Slack's body for a test message or roll-up. */
export function slackNoticePayload(n: ChatNotice): Record<string, unknown> {
  return slackBody(noticeSentence(n), n.link, n.workspaceName, null)
}

/** Teams' body for a test message or roll-up. */
export function teamsNoticePayload(n: ChatNotice): Record<string, unknown> {
  return teamsBody(noticeSentence(n), n.link, n.workspaceName, null)
}

// ---- routes --------------------------------------------------------------------------------------------------------

export const CHAT_HOOK_ROUTES = {
  hooks: '/api/workspaces/:wid/chat-hooks',
  hook: '/api/workspaces/:wid/chat-hooks/:hid',
  test: '/api/workspaces/:wid/chat-hooks/:hid/test',
  prefs: '/api/me/chat-prefs',
} as const
const R = CHAT_HOOK_ROUTES
export const CHAT_HOOK_ROUTE_KEYS = [
  `GET ${R.hooks}`,
  `POST ${R.hooks}`,
  `PATCH ${R.hook}`,
  `DELETE ${R.hook}`,
  `POST ${R.test}`,
  `GET ${R.prefs}`,
  `PUT ${R.prefs}`,
] as const
export type ChatHookRouteKey = (typeof CHAT_HOOK_ROUTE_KEYS)[number]
/**
 * A hook is an outbound channel for workspace data: managing one is a creator's (the guard, 'always', purpose share),
 * and the route also requires a workspace owner or admin. DELETE stays open to every owner and admin (lowering).
 */
export const CHAT_HOOK_CREATOR_ROUTE_KEYS: readonly ChatHookRouteKey[] = [
  `GET ${R.hooks}`,
  `POST ${R.hooks}`,
  `PATCH ${R.hook}`,
  `POST ${R.test}`,
]
export const CHAT_HOOK_GUESTS_MESSAGE =
  'Chat notifications are for people with an account. Sign in with an account to set them up.'

const enc = encodeURIComponent
export const chatHooksPath = (wid: string) => `/api/workspaces/${enc(wid)}/chat-hooks`
export const chatHookPath = (wid: string, hid: string) => `${chatHooksPath(wid)}/${enc(hid)}`
export const chatHookTestPath = (wid: string, hid: string) => `${chatHookPath(wid, hid)}/test`
export const chatPrefsPath = (wid?: string) =>
  wid ? `/api/me/chat-prefs?workspace=${enc(wid)}` : '/api/me/chat-prefs'
