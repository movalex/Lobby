// Running an AI action (docs/WAVE4-CONTRACTS.md §4 ai-assist): the privacy notice first (once per person
// per workspace, enforced by the api), one request at a time, a cancellable busy state, then the plan
// applied as one undo step (apply.ts). Every decision is the api's: this only follows AiStatus and
// shows the api's own (user-safe) error messages.
// - A summary always opens in the private panel first; editors add it to the board from there (DANA-04).
// - The toast's "Undo" only ever undoes the AI result: the toast goes once anything else changes (DANA-09).
// - The board's AI switch and the workspace default (board menu: menus.tsx) go through the api.

import { AI_ERROR_CODES, AiResult, AiSettings, AiStatus } from '@draftroom/contracts'
import type { Editor } from 'tldraw'
import { isApiError } from '../../api/client.ts'
import { applyNotes, applySummary, applyThemes } from './apply.ts'
import { actionItemText, ideasHeading, plural, themesDone } from './copy.ts'
import { type AiMenuState, type AiRequest, aiJob, aiMenu, aiPanel, aiStatus, getAiCtx } from './runtime.ts'
import type { AiTarget } from './target.ts'

const enc = encodeURIComponent
const NOTICE_KEY = 'dr-ai'
let jobSeq = 0

/** The latest status question per editor: only its answer may set what the web shows. */
const statusAsks = new WeakMap<Editor, number>()

/**
 * Asks the api what this person may do with AI on this board (hidden until it answers yes). Answers
 * can arrive out of order (a menu open's re-read, then the `ai.settings` hint's): an older one that
 * arrives last is dropped, so an "on" asked before the owner switched AI off never brings it back.
 */
export async function refreshAiStatus(editor: Editor, signal?: AbortSignal): Promise<void> {
  const ctx = getAiCtx(editor)
  if (!ctx) return
  const ask = (statusAsks.get(editor) ?? 0) + 1
  statusAsks.set(editor, ask)
  const latest = () => statusAsks.get(editor) === ask
  try {
    const status = await ctx.api.request('GET', `/api/boards/${enc(ctx.board.id)}/ai`, {
      schema: AiStatus,
      signal,
    })
    if (latest()) aiStatus(editor).set(status)
  } catch {
    // No answer, no AI (an older api without the route answers 404).
    if (!signal?.aborted && latest()) aiStatus(editor).set(null)
  }
}

export function openAiMenu(
  editor: Editor,
  at: AiMenuState['at'],
  target: AiTarget,
  view: AiMenuState['view'] = 'menu',
) {
  aiMenu(editor).set({ at, target, view, pending: null })
  // The budget line and the notice state stay current without polling: re-read on every open.
  void refreshAiStatus(editor)
}

export function closeAiMenu(editor: Editor, refocus = false) {
  aiMenu(editor).set(null)
  if (refocus) editor.focus()
}

export function cancelAiJob(editor: Editor) {
  const job = aiJob(editor).get()
  if (!job) return
  job.abort.abort()
  aiJob(editor).set(null)
  getAiCtx(editor)?.notify({
    key: NOTICE_KEY,
    text: 'AI request cancelled.',
    timeoutMs: 3000,
    testId: 'ai-cancelled',
  })
}

/** Longest wait for this tab's last edits to reach the server before an AI request. */
const SAVE_WAIT_MS = 3000

/**
 * Resolves once the board's save indicator (sync-quality's SaveStatus, in the top bar) no longer says
 * "Saving…", or after SAVE_WAIT_MS: an edit made a moment ago (a note just typed) then reaches the
 * server, which is what the api reads. Offline or read-only boards do not wait.
 */
async function untilSaved(editor: Editor, signal: AbortSignal): Promise<void> {
  const doc = editor.getContainer().ownerDocument
  const busy = () => doc.querySelector('[data-testid="save-status"]')?.getAttribute('data-state') === 'saving'
  const until = Date.now() + SAVE_WAIT_MS
  // Two frames first, so a change from this very tick has been picked up by the indicator.
  await new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())))
  while (busy() && Date.now() < until && !signal.aborted) await new Promise((r) => setTimeout(r, 100))
}

/**
 * Runs `req` on `target`. Without the notice acknowledged (and without `acknowledged`), opens the
 * notice instead, at `at` (or where the menu was).
 */
