// OWNER: WS4 (wave T; registered empty by the wave T foundation, docs/WAVE-T-CONTRACTS.md §1, §2, §6.5). The 'cards'
// feature on the Excalidraw board page: work cards (T3).
//
//  - a card is a rectangle or a sticky note with `card:status` (./model.ts); its title is its label (the text lease);
//  - Make a card / Unmake card (the context menu, the selection bar and the palette's `cards.make`), each one step;
//  - the chips (./Chips.tsx): status, due date, assignee initials, a `scene` layer, drawn into exports (./export.ts);
//  - the card popover (./Popover.tsx), registered through features/planning `registerCardPopover` so the card table
//    and WS5's timeline open it too; the assignee picker over the board's members (./people.ts).
//
// While its switch is off (features/planning/flags.ts PLANNING_FLAGS.cards) the feature contributes nothing and the
// board page is unchanged. With it on, a board's cards show in any room (`planningShown`); every write is offered
// only in a rev-14 room, never read-only (`planningOffered`), and the room checks each key again.
import { type CardStatus, cardOf, type PlanningElement } from '@draftroom/canvas-schema/planning'
import type {
  CanvasFeature,
  CanvasFeatureContext,
  CommandSpec,
  FeatureOverlaySpec,
  MenuEntrySpec,
  SelectionBarItemSpec,
} from '../../canvas/api/index.ts'
import { DEV_AUTH_ENABLED } from '../../lib/identity.ts'
import { atom, useValue } from '../../lib/signals.ts'
import { type CardPopoverRequest, planningShown, registerCardPopover } from '../planning/index.ts'
import { registerExportOverlay } from '../present-export/ported/badges.ts'
import { type CardsState, cardsOf, setCards } from './bridge.ts'
import { CardChipsLayer } from './Chips.tsx'
import { CARDS_OVERLAY } from './export.ts'
import { StatusIcon } from './icons.tsx'
import { CARD_STATUSES, isCard, statusWords } from './model.ts'
import { CardPopoverLayer } from './Popover.tsx'
import { People } from './people.ts'
import {
  cardsWritable,
  cardWritable,
  makeableIn,
  makeCards,
  setStatus,
  unmakeableIn,
  unmakeCards,
} from './write.ts'
import './cards.css'

export { cardsOf } from './bridge.ts'

const selectedCard = (ctx: CanvasFeatureContext): string | null => {
  const sel = ctx.canvas.selection
  if (sel.length !== 1) return null
  const id = sel[0] as string
  return isCard(ctx.canvas.get(id)) ? id : null
}

/** Opens the popover of card `id` (after the menu that asked has closed and handed the focus back). */
export function openPopover(ctx: CanvasFeatureContext, req: CardPopoverRequest): boolean {
  const s = cardsOf(ctx.canvas)
  if (!s || !planningShown('cards') || !isCard(ctx.canvas.get(req.id))) return false
  setTimeout(() => s.popover.set(req), 0)
  return true
}

function make(ctx: CanvasFeatureContext, ids: readonly string[]) {
  const n = makeCards(ctx.canvas, ids)
  if (n)
    ctx.notify({
      key: 'cards:make',
      text: n === 1 ? 'Made a card. Set its status, assignee and dates.' : `Made ${n} cards.`,
      testId: 'cards-made',
    })
}

export const COMMANDS: readonly CommandSpec[] = [
  {
    id: 'cards.make',
    label: 'Make a card',
    group: 'Plan',
    keywords: ['card', 'task', 'status', 'assignee', 'due', 'todo', 'kanban'],
    disabledReason: (ctx) =>
      !cardsWritable(ctx.canvas)
        ? 'Cards need the newest board server'
        : makeableIn(ctx.canvas, ctx.canvas.selection).length
          ? null
          : 'Select a sticky note or a rectangle',
    run: (ctx) => make(ctx, ctx.canvas.selection),
  },
]

const statusEntries: readonly MenuEntrySpec[] = CARD_STATUSES.map((st, i) => ({
  id: `cards-status-${st}`,
  group: 'organize' as const,
  order: i,
  label: statusWords(st),
  checked: (ctx, t) => t.ids.every((id) => cardOf(ctx.canvas.get(id) as PlanningElement)?.status === st),
  run: (ctx, t) => void setStatus(ctx.canvas, t.ids, st),
}))

