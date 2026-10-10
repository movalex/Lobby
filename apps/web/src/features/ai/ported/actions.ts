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

import {
  AI_ERROR_CODES,
  type AiAction,
  AiClientResult,
  type AiRect,
  type AiResult,
  type AiRunInput,
  AiSettings,
  AiStatus,
} from '@draftroom/contracts'
import { isApiError } from '../../../api/client.ts'
import type { Bounds, CanvasFeatureContext, LobbyCanvas } from '../../../canvas/api/index.ts'
import { react } from '../../../lib/signals.ts'
import { mindmapOf } from '../../mindmap/ported/bridge.ts'
import { addChildTopics, mindmapFromIdeas } from '../../mindmap/ported/commands.ts'
import {
  actionItemText,
  EXPAND_EMPTY,
  EXPAND_GONE,
  expandDone,
  ideasHeading,
  MINDMAP_FAILED,
  mindmapDone,
  plural,
  themesDone,
  themesPreviewLine,
} from '../copy.ts'
import { applyNotes, applySummary, applyThemes, previewThemes } from './apply.ts'
import { EXPAND_COUNT, expandPlan } from './expand.ts'
import { canBuildWithAi } from './gate.ts'
import { deferUntilIdle, type IdleEnv } from './idle.ts'
import { landingFor } from './landing.ts'
import { showPreview } from './preview.tsx'
import {
  type AiJob,
  type AiMenuState,
  type AiRequest,
  aiFlash,
  aiJob,
  aiMenu,
  aiOpener,
  aiPanel,
  aiStatus,
  getAiCtx,
  noteOwnRun,
  openingPrivatePanel,
  setAiCtx,
} from './runtime.ts'
import { regionTile } from './shimmer.ts'
import { type AiTarget, boardTarget, isLive, NONE, refOf } from './target.ts'

const enc = encodeURIComponent
const NOTICE_KEY = 'dr-ai'
let jobSeq = 0

/** The latest status question per canvas: only its answer may set what the web shows. */
const statusAsks = new WeakMap<LobbyCanvas, number>()

/** Whether the status has been asked for on this canvas (the first read waits for an idle moment, K7-4). */
export const hasAskedAiStatus = (canvas: LobbyCanvas): boolean => statusAsks.has(canvas)

/**
 * The overlay's read of the status (K7-4). The first one is not part of the burst of a board opening: it waits
 * for an idle moment (the overlay only mounts once the board is live). Later ones (a change of role or board
 * status) go at once, as does every opening of the AI menu (openAiMenu). Returns a cancel.
 */
export function askAiStatus(canvas: LobbyCanvas, signal?: AbortSignal, env?: IdleEnv): () => void {
  const ask = () => void refreshAiStatus(canvas, signal)
  if (hasAskedAiStatus(canvas)) {
    ask()
    return () => undefined
  }
  return deferUntilIdle(ask, env)
}

