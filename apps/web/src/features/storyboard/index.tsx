// OWNER: WS2 (wave T; registered by the wave T foundation, docs/WAVE-T-CONTRACTS.md §1). The 'storyboard' feature on
// the Excalidraw board page (T1): storyboards on the canvas. A storyboard is a head (a free text with `sb:head`: its
// title, aspect, panels per row) and panels (frames with `sb:of`, `sb:pos`, `sb:dur`), each with a picture slot and
// three field boxes (camera, action, dialogue/VO) marked by `kind`. Shot numbers are derived from `sb:pos` and drawn
// as an overlay, never stored: every tab shows the same numbers, and a tab that receives a change writes nothing.
//
//  - create: New storyboard…, Script to boards… (the parser, ./script/parse.ts, and "Break down with AI", ./ai.ts),
//    Make storyboard from frames (selected frames, and the Shapes kits' storyboard panels);
//  - the strip (./Strip.tsx): order, durations, insert / duplicate / delete, drag or Alt+arrow reorder, Arrange,
//    Put panels in review (./review.ts);
//  - the chips and the "+" handles (./Chips.tsx), and the export layer `storyboard` (./export-layer.ts);
//  - every write is ./ops.ts, one undo step each.
// The switch is features/planning/flags.ts PLANNING_FLAGS.storyboard (off: the feature contributes nothing visible);
// every write needs a rev-14 room and an editor (planningOffered). The palette commands are held while the contracts
// list them pending (PENDING_PALETTE_COMMAND_IDS, through the lead): their menu entries work all the same.
import { PENDING_PALETTE_COMMAND_IDS } from '@draftroom/contracts'
import type {
  CanvasFeature,
  CanvasFeatureContext,
  CommandSpec,
  FeatureOverlaySpec,
  MenuEntrySpec,
  SelectionBarItemSpec,
} from '../../canvas/api/index.ts'
import { useValue } from '../../lib/signals.ts'
import { registerExportOverlay } from '../present-export/ported/badges.ts'
import { StoryboardChipsLayer } from './Chips.tsx'
import { StoryboardDialogLayer } from './Dialogs.tsx'
import { STORYBOARD_OVERLAY } from './export-layer.ts'
import { frameCandidates, storyboardFromFrames } from './ops.ts'
import { followSelection, StoryboardStripLayer } from './Strip.tsx'
import { offered, sbState, selectedStoryboard, shown } from './state.ts'
import './storyboard.css'

export const STORYBOARD_COMMAND_IDS = {
  new: 'storyboard.new',
  fromFrames: 'storyboard.from-frames',
  fromScript: 'storyboard.from-script',
} as const

const openNew = (ctx: CanvasFeatureContext) => sbState(ctx.canvas).dialog.set({ kind: 'new' })
const openScript = (ctx: CanvasFeatureContext) =>
  sbState(ctx.canvas).dialog.set({
    kind: 'script',
    draft: { text: '', format: null, aspect: '16:9', title: 'Storyboard', beats: null, ai: null },
  })

/** What Make storyboard from frames would take from the selection (null: nothing to take). */
function fromFramesTarget(ctx: CanvasFeatureContext, ids: readonly string[]) {
  if (!offered(ctx.canvas) || !ids.length) return null
  const c = frameCandidates(ctx.canvas, ids)
  return c.frames.length || c.kits.length ? c : null
}

function makeFromFrames(ctx: CanvasFeatureContext, ids: readonly string[]) {
  const c = fromFramesTarget(ctx, ids)
  if (!c) return
  const head = storyboardFromFrames(ctx.canvas, c)
  if (!head) {
    ctx.notify({ key: 'storyboard', tone: 'error', text: 'The storyboard could not be made. Try again.' })
    return
  }
  sbState(ctx.canvas).strip.set(head)
  const n = c.frames.length + c.kits.length
  ctx.notify({
    key: 'storyboard',
    text: `Made a storyboard of ${n} ${n === 1 ? 'panel' : 'panels'}.`,
    testId: 'sb-made',
  })
}

const ALL_COMMANDS: readonly CommandSpec[] = [
  {
    id: STORYBOARD_COMMAND_IDS.new,
    label: 'New storyboard…',
    group: 'Insert',
    keywords: ['storyboard', 'panels', 'shots', 'animatic', 'film', 'video', 'ad'],
    enabled: (ctx) => offered(ctx.canvas),
    run: (ctx) => openNew(ctx),
  },
  {
    id: STORYBOARD_COMMAND_IDS.fromScript,
    label: 'Script to boards…',
    group: 'Insert',
    keywords: ['storyboard', 'script', 'screenplay', 'fountain', 'av script', 'shot list', 'breakdown'],
    enabled: (ctx) => offered(ctx.canvas),
    run: (ctx) => openScript(ctx),
  },
  {
    id: STORYBOARD_COMMAND_IDS.fromFrames,
    label: 'Make storyboard from frames',
    group: 'Insert',
    keywords: ['storyboard', 'frames', 'panels', 'convert'],
    disabledReason: (ctx) =>
      fromFramesTarget(ctx, ctx.canvas.selection) ? null : 'Select the frames that are the panels',
    run: (ctx) => makeFromFrames(ctx, ctx.canvas.selection),
  },
]

