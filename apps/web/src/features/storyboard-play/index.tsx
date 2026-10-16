// OWNER: WS3 (wave T; registered empty by the wave T foundation, docs/WAVE-T-CONTRACTS.md §1). The 'storyboard-play'
// feature on the Excalidraw board page: the animatic player and Present storyboard (switch `animatic`), and the
// storyboard exports (switch `storyboardExports`): the Export dialog's "Storyboard sheet (PDF)" and "Image sequence"
// sections (present-export/storyboard-sheet, present-export/sequence). The export layer that draws the shot numbers
// into every export is WS2's (features/storyboard/export-layer.ts, the contracts' owner of the 'storyboard' layer).
//
// Both only READ what a board holds (planningShown: the switch alone; no planning write anywhere here), so viewers
// and commenters play and present storyboards too; the exports follow the board's export policy (the dialog opens
// only when it lets this person export).
//
// With both switches off the feature is exactly the foundation's `{ id }`: no command, overlay, menu entry or export
// section, so the board page is unchanged. A switch is read once, when the page loads (a dev-auth page may set it in
// localStorage first: features/planning/flags.ts). The palette ids `storyboard.play` and `storyboard.present` are
// static commands once `animatic` ships on (the lead then removes them from PENDING_PALETTE_COMMAND_IDS).
import type {
  CanvasFeature,
  CanvasFeatureContext,
  CommandSpec,
  MenuEntrySpec,
  SelectionBarItemSpec,
} from '../../canvas/api/index.ts'
import { planningShown } from '../planning/flags.ts'
import { registerExportSection } from '../present-export/ported/export-sections.ts'
import { STORYBOARD_SEQUENCE_SECTION } from '../present-export/sequence/Section.tsx'
import { STORYBOARD_SHEET_SECTION } from '../present-export/storyboard-sheet/Section.tsx'
import { storyboardOfIds, storyboardViews } from './model.ts'
import { AnimaticOverlay } from './Player.tsx'
import { presentStoryboard } from './present.ts'
import { isPlayerOpen, openPlayer } from './state.ts'
import './player.css'

/** The storyboard a command acts on: the selection's, else the board's only one. */
export function targetStoryboard(ctx: Pick<CanvasFeatureContext, 'canvas'>): string | null {
  const { canvas } = ctx
  const fromSelection = storyboardOfIds(canvas, canvas.selection)
  if (fromSelection) return fromSelection
  const all = storyboardViews(canvas)
  return all.length === 1 ? (all[0]?.id ?? null) : null
}

const NO_TARGET = 'Select a panel of a storyboard'

const notifyNoTarget = (ctx: CanvasFeatureContext) =>
  ctx.notify({
    key: 'storyboard-play',
    text: 'Select a panel of the storyboard to play, then try again.',
    testId: 'animatic-no-target',
    timeoutMs: 5000,
  })

export function playAnimatic(ctx: CanvasFeatureContext): void {
  const id = targetStoryboard(ctx)
  if (!id) notifyNoTarget(ctx)
  else if (!isPlayerOpen(ctx.canvas)) openPlayer(ctx.canvas, id)
}

export function presentSelectedStoryboard(ctx: CanvasFeatureContext): void {
  const id = targetStoryboard(ctx)
  if (!id) notifyNoTarget(ctx)
  else presentStoryboard(ctx.canvas, id)
}

const COMMANDS: readonly CommandSpec[] = [
  {
    id: 'storyboard.play',
    label: 'Play animatic',
    group: 'Storyboard',
    keywords: ['animatic', 'storyboard', 'play', 'timing'],
    readOnlyAllowed: true,
    disabledReason: (ctx) => (targetStoryboard(ctx) ? null : NO_TARGET),
    run: (ctx) => playAnimatic(ctx),
  },
  {
    id: 'storyboard.present',
    label: 'Present storyboard',
    group: 'Storyboard',
    keywords: ['storyboard', 'present', 'slides', 'panels'],
    readOnlyAllowed: true,
    disabledReason: (ctx) => (targetStoryboard(ctx) ? null : NO_TARGET),
    run: (ctx) => presentSelectedStoryboard(ctx),
  },
]

const inStoryboard = (ctx: CanvasFeatureContext, ids: readonly string[]) =>
  storyboardOfIds(ctx.canvas, ids) !== null

const CONTEXT_MENU: readonly MenuEntrySpec[] = [
  {
    id: 'storyboard-play.play',
    group: 'view',
    order: 30,
    label: 'Play animatic',
    command: 'storyboard.play',
    visible: (ctx, target) => inStoryboard(ctx, target.ids),
  },
  {
    id: 'storyboard-play.present',
    group: 'view',
    order: 31,
    label: 'Present storyboard',
    command: 'storyboard.present',
    visible: (ctx, target) => inStoryboard(ctx, target.ids),
  },
]

const PLAY_BUTTON: SelectionBarItemSpec = {
  id: 'storyboard-play.play',
  order: 78,
  visible: (ctx, selection) => inStoryboard(ctx, selection),
  component: ({ ctx }) => (
    <button
      type="button"
      className="dr-btn dr-btn--sm dr-btn--ghost"
      data-testid="animatic-open"
      title="Play the storyboard's panels in order with their durations"
      onClick={() => playAnimatic(ctx)}
    >
      Play animatic
    </button>
  ),
}

const ANIMATIC = planningShown('animatic')
const EXPORTS = planningShown('storyboardExports')

// the two Export sections, once per page (the shot numbers' layer is WS2's: features/storyboard/export-layer.ts)
if (EXPORTS) {
  registerExportSection(STORYBOARD_SHEET_SECTION)
  registerExportSection(STORYBOARD_SEQUENCE_SECTION)
}

export const feature: CanvasFeature = ANIMATIC
  ? {
      id: 'storyboard-play',
      commands: COMMANDS,
      contextMenu: CONTEXT_MENU,
      selectionBar: [PLAY_BUTTON],
      overlays: [
        {
          id: 'storyboard-play.player',
          layer: 'screen',
          order: 1001,
          pointer: 'auto',
          focusMode: 'show',
          component: AnimaticOverlay,
        },
      ],
    }
  : { id: 'storyboard-play' }
