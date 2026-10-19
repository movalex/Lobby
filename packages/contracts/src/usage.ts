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
import { REACTION_CODES } from './workshops.ts'

// ---- the parameter lists -------------------------------------------------------------------------------

/** Wave T's palette commands (all live since the wave T integration; none is in PENDING_PALETTE_COMMAND_IDS). */
export const WAVE_T_PALETTE_COMMAND_IDS = [
  'storyboard.new',
  'storyboard.from-frames',
  'storyboard.from-script',
  'storyboard.play',
  'storyboard.present',
  'cards.make',
  'kanban.new',
  'card-table.open',
  'timeline.new',
] as const

/**
 * Wave V's palette commands (frozen by the wave V foundation; docs/WAVE-V-CONTRACTS.md §6.4), each pending until its
 * owner registers it: start a poll, scale or word cloud (WS2), show the join code card (WS3), start breakouts (WS4),
 * download the session summary CSV (WS5).
 */
export const WAVE_V_PALETTE_COMMAND_IDS = [
  'activities.start',
  'join.show-code',
  'breakouts.start',
  'session-summary.csv',
] as const

/**
 * The commands `palette.run:<id>` may name: every static command of the board features
 * (apps/web/src/features/canvas-registry.ts, checked by apps/web/src/lib/usage.test.ts), wave M's
 * 'ai.askWorkspace' and 'ws-templates.save' (W8) included.
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
  // wave Q (WS4): the new kits (arrows, callouts, badges, sticky-note kits, devices, storyboard, deliverables)
  'pieces.insert.arrow-straight',
  'pieces.insert.arrow-dashed',
  'pieces.insert.arrow-curved',
  'pieces.insert.arrow-double',
  'pieces.insert.arrow-uturn',
  'pieces.insert.arrow-pointer',
  'pieces.insert.block-right',
  'pieces.insert.block-left',
  'pieces.insert.block-up',
  'pieces.insert.block-down',
  'pieces.insert.block-double',
  'pieces.insert.chevron',
  'pieces.insert.step-pentagon',
  'pieces.insert.speech',
  'pieces.insert.speech-right',
  'pieces.insert.thought',
  'pieces.insert.burst',
  'pieces.insert.callout-line',
  'pieces.insert.callout-fold',
  'pieces.insert.approved',
  'pieces.insert.draft',
  'pieces.insert.needs-review',
  'pieces.insert.priority',
  'pieces.insert.done',
  'pieces.insert.wip',
  'pieces.insert.label',
  'pieces.insert.number-1',
  'pieces.insert.number-2',
  'pieces.insert.number-3',
  'pieces.insert.number-4',
  'pieces.insert.number-5',
  'pieces.insert.number-6',
  'pieces.insert.number-7',
  'pieces.insert.number-8',
  'pieces.insert.number-9',
  'pieces.insert.number-10',
  'pieces.insert.numbers-row',
  'pieces.insert.kit-retro',
  'pieces.insert.kit-start-stop',
  'pieces.insert.kit-matrix-2x2',
  'pieces.insert.kit-swot',
  'pieces.insert.kit-note-colours',
  'pieces.insert.device-phone',
  'pieces.insert.device-tablet',
  'pieces.insert.device-laptop',
  'pieces.insert.device-browser',
  'pieces.insert.device-tv',
  'pieces.insert.sb-16x9',
  'pieces.insert.sb-9x16',
  'pieces.insert.sb-sheet',
  'pieces.insert.deliver-fhd',
  'pieces.insert.deliver-4k',
  'pieces.insert.deliver-square',
  'pieces.insert.deliver-portrait',
  'pieces.insert.deliver-story',
  'pieces.insert.deliver-link',
  'pieces.insert.deliver-yt-banner',
  'pieces.insert.steam-main',
  'pieces.insert.steam-header',
  'pieces.insert.steam-small',
  'pieces.insert.steam-vertical',
  'pieces.insert.steam-set',
  // wave M, W8 (features/ai/workspace-ask, features/ws-templates)
  'ai.askWorkspace',
  'ws-templates.save',
  // wave N (frozen by the wave N foundation, pending until their owners register them): reactions (WS3), board
  // links (WS7), Capture the room (WS5)
  'reactions.react',
  'board-links.insert',
  'board-links.backlinks',
  'ai.capture',
  // wave Q (frozen by the wave Q foundation, pending until WS3 registers it): open the Elements panel
  'elements.open',
  // wave S (WS1, features/review; added by the integration): the Review panel and Mark for review
  'review.open-panel',
  'review.mark',
  // wave T (frozen by the wave T foundation, pending until their owners register them; docs/WAVE-T-CONTRACTS.md §6.4):
  // storyboards (WS2), the animatic and Present storyboard (WS3), cards, Kanban and the card table (WS4), timelines (WS5)
  ...WAVE_T_PALETTE_COMMAND_IDS,
  // wave V (frozen by the wave V foundation, pending until their owners register them): live activities (WS2), the
  // join card (WS3), breakouts (WS4), the session summary (WS5)
  ...WAVE_V_PALETTE_COMMAND_IDS,
] as const
export type PaletteCommandId = (typeof PALETTE_COMMAND_IDS)[number]

/**
 * The commands no feature registers yet (the wave N foundation's ids; each owner removes its id here when it
 * registers the command, apps/web/src/lib/usage.test.ts checks the two lists).
 */
