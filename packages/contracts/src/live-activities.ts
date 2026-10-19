// Wave V (V1): live activities, a poll, a scale or a word cloud (docs/WAVE-V-CONTRACTS.md §2). OWNER: the wave V
// lead (contracts are lead-only); WS1 builds the api (apps/api/src/features/live-activities), WS2 the web
// (apps/web/src/features/live-activities). Browser-safe.
//
// One activity at a time per board (a dot vote may run beside it). People answer in a panel (never on the canvas), one
// answer each, changeable until it closes. The facilitator reveals the results; their client may then place them on the
// board as ordinary elements (customData.lobby.kind 'poll-chart' / 'word-cloud', ./live.ts LIVE_ELEMENT_KINDS).
//
// Privacy (the wire rule; WS1's "anonymous wire test"): an anonymous activity's answers never leave the api tied to a
// person: no response, event, export, log line or board element carries a user id, name or per-person grouping of
// one. Every body here holds aggregates only, plus the CALLER's own answer (`myAnswer`). Counts anyone is shown while
// it is open are the counts at the last tally window boundary (activityTallyWindowMs, as the dot vote's RT-03), so a
// cursor and a count's timing never tie a person to an answer. A word is shown only after the reveal (or live when the
// facilitator turned `resultsLive` on), and never with its author. At the reveal (and at a cancel) the api deletes an
// anonymous activity's per-person rows in the same transaction and keeps only the aggregate (0038 live_activities.
// results). A named activity (`anonymous: false`, opt-in and labelled) lets the facilitator see who answered what after
// the reveal (GET …/answers); it never shows names to the other participants.
//
// Do not import values from ./index.ts here: index.ts re-exports this module.

import { z } from 'zod'
import { isJoiner, joinerJoins } from './outside.ts'
import { codePointLength } from './workshops.ts'

const IsoDate = z.string()
const WsUserId = z.string().regex(/^usr_[0-9A-Za-z]{10,40}$/)

export const ACTIVITY_ID_PATTERN = /^act_[0-9A-Za-z]{10,40}$/
export const ActivityId = z.string().regex(ACTIVITY_ID_PATTERN)

export const ACTIVITY_KINDS = ['poll', 'scale', 'words'] as const
export const ActivityKind = z.enum(ACTIVITY_KINDS)
export type ActivityKind = z.infer<typeof ActivityKind>
export const ACTIVITY_KIND_LABELS: Readonly<Record<ActivityKind, string>> = {
  poll: 'Poll',
  scale: 'Scale',
  words: 'Word cloud',
}

/** Every bound of the feature (0038's CHECKs say the same where a column holds it). */
export const ACTIVITY_LIMITS = {
  /** the question everyone sees, one line, code points */
  promptMaxChars: 200,
  pollOptionsMin: 2,
  pollOptionsMax: 12,
  optionMaxChars: 80,
  scaleLabelMaxChars: 40,
  wordsPerPersonMin: 1,
  wordsPerPersonMax: 5,
  wordsPerPersonDefault: 3,
  /** one entry of a word cloud, code points (CJK and emoji count one each) */
  wordMaxChars: 30,
  /** the most distinct words a result lists (by count) */
  resultWordsMax: 100,
  /** the most words a placed word cloud draws (the web's layout; R4) */
  cloudWordsMax: 60,
  /** words a facilitator may hide on one activity */
  hiddenWordsMax: 200,
  /** an activity's optional end time */
  durationMinMs: 30_000,
  durationMaxMs: 2 * 60 * 60 * 1000,
  extendMaxMs: 30 * 60 * 1000,
  /** GET /api/boards/:bid/activities: the most recent ones, newest first */
  pastListMax: 50,
  /** answers (and changes) one person may send, per activity, per minute: 429 RATE_LIMITED past it */
  answersPerMinute: 30,
  /** activities one board may start per minute */
  startsPerMinute: 10,
  /** a stored answer's JSON bytes (0038 CHECK); the largest valid answer is far below */
  answerMaxBytes: 2048,
} as const

/** The scales there are: [min, max]. */
export const SCALE_RANGES = [
  [1, 5],
  [1, 7],
  [0, 10],
] as const