export async function runAi(
  editor: Editor,
  req: AiRequest,
  target: AiTarget,
  opts: { acknowledged?: boolean; at?: AiMenuState['at'] } = {},
): Promise<void> {
  const ctx = getAiCtx(editor)
  const status = aiStatus(editor).get()
  if (!ctx || !status?.enabled) return
  if (aiJob(editor).get()) return
  if (!status.noticeAccepted && !opts.acknowledged) {
    const at = opts.at ?? aiMenu(editor).get()?.at
    if (at) aiMenu(editor).set({ at, target, view: 'notice', pending: req })
    return
  }
  // A summary always opens in the private panel first; an editor adds it to the board from there, so
  // nothing unreviewed appears on a board a client may be watching live (DANA-04).
  const mode = req.action === 'summarize' ? (req.mode ?? 'panel') : undefined
  const body = {
    action: req.action,
    shapeIds: target.ids,
    ...(mode ? { mode } : {}),
    ...(req.action === 'ideas' ? { prompt: req.prompt ?? '', count: req.count ?? 6 } : {}),
    ...(opts.acknowledged ? { acknowledged: true } : {}),
  }
  const job = { id: ++jobSeq, action: req.action, label: target.label, abort: new AbortController() }
  aiJob(editor).set(job)
  aiMenu(editor).set(null)
  // Back to the board, so Ctrl+Z, Delete and the arrows work on the result straight away.
  editor.focus()
  endUndoOffer(editor)
  ctx.dismiss(NOTICE_KEY)
  let result: AiResult
  try {
    // The api reads the board as the server has it: let a change made a moment ago arrive first.
    await untilSaved(editor, job.abort.signal)
    result = await ctx.api.request('POST', `/api/boards/${enc(ctx.board.id)}/ai/run`, {
      body,
      schema: AiResult,
      signal: job.abort.signal,
    })
  } catch (e) {
    if (aiJob(editor).get()?.id !== job.id) return // cancelled
    aiJob(editor).set(null)
    if (isApiError(e) && e.code === AI_ERROR_CODES.noticeRequired) {
      aiStatus(editor).set({ ...status, noticeAccepted: false })
      const at = opts.at
      if (at) aiMenu(editor).set({ at, target, view: 'notice', pending: req })
      return
    }
    if (
      isApiError(e) &&
      (e.code === AI_ERROR_CODES.turnedOff ||
        e.code === AI_ERROR_CODES.notConfigured ||
        e.code === AI_ERROR_CODES.boardOff)
    )
      void refreshAiStatus(editor)
    ctx.notify({
      key: NOTICE_KEY,
      text: isApiError(e) ? e.message : 'The AI request failed. Try again.',
      tone: 'error',
      testId: 'ai-error',
      timeoutMs: 9000,
    })
    return
  }
  if (aiJob(editor).get()?.id !== job.id) return // cancelled while the answer was on its way
  aiJob(editor).set(null)
  const now = aiStatus(editor).get() ?? status
  aiStatus(editor).set({ ...now, noticeAccepted: true, budget: result.budget ?? now.budget })
  applyResult(editor, result, target, req)
}

/** How long the "Undo" toast after an AI result stays up. */
export const UNDO_TOAST_MS = 7000
/** Ends the watch behind the current "Undo" toast (null when there is none). */
const undoWatches = new WeakMap<Editor, () => void>()

function endUndoOffer(editor: Editor) {
  undoWatches.get(editor)?.()
}

/**
 * The toast after an AI result, with an "Undo" that takes back exactly that result (DANA-09). The toast
 * goes as soon as anything else changes the board from this tab (Ctrl+Z of the result included), so its
 * button can never undo an unrelated edit. Collaborators' edits never enter this tab's undo stack, so
 * they leave it up. `store.listen` flushes pending history first: the result itself never counts.
 */
function offerUndo(editor: Editor, text: string) {
  const ctx = getAiCtx(editor)
  if (!ctx) return
  endUndoOffer(editor)
  let live = true
  const unlisten = editor.store.listen(
    () => {
      if (!live) return
      stop()
      ctx.dismiss(NOTICE_KEY)
    },
    { source: 'user', scope: 'document' },
  )
  const timer = setTimeout(() => stop(), UNDO_TOAST_MS + 1000)
  function stop() {
    if (!live) return
    live = false
    unlisten()
    clearTimeout(timer)
    if (undoWatches.get(editor) === stop) undoWatches.delete(editor)
  }
  undoWatches.set(editor, stop)
  ctx.notify({
    key: NOTICE_KEY,
    text,
    testId: 'ai-done',
    timeoutMs: UNDO_TOAST_MS,
    action: {
      label: 'Undo',
      testId: 'ai-undo',
      onClick: () => {
        // Nothing changed since the result (else the toast would be gone): undo is exactly that step.
        if (!live) return
        stop()
        editor.undo()
      },
    },
  })
}

