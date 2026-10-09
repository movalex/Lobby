// L8-1 and L8-2: the sort feature's commands (what the palette lists and runs by id, what the menus run) and
// the menu entries. Every one is for editors only (`commandRunnable` refuses a viewer, a commenter and a
// read-only board), and each says why it cannot run now in words the palette shows.
import type { AiScoreAxis } from '@draftroom/contracts'
import type { CanvasFeatureContext, CommandSpec, MenuEntrySpec, MenuTarget } from '../../canvas/api/index.ts'
import { placeOnMatrix, sortByLens, validAxes } from './ai.ts'
import { SORT_KEY_LABELS, SORT_KEYS, type SortKey } from './keys.ts'
import { detectMatrix } from './matrix.ts'
import { targetNotes } from './model.ts'
import { NEED_NOTES, sortBy, sortDisabledReason } from './run.ts'
import { scoresOf, showScores } from './scores.ts'
import { anchorAtSelection, openSortMenu } from './state.ts'

/** The command ids (frozen: the palette and other features run them by id). */
export const SORT_COMMAND_IDS = {
  colour: 'sort.colour',
  author: 'sort.author',
  tag: 'sort.tag',
  votes: 'sort.votes',
  lens: 'sort.lens',
  place: 'sort.place',
  scores: 'sort.scores',
} as const