/**
 * The tally window (as the dot vote's VOTE_TALLY_WINDOW_MS): counts change only at its wall-clock boundaries, one event
 * per window that changed something. 1 s only for a named activity whose counts participants do not see live; else 5 s
 * (an anonymous answer, or live results, must not be tied to a person by its timing).
 */
export const ACTIVITY_TALLY_WINDOW_MS = { named: 1_000, anonymous: 5_000 } as const
export const activityTallyWindowMs = (a: { anonymous: boolean; resultsLive: boolean }): number =>
  !a.anonymous && !a.resultsLive ? ACTIVITY_TALLY_WINDOW_MS.named : ACTIVITY_TALLY_WINDOW_MS.anonymous

// ---- text rules ----------------------------------------------------------------------------------------------------

// C0 and C1 controls (newline and tab included: every text here is one line), DEL, the bidi controls that make a text
// read differently on screen than it is stored, zero-width spaces, the word joiner, the BOM, line and paragraph
// separators. Code points, checked one at a time (no escapes needed in source). ZWNJ and ZWJ (U+200C, U+200D) are not
// here: they spell emoji sequences (a person and a laptop, a rainbow flag) and Persian or Indic words, so they are
// allowed where they join two such characters (outside.ts joinerJoins), and refused anywhere else (next to ASCII, a
// space, an end or another invisible character: there they only hide). The emoji variation selectors (U+FE0E, U+FE0F)
// are ordinary characters here. (Wave V fix wave, review m7.)
const FORBIDDEN = new Set([
  0x061c, 0x200b, 0x200e, 0x200f, 0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2060, 0x2066, 0x2067, 0x2068,
  0x2069, 0x2028, 0x2029, 0xfeff,
])
/** Whether `s` holds a character no live activity or breakout text may hold. */
export function hasForbiddenActivityChar(s: string): boolean {
  const chars = [...s]
  for (let i = 0; i < chars.length; i++) {
    const cp = chars[i]?.codePointAt(0) ?? 0
    if (isJoiner(cp)) {
      if (!joinerJoins(chars[i - 1], chars[i + 1])) return true
    } else if (cp < 0x20 || (cp >= 0x7f && cp <= 0x9f) || FORBIDDEN.has(cp)) return true
  }
  return false
}

/**
 * One line of text: whitespace runs (newlines and tabs too, before the control check) collapse to one space, trimmed;
 * 1..max code points; no character of `hasForbiddenActivityChar`.
 */
const oneLine = (max: number, empty: string, what: string) =>
  z
    .string()
    .max(max * 8) // before collapsing; the real limit is checked below
    .transform((s) => s.replace(/[\t\n\v\f\r \u00a0\u1680\u2000-\u200a\u202f\u205f\u3000]+/g, ' ').trim())
    .refine((s) => s.length > 0, { message: empty })
    .refine((s) => codePointLength(s) <= max, { message: `${what} can have at most ${max} characters.` })
    .refine((s) => !hasForbiddenActivityChar(s), {
      message: `${what} contains characters that cannot be shown.`,
    })

export const ActivityPrompt = oneLine(
  ACTIVITY_LIMITS.promptMaxChars,
  'Write a question for everyone.',
  'The question',
)
export const PollOptionText = oneLine(ACTIVITY_LIMITS.optionMaxChars, 'An option needs words.', 'An option')
export const ScaleLabel = oneLine(ACTIVITY_LIMITS.scaleLabelMaxChars, 'A label needs words.', 'A label')
/** One entry of a word cloud, as typed (trimmed, collapsed). Grouping uses normalizeWord. */
export const WordText = oneLine(ACTIVITY_LIMITS.wordMaxChars, 'Type a word first.', 'A word')

/**
 * The grouping key of a word-cloud entry (pure, the same on the api and the web): Unicode NFKC (fullwidth forms, ligatures
 * and compatibility characters fold), whitespace collapsed and trimmed, then lower-cased (locale-free). "Agile", " agile "
 * and "ＡＧＩＬＥ" are one word. The display form is chosen by tallyWords.
 */
export function normalizeWord(raw: string): string {
  return raw.normalize('NFKC').replace(/\s+/gu, ' ').trim().toLowerCase()
}

/** Code-point order (not UTF-16, not locale): the tie-break everywhere here. */
const byCodePoint = (a: string, b: string): number => {
  const x = [...a]
  const y = [...b]
  for (let i = 0; i < Math.min(x.length, y.length); i++) {
    const d = (x[i]?.codePointAt(0) ?? 0) - (y[i]?.codePointAt(0) ?? 0)
    if (d) return d
  }
  return x.length - y.length
}

