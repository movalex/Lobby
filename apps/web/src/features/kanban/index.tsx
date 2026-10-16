// OWNER: WS4 (wave T; registered empty by the wave T foundation, docs/WAVE-T-CONTRACTS.md §1, §2). The 'kanban'
// feature on the Excalidraw board page: Kanban frames (T3).
//
//  - a Kanban is a frame with a `kanban` key (column labels, hidden columns, WIP limits); its columns are equal bands of
//    the frame for the visible statuses, drawn as an overlay (./Columns.tsx) and into exports (./export.ts);
//  - dropping a card into a column writes its position and its status in ONE undo step (./runtime.ts, actor only); a
//    status set in the popover or the table moves the card into its column in the same step (features/cards);
//  - a card in another column than its status's shows as a mismatch with Tidy (the actor's re-layout);
//  - "Kanban board" (the palette's `kanban.new`), "Use as Kanban" on a frame, "Plain frame", "Tidy", "Move to column".
//
// While its switch is off (features/planning/flags.ts PLANNING_FLAGS.kanban) the feature contributes nothing.
import {
  type CardStatus,
  kanbanColumns,
  kanbanOf,
  type PlanningElement,
} from '@draftroom/canvas-schema/planning'
import type {
  CanvasFeature,
  CanvasFeatureContext,
  CommandSpec,
  FeatureOverlaySpec,
  MenuEntrySpec,
} from '../../canvas/api/index.ts'
import { atom } from '../../lib/signals.ts'
import { isCard } from '../cards/model.ts'
import { cardsWritable, cardWritable, setStatus } from '../cards/write.ts'
import { planningShown } from '../planning/index.ts'
import { registerExportOverlay } from '../present-export/ported/badges.ts'
import { type ColumnMenuRequest, type KanbanState, setKanbanState } from './bridge.ts'
import { KanbanColumnsLayer } from './Columns.tsx'
import { KANBAN_OVERLAY } from './export.ts'
import { KanbanMenuLayer } from './Menu.tsx'
import { KanbanRuntime } from './runtime.ts'
import { kanbanAt } from './scene.ts'
import {
  convertible,
  createKanban,
  kanbanFrameWritable,
  kanbanWritable,
  makeKanban,
  tidyKanban,
  unmakeKanban,
} from './write.ts'
import './kanban.css'

const one = (ids: readonly string[]) => (ids.length === 1 ? (ids[0] as string) : null)

/** The Kanban the selection's cards share (all in one Kanban), or null. */
function sharedKanban(ctx: CanvasFeatureContext, ids: readonly string[]) {
  if (!ids.length) return null
  let frameId: string | null = null
  for (const id of ids) {
    const el = ctx.canvas.get(id)
    if (!isCard(el) || !el?.frameId) return null
    if (frameId && el.frameId !== frameId) return null
    frameId = el.frameId
  }
  return kanbanAt(ctx.canvas, frameId)
}

function create(ctx: CanvasFeatureContext) {
  const id = createKanban(ctx.canvas)
  if (id)
    ctx.notify({
      key: 'kanban:new',
      text: 'Kanban board added. Drag cards into its columns, or make cards from notes.',
      testId: 'kanban-created',
    })
}

export const COMMANDS: readonly CommandSpec[] = [
  {
    id: 'kanban.new',
    label: 'Kanban board',
    group: 'Plan',
    keywords: ['kanban', 'board', 'columns', 'to do', 'status', 'cards', 'workflow'],
    disabledReason: (ctx) => (kanbanWritable(ctx.canvas) ? null : 'Kanbans need the newest board server'),
    run: (ctx) => create(ctx),
  },
]