/** Makes sure the status is known (an AI command run before the first read asked for it). */
export async function ensureAiStatus(canvas: LobbyCanvas): Promise<void> {
  if (aiStatus(canvas).get() === null) await refreshAiStatus(canvas)
}

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
  asked: AiTarget,
  opts: { acknowledged?: boolean; at?: AiMenuState['at'] } = {},
): Promise<void> {
  // M4-5: Summarize with nothing selected reads the whole board, as Ask does
  const target = req.action === 'summarize' && asked.kind === 'none' ? boardTarget(canvas) : asked
  const ctx = getAiCtx(canvas)
  const status = aiStatus(canvas).get()
  if (!ctx || !status?.enabled) return
  if (aiJob(canvas).get()) return
  // what builds onto the board is offered only to people who may (AI on, can add, budget left)
  if (req.into && !canBuildWithAi(status, canvas.readOnly())) return
  if (!status.noticeAccepted && !opts.acknowledged) {
    const at = opts.at ?? aiMenu(canvas).get()?.at
    if (at) aiMenu(canvas).set({ at, target, view: 'notice', pending: req })
    return
  }
  // A summary always opens in the private panel first (DANA-04).
  const mode = req.action === 'summarize' ? (req.mode ?? 'panel') : undefined
  // wave L: where it is (the live shimmer others see, L2-1e), and the vote the action items follow (L2-4)
  const at = atRect(target.bounds)
  const body = {
    action: req.action,
    shapeIds: target.ids.map(refOf),
    ...(mode ? { mode } : {}),
    ...(req.action === 'ideas' ? { prompt: req.prompt ?? '', count: req.count ?? 6 } : {}),
    ...(req.action === 'actions' && req.voteSessionId ? { voteSessionId: req.voteSessionId } : {}),
    ...(opts.acknowledged ? { acknowledged: true } : {}),
    ...(at ? { at } : {}),
  }
  // W5-47: asked from the popover, the keyboard goes back to what opened it (taken before the popover
  // closes, which forgets it); asked from a menu, to the board.
  const opener = aiMenu(canvas).get() ? aiOpener.get(canvas) : null
  const job = {
    id: ++jobSeq,
    action: req.action,
    ...(req.into ? { into: req.into } : {}),
    // K7-4: a placeholder where the result will land, for the wait (read-only, never written)
    landing: landingFor(canvas, req, target),
    label: target.label,
    abort: new AbortController(),
    opener,
  }
  const out = await sendRun(canvas, body, job)
  if (out === 'notice') {
    const where = opts.at
    if (where) aiMenu(canvas).set({ at: where, target, view: 'notice', pending: req })
    return
  }
  if (out) applyResult(canvas, out, target, req, job.opener)
}

/** The rect a run is about, as the api takes it (`at`: the live shimmer's place), or null. */
export function atRect(b: Bounds | null | undefined): AiRect | null {
  if (!b || ![b.x, b.y, b.width, b.height].every(Number.isFinite)) return null
  return {
    x: Math.round(b.x),
    y: Math.round(b.y),
    w: Math.max(0, Math.round(b.width)),
    h: Math.max(0, Math.round(b.height)),
  }
}

/**
 * Sends one run as `job` (the busy pill, its Cancel and the placeholder): this tab's last edits reach the
 * server first, then POST /ai/run. Resolves the answer; 'notice' when the api wants the privacy notice first
 * (the status says so now); null when it was cancelled or refused (the person was told why, in the AI
 * feature's notice). Every caller (the menus, public.ts `runAi`) goes through here.
 */