/** What a caller passes when it runs a sort command by id; anything else is ignored. */
export interface SortArgs {
  /** the elements to sort: notes, or a frame (default: the selection) */
  readonly ids?: readonly string[]
  /** 'sort.lens': the lens, so no question is asked */
  readonly lens?: string
  /** 'sort.place': the two axes (across, up) of a new 2x2 */
  readonly axes?: readonly [AiScoreAxis, AiScoreAxis]
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null

export function sortArgs(args: unknown): SortArgs {
  if (!isObj(args)) return {}
  const out: { ids?: readonly string[]; lens?: string; axes?: readonly [AiScoreAxis, AiScoreAxis] } = {}
  if (Array.isArray(args.ids) && args.ids.every((x) => typeof x === 'string'))
    out.ids = (args.ids as string[]).slice(0, 400)
  if (typeof args.lens === 'string' && args.lens.trim()) out.lens = args.lens
  const ax = args.axes
  if (Array.isArray(ax) && ax.length === 2 && ax.every((a) => isObj(a))) {
    const axes = (ax as Record<string, unknown>[]).map((a) => ({
      name: String(a.name ?? ''),
      low: String(a.low ?? ''),
      high: String(a.high ?? ''),
    }))
    if (validAxes(axes)) out.axes = [axes[0] as AiScoreAxis, axes[1] as AiScoreAxis]
  }
  return out
}

const idsOf = (ctx: CanvasFeatureContext, a: SortArgs) => a.ids ?? ctx.canvas.selection

/** Where a popover opened by a command points: the opening button, the selection, or the view. */
function openFrom(ctx: CanvasFeatureContext, view: 'lens' | 'axes', ids: readonly string[]) {
  openSortMenu(ctx, view, anchorAtSelection(ctx.canvas, ids), ids, null)
}

const enoughNotes = (ctx: CanvasFeatureContext, ids: readonly string[] = ctx.canvas.selection) =>
  targetNotes(ctx.canvas, ids).length >= 2

function keyCommand(key: SortKey): CommandSpec {
  return {
    id: SORT_COMMAND_IDS[key],
    label: `Sort notes ${SORT_KEY_LABELS[key] === 'Votes' ? 'by votes' : `by ${SORT_KEY_LABELS[key].toLowerCase()}`}`,
    group: 'Arrange',
    keywords: [
      'sort',
      'group',
      'columns',
      'cluster',
      'organise',
      'organize',
      'notes',
      SORT_KEY_LABELS[key].toLowerCase(),
    ],
    disabledReason: (ctx) => sortDisabledReason(ctx, key),
    run: (ctx, _source, args) => {
      void sortBy(ctx, key, idsOf(ctx, sortArgs(args)))
    },
  }
}

export const COMMANDS: readonly CommandSpec[] = [
  ...SORT_KEYS.map(keyCommand),
  {
    id: SORT_COMMAND_IDS.lens,
    label: 'Sort notes by a lens (AI)',
    group: 'AI',
    keywords: ['sort', 'group', 'cluster', 'columns', 'lens', 'theme', 'ai'],
    disabledReason: (ctx) => (enoughNotes(ctx) ? null : NEED_NOTES),
    run: (ctx, _source, args) => {
      const a = sortArgs(args)
      const ids = idsOf(ctx, a)
      if (a.lens) void sortByLens(ctx, a.lens, ids)
      else openFrom(ctx, 'lens', ids)
    },
  },
  {
    id: SORT_COMMAND_IDS.place,
    label: 'Place notes on a 2x2 (AI)',
    group: 'AI',
    keywords: ['place', '2x2', 'matrix', 'impact', 'effort', 'prioritise', 'prioritize', 'score', 'ai'],
    disabledReason: (ctx) => (enoughNotes(ctx) ? null : NEED_NOTES),
    run: async (ctx, _source, args) => {
      const a = sortArgs(args)
      const ids = idsOf(ctx, a)
      const known = detectMatrix(ctx.canvas, targetNotes(ctx.canvas, ids))
      if (known || a.axes) {
        await placeOnMatrix(ctx, { ids, ...(a.axes ? { axes: a.axes } : {}) })
        return
      }
      openFrom(ctx, 'axes', ids)
    },
  },
  {
    id: SORT_COMMAND_IDS.scores,
    label: 'Show or hide the scores of the last 2x2 placement',
    group: 'Arrange',
    keywords: ['scores', 'show', 'hide', '2x2'],
    disabledReason: (ctx) => (scoresOf(ctx.canvas).get() ? null : 'Place notes on a 2x2 first'),
    run: (ctx) => {
      const cur = scoresOf(ctx.canvas).get()
      if (cur) showScores(ctx.canvas, !cur.shown)
    },
  },
]

// ---- the context menu: "Sort by" ---------------------------------------------------------------------------------------

/** What a menu is about: the selection it opened over, else what was under the pointer. */
const menuIds = (ctx: CanvasFeatureContext, t: MenuTarget): readonly string[] =>
  t.ids.length ? t.ids : t.hit ? [t.hit.id] : ctx.canvas.selection

const keyEntry = (key: SortKey, order: number): MenuEntrySpec => ({
  id: `sort.menu.${key}`,
  group: 'arrange',
  order,
  label: (ctx, t) => {
    const why = sortDisabledReason(ctx, key, menuIds(ctx, t))
    return why && key === 'votes' ? `${SORT_KEY_LABELS[key]} (${why.toLowerCase()})` : SORT_KEY_LABELS[key]
  },
  disabled: (ctx, t) => sortDisabledReason(ctx, key, menuIds(ctx, t)) !== null,
  run: (ctx, t) => {
    void sortBy(ctx, key, menuIds(ctx, t))
  },
})

export const CONTEXT_MENU: readonly MenuEntrySpec[] = [
  {
    id: 'sort',
    group: 'arrange',
    order: 15,
    label: 'Sort by',
    visible: (ctx, t) => !ctx.canvas.readOnly() && enoughNotes(ctx, menuIds(ctx, t)),
    submenu: [
      ...SORT_KEYS.map((k, i) => keyEntry(k, i + 1)),
      {
        id: 'sort.menu.lens',
        group: 'arrange',
        order: 10,
        label: 'A lens (AI)…',
        run: (ctx, t) => {
          const ids = menuIds(ctx, t)
          // after the menu has closed (its focus handling first)
          setTimeout(() => openSortMenu(ctx, 'lens', anchorAtSelection(ctx.canvas, ids), ids, null), 0)
        },
      },
      {
        id: 'sort.menu.place',
        group: 'arrange',
        order: 11,
        label: 'Place on a 2x2 (AI)…',
        run: (ctx, t) => {
          const ids = menuIds(ctx, t)
          const known = detectMatrix(ctx.canvas, targetNotes(ctx.canvas, ids))
          setTimeout(() => {
            if (known) void placeOnMatrix(ctx, { ids })
            else openSortMenu(ctx, 'axes', anchorAtSelection(ctx.canvas, ids), ids, null)
          }, 0)
        },
      },
    ],
  },
]
