// OWNER: W2 (wave L, L2-3). What a recap says (pure): the AI's headline, decisions, actions with owners and open
// questions when AI ran; and, AI or not, the room's own results: the top voted items (the api's topVoted, from
// the revealed tallies, never the model's guess; without AI, this tab's last revealed vote, W5's
// lastRevealedResults) and "Planned vs actual" from the presenter's run of show (W5's agendaActuals). With AI off,
// or for a name-only guest, the recap is those non-AI sections only, and says so. A selection recap keeps only the
// votes on what is in the selected frames (and their sections of the run of show: ./recap.ts); votes from this
// tab's last revealed vote are titled as that ("Top voted (last vote)"), since they are not windowed. Catch me up
// names its window by date, and says when the api clamped it to AI_RECAP_MAX_WINDOW_MS.
//
// Wave V (WS5, the session summary): the registered sources' sections (./sources.ts: polls and scales, word clouds,
// breakouts; aggregates only, collected by ./recap.ts with no AI call) follow the room's own results, each as its
// title and a few one-line texts, in the sources' order. A plan built without them (the summary's switch off, or no
// source had anything to say) is exactly the plan before wave V.

import { AI_RECAP_MAX_WINDOW_MS, type AiResult } from '@draftroom/contracts'
import { cut } from '../copy.ts'
import type { RecapSection, RecapSourceId } from './sources.ts'
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

/** One registered source's section as the recap shows it (plain, one-line texts). */
export interface RecapSourceSection {
  readonly id: RecapSourceId
  readonly title: string
  readonly lines: readonly { readonly text: string; readonly ids: readonly string[] }[]
}

/** A section title's and a line's most code points (the panel, the Markdown and the frame show the same words). */
export const RECAP_SECTION_TITLE_MAX = 60
export const RECAP_SECTION_LINE_MAX = 200

export interface RecapPlan {
  /** "Recap · 8 Oct": the frame's name and the Markdown's heading */
  readonly title: string
  readonly scope: RecapScopeName
  /** "This session", "The selected frames", "Since your last visit, 8 Oct, 09:12", "Since 24 Sep, 16:00 (the last 14 days)" */
  readonly scopeLabel: string
  /** what the Recap frame and the Markdown say: scopeLabel without the visit time, which is private (the server keeps
   *  it for this person only; on the shared board it would be a read receipt) */
  readonly sharedLabel: string
  /** the AI sections are in */
  readonly ai: boolean
  /** why there are none, when there are none ("AI is off on this board.") */
  readonly aiNote: string | null
  readonly headline: string | null
  readonly decisions: readonly RecapLine[]
  readonly actions: readonly RecapActionLine[]
  readonly questions: readonly RecapLine[]
  readonly topVoted: readonly RecapVoteLine[]
  /** "Top voted" (the api's, for the window), or "Top voted (last vote)" (this tab's last revealed vote, no AI) */
  readonly topVotedTitle: string
  /** null: no "Planned vs actual" (no run of show recorded in this tab) */
  readonly plannedVsActual: readonly RecapRow[] | null
  /** wave V: the registered sources' sections, in order ([]: none, as before wave V) */
  readonly sections: readonly RecapSourceSection[]
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
  /** catch-up: `since` is this device's previous visit (else the last 24 hours) */
  readonly visit?: boolean
  /** a selection recap: whether a vote's ref (`shape:<id>`) is in the selected frames (else every vote counts) */
  readonly inScope?: (ref: string) => boolean
  /** W5's agendaActuals(boardId) */
  readonly actuals: readonly { name: string; plannedMin: number | null; actualMs: number }[] | null
  /** W5's lastRevealedResults(ctx.events) */
  readonly revealed: { readonly results: readonly { ref: string; count: number; rank: number }[] } | null
  /** the words of an element by its ref (for vote lines); '' when it is gone */
  readonly textOf: (ref: string) => string
  /** wave V: what the registered sources said (./sources.ts collectRecapSections); none when absent */
  readonly sections?: readonly RecapSection[]
}