async function sendRun(
  canvas: LobbyCanvas,
  body: Record<string, unknown>,
  job: AiJob,
): Promise<AiClientResult | 'notice' | null> {
  const ctx = getAiCtx(canvas)
  const status = aiStatus(canvas).get()
  if (!ctx || !status) return null
  aiJob(canvas).set(job)
  aiMenu(canvas).set(null)
  // Back to the board, so Ctrl+Z, Delete and the arrows work on the result straight away.
  canvas.focus({ preventScroll: true })
  // A run that only answers (Ask, a recap or summary panel) adds no step: the last result's one-click Undo stays.
  if (writesBoard(body as unknown as AiRunInput) || !undoWatches.has(canvas)) {
    endUndoOffer(canvas)
    ctx.dismiss(NOTICE_KEY)
  }
  let result: AiClientResult
  try {
    // The api reads the board as the server has it: let a change made a moment ago arrive first.
    await untilSaved(canvas, job.abort.signal)
    result = await ctx.api.request('POST', `/api/boards/${enc(ctx.board.id)}/ai/run`, {
      body,
      // runId optional: a wave K api (a rollback, or the web deployed first) sends none (foundation review)
      schema: AiClientResult,
      signal: job.abort.signal,
    })
  } catch (e) {
    if (aiJob(canvas).get()?.id !== job.id) return null // cancelled
    aiJob(canvas).set(null)
    if (isApiError(e) && e.code === AI_ERROR_CODES.noticeRequired) {
      aiStatus(canvas).set({ ...status, noticeAccepted: false })
      return 'notice'
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
    return null
  }
  if (aiJob(canvas).get()?.id !== job.id) return null // cancelled while the answer was on its way
  aiJob(canvas).set(null)
  // an `ai.working` of this run that arrives late shows no shimmer here (./working.tsx isOwnRun)
  noteOwnRun(canvas, result.runId)
  const now = aiStatus(canvas).get() ?? status
  aiStatus(canvas).set({ ...now, noticeAccepted: true, budget: result.budget ?? now.budget })
  return result
}

// ---- runs for every workstream (public.ts `runAi`, wave L) ---------------------------------------------

/** Whether a run adds to the board (edit on an active board); the rest only answer (view). */
export function writesBoard(input: AiRunInput): boolean {
  switch (input.action) {
    case 'summarize':
    case 'recap':
      return input.mode === 'insert'
    case 'command':
      return input.mode === 'do'
    case 'ask':
      return false
    default:
      return true
  }
}

/** The notice's words: what it does, what it sends, and its title (what kind of text leaves the board). */
export interface NoticeWords {
  readonly verb: string
  readonly what: string
  readonly title: string
}

export const NOTICE_TITLES = {
  selected: 'Sends the selected text to OpenAI',
  board: 'Sends the board’s text to OpenAI',
  words: 'Sends your words to OpenAI',
} as const

const NOTICE_WORDS: Record<AiAction, Omit<NoticeWords, 'title'>> = {
  summarize: { verb: 'summarize it', what: 'the text you selected' },
  themes: { verb: 'group the notes into themes', what: 'the text of the notes' },
  actions: { verb: 'find action items', what: 'the text you selected' },
  ideas: { verb: 'generate ideas', what: 'your prompt and the text you selected' },
  recap: { verb: 'write the recap', what: 'the text of what changed on the board in that time' },
  ask: { verb: 'answer your question', what: 'your question and the text on the board' },
  command: { verb: 'work out the command', what: 'your words and the text on the board' },
  diagram: { verb: 'draw the diagram', what: 'your description and the text you selected' },
  sort: { verb: 'sort the notes', what: 'the text of the notes and your lens' },
  score: { verb: 'place the notes on the 2x2', what: 'the text of the notes and the two axes' },
}

/**
 * Wave M (M4-5, FTU-11): the notice's words for a run of public.ts `runAi`, as the run is: "the selected text" only when
 * something selected is sent (a diagram or ideas from words alone send only them; Summarize with nothing selected
 * sends the board's text).
 */
export function noticeWords(
  input: Pick<AiRunInput, 'action'> & { shapeIds?: readonly string[] },
): NoticeWords {
  const base = NOTICE_WORDS[input.action]
  const sent = (input.shapeIds?.length ?? 0) > 0
  switch (input.action) {
    case 'diagram':
      return sent
        ? { ...base, title: NOTICE_TITLES.selected }
        : { ...base, what: 'your description', title: NOTICE_TITLES.words }
    case 'ideas':
      return sent
        ? { ...base, title: NOTICE_TITLES.selected }
        : { ...base, what: 'your prompt', title: NOTICE_TITLES.words }
    case 'recap':
    case 'command':
      return { ...base, title: NOTICE_TITLES.board }
    case 'ask':
      return sent
        ? { ...base, what: 'your question and the text you selected', title: NOTICE_TITLES.selected }
        : { ...base, title: NOTICE_TITLES.board }
    default:
      return { ...base, title: NOTICE_TITLES.selected }
  }
}

/**
 * The privacy notice for a run of public.ts `runAi` (the AI popover's notice view, in the middle of the view):
 * resolves true on Continue, false on Cancel, Escape or the popover closing any other way. `words`: what it says
 * (default: the action's, as if the selection were sent).
 */
export function askNotice(
  canvas: LobbyCanvas,
  action: AiAction,
  target: AiTarget = NONE,
  words: NoticeWords = noticeWords({ action, shapeIds: ['x'] }),
): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    let done = false
    let stop: (() => void) | null = null
    const finish = (ok: boolean) => {
      if (done) return
      done = true
      stop?.()
      resolve(ok)
    }
    const v = canvas.viewport.get()
    const state: AiMenuState = {
      at: anchorAtScene(canvas, { x: v.x + v.width / 2, y: v.y + v.height / 3 }),
      target,
      view: 'notice',
      pending: null,
      notice: { ...words, confirm: finish },
    }
    aiMenu(canvas).set(state)
    stop = react('lobby-ai-notice-watch', () => {
      if (aiMenu(canvas).get() !== state) finish(false)
    })
    if (done) stop()
  })
}

