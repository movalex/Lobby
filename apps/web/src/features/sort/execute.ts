// L8-1 and L8-2: the one path every sort and every 2x2 placement takes from "a plan can be made" to "it is on
// the board": build the plan from the board as it is now, show the preview when it moves more than a few notes,
// then build it AGAIN from the board as it is at the moment of writing (someone may have started typing in a
// note, locked it or dragged it while the preview was open or the AI answered) and write that, in one step.
// Building twice from the same board gives the same plan, so a board nobody touched gets exactly what the
// preview showed; a board somebody did touch gets a plan that leaves their note alone.
import type { CanvasFeatureContext } from '../../canvas/api/index.ts'
import type { AiPreviewPlan } from '../ai/ported/public.ts'
import { sortDeps } from './deps.ts'
import { type Skipped, skippedText } from './model.ts'

/** Moving more notes than this asks first (showAiPreview). */
export const PREVIEW_MIN_MOVES = 10
/** "Try again" in the preview, at most this many times in a row. */
export const MAX_RETRIES = 3

/** A plan that can be previewed and written. Built from the board as it is at the moment `build` runs. */
export interface BuiltPlan {
  /** notes left alone: locked, being typed in, being dragged by someone else (the notice names them) */
  readonly skipped: readonly Skipped[]
  /** the notes that change place, and where they go (scene top-left), for the preview */
  readonly moves: readonly { readonly id: string; readonly x: number; readonly y: number }[]
  /** what will be made, for the preview's outlines */
  readonly creates: AiPreviewPlan['creates']
  /** M4-1: the columns (or squares) it makes, with their notes, for the preview's list */
  readonly groups?: AiPreviewPlan['groups']
  /** the count line of the preview ('Moves 12 notes into 3 columns') */
  readonly summary: string
  /** applying it would change nothing */
  readonly noop: boolean
  /** writes it (one transact) and says what it did, for the notice */
  apply(): { readonly moved: number; readonly text: string; readonly ok: boolean }
  /** extra words for the notice after the apply (unscored notes, notes that did not fit, …) */
  readonly extra?: string
  /** a button in the notice after the apply ("Show scores") */
  readonly action?: { readonly label: string; readonly testId: string; onClick(): void }
}

export interface PlanProblem {
  readonly problem: string
}

export interface PlanSpec {
  /** the preview's heading and the undo step's name ('Sort by colour') */
  readonly title: string
  /** a stable id of the plan (an AI run's id, or one made for a deterministic sort) */
  readonly runId: string
  build(): BuiltPlan | PlanProblem
  /**
   * "Try again" in the preview: a new call, giving the next `build`, or null to stop (the call failed and the
   * person has been told). A plan with no retry (a deterministic sort) just builds again from the board.
   */
  retry?(): Promise<(() => BuiltPlan | PlanProblem) | null>
}

export type Outcome =
  | { readonly status: 'applied'; readonly moved: number; readonly skipped: number }
  | { readonly status: 'discarded' }
  | { readonly status: 'nothing'; readonly reason: string }
  | { readonly status: 'refused'; readonly reason: string }

const isProblem = (b: BuiltPlan | PlanProblem): b is PlanProblem => 'problem' in b

const busy = new WeakSet<object>()

/** Whether a sort or a placement of this canvas is waiting for the preview, or for the AI. */
export const isBusy = (canvas: object) => busy.has(canvas)

/** What a request made while another one is running is told. */
export const BUSY_TEXT = 'A sort is already running. Wait for it to finish, then try again.'

/**
 * Takes the canvas's one slot for a sort or a placement (null when it is taken). Whoever takes it gives it back:
 * the AI paths take it before the call to the api, so a second request made while the first waits is turned away
 * at once and not left to run a second call.
 */
export function takeBusy(canvas: object): (() => void) | null {
  if (busy.has(canvas)) return null
  busy.add(canvas)
  return () => void busy.delete(canvas)
}

/** Runs `run` holding the canvas's slot; a request that finds it taken is refused with a notice. */
export async function whileBusy<T extends { readonly status: string }>(
  ctx: CanvasFeatureContext,
  run: () => Promise<T>,
): Promise<T | Outcome> {
  const release = takeBusy(ctx.canvas)
  if (!release) {
    notice(ctx, BUSY_TEXT)
    return { status: 'refused', reason: 'busy' }
  }
  try {
    return await run()
  } finally {
    release()
  }
}

