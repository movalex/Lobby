// OWNER: 3h. Running an AI action on the Excalidraw board page (the tldraw twin is ../actions.ts), with
// the same rules and copy: the privacy notice first (once per person per workspace, enforced by the
// api), one request at a time, a cancellable busy state, then the plan applied as one undo step
// (./apply.ts). Every decision is the api's: this only follows AiStatus and shows the api's own
// (user-safe) error messages.
// - A summary always opens in the private panel first; editors add it to the board from there (DANA-04).
// - The toast's "Undo" only ever undoes the AI result: the toast goes once anything else changes the
//   board from this tab (a local edit, or an undo/redo), so its button can never undo an unrelated edit
//   (DANA-09). Collaborators' edits never enter this tab's undo stack, so they leave it up.
// - The board's AI switch and the workspace default (board menu: ./menus.tsx) go through the api.

import { AI_ERROR_CODES, AiResult, AiSettings, AiStatus } from '@draftroom/contracts'
import { isApiError } from '../../../api/client.ts'
import type { LobbyCanvas } from '../../../canvas/api/index.ts'
import { actionItemText, ideasHeading, plural, themesDone } from '../copy.ts'
import { applyNotes, applySummary, applyThemes } from './apply.ts'
import {
  type AiMenuState,
  type AiRequest,
  aiJob,
  aiMenu,
  aiOpener,
  aiPanel,
  aiStatus,
  getAiCtx,
} from './runtime.ts'
import { type AiTarget, refOf } from './target.ts'

const enc = encodeURIComponent
const NOTICE_KEY = 'dr-ai'
let jobSeq = 0

/** The latest status question per canvas: only its answer may set what the web shows. */
const statusAsks = new WeakMap<LobbyCanvas, number>()

/**
 * Asks the api what this person may do with AI on this board (hidden until it answers yes). Answers
 * can arrive out of order: an older one that arrives last is dropped, so an "on" asked before the owner
 * switched AI off never brings it back.
 */
export async function refreshAiStatus(canvas: LobbyCanvas, signal?: AbortSignal): Promise<void> {
  const ctx = getAiCtx(canvas)
  if (!ctx) return
  const ask = (statusAsks.get(canvas) ?? 0) + 1
  statusAsks.set(canvas, ask)
  const latest = () => statusAsks.get(canvas) === ask
  try {
    const status = await ctx.api.request('GET', `/api/boards/${enc(ctx.board.id)}/ai`, {
      schema: AiStatus,
      signal,
    })
    if (latest()) aiStatus(canvas).set(status)
  } catch {
    // No answer, no AI (an older api without the route answers 404).
    if (!signal?.aborted && latest()) aiStatus(canvas).set(null)
  }
}

export function openAiMenu(
  canvas: LobbyCanvas,
  at: AiMenuState['at'],
  target: AiTarget,
  view: AiMenuState['view'] = 'menu',
) {
  aiMenu(canvas).set({ at, target, view, pending: null })
  // The budget line and the notice state stay current without polling: re-read on every open.
  void refreshAiStatus(canvas)
}

export function closeAiMenu(canvas: LobbyCanvas, refocus = false) {
  aiMenu(canvas).set(null)
  if (refocus) canvas.focus({ preventScroll: true })
}

export function cancelAiJob(canvas: LobbyCanvas) {
  const job = aiJob(canvas).get()
  if (!job) return
  job.abort.abort()
  aiJob(canvas).set(null)
  getAiCtx(canvas)?.notify({
    key: NOTICE_KEY,
    text: 'AI request cancelled.',
    timeoutMs: 3000,
    testId: 'ai-cancelled',
  })
}

/** Longest wait for this tab's last edits to reach the server before an AI request. */
const SAVE_WAIT_MS = 3000

/**
 * Resolves once this tab's edits have reached the server (the engine's save status), or after
 * SAVE_WAIT_MS: an edit made a moment ago (a note just typed) then reaches the server, which is what the
 * api reads. Offline boards do not wait.
 */
async function untilSaved(canvas: LobbyCanvas, signal: AbortSignal): Promise<void> {
  const busy = () => {
    const s = canvas.saveStatus()
    return s.state !== 'saved' && s.state !== 'offline' && s.pending > 0
  }
  const until = Date.now() + SAVE_WAIT_MS
  // Two frames first, so a change from this very tick has been picked up by the engine.
  await new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())))
  while (busy() && Date.now() < until && !signal.aborted) await new Promise((r) => setTimeout(r, 100))
}

/**
 * Runs `req` on `target`. Without the notice acknowledged (and without `acknowledged`), opens the
 * notice instead, at `at` (or where the menu was).
 */