/** What the busy pill says a run of public.ts `runAi` is about. */
const ACTION_WORDS: Record<AiAction, string> = {
  summarize: 'the selection',
  themes: 'the notes',
  actions: 'the selection',
  ideas: 'your prompt',
  recap: 'the session',
  ask: 'the board',
  command: 'the board',
  diagram: 'the diagram',
  sort: 'the notes',
  score: 'the notes',
}

/**
 * public.ts `runAi` (frozen there): one run of any action for any workstream, through the same gate, notice,
 * busy pill, Cancel and error notices as the AI menus. Resolves the result, or null when there is nothing to
 * apply (the person has been told why). It applies nothing. `at` (the live shimmer's place) is the caller's,
 * else the selection's bounds. An answer without a run id cannot be a wave L api's (a wave K api refuses the
 * wave L actions with 400): it counts as an answer that could not be used.
 */
export async function runPublic(ctx: CanvasFeatureContext, input: AiRunInput): Promise<AiResult | null> {
  setAiCtx(ctx)
  const { canvas } = ctx
  await ensureAiStatus(canvas)
  const status = aiStatus(canvas).get()
  const refuse = (text: string) => {
    noticeOf(canvas, text, 'error')
    return null
  }
  if (!status?.enabled) return refuse('AI isn’t available on this board.')
  if (writesBoard(input) && !canBuildWithAi(status, canvas.readOnly()))
    return refuse('Only editors can add AI results to this board.')
  if (aiJob(canvas).get())
    return refuse('Lobby is still working on another AI request. Wait for it to finish.')
  let acknowledged = input.acknowledged === true
  const words = noticeWords(input as Pick<AiRunInput, 'action'> & { shapeIds?: readonly string[] })
  if (!status.noticeAccepted && !acknowledged) {
    if (!(await askNotice(canvas, input.action, NONE, words))) return null
    acknowledged = true
  }
  const sel = canvas.selection
  const at = input.at ?? atRect(sel.length ? canvas.boundsOf(sel) : null)
  const job = (): AiJob => ({
    id: ++jobSeq,
    action: input.action,
    landing: at && writesBoard(input) ? regionTile(at) : null,
    label: ACTION_WORDS[input.action],
    abort: new AbortController(),
    opener: null,
  })
  const body = (ack: boolean): Record<string, unknown> => ({
    ...input,
    ...(at ? { at } : {}),
    ...(ack ? { acknowledged: true } : {}),
  })
  let out = await sendRun(canvas, body(acknowledged), job())
  if (out === 'notice') {
    if (!(await askNotice(canvas, input.action, NONE, words))) return null
    out = await sendRun(canvas, body(true), job())
  }
  if (!out || out === 'notice') return null
  if (!out.runId) return refuse('The AI’s answer couldn’t be used. Try again.')
  return out as AiResult
}

// ---- the brief highlight of a result (K7-4) ---------------------------------------------------------

/** How long the new elements are highlighted. */
export const FLASH_MS = 1600
let flashSeq = 0

/**
 * Highlights what a result just wrote for a moment. Overlay only: the ids go to a signal the overlay draws
 * boxes from, nothing is written to the board, and the overlay draws nothing under reduced motion.
 */
export function flash(canvas: LobbyCanvas, ids: readonly string[]) {
  const mine = ++flashSeq
  aiFlash(canvas).set(ids.length ? { n: mine, ids: [...ids] } : null)
  if (!ids.length) return
  setTimeout(() => {
    if (aiFlash(canvas).get()?.n === mine) aiFlash(canvas).set(null)
  }, FLASH_MS)
}

// ---- mind maps (K7) ----------------------------------------------------------------------------------

/** A scene point as the popover's anchor (px from the canvas container's top-left). */
export function anchorAtScene(canvas: LobbyCanvas, scene: { x: number; y: number }): AiMenuState['at'] {
  const v = canvas.sceneToOverlay(scene)
  return { x: v.x, top: v.y, bottom: v.y }
}