// ---- setup ---------------------------------------------------------------------------------------------------------

export const PollConfig = z
  .strictObject({
    options: z.array(PollOptionText).min(ACTIVITY_LIMITS.pollOptionsMin).max(ACTIVITY_LIMITS.pollOptionsMax),
    /** how many options one person may pick (1: a single choice) */
    maxChoices: z.number().int().min(1).max(ACTIVITY_LIMITS.pollOptionsMax).default(1),
  })
  .superRefine((v, ctx) => {
    if (v.maxChoices > v.options.length)
      ctx.addIssue({ code: 'custom', path: ['maxChoices'], message: 'More choices than options.' })
    const seen = new Set<string>()
    v.options.forEach((o, i) => {
      const k = normalizeWord(o)
      if (seen.has(k)) ctx.addIssue({ code: 'custom', path: ['options', i], message: 'Each option once.' })
      seen.add(k)
    })
  })
export type PollConfig = z.infer<typeof PollConfig>

export const ScaleConfig = z
  .strictObject({
    min: z.number().int().min(0).max(1),
    max: z.number().int().min(5).max(10),
    minLabel: ScaleLabel.nullable().default(null),
    maxLabel: ScaleLabel.nullable().default(null),
  })
  .refine((v) => SCALE_RANGES.some(([a, b]) => a === v.min && b === v.max), {
    message: 'A scale is 1-5, 1-7 or 0-10.',
    path: ['max'],
  })
export type ScaleConfig = z.infer<typeof ScaleConfig>

export const WordsConfig = z.strictObject({
  maxWords: z
    .number()
    .int()
    .min(ACTIVITY_LIMITS.wordsPerPersonMin)
    .max(ACTIVITY_LIMITS.wordsPerPersonMax)
    .default(ACTIVITY_LIMITS.wordsPerPersonDefault),
})
export type WordsConfig = z.infer<typeof WordsConfig>

const Duration = z.number().int().min(ACTIVITY_LIMITS.durationMinMs).max(ACTIVITY_LIMITS.durationMaxMs)
const setupBase = {
  prompt: ActivityPrompt,
  /** default true: nobody, the facilitator included, ever learns who answered what */
  anonymous: z.boolean().default(true),
  /** participants see the (windowed) counts while it is open; default false (the facilitator always does) */
  resultsLive: z.boolean().default(false),
  /** optional end time; null/omitted = until the facilitator closes it */
  durationMs: Duration.nullable().default(null),
}

/** POST /api/boards/:bid/activities (facilitate). Strict: an `actor`, a `status` or any other key is a 400. */
export const StartActivityInput = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('poll'), config: PollConfig, ...setupBase }),
  z.strictObject({ kind: z.literal('scale'), config: ScaleConfig, ...setupBase }),
  z.strictObject({ kind: z.literal('words'), config: WordsConfig, ...setupBase }),
])
export type StartActivityInput = z.input<typeof StartActivityInput>
export type StartActivity = z.output<typeof StartActivityInput>

// ---- answers -------------------------------------------------------------------------------------------------------

export const PollAnswer = z.strictObject({
  kind: z.literal('poll'),
  /** option indexes, each once */
  choices: z
    .array(
      z
        .number()
        .int()
        .min(0)
        .max(ACTIVITY_LIMITS.pollOptionsMax - 1),
    )
    .min(1)
    .max(ACTIVITY_LIMITS.pollOptionsMax)
    .refine((c) => new Set(c).size === c.length, { message: 'Each option once.' }),
})
export const ScaleAnswer = z.strictObject({
  kind: z.literal('scale'),
  value: z.number().int().min(0).max(10),
})
export const WordsAnswer = z.strictObject({
  kind: z.literal('words'),
  words: z
    .array(WordText)
    .min(ACTIVITY_LIMITS.wordsPerPersonMin)
    .max(ACTIVITY_LIMITS.wordsPerPersonMax)
    .refine((w) => new Set(w.map(normalizeWord)).size === w.length, { message: 'Each word once.' }),
})
export const ActivityAnswer = z.discriminatedUnion('kind', [PollAnswer, ScaleAnswer, WordsAnswer])
export type ActivityAnswer = z.infer<typeof ActivityAnswer>

