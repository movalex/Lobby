// OWNER: WS1 (wave S, review status; docs/WAVE-S-CONTRACTS.md §2). The 'review' board feature: review status of a
// board's deliverables (a frame, a file card, an image with a Lobby file; never a placed PDF page).
//
//  - the store (./store.ts): GET /api/boards/:bid/review, kept current by the board events and refetched on
//    reconnect; WS4's review page reads it through ./bridge.ts;
//  - badges (./Badges.tsx): a `scene` layer of pills (never elements; nothing is written to the board) and the item's
//    popover in a `screen` layer: the status buttons, the note and the history; focus mode hides both;
//  - the Review dock panel (./Panel.tsx): the items in order, filters, "Show on board", rounds;
//  - "Mark for review" / "Remove from review" in the context menu and the selection bar, and a palette command;
//  - the review viewer's header entry `ws1.status` (order 20): the pill and the buttons of a file in review.
//
// Who may do what is decided by the api on every request (REVIEW_RULES); the UI shows the buttons GET review's `can`
// allows. While the status switch is off (./flags.ts REVIEW_FLAGS.status) the feature contributes nothing and the
// board page is exactly as before wave S.
import type {
  CanvasFeature,
  CanvasFeatureContext,
  CanvasPanelSpec,
  CommandSpec,
  FeatureOverlaySpec,
  MenuEntrySpec,
  SelectionBarItemSpec,
} from '../../canvas/api/index.ts'
import { DEV_AUTH_ENABLED } from '../../lib/identity.ts'
import { useValue } from '../../lib/signals.ts'
import { registerViewerSlot, type ViewerSlotProps } from '../review-viewer/slots.ts'
import { ReviewBadgesLayer, ReviewPopoverLayer } from './Badges.tsx'
import { type Review, reviewOf, setReview } from './bridge.ts'
import { reviewFlags } from './flags.ts'
import { markSelection, REVIEW_PANEL_ID, ReviewPanel, selectedMarkable } from './Panel.tsx'
import { History, StatusForm, StatusPill } from './StatusForm.tsx'
import { ReviewStore } from './store.ts'
import './review.css'

export { REVIEW_PANEL_ID }

function ReviewIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      width={18}
      height={18}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.9"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <rect x="4" y="3.5" width="16" height="17" rx="2" />
      <path d="M8.5 12.5l2.2 2.2 4.8-5" />
    </svg>
  )
}

const hasReview = (ctx: CanvasFeatureContext) => reviewOf(ctx.canvas) !== null

/** The selected element's live item, when one element alone is selected. */
function selectedItem(ctx: CanvasFeatureContext) {
  const r = reviewOf(ctx.canvas)
  const sel = ctx.canvas.selection
  if (!r || sel.length !== 1) return null
  return r.store.itemOf(sel[0] as string)
}

const canManage = (ctx: CanvasFeatureContext) => reviewOf(ctx.canvas)?.store.state.get().can.manage === true

const mayMark = (ctx: CanvasFeatureContext) =>
  canManage(ctx) && selectedMarkable(ctx) !== null && selectedItem(ctx) === null

export const PANELS: readonly CanvasPanelSpec[] = [
  {
    id: REVIEW_PANEL_ID,
    label: 'Review',
    icon: ReviewIcon,
    order: 55,
    // everyone who can see the board sees its review; the panel shows once there is one, or for whoever sets it up
    visible: (ctx) => {
      const r = reviewOf(ctx.canvas)
      if (!r) return false
      const s = r.store.state.get()
      return s.can.manage || s.items.length > 0
    },
    component: ReviewPanel,
  },
]

export const OVERLAYS: readonly FeatureOverlaySpec[] = [
  // above the comment pins; the layer takes no clicks, its pills do (review.css)
  { id: 'review.badges', layer: 'scene', order: 9, pointer: 'none', component: ReviewBadgesLayer },
  { id: 'review.popover', layer: 'screen', order: 27, pointer: 'none', component: ReviewPopoverLayer },
]

export const MENU: readonly MenuEntrySpec[] = [
  {
    id: 'review-mark',
    group: 'collaborate',
    order: 60,
    label: 'Mark for review',
    visible: (ctx) => mayMark(ctx),
    run: (ctx) => {
      const r = reviewOf(ctx.canvas)
      if (r) void markSelection(r)
    },
  },
  {
    id: 'review-open',
    group: 'collaborate',
    order: 61,
    label: 'Review status…',
    visible: (ctx) => selectedItem(ctx) !== null,
    // after the menu has closed and handed the focus back, so the popover keeps it
    run: (ctx) => {
      const item = selectedItem(ctx)
      const r = reviewOf(ctx.canvas)
      if (item && r) setTimeout(() => r.store.popover.set({ itemId: item.id, from: 'badge' }), 0)
    },
  },
  {
    id: 'review-remove',
    group: 'collaborate',
    order: 62,
    label: 'Remove from review',
    visible: (ctx) => canManage(ctx) && selectedItem(ctx) !== null,
    run: (ctx) => {
      const item = selectedItem(ctx)
      const r = reviewOf(ctx.canvas)
      if (item && r)
        void r.store
          .unmark(item.id)
          .catch(() =>
            ctx.notify({ key: 'review:remove', tone: 'error', text: "Couldn't remove it from review." }),
          )
    },
  },
]

