// OWNER: W4 (wave M, M4-6, L-AI-8 web half). "All boards" in the Ask panel: one question asked of every board of the
// workspace this person can open (W8's client, ../workspace-ask/client.ts askWorkspace: POST
// /api/workspaces/:wid/ai/ask), answered privately in this tab with a chip per cited board that opens it at the cited
// elements (lib/deep-link.ts elementsLink, `?el=`). The switch shows only while askWorkspaceAvailable() says so; when
// the api answers that it is not there after all (a 404: WorkspaceAskUnavailableError) the switch goes and the
// question is asked of this board instead. "Add answer to board" only when the answer says every cited board allows
// copying out of it (`exportAllowed`). Nothing is written but that note; the answer is never stored or sent.

import { AI_ERROR_CODES, parseFileHitObjectId } from '@draftroom/contracts'
import { isApiError } from '../../../api/client.ts'
import type { CanvasFeatureContext, LobbyCanvas } from '../../../canvas/api/index.ts'
import { fileHitHref } from '../../../dashboard/search/content-search.ts'
import { type FileHitLink, openFileHit } from '../../../file-card/ported/open-file-hit.ts'
import { elementsLink } from '../../../lib/deep-link.ts'
import { boardPath } from '../../../lib/routing.ts'
import { type Atom, atom } from '../../../lib/signals.ts'
import { countUsage } from '../../../lib/usage.ts'
import { formatsEnabled } from '../../formats/flags.ts'
import { cut } from '../copy.ts'
import {
  askWorkspace,
  type WorkspaceAskResult,
  WorkspaceAskUnavailableError,
} from '../workspace-ask/client.ts'
import { askNotice, NOTICE_TITLES, offerUndoFor } from './actions.ts'
import { applyNotes } from './apply.ts'
import { aiAnswer, answerText, askBoard, showSources, WHOLE_BOARD } from './ask.ts'
import { aiStatus, openingPrivatePanel, perCanvas, registerPrivatePanel } from './runtime.ts'
import { NONE } from './target.ts'

export interface WorkspaceAnswerState {
  readonly question: string
  readonly status: 'asking' | 'done'
  readonly result: WorkspaceAskResult | null
}

/** The open answer across boards of each canvas (private: this tab only, never stored). */
export const aiWorkspaceAnswer = perCanvas<Atom<WorkspaceAnswerState | null>>(() =>
  atom<WorkspaceAnswerState | null>('lobby-ai-workspace-answer', null),
)

// one private panel at a time: a summary or a recap closes it, as they close this board's answer
registerPrivatePanel('answer', (canvas) => {
  aiAnswer(canvas).set(null)
  aiWorkspaceAnswer(canvas).set(null)
})

/** What the notice says before the first question of all boards (once per person per workspace, as for any AI). */
export const ALL_BOARDS_NOTICE = {
  verb: 'answer your question',
  what: 'your question and the text of the boards you can open',
  title: NOTICE_TITLES.boards,
} as const

/** The words after the asking falls back to this board (the api has no ask across boards here). */
export const ALL_BOARDS_FALLBACK = 'Asking all boards isn’t available here, so this board answered.'

/**
 * Asks `question` of all boards (see the header) and opens the answer. Resolves once it is in (or refused). Counted as
 * `ai.open:ask` and `ai.ask.scope:all` (the event names only).
 */
export async function askAllBoards(ctx: CanvasFeatureContext, question: string): Promise<void> {
  const { canvas } = ctx
  const q = question.replace(/\s+/g, ' ').trim()
  if (!q) return
  countUsage('ai.open:ask')
  countUsage('ai.ask.scope:all')
  let acknowledged = aiStatus(canvas).get()?.noticeAccepted === true
  if (!acknowledged) {
    if (!(await askNotice(canvas, 'ask', NONE, ALL_BOARDS_NOTICE))) return
    acknowledged = true
  }
  const mine: WorkspaceAnswerState = { question: q, status: 'asking', result: null }
  openingPrivatePanel(canvas, 'answer')
  aiAnswer(canvas).set(null)
  aiWorkspaceAnswer(canvas).set(mine)
  const ask = () => askWorkspace(q, { acknowledged })
  let result: WorkspaceAskResult
  try {
    try {
      result = await ask()
    } catch (e) {
      // the api wants the notice first after all (accepted elsewhere, then reset): once more, with it
      if (!(isApiError(e) && e.code === AI_ERROR_CODES.noticeRequired)) throw e
      if (!(await askNotice(canvas, 'ask', NONE, ALL_BOARDS_NOTICE))) {
        if (aiWorkspaceAnswer(canvas).get() === mine) aiWorkspaceAnswer(canvas).set(null)
        return
      }
      acknowledged = true
      result = await ask()
    }
  } catch (e) {
    if (aiWorkspaceAnswer(canvas).get() === mine) aiWorkspaceAnswer(canvas).set(null)
    if (e instanceof WorkspaceAskUnavailableError) {
      // the switch has gone (the client latched it off); this board answers instead
      ctx.notify({ key: 'dr-ai', text: ALL_BOARDS_FALLBACK, testId: 'ai-ask-fallback', timeoutMs: 6000 })
      // (already counted above as ai.open:ask: one ask is one count, whoever answers it)
      await askBoard(ctx, q, WHOLE_BOARD, { counted: true })
      return
    }
    ctx.notify({
      key: 'dr-ai',
      text: isApiError(e) ? e.message : 'The AI request failed. Try again.',
      tone: 'error',
      testId: 'ai-error',
      timeoutMs: 9000,
    })
    return
  }
  if (aiWorkspaceAnswer(canvas).get() !== mine) return // replaced or closed meanwhile
  const now = aiStatus(canvas).get()
  if (now && !now.noticeAccepted) aiStatus(canvas).set({ ...now, noticeAccepted: true })
  aiWorkspaceAnswer(canvas).set({ ...mine, status: 'done', result })
}