/** POST /api/activities/:aid/answer (participate): the caller's answer, replacing theirs. */
export const AnswerActivityInput = z.strictObject({ answer: ActivityAnswer })
export type AnswerActivityInput = z.input<typeof AnswerActivityInput>

/** The configuration an answer is checked against (the stored activity's). */
export type ActivityConfigOf =
  | { kind: 'poll'; config: PollConfig }
  | { kind: 'scale'; config: ScaleConfig }
  | { kind: 'words'; config: WordsConfig }

/**
 * Why `answer` does not fit the activity (null = it does): the kind, a poll's option indexes and choice count, a scale's
 * range, a word cloud's entry count. The schema has already checked each value's own rules.
 */
export function answerProblem(activity: ActivityConfigOf, answer: ActivityAnswer): string | null {
  if (answer.kind !== activity.kind) return 'This answer is for another kind of activity.'
  if (activity.kind === 'poll' && answer.kind === 'poll') {
    if (answer.choices.some((c) => c >= activity.config.options.length)) return 'That option does not exist.'
    if (answer.choices.length > activity.config.maxChoices)
      return activity.config.maxChoices === 1
        ? 'Pick one option.'
        : `Pick at most ${activity.config.maxChoices} options.`
  }
  if (activity.kind === 'scale' && answer.kind === 'scale') {
    if (answer.value < activity.config.min || answer.value > activity.config.max)
      return `Pick a number from ${activity.config.min} to ${activity.config.max}.`
  }
  if (activity.kind === 'words' && answer.kind === 'words') {
    if (answer.words.length > activity.config.maxWords)
      return activity.config.maxWords === 1
        ? 'Send one word.'
        : `Send at most ${activity.config.maxWords} words.`
  }
  return null
}

// ---- results (aggregates only) -------------------------------------------------------------------------------------

export const WordCount = z.object({ text: z.string(), count: z.number().int().positive() })
export type WordCount = z.infer<typeof WordCount>

export const ActivityResults = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('poll'),
    /** people who answered */
    answered: z.number().int().nonnegative(),
    /** picks per option, in the options' order (zeros included) */
    counts: z.array(z.number().int().nonnegative()).max(ACTIVITY_LIMITS.pollOptionsMax),
  }),
  z.object({
    kind: z.literal('scale'),
    answered: z.number().int().nonnegative(),
    /** answers per value, from `min` to `max` */
    counts: z.array(z.number().int().nonnegative()).max(11),
    /** null with no answer; rounded to 2 decimals */
    mean: z.number().nullable(),
    median: z.number().nullable(),
  }),
  z.object({
    kind: z.literal('words'),
    answered: z.number().int().nonnegative(),
    /** the top words (hidden ones left out), highest count first, ties in code-point order of `text` */
    words: z.array(WordCount).max(ACTIVITY_LIMITS.resultWordsMax),
    /** distinct words (hidden ones left out), also those past the top list */
    distinct: z.number().int().nonnegative(),
    /** distinct words the facilitator hid */
    hidden: z.number().int().nonnegative(),
  }),
])
export type ActivityResults = z.infer<typeof ActivityResults>
export type PollResults = Extract<ActivityResults, { kind: 'poll' }>
export type ScaleResults = Extract<ActivityResults, { kind: 'scale' }>
export type WordsResults = Extract<ActivityResults, { kind: 'words' }>

/** Rounded to 2 decimals (what results carry). */
const round2 = (n: number) => Math.round(n * 100) / 100

/** A poll's results from its answers' choices (pure; the api's results and the tests). */
export function tallyPoll(optionCount: number, answers: readonly (readonly number[])[]): PollResults {
  const counts = new Array<number>(optionCount).fill(0)
  for (const a of answers)
    for (const c of new Set(a)) if (c >= 0 && c < optionCount) counts[c] = (counts[c] ?? 0) + 1
  return { kind: 'poll', answered: answers.length, counts }
}

