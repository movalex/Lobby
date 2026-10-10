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
  type CommandSpec,
  type LobbyCanvas,
  type MenuEntrySpec,
  type MenuTarget,
  type SelectionBarItemSpec,
  useCanvasFeatureContext,
} from '../../../canvas/api/index.ts'
import { useValue } from '../../../lib/signals.ts'
import { DIAGRAM_MENU } from '../diagram/DiagramPrompt.tsx'
import { SparkIcon, Spinner } from '../icons.tsx'
import { runRecap } from '../recap/recap.ts'
import {
  anchorAtScene,
  ensureAiStatus,
  expandTopic,
  openAiMenu,
  runAi,
  setBoardAi,
  setWorkspaceAiDefault,
} from './actions.ts'
import { askBoard, WHOLE_BOARD } from './ask.ts'
import { canBuildWithAi } from './gate.ts'
import { aiLens, toggleAiLens } from './lens.tsx'
import { aiItemStates, labelWithReason } from './menu-model.ts'
import { PROVENANCE_ITEM } from './provenance-chip.tsx'
import { AI_COMMAND_IDS, aiActionsArgs, aiAskArgs, aiRecapArgs } from './public.ts'
import { isThemesRun, recordedRunOf, removeResult } from './remove.ts'
import { type AiMenuState, aiJob, aiMenu, aiStatus, getAiCtx, setAiCtx } from './runtime.ts'
import { type AiTarget, boardTarget, NONE, selectionTarget, targetAt, viewTarget } from './target.ts'

/** A scene point as the popover's anchor (px from the canvas container's top-left). */
function anchorAtPoint(canvas: LobbyCanvas, scene: { x: number; y: number }): AiMenuState['at'] {
  const v = canvas.sceneToOverlay(scene)
  return { x: v.x, top: v.y, bottom: v.y }
}

function anchorAtElement(canvas: LobbyCanvas, el: HTMLElement): AiMenuState['at'] {
  const c = canvas.container()?.getBoundingClientRect() ?? { left: 0, top: 0 }
  const r = el.getBoundingClientRect()
  // wave K.1: the popover keeps clear of the whole selection bar the button is in (its More row included)
  const bar = el.closest('[data-testid="selection-bar"]')?.getBoundingClientRect() ?? r
  return {
    x: r.left + r.width / 2 - c.left,
    top: Math.min(r.top, bar.top) - c.top,
    bottom: Math.max(r.bottom, bar.bottom) - c.top,
  }
}

const enabledOn = (canvas: LobbyCanvas) => aiStatus(canvas).get()?.enabled === true
/** Ask this board (L2-2): AI on here and offered to this person to read with (view; never a name-only guest). */
const askOn = (ctx: CanvasFeatureContext) => aiStatus(ctx.canvas).get()?.canSummarize === true
/** Expand with AI and Mind map from a prompt: AI on, may add to the board, budget left (K7). */
const buildOn = (canvas: LobbyCanvas) => canBuildWithAi(aiStatus(canvas).get(), canvas.readOnly())
/** The one mind-map topic that is selected, if that is the selection. */
const topicOf = (canvas: LobbyCanvas): string | null => selectionTarget(canvas)?.topicId ?? null

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
    // The bar asks `visible` while it renders, not when the status arrives. The first status read waits for
    // an idle moment after the board opens (K7-4), so a selection made before the answer must still get the
    // button when it comes: until the status is known the item is in the bar (for people who can edit, whose
    // bar has other buttons) and draws nothing; once it is known, only a yes keeps it.
    visible: (ctx) => {
      const status = aiStatus(ctx.canvas).get()
      return status === null ? !ctx.canvas.readOnly() : status.enabled
    },
    component: () => <AiBarButton />,
  },
  // wave M (M4-2): the "AI-made" chip of a selection that holds something AI made
  PROVENANCE_ITEM,
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
/** M4-5: what the three reading actions can do for the menu's target, and why not (./menu-model.ts). */
const statesOf = (ctx: CanvasFeatureContext, t: MenuTarget) => {
  const target = targetOf(ctx, t)
  return aiItemStates(
    target,
    { texts: target.kind === 'none' ? boardTarget(ctx.canvas).texts : 0 },
    { insert: insertOn(ctx) },
  )
}