function BarButton({ ctx }: { ctx: CanvasFeatureContext; selection: readonly string[] }) {
  const view = useValue('review.bar', () => {
    const r = reviewOf(ctx.canvas)
    if (!r) return null
    const item = selectedItem(ctx)
    if (item) return { r, item, mark: false as const }
    return mayMark(ctx) ? { r, item: null, mark: true as const } : null
  }, [ctx])
  if (!view) return null
  return (
    <span className="dr-review-barslot">
      <span className="dr-cux-selbar__sep" aria-hidden="true" />
      {view.mark ? (
        <button
          type="button"
          className="dr-cux-selbar__btn dr-review-barbtn"
          data-testid="selection-review-mark"
          title="Mark for review"
          onClick={() => void markSelection(view.r)}
        >
          Mark for review
        </button>
      ) : (
        view.item && (
          <button
            type="button"
            className="dr-cux-selbar__btn dr-review-barbtn"
            data-testid="selection-review-status"
            data-review-keep-popover=""
            aria-haspopup="dialog"
            onClick={() => view.item && view.r.store.popover.set({ itemId: view.item.id, from: 'badge' })}
          >
            <StatusPill item={view.item} />
          </button>
        )
      )}
    </span>
  )
}

export const SELECTION_BAR: readonly SelectionBarItemSpec[] = [
  {
    id: 'review',
    order: 55,
    visible: (ctx) => selectedItem(ctx) !== null || mayMark(ctx),
    component: BarButton,
  },
]

export const COMMANDS: readonly CommandSpec[] = [
  {
    id: 'review.open-panel',
    label: 'Review',
    group: 'Collaborate',
    keywords: ['review', 'approve', 'approval', 'client', 'status', 'round'],
    readOnlyAllowed: true,
    enabled: (ctx) => hasReview(ctx),
    run: (ctx) => ctx.openPanel(REVIEW_PANEL_ID),
  },
  {
    id: 'review.mark',
    label: 'Mark for review',
    group: 'Collaborate',
    keywords: ['review', 'approval', 'client'],
    enabled: (ctx) => mayMark(ctx),
    run: (ctx) => {
      const r = reviewOf(ctx.canvas)
      if (r) void markSelection(r)
    },
  },
]

/** The review viewer's header entry (WS2/WS3 open the viewer): the file's status and buttons while it is in review. */
function ViewerStatus({ ctx, request }: ViewerSlotProps) {
  const r = useValue('review.bridge', () => reviewOf(ctx.canvas), [ctx.canvas])
  const item = useValue('review.viewer-item', () => r?.store.itemOf(request.elementId) ?? null, [r, request])
  if (!r || !item) return null
  return (
    <div className="dr-review-viewer" data-testid="review-viewer-status">
      <StatusPill item={item} />
      <StatusForm r={r} item={item} compact />
      <History r={r} item={item} />
    </div>
  )
}

function mount(ctx: CanvasFeatureContext): () => void {
  const store = new ReviewStore(ctx.board.id)
  const stop = store.start(ctx.events)
  void store.refresh()
  const r: Review = { store, ctx }
  setReview(ctx.canvas, r)
  const offSlot = registerViewerSlot({ id: 'ws1.status', slot: 'header', order: 20, Component: ViewerStatus })
  const debug = window as unknown as { __lobbyReview?: Review }
  // e2e and debugging only, behind the same local-dev guard as the board page's debug handle
  if (DEV_AUTH_ENABLED) debug.__lobbyReview = r
  return () => {
    stop()
    offSlot()
    setReview(ctx.canvas, null)
    if (debug.__lobbyReview === r) debug.__lobbyReview = undefined
  }
}

/** The feature for this page's switches: everything with the status switch on, nothing with it off. */
export function reviewFeature(on: boolean): CanvasFeature {
  if (!on) return { id: 'review' }
  return {
    id: 'review',
    panels: PANELS,
    overlays: OVERLAYS,
    contextMenu: MENU,
    selectionBar: SELECTION_BAR,
    commands: COMMANDS,
    onMount: mount,
  }
}

export const feature: CanvasFeature = reviewFeature(reviewFlags().status)