const held = (id: string) => (PENDING_PALETTE_COMMAND_IDS as readonly string[]).includes(id)

/** The palette commands, without the ones the contracts still hold pending. */
export const COMMANDS: readonly CommandSpec[] = ALL_COMMANDS.filter((c) => !held(c.id))

export const CONTEXT_MENU: readonly MenuEntrySpec[] = [
  {
    id: 'storyboard.from-frames',
    group: 'frame',
    order: 40,
    label: 'Make storyboard from frames',
    visible: (ctx, t) => shown() && fromFramesTarget(ctx, t.ids) !== null,
    run: (ctx, t) => makeFromFrames(ctx, t.ids),
  },
  {
    id: 'storyboard.open-strip',
    group: 'frame',
    order: 41,
    label: 'Show the storyboard strip',
    visible: (ctx) => shown() && selectedStoryboard(ctx.canvas) !== null,
    run: (ctx) => {
      const sb = selectedStoryboard(ctx.canvas)
      if (sb) sbState(ctx.canvas).strip.set(sb.id)
    },
  },
  {
    id: 'storyboard.new',
    group: 'frame',
    order: 42,
    label: 'New storyboard…',
    visible: (ctx, t) => shown() && offered(ctx.canvas) && t.ids.length === 0,
    // after the menu has closed and handed the focus back, so the dialog keeps it
    run: (ctx) => void setTimeout(() => openNew(ctx), 0),
  },
  {
    id: 'storyboard.from-script',
    group: 'frame',
    order: 43,
    label: 'Script to boards…',
    visible: (ctx, t) => shown() && offered(ctx.canvas) && t.ids.length === 0,
    run: (ctx) => void setTimeout(() => openScript(ctx), 0),
  },
]

export const MAIN_MENU: readonly MenuEntrySpec[] = [
  {
    id: 'storyboard.main-new',
    group: 'board',
    order: 30,
    label: 'New storyboard…',
    visible: (ctx) => shown() && offered(ctx.canvas),
    run: (ctx) => void setTimeout(() => openNew(ctx), 0),
  },
  {
    id: 'storyboard.main-script',
    group: 'board',
    order: 31,
    label: 'Script to boards…',
    visible: (ctx) => shown() && offered(ctx.canvas),
    run: (ctx) => void setTimeout(() => openScript(ctx), 0),
  },
]

function FromFramesButton({ ctx, selection }: { ctx: CanvasFeatureContext; selection: readonly string[] }) {
  const ok = useValue('storyboard.bar', () => shown() && fromFramesTarget(ctx, selection) !== null, [
    ctx,
    selection,
  ])
  if (!ok) return null
  return (
    <span className="dr-sb-barslot">
      <span className="dr-cux-selbar__sep" aria-hidden="true" />
      <button
        type="button"
        className="dr-cux-selbar__btn"
        data-testid="selection-sb-from-frames"
        title="Make storyboard from frames"
        onClick={() => makeFromFrames(ctx, selection)}
      >
        Make storyboard
      </button>
    </span>
  )
}

export const SELECTION_BAR: readonly SelectionBarItemSpec[] = [
  {
    id: 'storyboard.from-frames',
    order: 58,
    visible: (ctx, sel) => shown() && fromFramesTarget(ctx, sel) !== null,
    component: FromFramesButton,
  },
]

export const OVERLAYS: readonly FeatureOverlaySpec[] = [
  // the chips take no clicks (their layer and the chips are pointer: none); the "+" handles do
  { id: 'storyboard.chips', layer: 'scene', order: 8, pointer: 'none', component: StoryboardChipsLayer },
  { id: 'storyboard.strip', layer: 'screen', order: 26, pointer: 'none', component: StoryboardStripLayer },
  { id: 'storyboard.dialog', layer: 'screen', order: 64, pointer: 'none', component: StoryboardDialogLayer },
]

export const feature: CanvasFeature = {
  id: 'storyboard',
  commands: COMMANDS,
  contextMenu: CONTEXT_MENU,
  mainMenu: MAIN_MENU,
  selectionBar: SELECTION_BAR,
  overlays: OVERLAYS,
  onMount: (ctx) => {
    const offLayer = registerExportOverlay(STORYBOARD_OVERLAY)
    const offFollow = followSelection(ctx.canvas)
    return () => {
      offFollow()
      offLayer()
      const s = sbState(ctx.canvas)
      s.dialog.set(null)
      s.strip.set(null)
    }
  },
}