const noticeOf = (canvas: LobbyCanvas, text: string, tone?: 'error') =>
  getAiCtx(canvas)?.notify({
    key: NOTICE_KEY,
    text,
    ...(tone ? { tone } : {}),
    testId: tone ? 'ai-error' : 'ai-done',
    timeoutMs: 6000,
  })

/**
 * "Expand with AI": asks the existing 'ideas' action for sub-topics of mind-map topic `topicId` (its words as
 * the prompt, its path and children as the context) and adds them under it in one undo step. The notice
 * comes first, once per workspace, as for every AI action.
 */
export function expandTopic(canvas: LobbyCanvas, topicId: string, at?: AiMenuState['at']): void {
  const m = mindmapOf(canvas)
  if (!getAiCtx(canvas) || !m) return
  if (!canBuildWithAi(aiStatus(canvas).get(), canvas.readOnly())) return
  const plan = expandPlan(m.rt, topicId)
  if ('problem' in plan) {
    noticeOf(canvas, plan.problem === 'empty' ? EXPAND_EMPTY : EXPAND_GONE, 'error')
    return
  }
  const b = canvas.bounds(topicId)
  const target: AiTarget = {
    kind: 'selection',
    ids: plan.context,
    label: plan.label,
    notes: 0,
    prompts: 0,
    groups: [],
    texts: plan.context.length,
    bounds: b,
    topicId,
  }
  const where = at ?? (b ? anchorAtScene(canvas, { x: b.x + b.width / 2, y: b.y + b.height }) : undefined)
  void runAi(
    canvas,
    { action: 'ideas', prompt: plan.prompt, count: EXPAND_COUNT, into: { kind: 'expand', topicId } },
    target,
    where ? { at: where } : {},
  )
}

/**
 * "Mind map from a prompt": the prompt is sent to the existing 'ideas' action (nothing else from the board)
 * and comes back as a new mind map: the prompt as the central topic, the ideas as the first ring.
 */
export function mindmapFromPrompt(
  canvas: LobbyCanvas,
  prompt: string,
  count: number,
  at?: AiMenuState['at'],
): Promise<void> {
  const target: AiTarget = { ...NONE, kind: 'none', label: 'nothing selected', bounds: null }
  return runAi(
    canvas,
    { action: 'ideas', prompt, count, into: { kind: 'mindmap' } },
    target,
    at ? { at } : {},
  )
}

/** The answer of an 'ideas' request that goes into a mind map: one write, one undo step, or nothing at all. */
function applyIdeasIntoMap(
  canvas: LobbyCanvas,
  ideas: readonly string[],
  into: NonNullable<AiRequest['into']>,
  prompt: string,
  done: (text: string, ids: readonly string[], shown?: readonly string[]) => void,
) {
  const ctx = getAiCtx(canvas)
  const m = mindmapOf(canvas)
  if (!ctx || !m) return
  const stamp = { by: ctx.me.user.id, kind: 'ai-topic' }
  if (into.kind === 'expand') {
    if (!isLive(canvas.get(into.topicId))) {
      noticeOf(canvas, EXPAND_GONE, 'error')
      return
    }
    const made = addChildTopics(m, into.topicId, ideas, { stamp })
    if (!made) {
      noticeOf(canvas, 'AI had nothing new to add under that topic.')
      return
    }
    done(expandDone(made.children.length), made.touched, made.ids)
    return
  }
  const made = mindmapFromIdeas(m, prompt, ideas, { stamp })
  if (!made) {
    noticeOf(canvas, MINDMAP_FAILED, 'error')
    return
  }
  done(mindmapDone(made.children.length), made.touched, made.ids)
}

/** How long the "Undo" toast after an AI result stays up. */
export const UNDO_TOAST_MS = 7000
/** Ends the watch behind the current "Undo" toast (null when there is none). */
const undoWatches = new WeakMap<LobbyCanvas, () => void>()

