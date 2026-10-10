// Privacy-safe usage counters (wave M, S3 / M5-5). OWNER: W5 (packages/contracts is W5's after the wave M
// foundation; the event list was frozen by the foundation, and any addition goes through W5).
//
// Do not import values from ./index.ts here: index.ts re-exports this module.
//
// The web counts what people use (apps/web/src/lib/usage.ts `countUsage(event: UsageEvent)`): a fixed list of
// event names, some with a parameter from a fixed list too (`palette.run:<command id>`). Nothing else is ever
// sent: no user id, board id, element id, text or time finer than the day. The api adds each batch to
// `usage_daily(day, event, role_class, count)` (migration 0029_usage_daily) and keeps nothing more.
//
//   POST /api/usage            UsageBatch → 204   (signed in or name-only guest; same origin, sendBeacon)
//   GET  /internal/usage?days= → 200 InternalUsageResponse (internal secret)
//
// Until W5 implements them neither route is registered (the api answers 404 NOT_FOUND, as for any unknown
// route), and the web's countUsage only counts in memory. A web on an older api drops its batch on the 404.

import { z } from 'zod'

// ---- the parameter lists -------------------------------------------------------------------------------

/**
 * The commands `palette.run:<id>` may name: every static command of the board features
 * (apps/web/src/features/canvas-registry.ts, checked by apps/web/src/lib/usage.test.ts) plus the wave M
 * commands still to come ('ai.askWorkspace' and 'ws-templates.save', W8).
 */
export const PALETTE_COMMAND_IDS = [
  // canvas-ux
  'canvas-ux.undo',
  'canvas-ux.redo',
  'canvas-ux.cut',
  'canvas-ux.copy',
  'canvas-ux.paste',
  'canvas-ux.duplicate',
  'canvas-ux.delete',
  'canvas-ux.select-all',
  'canvas-ux.select-none',
  'canvas-ux.group',
  'canvas-ux.ungroup',
  'canvas-ux.toggle-lock',
  'canvas-ux.unlock-all',
  'canvas-ux.bring-to-front',
  'canvas-ux.send-to-back',
  'canvas-ux.bring-forward',
  'canvas-ux.send-backward',
  'canvas-ux.align-left',
  'canvas-ux.align-center-horizontal',
  'canvas-ux.align-right',
  'canvas-ux.align-top',
  'canvas-ux.align-center-vertical',
  'canvas-ux.align-bottom',
  'canvas-ux.distribute-horizontal',
  'canvas-ux.distribute-vertical',
  'canvas-ux.keyboard-shortcuts',
  'canvas-ux.insert-file',
  'canvas-ux.toggle-note-authors',
  'canvas-ux.toggle-snap',
  'canvas-ux.toggle-grid',
  'canvas-ux.tool-lock',
  // navigation
  'navigation.board-search',
  'navigation.toggle-minimap',
  'navigation.zoom-in',
  'navigation.zoom-out',
  'navigation.zoom-to-100',
  'navigation.zoom-to-fit',
  'navigation.zoom-to-selection',
  'navigation.copy-link',
  'navigation.arrange-grid',
  'navigation.go-to-start-view',
  'navigation.set-start-view',
  'navigation.set-frame-start-view',
  'navigation.clear-start-view',
  'navigation.open-templates',
  // comments
  'comments.select-tool',
  'comments.toggle-pins',
  'comments.comment-selection',
  // workshops
  'workshops.vote.setup',
  'workshops.spotlight',
  'workshops.spotlight-end',
  // present-export
  'present-export.present',
  'present-export.export',
  'present-export.print',
  'present-export.copy-as-png',
  'present-export.export-as-png',
  'present-export.export-as-svg',
  'present-export.export-all-as-png',
  'present-export.export-all-as-svg',
  // mindmap
  'mindmap.start',
  'mindmap.new',
  'mindmap.add-child',
  'mindmap.add-sibling',
  'mindmap.promote',
  'mindmap.toggle-collapsed',
  'mindmap.tidy',
  'mindmap.copy-outline',
  'mindmap.download-md',
  'mindmap.download-csv',
  'mindmap.delete',
  // tags
  'tags.picker',
  // ai
  'ai.recap',
  'ai.ask',
  'ai.themes',
  'ai.actions',
  'ai.remove-result',
  'ai.lens',
  'ai.expand',
  'ai.ideas',
  'ai.mindmap',
  // media
  'media.insert-file',
  'media.download-original',
  'media.replace',
  'media.crop',
  'media.alt-text',
  // flow
  'flow.diagram',
  // a11y
  'a11y.enter-canvas',
  'a11y.next',
  'a11y.previous',
  'a11y.into-frame',
  'a11y.out-of-frame',
  'a11y.repeat',
  // cursor-chat
  'cursor-chat.open',
  // command-palette
  'command-palette.open',
  // sort
  'sort.colour',
  'sort.author',
  'sort.tag',
  'sort.votes',
  'sort.lens',
  'sort.place',
  'sort.scores',
  // pieces
  'pieces.open',
  'pieces.insert.process',
  'pieces.insert.decision',
  'pieces.insert.terminator',
  'pieces.insert.data',
  'pieces.insert.document',
  'pieces.insert.subprocess',
  'pieces.insert.swimlane',
  'pieces.insert.browser',
  'pieces.insert.phone',
  'pieces.insert.button',
  'pieces.insert.input',
  'pieces.insert.checkbox',
  'pieces.insert.toggle',
  'pieces.insert.card',
  'pieces.insert.navbar',
  'pieces.insert.modal',
  'pieces.insert.image',
  'pieces.insert.person',
  'pieces.insert.shot',
  'pieces.insert.storyboard',
  'pieces.insert.persona',
  'pieces.insert.stage',
  // wave M, W8 (registered when W8 implements them)
  'ai.askWorkspace',
  'ws-templates.save',
] as const
export type PaletteCommandId = (typeof PALETTE_COMMAND_IDS)[number]