/** "Add to board" in the summary panel (editors): the summary as a card in the frame it is about. */
export function addSummaryToBoard(editor: Editor) {
  const panel = aiPanel(editor).get()
  if (!panel || editor.getIsReadonly() || !aiStatus(editor).get()?.canInsert) return
  applySummary(editor, panel.target, panel.summary)
  // It is on the board now (and the toast can take it back): the private copy goes.
  aiPanel(editor).set(null)
  editor.focus()
  offerUndo(editor, 'Summary added to the board.')
}

/** The board's AI switch (board owners; the api decides). `enabled` null follows the workspace default. */
export async function setBoardAi(editor: Editor, enabled: boolean | null): Promise<void> {
  const ctx = getAiCtx(editor)
  if (!ctx) return
  try {
    await ctx.api.request('PUT', `/api/boards/${enc(ctx.board.id)}/ai/settings`, {
      body: { enabled },
      schema: AiSettings,
    })
    ctx.notify({
      key: NOTICE_KEY,
      text: enabled === false ? 'AI is off on this board.' : 'AI is on for this board.',
      testId: 'ai-settings-saved',
      timeoutMs: 4000,
    })
  } catch (e) {
    ctx.notify({
      key: NOTICE_KEY,
      text: isApiError(e) ? e.message : 'Lobby couldn’t change the AI setting. Try again.',
      tone: 'error',
      timeoutMs: 6000,
    })
  }
  await refreshAiStatus(editor)
}

/** The workspace default (workspace owners and admins; the api decides). */
export async function setWorkspaceAiDefault(editor: Editor, enabled: boolean): Promise<void> {
  const ctx = getAiCtx(editor)
  if (!ctx) return
  try {
    await ctx.api.request('PUT', `/api/workspaces/${enc(ctx.workspace.id)}/ai/settings`, {
      body: { enabled },
      schema: null,
    })
    ctx.notify({
      key: NOTICE_KEY,
      text: enabled
        ? `AI is on by default for boards in ${ctx.workspace.name}.`
        : `AI is off by default for boards in ${ctx.workspace.name}.`,
      testId: 'ai-settings-saved',
      timeoutMs: 5000,
    })
  } catch (e) {
    ctx.notify({
      key: NOTICE_KEY,
      text: isApiError(e) ? e.message : 'Lobby couldn’t change the AI setting. Try again.',
      tone: 'error',
      timeoutMs: 6000,
    })
  }
  await refreshAiStatus(editor)
}

function applyResult(editor: Editor, result: AiResult, target: AiTarget, req: AiRequest) {
  const ctx = getAiCtx(editor)
  if (!ctx) return
  const partly = result.truncated ? ' Only part of the selection fitted in one request.' : ''
  const done = (text: string) => offerUndo(editor, `${text}${partly}`)
  const canEdit = !editor.getIsReadonly() && (aiStatus(editor).get()?.canInsert ?? false)
  switch (result.action) {
    case 'summarize': {
      // Private first, for everyone: an editor puts it on the board with "Add to board".
      aiPanel(editor).set({
        summary: result.summary,
        about: target.label,
        truncated: result.truncated,
        target,
      })
      return
    }
    case 'themes': {
      if (!canEdit) return
      const out = applyThemes(editor, result.themes)
      if (!out) {
        ctx.notify({
          key: NOTICE_KEY,
          text: 'Those notes were moved away or locked meanwhile.',
          tone: 'error',
          timeoutMs: 6000,
        })
        return
      }
      done(themesDone({ ...out, prompts: target.prompts }))
      return
    }
    case 'actions': {
      if (!canEdit) return
      if (!result.items.length) {
        ctx.notify({
          key: NOTICE_KEY,
          text: 'No action items found in the selection.',
          timeoutMs: 6000,
          testId: 'ai-done',
        })
        return
      }
      applyNotes(editor, target, {
        heading: 'Action items',
        texts: result.items.map(actionItemText),
        color: 'light-green',
        kind: 'action-item',
      })
      done(`Added ${plural(result.items.length, 'action item')}.`)
      return
    }
    case 'ideas': {
      if (!canEdit) return
      applyNotes(editor, target, {
        heading: ideasHeading(req.prompt),
        texts: result.ideas,
        color: 'yellow',
        kind: 'idea',
      })
      done(`Added ${plural(result.ideas.length, 'idea')}.`)
      return
    }
  }
}