/** A scale's results from its answers' values (pure). The median of an even count is the mean of the middle two. */
export function tallyScale(min: number, max: number, values: readonly number[]): ScaleResults {
  const counts = new Array<number>(max - min + 1).fill(0)
  const kept = values.filter((v) => Number.isInteger(v) && v >= min && v <= max)
  for (const v of kept) counts[v - min] = (counts[v - min] ?? 0) + 1
  if (!kept.length) return { kind: 'scale', answered: 0, counts, mean: null, median: null }
  const sorted = [...kept].sort((a, b) => a - b)
  const mid = sorted.length >> 1
  const median = sorted.length % 2 ? (sorted[mid] ?? 0) : ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2
  const mean = kept.reduce((s, v) => s + v, 0) / kept.length
  return { kind: 'scale', answered: kept.length, counts, mean: round2(mean), median: round2(median) }
}

/**
 * A word cloud's results (pure, deterministic): entries grouped by normalizeWord (one person's same word counts once),
 * hidden keys (normalized) left out; each word shown in its most frequent original spelling (ties: code-point order);
 * highest count first, ties by the shown text in code-point order; at most `limit`.
 */
export function tallyWords(
  answers: readonly (readonly string[])[],
  hidden: Iterable<string> = [],
  limit: number = ACTIVITY_LIMITS.resultWordsMax,
): WordsResults {
  const hide = new Set([...hidden].map(normalizeWord))
  const groups = new Map<string, { count: number; spellings: Map<string, number> }>()
  const hiddenSeen = new Set<string>()
  for (const words of answers) {
    const mine = new Map<string, string>()
    for (const w of words) {
      const shown = w.replace(/\s+/gu, ' ').trim()
      const key = normalizeWord(shown)
      if (!key || mine.has(key)) continue
      mine.set(key, shown)
    }
    for (const [key, shown] of mine) {
      if (hide.has(key)) {
        hiddenSeen.add(key)
        continue
      }
      let g = groups.get(key)
      if (!g) {
        g = { count: 0, spellings: new Map() }
        groups.set(key, g)
      }
      g.count++
      g.spellings.set(shown, (g.spellings.get(shown) ?? 0) + 1)
    }
  }
  const words = [...groups.values()]
    .map((g) => {
      const text =
        [...g.spellings.entries()].sort((a, b) => b[1] - a[1] || byCodePoint(a[0], b[0]))[0]?.[0] ?? ''
      return { text, count: g.count }
    })
    .sort((a, b) => b.count - a.count || byCodePoint(a.text, b.text))
  return {
    kind: 'words',
    answered: answers.length,
    words: words.slice(0, Math.max(0, limit)),
    distinct: words.length,
    hidden: hiddenSeen.size,
  }
}

/** Competition ranks of a poll's options by count (ties share a rank: 1, 1, 3); zero-count options rank last. */
export function rankActivityResults(
  counts: readonly number[],
): { option: number; count: number; rank: number }[] {
  const sorted = counts
    .map((count, option) => ({ option, count }))
    .sort((a, b) => b.count - a.count || a.option - b.option)
  const out: { option: number; count: number; rank: number }[] = []
  sorted.forEach((t, i) => {
    const prev = out[i - 1]
    out.push({ ...t, rank: prev && prev.count === t.count ? prev.rank : i + 1 })
  })
  return out
}

// ---- state ---------------------------------------------------------------------------------------------------------

/**
 * - open: people are answering (an open activity past `endsAt` is reported as closed: the effective status);
 * - closed: no more answers; the facilitator may reveal it;
 * - revealed: the results are everyone's (and may be placed on the board);
 * - cancelled: ended without results (an anonymous one's answers are deleted).
 */
export const ActivityStatus = z.enum(['open', 'closed', 'revealed', 'cancelled'])
export type ActivityStatus = z.infer<typeof ActivityStatus>

const activityBase = {
  id: ActivityId,
  boardId: z.string(),
  prompt: z.string(),
  anonymous: z.boolean(),
  resultsLive: z.boolean(),
  status: ActivityStatus,
  /** an account (the starter); null when that account was deleted */
  createdBy: WsUserId.nullable(),
  createdAt: IsoDate,
  endsAt: IsoDate.nullable(),
  closedAt: IsoDate.nullable(),
  revealedAt: IsoDate.nullable(),
  /** when a facilitator's client placed the results on the board (POST …/placed); no element id is kept */
  placedAt: IsoDate.nullable(),
}
export const LiveActivity = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('poll'), config: PollConfig, ...activityBase }),
  z.object({ kind: z.literal('scale'), config: ScaleConfig, ...activityBase }),
  z.object({ kind: z.literal('words'), config: WordsConfig, ...activityBase }),
])
export type LiveActivity = z.infer<typeof LiveActivity>

