// OWNER: 3h. The ways into AI on the Excalidraw board page (the tldraw twin is ../menus.tsx), declared
// for 3a's shells to render (docs/EXCALIDRAW-CONTRACTS.md §3):
//  - "AI" in the selection bar (a SelectionBarItemSpec): opens the AI menu for the selection;
//  - "AI ›" in the canvas context menu (a submenu in the `ai` group): the four actions for the
//    selection, or, with nothing selected, for the frame under the pointer ("Generate ideas…" works
//    anywhere);
//  - the owners' AI switches in the board menu (`board` group of the main menu): "AI on this board"
//    for its owners, "AI on by default in this workspace" for workspace owners and admins.
// All stay hidden unless the api reports AI on for this person on this board (AiStatus), and read-only
// people only get "Summarize" (into a panel).
//
// Until 3a's selection-bar shell is on the page (the `selectionBar` host slot has no provider), a small
// stand-in bar over the selection carries the same button (./index.tsx `ai-entry`), so the AI flow is
// usable and testable on its own; it renders nothing once the shell is there.

import { memo, useRef, useSyncExternalStore } from 'react'
import {
  type CanvasFeatureContext,
  type LobbyCanvas,
  type MenuEntrySpec,
  type MenuTarget,
  type SelectionBarItemSpec,
  useCanvasFeatureContext,
} from '../../../canvas/api/index.ts'
import { useValue } from '../../../lib/signals.ts'
import { SparkIcon, Spinner } from '../icons.tsx'
import { openAiMenu, runAi, setBoardAi, setWorkspaceAiDefault } from './actions.ts'
import { type AiMenuState, aiJob, aiMenu, aiStatus, getAiCtx, setAiCtx } from './runtime.ts'
import { type AiTarget, selectionTarget, targetAt } from './target.ts'

/** A scene point as the popover's anchor (px from the canvas container's top-left). */
function anchorAtPoint(canvas: LobbyCanvas, scene: { x: number; y: number }): AiMenuState['at'] {
  const v = canvas.sceneToOverlay(scene)
  return { x: v.x, top: v.y, bottom: v.y }
}

function anchorAtElement(canvas: LobbyCanvas, el: HTMLElement): AiMenuState['at'] {
  const c = canvas.container()?.getBoundingClientRect() ?? { left: 0, top: 0 }
  const r = el.getBoundingClientRect()
  return { x: r.left + r.width / 2 - c.left, top: r.top - c.top, bottom: r.bottom - c.top }
}

const enabledOn = (canvas: LobbyCanvas) => aiStatus(canvas).get()?.enabled === true

/** The selection bar's "AI" button. */
export const AiBarButton = memo(function AiBarButton() {
  const ctx = useCanvasFeatureContext()
  const { canvas } = ctx
  const enabled = useValue('lobby-ai-enabled', () => enabledOn(canvas), [canvas])
  const busy = useValue('lobby-ai-busy', () => aiJob(canvas).get() !== null, [canvas])
  const open = useValue('lobby-ai-menu-open', () => aiMenu(canvas).get() !== null, [canvas])
  const ref = useRef<HTMLButtonElement>(null)
  if (!enabled) return null
  return (
    <span className="dr-ai-barslot">
      <span className="dr-cux-selbar__sep" aria-hidden="true" />
      <button
        ref={ref}
        type="button"
        className="dr-cux-selbar__btn dr-ai-barbtn"
        aria-label={busy ? 'AI is working' : 'AI'}
        title="AI: summarize, group into themes, action items, ideas"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-busy={busy}
        disabled={busy}
        data-testid="selection-ai"
        onClick={() => {
          if (open) {
            aiMenu(canvas).set(null)
            return
          }
          setAiCtx(ctx)
          const target = selectionTarget(canvas)
          if (target && ref.current) openAiMenu(canvas, anchorAtElement(canvas, ref.current), target)
        }}
      >
        {busy ? <Spinner /> : <SparkIcon />}
        <span className="dr-ai-barbtn__label">AI</span>
      </button>
    </span>
  )
})

export const SELECTION_BAR: readonly SelectionBarItemSpec[] = [
  {
    id: 'ai',
    order: 80,
    visible: (ctx) => enabledOn(ctx.canvas),
    component: () => <AiBarButton />,
  },
]

// ---- the context menu ----------------------------------------------------------------------------

/** The menu's target: the selection when it opened, else the frame under the pointer. */
const targetOf = (ctx: CanvasFeatureContext, t: MenuTarget): AiTarget => targetAt(ctx.canvas, t.point)
const insertOn = (ctx: CanvasFeatureContext) =>
  aiStatus(ctx.canvas).get()?.canInsert === true && !ctx.canvas.readOnly()
const at = (ctx: CanvasFeatureContext, t: MenuTarget): AiMenuState['at'] => {
  const v = ctx.canvas.viewport.get()
  return anchorAtPoint(ctx.canvas, t.point ?? { x: v.x + v.width / 2, y: v.y + v.height / 2 })
}
/** After the menu has closed (its focus handling first). */
const later = (fn: () => void) => void setTimeout(fn, 0)
const run = (ctx: CanvasFeatureContext, t: MenuTarget, action: 'summarize' | 'themes' | 'actions') => {
  setAiCtx(ctx)
  const target = targetOf(ctx, t)
  const where = at(ctx, t)
  later(() => void runAi(ctx.canvas, { action }, target, { at: where }))
}

