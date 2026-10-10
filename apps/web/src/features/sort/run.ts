// L8-1: sorting the selection by colour, author, tag or votes. Builds the plan (./plan.ts) from the board as
// it is at that moment and hands it to the shared executor (./execute.ts: preview over 10 moves, re-read at
// the moment of writing, one undo step). The AI sort by a lens (./ai.ts) goes the same way with the groups the
// api names.
import type { CanvasFeatureContext } from '../../canvas/api/index.ts'
import { applyColumns, bringIntoView, planBounds } from './apply.ts'
import { plural } from './copy.ts'
import { type BuiltPlan, executePlan, type Outcome, type PlanProblem, type PlanSpec } from './execute.ts'
import { groupNotes, SORT_KEY_LABELS, type SortKey, sortKeyProblem } from './keys.ts'
import {
  authorsHidden,
  eligibility,
  MAX_SORT_NOTES,
  readSortContext,
  revealedVotes,
  type Skipped,
  skippedText,
  sortNotesOf,
  targetNotes,
} from './model.ts'
import { type ColumnsPlan, isNoop, MAX_COLUMNS, planColumns, SORT_LABEL_KIND } from './plan.ts'

export const NEED_NOTES = 'Select a frame or two or more sticky notes to sort.'

/** The measuring function of the canvas's text metrics. */
export const measureOf =
  (ctx: CanvasFeatureContext) => (text: string, style: { fontFamily: number; fontSize: number }) =>
    ctx.canvas.text.measure(text, style)

/** A columns plan as something the executor can preview and write. */
export function columnsBuilt(
  ctx: CanvasFeatureContext,
  plan: ColumnsPlan,
  skipped: readonly Skipped[],
  opts: { title: string; customData(): Record<string, unknown>; extra?: string },
): BuiltPlan {
  const { canvas } = ctx
  const moves = plan.spaces.flatMap((s) =>
    s.moves.filter((m) => m.x !== m.fromX || m.y !== m.fromY).map((m) => ({ id: m.id, x: m.x, y: m.y })),
  )
  // M4-1: each heading's outline says its column's name, and the preview lists the columns with their notes
  const creates = plan.spaces.flatMap((s) =>
    s.labels.map((l) => ({ x: l.x, y: l.y, w: l.width, h: l.block.height, kind: 'text', label: l.name })),
  )
  const groups = plan.spaces.flatMap((s) => s.labels.map((l) => ({ name: l.name, count: l.count })))
  const noun = (n: number) => plural(n, 'note')
  return {
    skipped,
    moves,
    creates,
    groups,
    summary: `Moves ${noun(plan.moved)} into ${plural(plan.columns, 'column')}`,
    noop: isNoop(plan),
    ...(opts.extra ? { extra: opts.extra } : {}),
    apply() {
      const out = applyColumns(canvas, plan, { label: opts.title, customData: opts.customData })
      bringIntoView(canvas, planBounds(canvas, plan))
      return {
        moved: out.moved,
        ok: true,
        text: `${opts.title}: ${noun(out.moved)} in ${plural(plan.columns, 'column')}. Ctrl+Z undoes it.`,
      }
    },
  }
}

/** The spec of a deterministic sort of `ids` (a selection) by `key`. */
export function sortSpec(ctx: CanvasFeatureContext, key: SortKey, ids: readonly string[]): PlanSpec {
  const { canvas } = ctx
  const title = `Sort by ${SORT_KEY_LABELS[key].toLowerCase()}`
  return {
    title,
    runId: `sort-${key}`,
    build(): BuiltPlan | PlanProblem {
      const targets = targetNotes(canvas, ids)
      if (targets.length < 2) return { problem: NEED_NOTES }
      if (targets.length > MAX_SORT_NOTES)
        return { problem: `That is ${targets.length} notes. Sort up to ${MAX_SORT_NOTES} at a time.` }
      const { movable, skipped } = eligibility(canvas, targets)
      if (movable.length < 2)
        return { problem: skipped.length ? `${skippedText(skipped)} Nothing to sort.` : NEED_NOTES }
      const context = readSortContext(ctx)
      const groups = groupNotes(key, sortNotesOf(canvas, movable), context)
      if (!groups) return { problem: sortKeyProblem(key, context) ?? 'That sort is not available.' }
      if (groups.length > MAX_COLUMNS)
        return { problem: `That makes ${groups.length} columns; the most one sort makes is ${MAX_COLUMNS}.` }
      const plan = planColumns(canvas, groups, measureOf(ctx))
      return columnsBuilt(ctx, plan, skipped, {
        title,
        customData: () => ({ lobby: { kind: SORT_LABEL_KIND } }),
      })
    },
  }
}

/** Sorts `ids` (default: the selection) by `key`. */
export function sortBy(
  ctx: CanvasFeatureContext,
  key: SortKey,
  ids: readonly string[] = ctx.canvas.selection,
): Promise<Outcome> {
  return executePlan(ctx, sortSpec(ctx, key, ids))
}

/** Why a sort by `key` cannot run for `ids` right now (words for the person), or null when it can. */
export function sortDisabledReason(
  ctx: CanvasFeatureContext,
  key: SortKey,
  ids: readonly string[] = ctx.canvas.selection,
): string | null {
  if (targetNotes(ctx.canvas, ids).length < 2) return NEED_NOTES
  // the palette asks this of every command as it lists them: only the keys with a condition look anything up
  if (key === 'author') return sortKeyProblem(key, { votes: null, authorsHidden: authorsHidden(ctx.canvas) })
  return key === 'votes' ? sortKeyProblem(key, { votes: revealedVotes(ctx), authorsHidden: false }) : null
}