/**
 * GET /api/boards/:bid/activity (view), and the answer to every activity mutation, for the caller. Not strict
 * (additive fields are safe for an older web).
 */
export const ActivityState = z.object({
  /** the open activity, else the most recent closed or revealed one (cancelled ones are not shown) */
  activity: LiveActivity.nullable(),
  /** people who answered, as of the last tally window boundary while open (exact once it is not) */
  answered: z.number().int().nonnegative(),
  /** the CALLER's own answer (never anybody else's); null when they have none, or can no longer see it (after the
   *  reveal of an anonymous activity the api keeps no per-person answer) */
  myAnswer: ActivityAnswer.nullable(),
  /**
   * revealed: everyone's; open or closed: the facilitator's (`canManage`) and, with `resultsLive`, everyone's, as of the
   * last window boundary; else null.
   */
  results: ActivityResults.nullable(),
  /** the caller may close, reveal, extend, cancel, hide words and mark it placed (the api decides) */
  canManage: z.boolean(),
  /** the starter can no longer edit the board, so any editor with an account may manage it */
  starterLeft: z.boolean(),
  /** for a manager of a word cloud: the words they hid (normalized); [] otherwise */
  hiddenWords: z.array(z.string()).max(ACTIVITY_LIMITS.hiddenWordsMax),
  serverNow: IsoDate,
})
export type ActivityState = z.infer<typeof ActivityState>

/** POST /api/activities/:aid/extend (manage). */
export const ExtendActivityInput = z.strictObject({
  addMs: z.number().int().min(1000).max(ACTIVITY_LIMITS.extendMaxMs),
})
export type ExtendActivityInput = z.infer<typeof ExtendActivityInput>

/** POST /api/activities/:aid/hide (manage; word clouds only): hide (or show again) one word, by any spelling of it. */
export const HideWordInput = z.strictObject({ word: WordText, hidden: z.boolean().default(true) })
export type HideWordInput = z.input<typeof HideWordInput>

/** One past activity (GET /api/boards/:bid/activities, view): aggregates only, for the list and the session summary. */
export const ActivitySummary = z.object({
  activity: LiveActivity,
  answered: z.number().int().nonnegative(),
  /** revealed only (null before, and for a cancelled one) */
  results: ActivityResults.nullable(),
})
export type ActivitySummary = z.infer<typeof ActivitySummary>
export const ListActivitiesResponse = z.object({ activities: z.array(ActivitySummary) })
export type ListActivitiesResponse = z.infer<typeof ListActivitiesResponse>

/** GET /api/activities/:aid/results: revealed (view), or open/closed for a manager. */
export const ActivityResultsResponse = z.object({
  activity: LiveActivity,
  results: ActivityResults,
})
export type ActivityResultsResponse = z.infer<typeof ActivityResultsResponse>

/**
 * GET /api/activities/:aid/answers (manage; a NAMED activity, after the reveal only): who answered what. 404 for an
 * anonymous activity (there is nothing to answer with), 409 NOT_REVEALED before the reveal.
 */
export const NamedAnswersResponse = z.object({
  answers: z.array(z.object({ userId: WsUserId, name: z.string(), answer: ActivityAnswer })),
})
export type NamedAnswersResponse = z.infer<typeof NamedAnswersResponse>

/** The refusals the web tells apart (409 unless said; the messages are user-facing). */
export const ACTIVITY_ERROR_CODES = {
  /** 409: the board already has an open activity */
  activityOpen: 'ACTIVITY_OPEN',
  /** 409: the activity is not open (an answer, an extend, a close) */
  notOpen: 'ACTIVITY_NOT_OPEN',
  /** 409: the results are not revealed yet (named answers) */
  notRevealed: 'ACTIVITY_NOT_REVEALED',
  /** 400: the answer does not fit the activity (answerProblem) */
  badAnswer: 'ACTIVITY_BAD_ANSWER',
  /** 403: someone else runs this activity (and has not left) */
  notYours: 'ACTIVITY_NOT_YOURS',
} as const