export const PENDING_PALETTE_COMMAND_IDS: readonly PaletteCommandId[] = [
  // wave N: none left. reactions.react is registered by WS3 (features/workshops), board-links.insert and
  // board-links.backlinks by WS7 (features/board-links), ai.capture by WS5 (features/ai/capture; listing it here
  // again holds the whole capture feature on the web).
  // wave Q: none left. elements.open is registered by WS3 (features/elements) since the integration turned
  // ELEMENTS_PANEL on.
  // wave T: none left. The foundation listed every wave T command; WS5 registered 'timeline.new' (features/timeline)
  // and the integration, turning every PLANNING_FLAGS switch on, released the rest (WS2's storyboard.*, WS3's
  // storyboard.play and storyboard.present, WS4's cards.make, kanban.new and card-table.open).
  // wave V (the foundation): every wave V command, until its owner registers it (and deletes its line here). WS2
  // registered 'activities.start' (features/live-activities).
  'join.show-code',
  'breakouts.start',
  'session-summary.csv',
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
  // wave T (WS2)
  'storyboard',
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

/** `open.decode:<where>`: where a board's snapshot was decoded (WS1, N1-1: a module Worker, or the main thread). */
export const USAGE_OPEN_DECODE_KINDS = ['worker', 'main'] as const
/** `open.apply:<how>`: how a reset snapshot was applied (WS1: a diff against the painted copy, in chunks, whole). */
export const USAGE_OPEN_APPLY_KINDS = ['diff', 'chunked', 'full'] as const

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
  // wave N (frozen by the wave N foundation): reactions (WS3), since your last visit (WS4), Capture the room (WS5),
  // vector PDF (WS6), board links (WS7)
  'reactions.clear',
  'visits.chip.shown',
  'visits.tour',
  'visits.markseen',
  'ai.capture.photo',
  'ai.capture.boardimage',
  'ai.capture.transcript',
  'ai.capture.apply',
  'export.pdf.vector',
  'export.pdf.raster',
  'boardlinks.insert',
  'boardlinks.open',
  'boardlinks.backlinks',
  // wave Q (frozen by the wave Q foundation): the Elements panel (WS3: inserts by source, saves, favourites) and the
  // .excalidrawlib import (WS4)
  'elements.insert.icon',
  'elements.insert.piece',
  'elements.insert.item',
  'elements.save',
  'elements.favourite',
  'elements.import',
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
  // wave N: how a big board's snapshot was decoded and applied (WS1), and which reaction was added (WS3)
  'open.decode': USAGE_OPEN_DECODE_KINDS,
  'open.apply': USAGE_OPEN_APPLY_KINDS,
  'reactions.add': REACTION_CODES,
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