export const MENU: readonly MenuEntrySpec[] = [
  {
    id: 'kanban-make',
    group: 'frame',
    order: 60,
    label: 'Use as Kanban',
    visible: (ctx, t) => {
      const id = one(t.ids)
      return !!id && kanbanWritable(ctx.canvas) && convertible(ctx.canvas, id)
    },
    run: (ctx, t) => {
      const id = one(t.ids)
      if (id && makeKanban(ctx.canvas, id)) tidyKanban(ctx.canvas, id)
    },
  },
  {
    id: 'kanban-tidy',
    group: 'frame',
    order: 61,
    label: 'Tidy Kanban',
    visible: (ctx, t) => {
      const id = one(t.ids)
      return !!id && kanbanFrameWritable(ctx.canvas, id)
    },
    run: (ctx, t) => {
      const id = one(t.ids)
      if (id) tidyKanban(ctx.canvas, id)
    },
  },
  {
    id: 'kanban-unmake',
    group: 'frame',
    order: 62,
    label: 'Make plain frame',
    visible: (ctx, t) => {
      const id = one(t.ids)
      return !!id && kanbanFrameWritable(ctx.canvas, id)
    },
    run: (ctx, t) => {
      const id = one(t.ids)
      if (id) unmakeKanban(ctx.canvas, id)
    },
  },
  {
    id: 'kanban-move',
    group: 'organize',
    order: 44,
    label: 'Move to column',
    visible: (ctx, t) =>
      cardsWritable(ctx.canvas) &&
      kanbanWritable(ctx.canvas) &&
      sharedKanban(ctx, t.ids) !== null &&
      t.ids.every((id) => cardWritable(ctx.canvas, id)),
    // the columns of the Kanban the cards are in, by their labels (one entry per status: the submenu is static)
    submenu: (['todo', 'doing', 'review', 'blocked', 'done'] as const).map((st, i) => ({
      id: `kanban-move-${st}`,
      group: 'organize' as const,
      order: i,
      label: (ctx: CanvasFeatureContext, t: { ids: readonly string[] }) => {
        const k = sharedKanban(ctx, t.ids)
        return (k && kanbanColumns(k.value).find((c) => c.status === st)?.label) || st
      },
      visible: (ctx: CanvasFeatureContext, t: { ids: readonly string[] }) => {
        const k = sharedKanban(ctx, t.ids)
        return !!k && !(k.value.hidden ?? []).includes(st)
      },
      run: (ctx: CanvasFeatureContext, t: { ids: readonly string[] }) =>
        void setStatus(ctx.canvas, t.ids, st),
    })),
  },
]

export const OVERLAYS: readonly FeatureOverlaySpec[] = [
  // under the card chips (order 10) and the tag chips: the columns sit behind what is on them
  { id: 'kanban.columns', layer: 'scene', order: 4, pointer: 'none', component: KanbanColumnsLayer },
  { id: 'kanban.menu', layer: 'screen', order: 29, pointer: 'none', component: KanbanMenuLayer },
]

function mount(ctx: CanvasFeatureContext): () => void {
  const s: KanbanState = {
    ctx,
    menu: atom<ColumnMenuRequest | null>('kanban.menu', null),
    renaming: atom<{ frameId: string; status: CardStatus } | null>('kanban.renaming', null),
  }
  setKanbanState(ctx.canvas, s)
  const runtime = new KanbanRuntime(ctx.canvas, {
    kanbanOffered: () => kanbanWritable(ctx.canvas),
    cardsOffered: () => cardsWritable(ctx.canvas),
  })
  const stop = runtime.start()
  return () => {
    stop()
    setKanbanState(ctx.canvas, null)
  }
}

/** Whether `id` is a Kanban frame (for other features: the card table's "this Kanban" scope). */
export const isKanban = (ctx: CanvasFeatureContext, id: string): boolean =>
  !!kanbanOf(ctx.canvas.get(id) as PlanningElement)

/** The feature for this page's switch: everything with it on, nothing with it off. */
export function kanbanFeature(on: boolean): CanvasFeature {
  if (!on) return { id: 'kanban' }
  return { id: 'kanban', overlays: OVERLAYS, contextMenu: MENU, commands: COMMANDS, onMount: mount }
}

const ON = planningShown('kanban')
if (ON) registerExportOverlay(KANBAN_OVERLAY)

export const feature: CanvasFeature = kanbanFeature(ON)