/** The wave M commands no feature registers yet (their owner, W8, adds them): the web test allows them. */
export const PENDING_PALETTE_COMMAND_IDS: readonly PaletteCommandId[] = [
  'ai.askWorkspace',
  'ws-templates.save',
]

/**
 * The template picker's templates (`@draftroom/templates` TEMPLATE_INFOS ids, checked by
 * apps/web/src/lib/usage.test.ts), for `template.pick:<id>`; a workspace template counts as
 * `template.pick:workspace` (never its board id).
 */
export const USAGE_TEMPLATE_IDS = [
  'brainstorm',
  'mood-board',
  'storyboard',
  'pitch-outline',
  'retrospective',
  'production-plan',
  'creative-brief',
  'client-feedback',
  'shot-list',
  'launch-timeline',
  'prioritisation-2x2',
  'kanban',
  'lobby-tour',
] as const

/** `ai.open:<kind>`: the AI actions (contracts ai.ts AI_ACTIONS) and the AI menu's other entries. */
export const USAGE_AI_OPEN_KINDS = [
  'summarize',
  'themes',
  'actions',
  'ideas',
  'recap',
  'ask',
  'command',
  'diagram',
  'sort',
  'score',
  'lens',
  'expand',
  'mindmap',
  'remove-result',
] as const

/** `sort.run:<kind>`: the ways to sort (features/sort commands). */
export const USAGE_SORT_KINDS = ['colour', 'author', 'tag', 'votes', 'lens', 'place'] as const

/**
 * `whatsnew.try:<id>`: the wave L What's new items' "Try it" (W3, M3-3), in the card's order: Ctrl+K, Ask this
 * board / Wrap up, Diagram from words and Mermaid paste, Time travel, Run of show / spotlight / vote results.
 */
export const USAGE_WHATS_NEW_IDS = ['palette', 'ask', 'diagram', 'time-travel', 'run-of-show'] as const

/** `emptyhint.<action>`: the empty board's hint actions (EmptyBoardHint.tsx; 'diagram' and 'palette' are W3's). */
export const USAGE_EMPTY_HINT_ACTIONS = ['templates', 'mindmap', 'ai', 'diagram', 'palette'] as const

/** `selectionbar.style:<kind>`: what a tier one selection-toolbar item changed (W1, M1-4). */
export const USAGE_SELECTION_STYLE_KINDS = [
  'note-colour',
  'font-size',
  'text-align',
  'text-colour',
  'fill',
  'stroke-colour',
  'stroke-width',
  'stroke-style',
  'opacity',
  'arrowheads',
  'more-styles',
] as const

// ---- the events -----------------------------------------------------------------------------------------

/** Events without a parameter. */
export const USAGE_FIXED_EVENTS = [
  'mermaid.paste',
  'pieces.insert',
  'runofshow.set',
  'present.justme',
  'present.everyone',
  'vote.join.banner',
  'spotlight.start',
  'template.save',
  'coach.shown',
  'coach.run',
  'feedback.prompt.shown',
  'feedback.prompt.good',
  'feedback.prompt.issue',
  'emptyhint.templates',
  'emptyhint.mindmap',
  'emptyhint.ai',
  'emptyhint.diagram',
  'emptyhint.palette',
  'open.cached',
  'open.cold',
  'timetravel.scrub',
  'timetravel.restore',
  'stalechunk.notice',
  'stalechunk.reload',
  'version.notice',
  'compass.click',
  'follow.pause',
] as const

