// K2-4 (wave K, UXD-03, F7): a blank board is no longer a flat sheet. While the board has nothing on it, a
// short "start here" card sits in the middle of the view and a subtle dot grid lies under it, both gone with
// the first element (and back if the board is emptied). The features register them as overlays that take no
// pointer events: a double-click anywhere, the card's words included, still reaches the board (a note there);
// only the card's buttons take clicks. People who can edit get the ways to start (templates, a mind map,
// "Ideas with AI" when AI is on for them here); viewers and commenters get one read-only line. Hidden while
// presenting, as every overlay is that does not ask to stay.
//
// The grid is CSS (canvas-ux.css `.cux-empty-grid`): a dot pattern whose step and offset follow the camera,
// so it pans and zooms with the board. It is drawn only on the empty board: the engine paints an opaque
// canvas, so a grid under existing elements would need the engine's background changed (Board ▸ View ▸ Show
// grid is the engine's own grid for that).
import { useEffect, useState } from 'react'
import type { CanvasFeatureContext, MenuEntrySpec, MenuTarget } from '../../../canvas/api/index.ts'
import { useValue } from '../../../lib/signals.ts'
import { TEMPLATE_PARAM } from '../start-view.ts'
import { runCommand } from './commands.ts'
import { TEMPLATES_PANEL } from './Toolbar.tsx'

/** Scene px between two dots at 100 %. */
export const GRID_STEP = 24
/** The dots never get closer than this on screen (zoomed out, the step doubles). */
export const GRID_MIN_SCREEN = 14

/** The dot grid's screen step and offset for a camera (pure). */
export function gridLayout(v: { readonly x: number; readonly y: number; readonly zoom: number }): {
  size: number
  offsetX: number
  offsetY: number
} {
  const zoom = v.zoom > 0 && Number.isFinite(v.zoom) ? v.zoom : 1
  let step = GRID_STEP
  while (step * zoom < GRID_MIN_SCREEN) step *= 2
  const size = step * zoom
  const mod = (n: number) => ((n % size) + size) % size
  return { size, offsetX: mod(-v.x * zoom), offsetY: mod(-v.y * zoom) }
}

/** The command K7 registers for "Ideas with AI" (else the AI context menu's own entry of the same id). */
export const AI_IDEAS_ID = 'ai.ideas'
/** The mind-map feature's command that starts a map in the middle of the view. */
export const MINDMAP_START_ID = 'mindmap.start'

export interface HintAction {
  readonly id: 'templates' | 'mindmap' | 'ai'
  readonly label: string
  readonly testId: string
  run(): void
}

/** The AI menu's entry of `id`, in any submenu (the "AI ›" context menu). */
function findMenuEntry(entries: readonly MenuEntrySpec[], id: string): MenuEntrySpec | null {
  for (const e of entries) {
    if (e.id === id) return e
    const sub = e.submenu ? findMenuEntry(e.submenu, id) : null
    if (sub) return sub
  }
  return null
}

/** Where a hint action that asks for a place acts: the middle of the view, nothing selected. */
function centreTarget(ctx: CanvasFeatureContext): MenuTarget {
  const v = ctx.canvas.viewport.get()
  return { ids: [], point: { x: v.x + v.width / 2, y: v.y + v.height / 2 }, hit: null }
}

/**
 * The card's buttons for people who can edit, from what the board has: the templates panel, the mind map's
 * start command, and AI ideas when AI is on for this person here (the command's own `enabled`, or the AI menu
 * entry's `visible`, both read the AI status). Each is dispatched by its existing id.
 */