export const CONTEXT_MENU: readonly MenuEntrySpec[] = [
  {
    id: 'ai',
    group: 'ai',
    order: 10,
    label: 'AI',
    visible: (ctx) => enabledOn(ctx.canvas),
    disabled: (ctx) => aiJob(ctx.canvas).get() !== null,
    submenu: [
      {
        id: 'ai.summarize',
        group: 'ai',
        order: 1,
        label: 'Summarize',
        disabled: (ctx, t) => targetOf(ctx, t).texts === 0,
        run: (ctx, t) => run(ctx, t, 'summarize'),
      },
      {
        id: 'ai.themes',
        group: 'ai',
        order: 2,
        label: 'Group into themes',
        visible: insertOn,
        disabled: (ctx, t) => targetOf(ctx, t).notes < 2,
        run: (ctx, t) => {
          const target = targetOf(ctx, t)
          if (!target.groups.length) {
            run(ctx, t, 'themes')
            return
          }
          setAiCtx(ctx)
          const where = at(ctx, t)
          later(() => openAiMenu(ctx.canvas, where, target, 'regroup'))
        },
      },
      {
        id: 'ai.actions',
        group: 'ai',
        order: 3,
        label: 'Action items',
        visible: insertOn,
        disabled: (ctx, t) => targetOf(ctx, t).texts === 0,
        run: (ctx, t) => run(ctx, t, 'actions'),
      },
      {
        id: 'ai.ideas',
        group: 'ai',
        order: 4,
        label: 'Generate ideas…',
        visible: insertOn,
        run: (ctx, t) => {
          setAiCtx(ctx)
          const target = targetOf(ctx, t)
          const where = at(ctx, t)
          later(() => openAiMenu(ctx.canvas, where, target, 'ideas'))
        },
      },
    ],
  },
]

// ---- the board menu --------------------------------------------------------------------------------

const settingsOf = (ctx: CanvasFeatureContext) => aiStatus(ctx.canvas).get()?.settings ?? null

/** Shown even while AI is off here (the owner turns it back on from here); nothing for anyone else. */
export const MAIN_MENU: readonly MenuEntrySpec[] = [
  {
    id: 'ai.board',
    group: 'board',
    order: 60,
    label: 'AI on this board',
    visible: (ctx) => settingsOf(ctx)?.canManageBoard === true,
    checked: (ctx) => settingsOf(ctx)?.on === true,
    run: (ctx) => {
      setAiCtx(ctx)
      void setBoardAi(ctx.canvas, !(settingsOf(ctx)?.on ?? false))
    },
  },
  {
    id: 'ai.workspace',
    group: 'board',
    order: 61,
    label: 'AI on by default in this workspace',
    visible: (ctx) => settingsOf(ctx)?.canManageWorkspace === true,
    checked: (ctx) => settingsOf(ctx)?.workspaceDefault === true,
    run: (ctx) => {
      setAiCtx(ctx)
      void setWorkspaceAiDefault(ctx.canvas, !(settingsOf(ctx)?.workspaceDefault ?? false))
    },
  },
]

// ---- the stand-in selection bar (until 3a's shell is on the page) --------------------------------------

/** Whether the page has a selection-bar shell (3a's host slot): the stand-in then steps aside. */
function useHasSelectionBar(ctx: CanvasFeatureContext): boolean {
  const r = ctx.registries
  return useSyncExternalStore(
    (l) => r.subscribe(l),
    () => r.hostSlots.get('selectionBar') !== null,
  )
}

export function AiEntryFallback({ ctx }: { ctx: CanvasFeatureContext }) {
  const { canvas } = ctx
  const shell = useHasSelectionBar(ctx)
  const where = useValue('lobby-ai-entry', () => {
    if (!enabledOn(canvas)) return null
    const sel = canvas.selection
    if (!sel.length || canvas.editingId() !== null) return null
    canvas.viewport.get()
    const b = canvas.boundsOf(sel)
    if (!b) return null
    const p = canvas.sceneToOverlay({ x: b.x + b.width / 2, y: b.y })
    return { x: Math.round(p.x), y: Math.round(p.y) }
  }, [canvas])
  if (shell || !where || !getAiCtx(canvas)) return null
  return (
    <div
      className="dr-cux-selbar"
      data-testid="ai-entry-fallback"
      style={{
        position: 'absolute',
        // the layer takes no clicks; this bar does
        pointerEvents: 'auto',
        left: where.x,
        top: Math.max(8, where.y - 52),
        transform: 'translateX(-50%)',
        display: 'flex',
        alignItems: 'center',
        padding: 4,
        borderRadius: 10,
        background: 'var(--dr-surface, #fff)',
        boxShadow: '0 2px 10px rgb(0 0 0 / 0.15)',
      }}
    >
      <AiBarButton />
    </div>
  )
}