export async function runAi(
  canvas: LobbyCanvas,
  req: AiRequest,
  target: AiTarget,
  opts: { acknowledged?: boolean; at?: AiMenuState['at'] } = {},
): Promise<void> {
  const ctx = getAiCtx(canvas)
  const status = aiStatus(canvas).get()
  if (!ctx || !status?.enabled) return
  if (aiJob(canvas).get()) return
  if (!status.noticeAccepted && !opts.acknowledged) {
    const at = opts.at ?? aiMenu(canvas).get()?.at
    if (at) aiMenu(canvas).set({ at, target, view: 'notice', pending: req })
    return
  }
  // A summary always opens in the private panel first (DANA-04).
  const mode = req.action === 'summarize' ? (req.mode ?? 'panel') : undefined
  const body = {
    action: req.action,
    shapeIds: target.ids.map(refOf),
    ...(mode ? { mode } : {}),
    ...(req.action === 'ideas' ? { prompt: req.prompt ?? '', count: req.count ?? 6 } : {}),
    ...(opts.acknowledged ? { acknowledged: true } : {}),
  }
  // W5-47: asked from the popover, the keyboard goes back to what opened it (taken before the popover
  // closes, which forgets it); asked from a menu, to the board.
  const opener = aiMenu(canvas).get() ? aiOpener.get(canvas) : null
  const job = { id: ++jobSeq, action: req.action, label: target.label, abort: new AbortController(), opener }
  aiJob(canvas).set(job)
  aiMenu(canvas).set(null)
  // Back to the board, so Ctrl+Z, Delete and the arrows work on the result straight away.
  canvas.focus({ preventScroll: true })
  endUndoOffer(canvas)
  ctx.dismiss(NOTICE_KEY)
  let result: AiResult
  try {
    // The api reads the board as the server has it: let a change made a moment ago arrive first.
    await untilSaved(canvas, job.abort.signal)
    result = await ctx.api.request('POST', `/api/boards/${enc(ctx.board.id)}/ai/run`, {
      body,
      schema: AiResult,
      signal: job.abort.signal,
    })
  } catch (e) {
    if (aiJob(canvas).get()?.id !== job.id) return // cancelled
    aiJob(canvas).set(null)
    if (isApiError(e) && e.code === AI_ERROR_CODES.noticeRequired) {
      aiStatus(canvas).set({ ...status, noticeAccepted: false })
      const at = opts.at
      if (at) aiMenu(canvas).set({ at, target, view: 'notice', pending: req })
      return
    }
    if (
      isApiError(e) &&
      (e.code === AI_ERROR_CODES.turnedOff ||
        e.code === AI_ERROR_CODES.notConfigured ||
        e.code === AI_ERROR_CODES.boardOff)
    )
      void refreshAiStatus(canvas)
    ctx.notify({
      key: NOTICE_KEY,
      text: isApiError(e) ? e.message : 'The AI request failed. Try again.',
      tone: 'error',
      testId: 'ai-error',
      timeoutMs: 9000,
    })
    return
  }
  if (aiJob(canvas).get()?.id !== job.id) return // cancelled while the answer was on its way
  aiJob(canvas).set(null)
  const now = aiStatus(canvas).get() ?? status
  aiStatus(canvas).set({ ...now, noticeAccepted: true, budget: result.budget ?? now.budget })
  applyResult(canvas, result, target, req, job.opener)
}

/** How long the "Undo" toast after an AI result stays up. */
export const UNDO_TOAST_MS = 7000
/** Ends the watch behind the current "Undo" toast (null when there is none). */
const undoWatches = new WeakMap<LobbyCanvas, () => void>()

function endUndoOffer(canvas: LobbyCanvas) {
  undoWatches.get(canvas)?.()
}

/** Each element's version right after the result was written (the result's own change batch). */
function versionsOf(canvas: LobbyCanvas, ids: readonly string[]): Map<string, number> {
  return new Map(ids.map((id) => [id, (canvas.get(id) as { version?: number } | undefined)?.version ?? -1]))
}

/**
 * The toast after an AI result, with an "Undo" that takes back exactly that result (DANA-09). The toast
 * goes as soon as anything else changes the board from this tab (Ctrl+Z of the result included), so its
 * button can never undo an unrelated edit. The result's own change batch (reported a moment after its
 * `transact`, with exactly the versions it wrote) never counts; remote edits never do either.
 */