export function previewOf(spec: Pick<PlanSpec, 'title' | 'runId'>, built: BuiltPlan): AiPreviewPlan {
  return {
    runId: spec.runId,
    title: spec.title,
    summary: built.summary,
    moves: built.moves,
    recolors: [],
    creates: built.creates,
    ...(built.groups?.length ? { groups: built.groups } : {}),
  }
}

function notice(ctx: CanvasFeatureContext, text: string, tone?: 'error', action?: BuiltPlan['action']) {
  ctx.notify({
    key: 'sort',
    text,
    testId: 'sort-notice',
    timeoutMs: 8000,
    ...(tone ? { tone } : {}),
    ...(action ? { action } : {}),
  })
}

/** When the preview asks first: past PREVIEW_MIN_MOVES moves (a deterministic sort), or always (an AI answer, M4-2). */
export type PreviewWhen = 'over-ten' | 'always'

/**
 * Runs `spec` (see the header). Resolves what happened; tells the person in a notice. `held`: the caller already
 * holds the canvas's slot (`whileBusy`, around its AI call), so this neither takes nor gives it back. `preview`:
 * wave M (M4-2) shows every AI answer's plan first, whatever its size ('always'), so nothing an AI chose lands unseen.
 */
export async function executePlan(
  ctx: CanvasFeatureContext,
  spec: PlanSpec,
  held = false,
  preview: PreviewWhen = 'over-ten',
): Promise<Outcome> {
  const { canvas } = ctx
  if (canvas.readOnly()) return { status: 'refused', reason: 'read-only' }
  const release = held ? () => {} : takeBusy(canvas)
  if (!release) {
    notice(ctx, BUSY_TEXT)
    return { status: 'refused', reason: 'busy' }
  }
  try {
    let build = spec.build
    let built = build()
    if (isProblem(built)) {
      notice(ctx, built.problem)
      return { status: 'nothing', reason: built.problem }
    }
    if (built.noop) {
      const text = 'Nothing to change: these notes are already arranged that way.'
      notice(ctx, `${text}${built.skipped.length ? ` ${skippedText(built.skipped)}` : ''}`)
      return { status: 'nothing', reason: text }
    }
    // the preview, when it moves more than a few notes (an AI answer: always); "Try again" builds again (a new AI
    // call when it has one)
    let retries = 0
    while (preview === 'always' || built.moves.length > PREVIEW_MIN_MOVES) {
      const choice = await sortDeps().showAiPreview(ctx, previewOf(spec, built))
      if (choice === 'apply') break
      if (choice === 'discard' || retries >= MAX_RETRIES) return { status: 'discarded' }
      retries++
      if (spec.retry) {
        const next = await spec.retry()
        if (!next) return { status: 'discarded' }
        build = next
      }
      const again = build()
      if (isProblem(again)) {
        notice(ctx, again.problem)
        return { status: 'nothing', reason: again.problem }
      }
      built = again
    }
    if (canvas.readOnly()) return { status: 'refused', reason: 'read-only' }
    // the board as it is now: a note that became busy while the preview was open stays where it is
    const fresh = build()
    if (isProblem(fresh)) {
      notice(ctx, fresh.problem)
      return { status: 'nothing', reason: fresh.problem }
    }
    if (fresh.noop) {
      notice(ctx, 'Nothing to change: these notes are already arranged that way.')
      return { status: 'nothing', reason: 'noop' }
    }
    let result: ReturnType<BuiltPlan['apply']>
    try {
      result = fresh.apply()
    } catch (e) {
      console.error('sort: could not write the plan', e)
      notice(ctx, 'The notes could not be moved. Nothing was changed.', 'error')
      return { status: 'refused', reason: 'write-failed' }
    }
    const skipped = skippedText(fresh.skipped)
    notice(ctx, [result.text, fresh.extra ?? '', skipped].filter(Boolean).join(' '), undefined, fresh.action)
    return { status: 'applied', moved: result.moved, skipped: fresh.skipped.length }
  } finally {
    release()
  }
}