/**
 * The page inside a file a citation leads with (wave W, WS3: Ask across boards cites file text by the file hit's id
 * `file:<ver>.p<page>`), or null when its first id is a canvas element. Such an id is never an element of the board.
 * Null too while this page does not offer file search (`formatsEnabled('fileSearch')`): the chip then opens the board
 * at its canvas elements, as the `?file=` opener would do nothing.
 */
export function citedFilePage(
  c: { readonly elementIds: readonly string[] },
  fileSearchOn: boolean = formatsEnabled('fileSearch'),
): FileHitLink | null {
  const first = c.elementIds[0]
  return first === undefined || !fileSearchOn ? null : parseFileHitObjectId(first)
}

/** The canvas elements a citation names (its file page ids left out: they name no element). */
export const citedElementIds = (c: { readonly elementIds: readonly string[] }): string[] =>
  c.elementIds.filter((id) => parseFileHitObjectId(id) === null)

/**
 * A cited board's link: a citation that leads with a page inside a file opens that file at its page (the search's
 * `?file=<ver>&page=<n>`, file-card/ported/open-file-hit.ts); any other opens the board at its cited elements (`?el=`),
 * as the dashboard's search links them.
 */
export const citationHref = (c: {
  readonly boardId: string
  readonly elementIds: readonly string[]
}): string => {
  const file = citedFilePage(c)
  if (file) return fileHitHref(c.boardId, file.versionId, file.page)
  return elementsLink(boardPath(c.boardId), citedElementIds(c))
}

/**
 * A citation of the board open here: a page inside a file opens that file's viewer at the page (as its `?file=` link
 * would); otherwise, or when the board no longer shows that file, its canvas elements are selected and shown.
 */
export function showCitationHere(
  ctx: CanvasFeatureContext,
  c: { readonly elementIds: readonly string[] },
): boolean {
  const file = citedFilePage(c)
  if (file && openFileHit(ctx, file)) return true
  return showSources(ctx.canvas, citedElementIds(c))
}

/** Whether "Add answer to board" may run: an answer that says something, every cited board allowing it, an editor. */
export function canAddWorkspaceAnswer(canvas: LobbyCanvas, state: WorkspaceAnswerState | null): boolean {
  const r = state?.result
  return (
    !!r &&
    r.found !== 'no' &&
    r.exportAllowed &&
    !!answerText(r.answer) &&
    !canvas.readOnly() &&
    aiStatus(canvas).get()?.canInsert === true
  )
}

/** Why "Add answer to board" cannot run, when the answer itself is the reason (else null). */
export function addAnswerReason(state: WorkspaceAnswerState | null): string | null {
  const r = state?.result
  if (!r || r.found === 'no') return null
  return r.exportAllowed ? null : 'A board it cites doesn’t allow copying out of it.'
}

/** "Add answer to board": the answer's words as one note under a heading, in the view (one step, AI provenance). */
export function addWorkspaceAnswer(ctx: CanvasFeatureContext): string[] | null {
  const { canvas } = ctx
  const state = aiWorkspaceAnswer(canvas).get()
  if (!state?.result || !canAddWorkspaceAnswer(canvas, state)) return null
  const ids = applyNotes(
    canvas,
    NONE,
    {
      heading: `Answer: ${cut(state.question, 60)}`,
      texts: [answerText(state.result.answer)],
      color: 'light-blue',
      kind: 'answer',
    },
    ctx.me.user.id,
    null,
  )
  aiWorkspaceAnswer(canvas).set(null)
  offerUndoFor(canvas, 'Answer added to the board.', ids)
  return ids
}