const SCOPE_LABELS: Record<RecapScopeName, string> = {
  session: 'This session',
  selection: 'The selected frames',
  'catch-up': 'Since your last visit',
}

/** "8 Oct, 09:12": a window's start as the recap names it (this browser's time). */
export function recapWhen(at: number): string {
  return new Date(at).toLocaleString('en-GB', {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  })
}

const WINDOW_DAYS = Math.round(AI_RECAP_MAX_WINDOW_MS / 86_400_000)

/** Catch me up's label: since the last visit, or the last 24 hours, or the clamp. */
function catchUpLabel(from: number | null, clamped: boolean, visit: boolean, shared: boolean): string {
  if (from === null) return SCOPE_LABELS['catch-up']
  if (clamped) return `Since ${recapWhen(from)} (the last ${WINDOW_DAYS} days)`
  if (visit && shared) return SCOPE_LABELS['catch-up'] // the visit time is private: never on the board
  return visit ? `Since your last visit, ${recapWhen(from)}` : `Since ${recapWhen(from)} (the last 24 hours)`
}

/** "Recap · 8 Oct" (the date of `now`, this browser's day). */
export function recapTitle(now: number): string {
  return `Recap · ${new Date(now).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}`
}

const flat = (s: string) => s.replace(/\s+/g, ' ').trim()

/** The sources' sections as plain one-line words: empty lines and empty sections left out, each source once. */
export function recapSourceSections(sections: readonly RecapSection[] | undefined): RecapSourceSection[] {
  const seen = new Set<RecapSourceId>()
  const out: RecapSourceSection[] = []
  for (const s of sections ?? []) {
    if (seen.has(s.id)) continue
    const lines = s.lines
      .map((l) => ({ text: cut(flat(l.text), RECAP_SECTION_LINE_MAX), ids: [...(l.ids ?? [])] }))
      .filter((l) => l.text)
    const title = cut(flat(s.title), RECAP_SECTION_TITLE_MAX)
    if (!lines.length || !title) continue
    seen.add(s.id)
    out.push({ id: s.id, title, lines })
  }
  return out
}

export function recapPlan(input: RecapInput): RecapPlan {
  const r = input.result
  const votes = r
    ? r.topVoted.map((v) => ({ ref: v.id, count: v.votes, rank: v.rank }))
    : (input.revealed?.results ?? [])
  const inScope = input.inScope
  const topVoted = [...votes]
    .filter((v) => v.count > 0 && (!inScope || inScope(v.ref)))
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
  // the window as applied: the api's (it clamps), else ours, clamped the same way for Catch me up
  const asked = input.since
  const floor = input.now - AI_RECAP_MAX_WINDOW_MS
  const from = r
    ? r.windowFrom
    : asked !== null && input.scope === 'catch-up'
      ? Math.max(asked, floor)
      : asked
  const clamped = input.scope === 'catch-up' && asked !== null && from !== null && from > asked + 60_000
  return {
    title: recapTitle(input.now),
    scope: input.scope,
    scopeLabel:
      input.scope === 'catch-up'
        ? catchUpLabel(from, clamped, input.visit === true, false)
        : SCOPE_LABELS[input.scope],
    sharedLabel:
      input.scope === 'catch-up'
        ? catchUpLabel(from, clamped, input.visit === true, true)
        : SCOPE_LABELS[input.scope],
    ai: r !== null,
    aiNote: r ? null : input.aiNote,
    headline: r && flat(r.summary) ? flat(r.summary) : null,
    decisions: r ? r.decisions.map((d) => ({ text: flat(d.text), refs: d.ids })).filter((d) => d.text) : [],
    actions: r
      ? r.actions.map((a) => ({ task: flat(a.task), owner: a.owner, refs: a.ids })).filter((a) => a.task)
      : [],
    questions: r ? r.questions.map((q) => ({ text: flat(q.text), refs: q.ids })).filter((q) => q.text) : [],
    topVoted,
    topVotedTitle: r ? 'Top voted' : 'Top voted (last vote)',
    plannedVsActual,
    sections: recapSourceSections(input.sections),
    windowFrom: from,
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
  !p.plannedVsActual?.length &&
  !p.sections.length
