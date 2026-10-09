// OWNER: W2 (wave L, L2-3). What a recap says (pure): the AI's headline, decisions, actions with owners and open
// questions when AI ran; and, AI or not, the room's own results: the top voted items (the api's topVoted, from
// the revealed tallies, never the model's guess; without AI, this tab's last revealed vote, W5's
// lastRevealedResults) and "Planned vs actual" from the presenter's run of show (W5's agendaActuals). With AI off,
// or for a name-only guest, the recap is those non-AI sections only, and says so.

import type { AiResult } from '@draftroom/contracts'
import { cut } from '../copy.ts'
import type { RecapScopeName } from './window.ts'

export type RecapResult = Extract<AiResult, { action: 'recap' }>

/** Top voted items shown (the api sends up to 20). */
export const TOP_VOTED_SHOWN = 5

export interface RecapLine {
  readonly text: string
  /** the items it comes from (shape refs, `shape:<id>`) */
  readonly refs: readonly string[]
}
export interface RecapActionLine {
  readonly task: string
  readonly owner: string | null
  readonly refs: readonly string[]
}
export interface RecapVoteLine {
  readonly ref: string
  readonly label: string
  readonly votes: number
  readonly rank: number
}
export interface RecapRow {
  readonly name: string
  readonly plannedMin: number | null
  readonly actualMin: number
}

export interface RecapPlan {
  /** "Recap · 8 Oct": the frame's name and the Markdown's heading */
  readonly title: string
  readonly scope: RecapScopeName
  /** "This session", "The selected frames", "Since your last visit" */
  readonly scopeLabel: string
  /** the AI sections are in */
  readonly ai: boolean
  /** why there are none, when there are none ("AI is off on this board.") */
  readonly aiNote: string | null
  readonly headline: string | null
  readonly decisions: readonly RecapLine[]
  readonly actions: readonly RecapActionLine[]
  readonly questions: readonly RecapLine[]
  readonly topVoted: readonly RecapVoteLine[]
  /** null: no "Planned vs actual" (no run of show recorded in this tab) */
  readonly plannedVsActual: readonly RecapRow[] | null
  readonly windowFrom: number | null
  readonly runId: string | null
}

export interface RecapInput {
  readonly scope: RecapScopeName
  readonly now: number
  /** the api's answer; null when AI did not run (off, a guest, refused) */
  readonly result: RecapResult | null
  /** why AI did not run (null when it did) */
  readonly aiNote: string | null
  readonly since: number | null
  /** W5's agendaActuals(boardId) */
  readonly actuals: readonly { name: string; plannedMin: number | null; actualMs: number }[] | null
  /** W5's lastRevealedResults(ctx.events) */
  readonly revealed: { readonly results: readonly { ref: string; count: number; rank: number }[] } | null
  /** the words of an element by its ref (for vote lines); '' when it is gone */
  readonly textOf: (ref: string) => string
}

const SCOPE_LABELS: Record<RecapScopeName, string> = {
  session: 'This session',
  selection: 'The selected frames',
  'catch-up': 'Since your last visit',
}

/** "Recap · 8 Oct" (the date of `now`, this browser's day). */
export function recapTitle(now: number): string {
  return `Recap · ${new Date(now).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}`
}

const flat = (s: string) => s.replace(/\s+/g, ' ').trim()

export function recapPlan(input: RecapInput): RecapPlan {
  const r = input.result
  const votes = r
    ? r.topVoted.map((v) => ({ ref: v.id, count: v.votes, rank: v.rank }))
    : (input.revealed?.results ?? [])
  const topVoted = [...votes]
    .filter((v) => v.count > 0)
    .sort((a, b) => a.rank - b.rank || b.count - a.count)
    .map((v) => ({ ref: v.ref, label: cut(flat(input.textOf(v.ref)), 80), votes: v.count, rank: v.rank }))
    .filter((v) => v.label)
    .slice(0, TOP_VOTED_SHOWN)
  const plannedVsActual = input.actuals?.length
    ? input.actuals.map((a) => ({
        name: cut(flat(a.name) || 'Untitled frame', 60),
        plannedMin: a.plannedMin,
        actualMin: Math.max(0, Math.round(a.actualMs / 60_000)),
      }))
    : null
  return {
    title: recapTitle(input.now),
    scope: input.scope,
    scopeLabel: SCOPE_LABELS[input.scope],
    ai: r !== null,
    aiNote: r ? null : input.aiNote,
    headline: r && flat(r.summary) ? flat(r.summary) : null,
    decisions: r ? r.decisions.map((d) => ({ text: flat(d.text), refs: d.ids })).filter((d) => d.text) : [],
    actions: r
      ? r.actions.map((a) => ({ task: flat(a.task), owner: a.owner, refs: a.ids })).filter((a) => a.task)
      : [],
    questions: r ? r.questions.map((q) => ({ text: flat(q.text), refs: q.ids })).filter((q) => q.text) : [],
    topVoted,
    plannedVsActual,
    windowFrom: r ? r.windowFrom : input.since,
    runId: r?.runId ?? null,
  }
}

/** Whether a plan says anything at all (else the panel says there is nothing to recap). */
export const recapIsEmpty = (p: RecapPlan) =>
  !p.headline &&
  !p.decisions.length &&
  !p.actions.length &&
  !p.questions.length &&
  !p.topVoted.length &&
  !p.plannedVsActual?.length