export function hintActions(ctx: CanvasFeatureContext): HintAction[] {
  const r = ctx.registries
  const out: HintAction[] = []
  if (r.panels.get(TEMPLATES_PANEL))
    out.push({
      id: 'templates',
      label: 'Browse templates',
      testId: 'empty-hint-templates',
      run: () => ctx.openPanel(TEMPLATES_PANEL),
    })
  const mindmap = r.commands.get(MINDMAP_START_ID)
  if (mindmap && (!mindmap.enabled || mindmap.enabled(ctx)))
    out.push({
      id: 'mindmap',
      label: 'Start a mind map',
      testId: 'empty-hint-mindmap',
      run: () => void runCommand(ctx, MINDMAP_START_ID, 'menu'),
    })
  const aiCommand = r.commands.get(AI_IDEAS_ID)
  if (aiCommand) {
    if (!aiCommand.enabled || aiCommand.enabled(ctx))
      out.push({
        id: 'ai',
        label: 'Ideas with AI',
        testId: 'empty-hint-ai',
        run: () => void runCommand(ctx, AI_IDEAS_ID, 'menu'),
      })
  } else {
    const entry = findMenuEntry(r.contextMenu.list(), AI_IDEAS_ID)
    const target = centreTarget(ctx)
    if (entry?.run && (!entry.visible || entry.visible(ctx, target)))
      out.push({
        id: 'ai',
        label: 'Ideas with AI',
        testId: 'empty-hint-ai',
        run: () => entry.run?.(ctx, centreTarget(ctx)),
      })
  }
  return out
}

/** The primary pointer is coarse (a phone or a tablet): the card says tap instead of click. */
function useCoarsePointer(): boolean {
  const [coarse, setCoarse] = useState(false)
  useEffect(() => {
    try {
      const mq = window.matchMedia?.('(pointer: coarse)')
      if (!mq) return
      setCoarse(mq.matches)
      const on = () => setCoarse(mq.matches)
      mq.addEventListener?.('change', on)
      return () => mq.removeEventListener?.('change', on)
    } catch {
      // no matchMedia: a fine pointer
    }
  }, [])
  return coarse
}

/**
 * A board opened from the dashboard with a template (`?template=`) is empty only until the first view inserts it
 * (navigation/start-view.ts): no card or grid flashes up meanwhile.
 */
function templatePending(): boolean {
  try {
    return new URLSearchParams(globalThis.location?.search ?? '').has(TEMPLATE_PARAM)
  } catch {
    return false
  }
}

const useEmpty = (ctx: CanvasFeatureContext) =>
  useValue('cux-empty-board', () => ctx.canvas.items().length === 0 && !templatePending(), [ctx.canvas])

/** The scene layer's dot grid, under every other layer, while the board is empty. */
export function EmptyBoardGrid({ ctx }: { ctx: CanvasFeatureContext }) {
  const empty = useEmpty(ctx)
  const v = useValue('cux-empty-grid-view', () => (empty ? ctx.canvas.viewport.get() : null), [
    ctx.canvas,
    empty,
  ])
  if (!empty || !v) return null
  const g = gridLayout(v)
  return (
    <div
      className="cux-empty-grid"
      data-testid="empty-board-grid"
      aria-hidden="true"
      style={{
        backgroundSize: `${g.size}px ${g.size}px`,
        backgroundPosition: `${g.offsetX}px ${g.offsetY}px`,
      }}
    />
  )
}

/** The screen layer's card in the middle of the view, while the board is empty. */
export function EmptyBoardHint({ ctx }: { ctx: CanvasFeatureContext }) {
  const empty = useEmpty(ctx)
  const readOnly = useValue('cux-empty-hint-readonly', () => ctx.canvas.readOnly(), [ctx.canvas])
  // re-read when what the actions depend on changes (the AI status, the registered panels and commands)
  const actions = useValue('cux-empty-hint-actions', () => (empty && !readOnly ? hintActions(ctx) : []), [
    ctx,
    empty,
    readOnly,
  ])
  const coarse = useCoarsePointer()
  if (!empty) return null
  if (readOnly)
    return (
      <div className="cux-empty-hint" data-testid="empty-board-hint" data-readonly="true">
        <p className="cux-empty-hint__line">Nothing on this board yet.</p>
      </div>
    )
  return (
    <div className="cux-empty-hint" data-testid="empty-board-hint">
      <p className="cux-empty-hint__title">Start your board</p>
      <p className="cux-empty-hint__line">
        {coarse ? 'Double-tap to add a sticky note' : 'Double-click to add a sticky note'}
        {coarse ? '' : ' · N note · T text · L connector'}
      </p>
      {actions.length > 0 && (
        <div className="cux-empty-hint__actions">
          {actions.map((a) => (
            <button
              key={a.id}
              type="button"
              className="dr-btn dr-btn--sm cux-empty-hint__btn"
              data-testid={a.testId}
              onClick={() => a.run()}
            >
              {a.label}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