export const MENU: readonly MenuEntrySpec[] = [
  {
    id: 'cards-make',
    group: 'organize',
    order: 40,
    label: (ctx, t) => (makeableIn(ctx.canvas, t.ids).length > 1 ? 'Make cards' : 'Make a card'),
    visible: (ctx, t) => makeableIn(ctx.canvas, t.ids).length > 0,
    run: (ctx, t) => make(ctx, t.ids),
  },
  {
    id: 'cards-open',
    group: 'organize',
    order: 41,
    label: 'Card details…',
    visible: (ctx, t) => t.ids.length === 1 && isCard(ctx.canvas.get(t.ids[0] as string)),
    run: (ctx, t) => void openPopover(ctx, { id: t.ids[0] as string }),
  },
  {
    id: 'cards-status',
    group: 'organize',
    order: 42,
    label: 'Status',
    visible: (ctx, t) => t.ids.length > 0 && t.ids.every((id) => cardWritable(ctx.canvas, id)),
    submenu: statusEntries,
  },
  {
    id: 'cards-unmake',
    group: 'organize',
    order: 43,
    label: (_ctx, t) => (t.ids.length > 1 ? 'Unmake cards' : 'Unmake card'),
    visible: (ctx, t) => unmakeableIn(ctx.canvas, t.ids).length > 0,
    run: (ctx, t) => void unmakeCards(ctx.canvas, t.ids),
  },
]

function BarItem({ ctx }: { ctx: CanvasFeatureContext; selection: readonly string[] }) {
  const view = useValue('cards.bar', () => {
    const id = selectedCard(ctx)
    if (id) {
      const card = cardOf(ctx.canvas.get(id) as PlanningElement)
      return card ? { kind: 'card' as const, id, status: card.status as CardStatus } : null
    }
    return makeableIn(ctx.canvas, ctx.canvas.selection).length ? { kind: 'make' as const } : null
  }, [ctx])
  if (!view) return null
  return (
    <span className="dr-card-barslot">
      <span className="dr-cux-selbar__sep" aria-hidden="true" />
      {view.kind === 'make' ? (
        <button
          type="button"
          className="dr-cux-selbar__btn dr-card-barbtn"
          data-testid="selection-card-make"
          title="Make a card: a status, an assignee and dates"
          onClick={() => make(ctx, ctx.canvas.selection)}
        >
          Make a card
        </button>
      ) : (
        <button
          type="button"
          className="dr-cux-selbar__btn dr-card-barbtn"
          data-testid="selection-card-status"
          data-card-keep-popover=""
          aria-haspopup="dialog"
          onClick={() => {
            const s = cardsOf(ctx.canvas)
            if (s) s.popover.set(s.popover.get()?.id === view.id ? null : { id: view.id })
          }}
        >
          <span className="dr-card-chip dr-card-status" data-status={view.status}>
            <StatusIcon status={view.status} size={12} />
            {statusWords(view.status)}
          </span>
          <span className="dr-card-barbtn__more">Details</span>
        </button>
      )}
    </span>
  )
}

export const SELECTION_BAR: readonly SelectionBarItemSpec[] = [
  {
    id: 'cards',
    order: 56,
    visible: (ctx, sel) =>
      (sel.length === 1 && isCard(ctx.canvas.get(sel[0] as string))) ||
      makeableIn(ctx.canvas, sel).length > 0,
    component: BarItem,
  },
]

export const OVERLAYS: readonly FeatureOverlaySpec[] = [
  // above the tag chips and the review pills; the layer takes no clicks, its chip rows do (cards.css)
  { id: 'cards.chips', layer: 'scene', order: 10, pointer: 'none', component: CardChipsLayer },
  { id: 'cards.popover', layer: 'screen', order: 28, pointer: 'none', component: CardPopoverLayer },
]

function mount(ctx: CanvasFeatureContext): () => void {
  const people = new People(() => ctx.api.listMembers(ctx.board.id))
  void people.refresh()
  const s: CardsState = { ctx, people, popover: atom<CardPopoverRequest | null>('cards.popover', null) }
  setCards(ctx.canvas, s)
  const offPopover = registerCardPopover((c, req) => openPopover(c, req))
  const debug = window as unknown as { __lobbyCards?: CardsState }
  // e2e and debugging only, behind the same local-dev guard as the board page's debug handle
  if (DEV_AUTH_ENABLED) debug.__lobbyCards = s
  return () => {
    offPopover()
    setCards(ctx.canvas, null)
    if (debug.__lobbyCards === s) debug.__lobbyCards = undefined
  }
}

/** The feature for this page's switch: everything with it on, nothing with it off. */
export function cardsFeature(on: boolean): CanvasFeature {
  if (!on) return { id: 'cards' }
  return {
    id: 'cards',
    overlays: OVERLAYS,
    contextMenu: MENU,
    selectionBar: SELECTION_BAR,
    commands: COMMANDS,
    onMount: mount,
  }
}

const ON = planningShown('cards')
if (ON) registerExportOverlay(CARDS_OVERLAY)

export const feature: CanvasFeature = cardsFeature(ON)
