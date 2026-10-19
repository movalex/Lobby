// OWNER: WS2 (wave V, V1). The words the live activities show (pure; Node-tested): counts, statuses, the setup's
// choices, the recap's lines. Aggregates only: nothing here ever takes a person.
import {
  ACTIVITY_KIND_LABELS,
  type ActivityKind,
  type ActivityResults,
  type ActivityStatus,
  type ActivitySummary,
  type LiveActivity,
  rankActivityResults,
} from '@draftroom/contracts'
import { clip, oneDecimal, scaleSummary } from './board-plan.ts'

/** The dock panel's id (CanvasPanelSpec.id). */
export const ACTIVITY_PANEL_ID = 'live-activity'

/** "1 answer" / "12 answers" */
export const answersText = (n: number) => `${n} ${n === 1 ? 'answer' : 'answers'}`

/** The pill's short word for an open activity (the Facilitate button's pill, at most 24 characters). */
export const PILL_TEXT: Readonly<Record<ActivityKind, string>> = {
  poll: 'Poll',
  scale: 'Scale',
  words: 'Words',
}
/** What a screen reader says for the pill part. */
export const PILL_SPOKEN: Readonly<Record<ActivityKind, string>> = {
  poll: 'a poll is open',
  scale: 'a scale is open',
  words: 'a word cloud is open',
}

export const kindLabel = (k: ActivityKind) => ACTIVITY_KIND_LABELS[k]

/** "Poll is open" / "Answers are closed" / "Results" (the panel's status line, and the menu entry's meta). */
export function statusText(status: ActivityStatus | null): string {
  switch (status) {
    case 'open':
      return 'Open'
    case 'closed':
      return 'Closed'
    case 'revealed':
      return 'Results'
    case 'cancelled':
      return 'Cancelled'
    default:
      return ''
  }
}

/** "2:05" (ms left, rounded up to the second). */
export function clockText(ms: number): string {
  const s = Math.max(0, Math.ceil(ms / 1000))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

/** "2 minutes 5 seconds" (for screen readers). */
export function spokenClock(ms: number): string {
  const s = Math.max(0, Math.ceil(ms / 1000))
  const m = Math.floor(s / 60)
  const r = s % 60
  const parts: string[] = []
  if (m) parts.push(`${m} minute${m === 1 ? '' : 's'}`)
  if (r || !m) parts.push(`${r} second${r === 1 ? '' : 's'}`)
  return parts.join(' ')
}

/** The time limits the setup offers (ms; null: until the facilitator closes it). */
export const DURATION_CHOICES: readonly { readonly ms: number | null; readonly label: string }[] = [
  { ms: null, label: 'No time limit' },
  { ms: 60_000, label: '1 minute' },
  { ms: 2 * 60_000, label: '2 minutes' },
  { ms: 3 * 60_000, label: '3 minutes' },
  { ms: 5 * 60_000, label: '5 minutes' },
  { ms: 10 * 60_000, label: '10 minutes' },
]

/** How much "+ time" adds while it runs. */
export const EXTEND_MS = 60_000

/** "Pick one" / "Pick up to 3" (a poll's instruction). */
export const pickText = (maxChoices: number) => (maxChoices <= 1 ? 'Pick one.' : `Pick up to ${maxChoices}.`)

/** "Up to 3 words" / "One word" (a word cloud's instruction). */
export const wordsText = (maxWords: number) =>
  maxWords <= 1 ? 'Send one word or short phrase.' : `Send up to ${maxWords} words or short phrases.`

/** What anonymity means here, in the answer sheet. */
export const anonymityText = (anonymous: boolean) =>
  anonymous
    ? 'Anonymous: nobody, the facilitator included, sees who answered what.'
    : 'Named: the facilitator sees who answered what after the reveal. Nobody else does.'

// ---- the recap -----------------------------------------------------------------------------------------------

/** A poll's options with their counts, best first ("Friday 8, Monday 6, Tuesday 0"), at most `max` of them. */
export function pollLine(options: readonly string[], counts: readonly number[], max = 6): string {
  const ranked = rankActivityResults(options.map((_, i) => counts[i] ?? 0))
  const shown = ranked.slice(0, max).map((r) => `${clip(options[r.option] ?? '', 40)} ${r.count}`)
  const more = ranked.length - shown.length
  return more > 0 ? `${shown.join(', ')} and ${more} more` : shown.join(', ')
}

/** The recap's line for one activity, or null (a cancelled one says nothing). */
export function recapLine(s: Pick<ActivitySummary, 'activity' | 'answered' | 'results'>): string | null {
  const a: LiveActivity = s.activity
  if (a.status === 'cancelled') return null
  const head = `${clip(a.prompt, 120)}: ${answersText(s.answered)}`
  const r: ActivityResults | null = a.status === 'revealed' ? s.results : null
  if (!r) return `${head} (results not revealed).`
  if (a.kind === 'poll' && r.kind === 'poll') return `${head}. ${pollLine(a.config.options, r.counts)}.`
  if (a.kind === 'scale' && r.kind === 'scale') {
    const summary = r.mean === null ? 'no answers' : scaleSummary(r)
    return `${head}, ${summary} (${a.config.min} to ${a.config.max}).`
  }
  if (a.kind === 'words' && r.kind === 'words') {
    if (!r.words.length) return `${head}.`
    const top = r.words
      .slice(0, 10)
      .map((w) => `${clip(w.text, 30)} ${w.count}`)
      .join(', ')
    return `${head}. Top words: ${top}.`
  }
  return `${head}.`
}

export { oneDecimal }