/** After the menu has closed (its focus handling first). */
const later = (fn: () => void) => void setTimeout(fn, 0)
const run = (ctx: CanvasFeatureContext, t: MenuTarget, action: 'summarize' | 'themes' | 'actions') => {
  setAiCtx(ctx)
  const target = targetOf(ctx, t)
  const where = at(ctx, t)
  later(() => void runAi(ctx.canvas, { action }, target, { at: where }))
}

/** The recorded AI run the context menu is about: the element under the pointer, else the one selected. */
function runAt(ctx: CanvasFeatureContext, t: MenuTarget): string | null {
  const id = t.hit?.id ?? (t.ids.length === 1 ? t.ids[0] : undefined)
  return id ? recordedRunOf(ctx.canvas, id) : null
}

export const CONTEXT_MENU: readonly MenuEntrySpec[] = [
  {
    id: 'ai.remove',
    group: 'ai',
    order: 20,
    label: (ctx, t) => {
      const run = runAt(ctx, t)
      return run && isThemesRun(ctx.canvas, run) ? 'Put the notes back (History)…' : 'Remove this AI result'
    },
    visible: (ctx, t) => !ctx.canvas.readOnly() && runAt(ctx, t) !== null,
    run: (ctx, t) => {
      const run = runAt(ctx, t)
      if (run) later(() => removeResult(ctx, run))
    },
  },
  {
    // K7-1: one click from a topic's context menu
    id: 'ai.expand',
    group: 'ai',
    order: 5,
    label: 'Expand with AI',
    command: 'ai.expand',
    visible: (ctx) => buildOn(ctx.canvas) && topicOf(ctx.canvas) !== null,
    disabled: (ctx) => aiJob(ctx.canvas).get() !== null || (selectionTarget(ctx.canvas)?.texts ?? 0) === 0,
  },
  {
    id: 'ai',
    group: 'ai',
    order: 10,
    label: 'AI',
    visible: (ctx) => enabledOn(ctx.canvas),
    disabled: (ctx) => aiJob(ctx.canvas).get() !== null,
    submenu: [
      {
        // M4-5: with nothing selected, the whole board (as Ask)
        id: 'ai.summarize',
        group: 'ai',
        order: 1,
        label: (ctx, t) => labelWithReason('Summarize', statesOf(ctx, t).summarize),
        disabled: (ctx, t) => statesOf(ctx, t).summarize.disabled,
        run: (ctx, t) => run(ctx, t, 'summarize'),
      },
      {
        // L2-3: the session's recap (the selected frames' when frames are selected)
        id: 'ai.recap',
        group: 'ai',
        order: 1.7,
        label: 'Wrap up this session',
        visible: askOn,
        run: (ctx) => {
          setAiCtx(ctx)
          const frames = ctx.canvas.selection.some((id) => ctx.canvas.get(id)?.type === 'frame')
          later(() => void runRecap(ctx, frames ? 'selection' : 'session'))
        },
      },
      {
        // L2-2: about the selection, the frame under the pointer, else the whole board (view is enough)
        id: 'ai.ask',
        group: 'ai',
        order: 1.5,
        label: 'Ask this board…',
        visible: askOn,
        run: (ctx, t) => {
          setAiCtx(ctx)
          const target = targetOf(ctx, t)
          const where = at(ctx, t)
          later(() => openAiMenu(ctx.canvas, where, target.kind === 'none' ? WHOLE_BOARD : target, 'ask'))
        },
      },
      {
        id: 'ai.themes',
        group: 'ai',
        order: 2,
        label: (ctx, t) => labelWithReason('Group into themes', statesOf(ctx, t).themes),
        visible: insertOn,
        disabled: (ctx, t) => statesOf(ctx, t).themes.disabled,
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
        label: (ctx, t) => labelWithReason('Action items', statesOf(ctx, t).actions),
        visible: insertOn,
        disabled: (ctx, t) => statesOf(ctx, t).actions.disabled,
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
      // M4-5 (FTU-11): Diagram from words sits with the other AI entries (its command stays in the palette)
      { ...DIAGRAM_MENU, order: 4.5 },
      {
        id: 'ai.mindmap',
        group: 'ai',
        order: 5,
        label: 'Mind map from a prompt…',
        visible: (ctx) => buildOn(ctx.canvas),
        run: (ctx, t) => {
          setAiCtx(ctx)
          const where = at(ctx, t)
          later(() => openAiMenu(ctx.canvas, where, NONE, 'mindmap'))
        },
      },
    ],
  },
]

// ---- the commands (K7) -------------------------------------------------------------------------------------
//
// By id, for other features' buttons (the empty board's "Ideas with AI") and the menus above. Each makes sure
// the status is known first (its first read waits for an idle moment, K7-4), then does nothing unless AI is
// on and may add to the board.

/** The middle of the view, where a popover with no selection points. */
const viewCentre = (ctx: CanvasFeatureContext): AiMenuState['at'] => {
  const v = ctx.canvas.viewport.get()
  return anchorAtScene(ctx.canvas, { x: v.x + v.width / 2, y: v.y + v.height / 2 })
}

export const COMMANDS: readonly CommandSpec[] = [
  {
    // L2-3 Wrap up / Catch me up: args AiRecapArgs ('session' by default; 'selection'; 'catch-up'). Everyone who
    // can see the board (the recap is private); the AI part only where AI is on for this person.
    id: AI_COMMAND_IDS.recap,
    label: 'Wrap up',
    group: 'AI',
    keywords: ['recap', 'summary', 'catch me up', 'minutes', 'decisions', 'actions'],
    readOnlyAllowed: true,
    run: (ctx, _source, args) => {
      setAiCtx(ctx)
      void runRecap(ctx, aiRecapArgs(args).scope ?? 'session')
    },
  },
  {
    // L2-2 Ask this board: args AiAskArgs (the palette's "Ask: <question>" asks at once); else the question box.
    // About the selection when there is one, else the whole board. View is enough (a viewer may ask).
    id: AI_COMMAND_IDS.ask,
    label: 'Ask this board',
    group: 'AI',
    keywords: ['ai', 'question', 'answer', 'search', 'find'],
    readOnlyAllowed: true,
    enabled: (ctx) => askOn(ctx) && aiJob(ctx.canvas).get() === null,
    run: async (ctx, _source, args) => {
      setAiCtx(ctx)
      await ensureAiStatus(ctx.canvas)
      if (!askOn(ctx) || aiJob(ctx.canvas).get()) return
      const target = selectionTarget(ctx.canvas) ?? WHOLE_BOARD
      const { question } = aiAskArgs(args)
      if (question) void askBoard(ctx, question, target)
      else openAiMenu(ctx.canvas, viewCentre(ctx), target, 'ask')
    },
  },
  {
    // Group into themes on the selection, else the frame in the middle of the view (the coach, the palette)
    id: AI_COMMAND_IDS.themes,
    label: 'Group into themes',
    group: 'AI',
    keywords: ['ai', 'cluster', 'affinity'],
    enabled: (ctx) => insertOn(ctx) && aiJob(ctx.canvas).get() === null,
    disabledReason: (ctx) =>
      insertOn(ctx) && viewTarget(ctx.canvas).notes < 2 ? 'Select two or more sticky notes' : null,
    run: async (ctx) => {
      setAiCtx(ctx)
      await ensureAiStatus(ctx.canvas)
      if (!insertOn(ctx) || aiJob(ctx.canvas).get()) return
      const target = viewTarget(ctx.canvas)
      if (target.notes < 2) return
      const where = viewCentre(ctx)
      if (target.groups.length) openAiMenu(ctx.canvas, where, target, 'regroup')
      else void runAi(ctx.canvas, { action: 'themes' }, target, { at: where })
    },
  },
  {
    // Action items on the selection (else the frame in view); args AiActionsArgs: ordered by a revealed vote
    id: AI_COMMAND_IDS.actions,
    label: 'Action items',
    group: 'AI',
    keywords: ['ai', 'next steps', 'todo', 'owners'],
    enabled: (ctx) => insertOn(ctx) && aiJob(ctx.canvas).get() === null,
    run: async (ctx, _source, args) => {
      setAiCtx(ctx)
      await ensureAiStatus(ctx.canvas)
      if (!insertOn(ctx) || aiJob(ctx.canvas).get()) return
      const target = viewTarget(ctx.canvas)
      if (target.texts === 0) return
      const { voteSessionId } = aiActionsArgs(args)
      void runAi(ctx.canvas, { action: 'actions', ...(voteSessionId ? { voteSessionId } : {}) }, target, {
        at: viewCentre(ctx),
      })
    },
  },
  {
    // L2-1d: the selected AI-made element's run
    id: 'ai.remove-result',
    label: 'Remove this AI result',
    group: 'AI',
    enabled: (ctx) =>
      !ctx.canvas.readOnly() &&
      ctx.canvas.selection.length === 1 &&
      recordedRunOf(ctx.canvas, ctx.canvas.selection[0] as string) !== null,
    run: (ctx) => {
      const id = ctx.canvas.selection[0]
      const run = id ? recordedRunOf(ctx.canvas, id) : null
      if (run) removeResult(ctx, run)
    },
  },
  {
    // L2-1c: the AI lens (this tab only)
    id: 'ai.lens',
    label: 'Show what AI made',
    group: 'View',
    readOnlyAllowed: true,
    run: (ctx) => toggleAiLens(ctx.canvas),
  },
  {
    id: 'ai.expand',
    label: 'Expand with AI',
    enabled: (ctx) => buildOn(ctx.canvas) && topicOf(ctx.canvas) !== null && aiJob(ctx.canvas).get() === null,
    run: async (ctx) => {
      setAiCtx(ctx)
      await ensureAiStatus(ctx.canvas)
      const topic = topicOf(ctx.canvas)
      if (topic) expandTopic(ctx.canvas, topic)
    },
  },
  {
    // "Ideas with AI": the prompt for sticky notes next to the selection, or in the middle of the view
    id: 'ai.ideas',
    label: 'Ideas with AI',
    enabled: (ctx) => insertOn(ctx) && aiJob(ctx.canvas).get() === null,
    run: async (ctx) => {
      setAiCtx(ctx)
      await ensureAiStatus(ctx.canvas)
      if (!insertOn(ctx) || aiJob(ctx.canvas).get()) return
      openAiMenu(ctx.canvas, viewCentre(ctx), viewTarget(ctx.canvas), 'ideas')
    },
  },
  {
    id: 'ai.mindmap',
    label: 'Mind map from a prompt',
    enabled: (ctx) => buildOn(ctx.canvas) && aiJob(ctx.canvas).get() === null,
    run: async (ctx) => {
      setAiCtx(ctx)
      await ensureAiStatus(ctx.canvas)
      if (!buildOn(ctx.canvas) || aiJob(ctx.canvas).get()) return
      openAiMenu(ctx.canvas, viewCentre(ctx), NONE, 'mindmap')
    },
  },
]

// ---- the board menu --------------------------------------------------------------------------------

const settingsOf = (ctx: CanvasFeatureContext) => aiStatus(ctx.canvas).get()?.settings ?? null

/** Shown even while AI is off here (the owner turns it back on from here); nothing for anyone else. */
export const MAIN_MENU: readonly MenuEntrySpec[] = [
  {
    // L2-3: what changed since this device's last visit (everyone; AI's part only where AI is on)
    id: 'ai.catch-up',
    group: 'board',
    order: 58,
    label: 'Catch me up',
    run: (ctx) => {
      setAiCtx(ctx)
      void runRecap(ctx, 'catch-up')
    },
  },
  {
    // L2-1c: everyone (what AI made is on the board for everyone); this tab only, never stored
    id: 'ai.lens',
    group: 'board',
    order: 59,
    label: 'Show what AI made',
    checked: (ctx) => aiLens(ctx.canvas).get(),
    run: (ctx) => toggleAiLens(ctx.canvas),
  },
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