/** Events with a parameter (`<name>:<value>`), each value from its fixed list. */
export const USAGE_PARAM_EVENTS = {
  'palette.open': ['key', 'button', 'phone'],
  'palette.run': PALETTE_COMMAND_IDS,
  'sort.run': USAGE_SORT_KINDS,
  'template.pick': [...USAGE_TEMPLATE_IDS, 'workspace'],
  'ai.open': USAGE_AI_OPEN_KINDS,
  'ai.ask.scope': ['board', 'all'],
  'whatsnew.try': USAGE_WHATS_NEW_IDS,
  'selectionbar.style': USAGE_SELECTION_STYLE_KINDS,
} as const satisfies Record<string, readonly string[]>

type ParamEvents = typeof USAGE_PARAM_EVENTS
type ParamEvent = { [K in keyof ParamEvents]: `${K}:${ParamEvents[K][number]}` }[keyof ParamEvents]

/** Every event the web may count: a fixed one, or `<name>:<value>` of USAGE_PARAM_EVENTS. */
export type UsageEvent = (typeof USAGE_FIXED_EVENTS)[number] | ParamEvent

/** The whole list, fixed events first, then each parameterised event in USAGE_PARAM_EVENTS order. */
export const USAGE_EVENTS: readonly UsageEvent[] = [
  ...USAGE_FIXED_EVENTS,
  ...Object.entries(USAGE_PARAM_EVENTS).flatMap(([name, values]) =>
    values.map((v: string) => `${name}:${v}` as UsageEvent),
  ),
]

const EVENT_SET: ReadonlySet<string> = new Set(USAGE_EVENTS)
export const isUsageEvent = (s: unknown): s is UsageEvent => typeof s === 'string' && EVENT_SET.has(s)

/** The shape every event name has (usage_daily.event's CHECK in 0029_usage_daily uses the same pattern). */
export const USAGE_EVENT_PATTERN = /^[a-z][A-Za-z0-9._:-]{0,119}$/

// ---- caps and cadence -------------------------------------------------------------------------------------

/** The most one batch may add to one event (an account). */
export const USAGE_COUNT_CAP = 50
/** The most one batch may add to one event for a name-only guest. */
export const USAGE_GUEST_COUNT_CAP = 10
/** Events per batch. */
export const USAGE_BATCH_MAX_KEYS = 40
/** One batch per session (or guest token) per this long; more answer 429. */
export const USAGE_BATCH_MIN_INTERVAL_MS = 60_000
/** The web flushes this often while the tab is visible, and on pagehide. */
export const USAGE_FLUSH_MS = 5 * 60_000
/** GET /internal/usage?days=: the default and the most. */
export const USAGE_INTERNAL_DEFAULT_DAYS = 7
export const USAGE_INTERNAL_MAX_DAYS = 90

export const USAGE_ROUTE = '/api/usage'
export const INTERNAL_USAGE_ROUTE = '/internal/usage'

// ---- schemas -------------------------------------------------------------------------------------------------

export const UsageEventName = z.string().refine(isUsageEvent, 'unknown usage event')

/**
 * POST /api/usage: event → how many times (1 to USAGE_COUNT_CAP), at most USAGE_BATCH_MAX_KEYS events. Any
 * unknown event refuses the whole batch (400; nothing stored). A guest's counts above USAGE_GUEST_COUNT_CAP are
 * capped by the api (not refused).
 */
export const UsageBatch = z.strictObject({
  events: z
    .record(UsageEventName, z.number().int().min(1).max(USAGE_COUNT_CAP))
    .refine((r) => Object.keys(r).length >= 1, 'at least one event')
    .refine((r) => Object.keys(r).length <= USAGE_BATCH_MAX_KEYS, `at most ${USAGE_BATCH_MAX_KEYS} events`),
})
export type UsageBatch = z.infer<typeof UsageBatch>

/** Who counted, as stored: never the person. */
export const USAGE_ROLE_CLASSES = ['creator', 'member', 'guest'] as const
export const UsageRoleClass = z.enum(USAGE_ROLE_CLASSES)
export type UsageRoleClass = z.infer<typeof UsageRoleClass>

export const InternalUsageQuery = z.object({
  days: z.coerce.number().int().min(1).max(USAGE_INTERNAL_MAX_DAYS).default(USAGE_INTERNAL_DEFAULT_DAYS),
})
export type InternalUsageQuery = z.infer<typeof InternalUsageQuery>

/** One usage_daily row (its only columns). */
export const UsageDailyRow = z.strictObject({
  /** UTC day, YYYY-MM-DD */
  day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  event: z.string().regex(USAGE_EVENT_PATTERN),
  roleClass: UsageRoleClass,
  count: z.number().int().nonnegative(),
})
export type UsageDailyRow = z.infer<typeof UsageDailyRow>

/** GET /internal/usage?days=N: the rows of the last N UTC days, newest day first. */
export const InternalUsageResponse = z.strictObject({ rows: z.array(UsageDailyRow) })
export type InternalUsageResponse = z.infer<typeof InternalUsageResponse>