export function offerUndo(canvas: LobbyCanvas, text: string, written: ReadonlyMap<string, number>) {
  const ctx = getAiCtx(canvas)
  if (!ctx) return
  endUndoOffer(canvas)
  let live = true
  const isEcho = (ids: readonly string[]) =>
    ids.length > 0 &&
    ids.every((id) => {
      const v = written.get(id)
      return v !== undefined && ((canvas.get(id) as { version?: number } | undefined)?.version ?? -1) === v
    })
  const off = canvas.on('change', (change) => {
    if (!live || change.source === 'remote') return
    // the result's own batch (reported as local, or as history when an earlier undo or redo marked the same
    // ids): exactly the versions it wrote. An undo of it, or any other edit, writes new ones.
    if (isEcho([...change.created, ...change.updated, ...change.deleted])) return
    stop()
    ctx.dismiss(NOTICE_KEY)
  })
  const timer = setTimeout(() => stop(), UNDO_TOAST_MS + 1000)
  function stop() {
    if (!live) return
    live = false
    off()
    clearTimeout(timer)
    if (undoWatches.get(canvas) === stop) undoWatches.delete(canvas)
  }
  undoWatches.set(canvas, stop)
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
        canvas.history.undo()
      },
    },
  })
}

/** Every element a result wrote (created and moved ones, with their labels), and the frame it grew. */
function touched(canvas: LobbyCanvas, ids: readonly string[]): string[] {
  const out = new Set<string>()
  for (const id of ids) {
    out.add(id)
    const el = canvas.get(id) as
      | { boundElements?: { id: string; type: string }[] | null; frameId?: string | null }
      | undefined
    for (const b of el?.boundElements ?? []) if (b.type === 'text') out.add(b.id)
    if (el?.frameId) out.add(el.frameId)
  }
  return [...out]
}

/** "Add to board" in the summary panel (editors): the summary as a card in the frame it is about. */
export function addSummaryToBoard(canvas: LobbyCanvas) {
  const ctx = getAiCtx(canvas)
  const panel = aiPanel(canvas).get()
  if (!ctx || !panel || canvas.readOnly() || !aiStatus(canvas).get()?.canInsert) return
  const ids = applySummary(canvas, panel.target, panel.summary, ctx.me.user.id)
  // It is on the board now (and the toast can take it back): the private copy goes.
  aiPanel(canvas).set(null)
  canvas.focus({ preventScroll: true })
  offerUndo(canvas, 'Summary added to the board.', versionsOf(canvas, touched(canvas, ids)))
}

/** The board's AI switch (board owners; the api decides). `enabled` null follows the workspace default. */
export async function setBoardAi(canvas: LobbyCanvas, enabled: boolean | null): Promise<void> {
  const ctx = getAiCtx(canvas)
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
  await refreshAiStatus(canvas)
}

/** The workspace default (workspace owners and admins; the api decides). */
export async function setWorkspaceAiDefault(canvas: LobbyCanvas, enabled: boolean): Promise<void> {
  const ctx = getAiCtx(canvas)
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
  await refreshAiStatus(canvas)
}

function applyResult(
  canvas: LobbyCanvas,
  result: AiResult,
  target: AiTarget,
  req: AiRequest,
  opener: HTMLElement | null,
) {
  const ctx = getAiCtx(canvas)
  if (!ctx) return
  const by = ctx.me.user.id
  const partly = result.truncated ? ' Only part of the selection fitted in one request.' : ''
  const done = (text: string, ids: readonly string[]) =>
    offerUndo(canvas, `${text}${partly}`, versionsOf(canvas, touched(canvas, ids)))
  const canEdit = !canvas.readOnly() && (aiStatus(canvas).get()?.canInsert ?? false)
  switch (result.action) {
    case 'summarize': {
      // Private first, for everyone: an editor puts it on the board with "Add to board".
      aiPanel(canvas).set({
        summary: result.summary,
        about: target.label,
        truncated: result.truncated,
        target,
        opener,
      })
      return
    }
    case 'themes': {
      if (!canEdit) return
      const out = applyThemes(canvas, result.themes, by)
      if (!out) {
        ctx.notify({
          key: NOTICE_KEY,
          text: 'Those notes were moved away or locked meanwhile.',
          tone: 'error',
          timeoutMs: 6000,
        })
        return
      }
      done(themesDone({ ...out, prompts: target.prompts }), out.written)
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
      const ids = applyNotes(
        canvas,
        target,
        {
          heading: 'Action items',
          texts: result.items.map(actionItemText),
          color: 'light-green',
          kind: 'action-item',
        },
        by,
      )
      done(`Added ${plural(result.items.length, 'action item')}.`, ids)
      return
    }
    case 'ideas': {
      if (!canEdit) return
      const ids = applyNotes(
        canvas,
        target,
        { heading: ideasHeading(req.prompt), texts: result.ideas, color: 'yellow', kind: 'idea' },
        by,
      )
      done(`Added ${plural(result.ideas.length, 'idea')}.`, ids)
      return
    }
  }
}