// ---- events (GET /api/boards/:bid/events; after COMMIT; the same body for every viewer) -----------------------------

/** Event names (also in workshops.ts WORKSHOP_EVENTS). An older web has no listener for them. */
export const LIVE_ACTIVITY_EVENTS = {
  activity: 'workshop.activity',
  results: 'workshop.activity.results',
} as const

/**
 * `workshop.activity`: the activity after a change (start, a window's new count, close, extend, reveal, cancel, placed,
 * a hidden word); aggregates only. `results` only when its `resultsLive` is on, or once revealed. Each client refetches
 * its own answer.
 */
export const WorkshopActivityEvent = z.object({
  activity: LiveActivity,
  answered: z.number().int().nonnegative(),
  results: ActivityResults.nullable(),
})
export type WorkshopActivityEvent = z.infer<typeof WorkshopActivityEvent>

/** `workshop.activity.results`: published once, at the reveal. */
export const WorkshopActivityResultsEvent = z.object({ activityId: ActivityId, results: ActivityResults })
export type WorkshopActivityResultsEvent = z.infer<typeof WorkshopActivityResultsEvent>

// ---- routes and who may call them (./live.ts LiveRule) --------------------------------------------------------------

export const ACTIVITY_ROUTES = {
  current: '/api/boards/:bid/activity',
  list: '/api/boards/:bid/activities',
  answer: '/api/activities/:aid/answer',
  close: '/api/activities/:aid/close',
  reveal: '/api/activities/:aid/reveal',
  extend: '/api/activities/:aid/extend',
  cancel: '/api/activities/:aid/cancel',
  hide: '/api/activities/:aid/hide',
  placed: '/api/activities/:aid/placed',
  results: '/api/activities/:aid/results',
  answers: '/api/activities/:aid/answers',
} as const
const A = ACTIVITY_ROUTES
export const ACTIVITY_ROUTE_KEYS = [
  `GET ${A.current}`,
  `GET ${A.list}`,
  `POST ${A.list}`,
  `POST ${A.answer}`,
  `POST ${A.close}`,
  `POST ${A.reveal}`,
  `POST ${A.extend}`,
  `POST ${A.cancel}`,
  `POST ${A.hide}`,
  `POST ${A.placed}`,
  `GET ${A.results}`,
  `GET ${A.answers}`,
] as const
export type ActivityRouteKey = (typeof ACTIVITY_ROUTE_KEYS)[number]

/**
 * Each route's rule. GET …/results is `view` for a revealed activity and `manage` before (the route decides by status);
 * it is listed as `view` (a guest may read revealed results).
 */
export const ACTIVITY_RULES: Readonly<
  Record<ActivityRouteKey, 'view' | 'participate' | 'facilitate' | 'manage'>
> = {
  'GET /api/boards/:bid/activity': 'view',
  'GET /api/boards/:bid/activities': 'view',
  'POST /api/boards/:bid/activities': 'facilitate',
  'POST /api/activities/:aid/answer': 'participate',
  'POST /api/activities/:aid/close': 'manage',
  'POST /api/activities/:aid/reveal': 'manage',
  'POST /api/activities/:aid/extend': 'manage',
  'POST /api/activities/:aid/cancel': 'manage',
  'POST /api/activities/:aid/hide': 'manage',
  'POST /api/activities/:aid/placed': 'manage',
  'GET /api/activities/:aid/results': 'view',
  'GET /api/activities/:aid/answers': 'manage',
}

/** The routes a name-only guest is refused outright (guests/guard.ts, LIVE_FACILITATE_GUESTS_MESSAGE). */
export const ACTIVITY_FACILITATOR_ROUTE_KEYS: readonly ActivityRouteKey[] = ACTIVITY_ROUTE_KEYS.filter(
  (k) => ACTIVITY_RULES[k] === 'facilitate' || ACTIVITY_RULES[k] === 'manage',
)

const enc = encodeURIComponent
export const activityPath = (bid: string) => `/api/boards/${enc(bid)}/activity`
export const activitiesPath = (bid: string) => `/api/boards/${enc(bid)}/activities`
export const activityActionPath = (
  aid: string,
  action: 'answer' | 'close' | 'reveal' | 'extend' | 'cancel' | 'hide' | 'placed' | 'results' | 'answers',
) => `/api/activities/${enc(aid)}/${action}`