/** Ends the watch behind the current "Undo" toast (another AI step is about to change the board). */
export function endUndoOffer(canvas: LobbyCanvas) {
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

/**
 * Wave L: the "Undo" toast and the brief highlight for what an AI step of this feature just wrote (`ids`; their
 * labels and frames count too): Ask's answer note, the recap frame.
 */
export function offerUndoFor(canvas: LobbyCanvas, text: string, ids: readonly string[]) {
  offerUndo(canvas, text, versionsOf(canvas, touched(canvas, ids)))
  flash(canvas, ids)
}

/** "Add to board" in the summary panel (editors): the summary as a card in the frame it is about. */
export function addSummaryToBoard(canvas: LobbyCanvas) {
  const ctx = getAiCtx(canvas)
  const panel = aiPanel(canvas).get()
  if (!ctx || !panel || canvas.readOnly() || !aiStatus(canvas).get()?.canInsert) return
  const ids = applySummary(canvas, panel.target, panel.summary, ctx.me.user.id, panel.runId)
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
  result: AiClientResult,
  target: AiTarget,
  req: AiRequest,
  opener: HTMLElement | null,
) {
  const ctx = getAiCtx(canvas)
  if (!ctx) return
  const by = ctx.me.user.id
  /** wave L provenance: the run id (none from a wave K api: `lobby.ai` without `run`, as before) */
  const run = result.runId ?? null
  const partly = result.truncated ? ' Only part of the selection fitted in one request.' : ''
  const done = (text: string, ids: readonly string[], shown: readonly string[] = ids) => {
    offerUndo(canvas, `${text}${partly}`, versionsOf(canvas, touched(canvas, ids)))
    flash(canvas, shown)
  }
  const canEdit = !canvas.readOnly() && (aiStatus(canvas).get()?.canInsert ?? false)
  switch (result.action) {
    case 'summarize': {
      // Private first, for everyone: an editor puts it on the board with "Add to board". One private panel at a time.
      openingPrivatePanel(canvas, 'summary')
      aiPanel(canvas).set({
        summary: result.summary,
        about: target.label,
        truncated: result.truncated,
        runId: run,
        // a summary of the whole board is added in the view, not beside everything on it (M4-5)
        target: target.kind === 'none' ? { ...target, ids: [] } : target,
        opener,
      })
      return
    }
    case 'themes': {
      if (!canEdit) return
      // L2-1b: the notes move only once the person has seen where (the preview) and chose Apply.
      const gone = () =>
        ctx.notify({
          key: NOTICE_KEY,
          text: 'Those notes were moved away or locked meanwhile.',
          tone: 'error',
          timeoutMs: 6000,
        })
      const pv = previewThemes(canvas, result.themes)
      if (!pv) {
        gone()
        return
      }
      void showPreview(ctx, {
        runId: run ?? `themes-${++jobSeq}`,
        title: 'Group into themes',
        summary: themesPreviewLine(pv),
        moves: pv.moves,
        recolors: [],
        // M4-1: each label's outline says the theme's name, and the panel lists the themes with their notes
        creates: pv.labels.map((l) => ({ x: l.x, y: l.y, w: l.w, h: l.h, kind: 'text', label: l.name })),
        groups: pv.groups,
      }).then((choice) => {
        if (choice === 'retry') {
          // a new, budgeted call (a new run id)
          void runAi(canvas, { action: 'themes' }, target)
          return
        }
        if (choice !== 'apply') return
        const out = applyThemes(canvas, result.themes, by, run)
        if (!out) {
          gone()
          return
        }
        done(themesDone({ ...out, prompts: target.prompts }), out.written)
      })
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
        run,
      )
      done(`Added ${plural(result.items.length, 'action item')}.`, ids)
      return
    }
    case 'ideas': {
      if (!canEdit) return
      if (req.into) {
        applyIdeasIntoMap(canvas, result.ideas, req.into, req.prompt ?? '', done)
        return
      }
      const ids = applyNotes(
        canvas,
        target,
        { heading: ideasHeading(req.prompt), texts: result.ideas, color: 'yellow', kind: 'idea' },
        by,
        run,
      )
      done(`Added ${plural(result.ideas.length, 'idea')}.`, ids)
      return
    }
  }
}
