// OWNER: W2 (wave L, L2-2). Ask this board: a question in a sentence, a short answer with numbered sources that
// are proven to be on the board (the api validates every citation against the items it sent). The answer is
// private (a panel, ./Overlay.tsx AnswerPanel); a source selects its elements and moves this tab's camera to them,
// nothing else (no write, no push); "The board doesn't say" when it does not. Editors may add the answer as a note
// (one transact, kind 'ai-answer', with the run's provenance). Asking needs view (a viewer may ask); a name-only
// guest gets no AI at all (the api's rule, AiStatus says so).
//
// Entry points: the AI menu ("Ask this board…", for the selection or the whole board), the command 'ai.ask' (the
// palette passes {question}) and the selection bar's AI button.

import { AI_ASK_QUESTION_MAX, AI_MAX_REQUEST_SHAPES, type AiResult } from '@draftroom/contracts'
import type { CanvasFeatureContext, LobbyCanvas } from '../../../canvas/api/index.ts'
import { type Atom, atom } from '../../../lib/signals.ts'
import { countUsage } from '../../../lib/usage.ts'
import { cut } from '../copy.ts'
import { offerUndoFor, runPublic } from './actions.ts'
import { applyNotes } from './apply.ts'
import { aiJob, aiStatus, openingPrivatePanel, perCanvas, registerPrivatePanel } from './runtime.ts'
import { type AiTarget, idOfRef, isLive, NONE, refOf } from './target.ts'

export type AskResult = Extract<AiResult, { action: 'ask' }>

export interface AiAnswerState {
  readonly question: string
  /** 'asking' until the answer is in */
  readonly status: 'asking' | 'done'
  readonly result: AskResult | null
  /** what was asked about (the answer note goes beside its sources, else beside this) */
  readonly target: AiTarget
}

/** The open answer of each canvas (private: this tab only, never stored). */
export const aiAnswer = perCanvas<Atom<AiAnswerState | null>>(() =>
  atom<AiAnswerState | null>('lobby-ai-answer', null),
)

registerPrivatePanel('answer', (canvas) => aiAnswer(canvas).set(null))

/** The whole board as what a question is about. */
export const WHOLE_BOARD: AiTarget = { ...NONE, label: 'the whole board' }

/**
 * Asks `question` about `target` (its ids; none: the whole board) and opens the answer. Nothing is written. A newer
 * question replaces an older one still on its way (that request is cancelled, as the busy pill's Cancel does).
 * While another AI request of this tab is running (themes, a recap, …) it asks nothing and leaves the open answer
 * alone: the person is told to wait.
 */
export async function askBoard(ctx: CanvasFeatureContext, question: string, target: AiTarget): Promise<void> {
  const { canvas } = ctx
  const q = question.replace(/\s+/g, ' ').trim().slice(0, AI_ASK_QUESTION_MAX)
  if (!q) return
  const running = aiJob(canvas).get()
  if (running && running.action !== 'ask') {
    ctx.notify({
      key: 'dr-ai',
      text: 'Lobby is still working on another AI request. Wait for it to finish.',
      tone: 'error',
      testId: 'ai-error',
      timeoutMs: 6000,
    })
    return
  }
  if (running) {
    running.abort.abort()
    aiJob(canvas).set(null)
  }
  countUsage('ai.ask.scope:board')
  const mine: AiAnswerState = { question: q, status: 'asking', result: null, target }
  aiAnswer(canvas).set(mine)
  // one private panel at a time: the summary or a recap closes
  openingPrivatePanel(canvas, 'answer')
  const r = await runPublic(ctx, {
    action: 'ask',
    question: q,
    shapeIds: target.ids.slice(0, AI_MAX_REQUEST_SHAPES).map(refOf),
  })
  if (aiAnswer(canvas).get() !== mine) return // replaced or closed meanwhile
  if (r?.action !== 'ask') {
    aiAnswer(canvas).set(null)
    return
  }
  aiAnswer(canvas).set({ ...mine, status: 'done', result: r })
}

/** A piece of the answer's text: words, or a citation marker `[n]` (n from 1, a valid citation). */
export type AnswerPart = { readonly text: string } | { readonly cite: number }

/** The answer as words and citation chips (pure): `[n]` with no such citation stays as words. */
export function answerParts(answer: string, citations: number): AnswerPart[] {
  const out: AnswerPart[] = []
  let last = 0
  for (const m of answer.matchAll(/\[(\d{1,2})\]/g)) {
    const n = Number(m[1])
    if (n < 1 || n > citations) continue
    const at = m.index ?? 0
    if (at > last) out.push({ text: answer.slice(last, at) })
    out.push({ cite: n })
    last = at + m[0].length
  }
  if (last < answer.length) out.push({ text: answer.slice(last) })
  return out
}

/** The answer's words without its markers, for a note or the clipboard. */
export const answerText = (answer: string) =>
  answer
    .replace(/\s*\[\d{1,2}\]/g, '')
    .replace(/\s+/g, ' ')
    .trim()

/** The live element ids of citation refs (`shape:<id>`), as the board has them now. */
export function sourceIds(canvas: Pick<LobbyCanvas, 'get'>, refs: readonly string[]): string[] {
  return refs.map(idOfRef).filter((id) => isLive(canvas.get(id)))
}

const reducedMotion = () => {
  try {
    return globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true
  } catch {
    return false
  }
}

/**
 * A source chip: selects the cited elements and moves this tab's camera to them (never above 100%, animated
 * unless motion is reduced). Writes nothing. False when none of them is on the board any more.
 */
export function showSources(canvas: LobbyCanvas, refs: readonly string[]): boolean {
  const ids = sourceIds(canvas, refs)
  if (!ids.length) return false
  canvas.select(ids)
  const b = canvas.boundsOf(ids)
  if (b) canvas.viewport.zoomTo(b, { inset: 96, maxZoom: 1, ...(reducedMotion() ? {} : { animate: true }) })
  return true
}

/** Whether "Add answer as a note" is offered: an editor with AI on that may add, and an answer that says something. */
export function canAddAnswer(canvas: LobbyCanvas, state: AiAnswerState | null): boolean {
  return (
    !!state?.result &&
    state.result.found !== 'no' &&
    !!answerText(state.result.answer) &&
    !canvas.readOnly() &&
    aiStatus(canvas).get()?.canInsert === true
  )
}

/**
 * "Add answer as a note" (editors): the answer's words as one note under a heading, beside its sources (else beside
 * what was asked about, else in the view), in one transact, stamped with the run (kind 'ai-answer'). The private
 * answer then closes.
 */
export function addAnswerAsNote(ctx: CanvasFeatureContext): string[] | null {
  const { canvas } = ctx
  const state = aiAnswer(canvas).get()
  if (!state?.result || !canAddAnswer(canvas, state)) return null
  const cited = sourceIds(
    canvas,
    state.result.citations.flatMap((c) => c.ids),
  )
  const near: AiTarget = cited.length
    ? { ...state.target, kind: 'selection', ids: cited, bounds: canvas.boundsOf(cited) }
    : state.target
  const ids = applyNotes(
    canvas,
    near,
    {
      heading: `Answer: ${cut(state.question, 60)}`,
      texts: [answerText(state.result.answer)],
      color: 'light-blue',
      kind: 'answer',
    },
    ctx.me.user.id,
    state.result.runId,
  )
  aiAnswer(canvas).set(null)
  offerUndoFor(canvas, 'Answer added to the board.', ids)
  return ids
}
