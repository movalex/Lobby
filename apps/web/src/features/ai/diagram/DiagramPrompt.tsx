// OWNER: W4 (wave L, L4-2). Diagram from words: "Diagram from words…" in the context menu's AI group and the
// command 'flow.diagram' (the palette finds it) open this prompt: a description field, the selection's text
// (the selected notes and texts, which the api reads itself), and which way the diagram reads (down or right).
// It calls runAi('diagram') through W2's public.ts and builds the answer as native boxes, diamonds and ovals
// joined by bound elbow connectors (./apply.ts), every element carrying its provenance (the person and the run).
// Every result is shown first (showAiPreview; wave M, M4-2: whatever its size), "Try again" asks again, and once
// it is written a toast says AI made it, with the one-step Undo.
//
// The entry and the command are offered only when the AI tools that build on the board are (the AI feature's own
// rule, ../ported/gate.ts canBuildWithAi over its AiStatus, as the mind map's "Mind map from a prompt" reads it):
// AI on for this person on this board, allowed to add to it, the day's budget not spent, and an editor. So
// read-only roles, name-only guests and a board or workspace with AI off get no entry. The api still enforces
// all of it (runAi resolves null, having told the person why).
// Placement: findSpot (public.ts): inside the home frame of the selection, or beside it, or in the view.
import { toShapeRef } from '@draftroom/canvas-schema/refs'
import type { AiRunInput } from '@draftroom/contracts'
import { AI_DIAGRAM_PROMPT_MAX_CHARS } from '@draftroom/contracts'
import { useEffect, useId, useRef, useState } from 'react'
import {
  type CanvasFeatureContext,
  type CommandSpec,
  items,
  type LobbyCanvas,
  type MenuEntrySpec,
} from '../../../canvas/api/index.ts'
import { type Atom, atom, useValue } from '../../../lib/signals.ts'
import { freshId } from '../../flow/runtime.ts'
import { topCentreAnchor } from '../board-chrome.ts'
import { inPopoverLayer, useBoardPlacement, usePopoverLayer } from '../board-popover.tsx'
import '../ai.css'
import '../ported/wave-m.css'
import { SparkIcon } from '../icons.tsx'
import { canBuildWithAi } from '../ported/gate.ts'
import { type AiPreviewPlan, aiResultToast, findSpot, runAi, showAiPreview } from '../ported/public.ts'
import { aiStatus } from '../ported/runtime.ts'
import { revealResult } from '../reveal.ts'
import { applyDiagram, type DiagramPlan, measureDiagram, planDiagram } from './apply.ts'
import { type DiagramDirection, graphFromAi } from './graph.ts'

export const DIAGRAM_COMMAND_ID = 'flow.diagram'

/** The toast after an AI diagram is written (M4-2): "Made by AI: 4 shapes and 3 connectors." */
export function madeByAiText(plan: Pick<DiagramPlan, 'shapeIds' | 'arrowIds'>): string {
  const s = plan.shapeIds.length
  const l = plan.arrowIds.length
  return `Made by AI: ${s} ${s === 1 ? 'shape' : 'shapes'} and ${l} ${l === 1 ? 'connector' : 'connectors'}.`
}

interface PromptState {
  readonly id: number
}
const prompts = new WeakMap<object, Atom<PromptState | null>>()
/** The open Diagram from words prompt of this board, or null. */
export function diagramPrompt(canvas: object): Atom<PromptState | null> {
  let a = prompts.get(canvas)
  if (!a) {
    a = atom<PromptState | null>('flow.diagram-prompt', null)
    prompts.set(canvas, a)
  }
  return a
}
let seq = 0
export const openDiagramPrompt = (canvas: object) => diagramPrompt(canvas).set({ id: ++seq })

/** The selected elements whose words the diagram may be made from: notes, texts and labelled shapes. */
export function wordyIds(canvas: Pick<LobbyCanvas, 'get' | 'selection'>): string[] {
  const get = (id: string) => canvas.get(id)
  const out = new Set<string>()
  for (const id of canvas.selection) {
    const raw = get(id)
    if (!raw || raw.isDeleted) continue
    const el = items.containerOf(raw, get)
    if (el.type === 'stickynote' || el.type === 'text' || items.textOf(el, get).trim()) out.add(el.id)
  }
  return [...out]
}

/** What the preview draws: each node's box and each connector's bounds. */
export function previewOf(plan: DiagramPlan, runId: string): AiPreviewPlan {
  const creates: { x: number; y: number; w: number; h: number; kind: string; label?: string }[] = []
  // M4-1: each node's outline says its label (the words the person judges)
  const words = new Map<string, string>()
  for (const c of plan.creates) {
    const p = c.props as { containerId?: string | null; originalText?: string }
    if (c.kind === 'text' && p.containerId && p.originalText) words.set(p.containerId, p.originalText)
  }
  for (const c of plan.creates) {
    const p = c.props as { x: number; y: number; width: number; height: number; points?: [number, number][] }
    if (c.kind === 'text') continue
    if (c.kind === 'arrow') {
      const xs = (p.points ?? [[0, 0]]).map((q) => p.x + q[0])
      const ys = (p.points ?? [[0, 0]]).map((q) => p.y + q[1])
      const x = Math.min(...xs)
      const y = Math.min(...ys)
      creates.push({ x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y, kind: 'arrow' })
    } else {
      const label = words.get(String((c.props as { id?: unknown }).id ?? ''))
      creates.push({
        x: p.x,
        y: p.y,
        w: p.width,
        h: p.height,
        kind: 'diagram-node',
        ...(label ? { label } : {}),
      })
    }
  }
  const shapes = plan.shapeIds.length
  const links = plan.arrowIds.length
  return {
    runId,
    title: 'Diagram from words',
    summary: `Adds ${shapes} ${shapes === 1 ? 'shape' : 'shapes'} and ${links} ${links === 1 ? 'connector' : 'connectors'}`,
    moves: [],
    recolors: [],
    creates,
  }
}

/**
 * Asks the api for a diagram and builds it (see the header). Resolves the ids it made, or null when nothing was
 * made (AI said no, the person discarded the preview, the answer had no diagram).
 */
export async function runDiagram(
  ctx: CanvasFeatureContext,
  ask: {
    readonly prompt: string
    readonly shapeIds: readonly string[]
    readonly direction: DiagramDirection
  },
): Promise<string[] | null> {
  const { canvas } = ctx
  const prompt = ask.prompt.trim().slice(0, AI_DIAGRAM_PROMPT_MAX_CHARS)
  const refs = ask.shapeIds.map((id) => toShapeRef(id))
  if (!prompt && !refs.length) return null
  const input = {
    action: 'diagram',
    shapeIds: refs,
    ...(prompt ? { prompt } : {}),
    direction: ask.direction,
  } as AiRunInput
  for (let tries = 0; tries < 5; tries++) {
    const result = await runAi(ctx, input)
    if (result?.action !== 'diagram') return null
    const graph = graphFromAi(result)
    if (!graph) {
      ctx.notify({
        key: 'flow-diagram',
        text: 'That answer had no diagram in it. Try naming the steps.',
        testId: 'diagram-notice',
      })
      return null
    }
    if (canvas.readOnly()) return null
    const measured = measureDiagram(graph, (t, s) => canvas.text.measure(t, s))
    const spot = findSpot(ctx, {
      size: { w: measured.layout.width, h: measured.layout.height },
      near: ask.shapeIds,
    })
    const runId = (result as { runId?: string }).runId ?? null
    const plan = planDiagram(measured, {
      origin: { x: spot.x, y: spot.y },
      frameId: spot.frameId,
      provenance: { by: ctx.me.user.id, run: runId },
      newId: freshId,
    })
    // M4-2: every AI diagram is shown first, whatever its size (nothing an AI drew lands unseen)
    const choice = await showAiPreview(ctx, previewOf(plan, runId ?? `diagram-${seq}`))
    if (choice === 'retry') continue
    if (choice !== 'apply' || canvas.readOnly()) return null
    const ids = applyDiagram(canvas, plan, 'ai: diagram')
    // M4-4 (FTU-8): shown whole, clear of the board's chrome (this tab's camera only)
    void revealResult(canvas, ids)
    // and once it is there, it says who made it, with the one-step Undo
    aiResultToast(ctx, madeByAiText(plan), ids)
    return ids
  }
  return null
}

export const DIAGRAM_COMMAND: CommandSpec = {
  id: DIAGRAM_COMMAND_ID,
  label: 'Diagram from words…',
  keywords: ['flowchart', 'flow chart', 'process', 'diagram', 'ai'],
  group: 'AI',
  enabled: (ctx) => diagramOffered(ctx.canvas),
  run: (ctx) => openDiagramPrompt(ctx.canvas),
}

export const DIAGRAM_MENU: MenuEntrySpec = {
  id: 'flow.diagram',
  group: 'ai',
  order: 12,
  label: 'Diagram from words…',
  command: DIAGRAM_COMMAND_ID,
  visible: (ctx) => diagramOffered(ctx.canvas),
}

/** Whether Diagram from words is offered here (see the header): the AI tools that build on the board are. */
export function diagramOffered(canvas: LobbyCanvas): boolean {
  return canBuildWithAi(aiStatus(canvas).get(), canvas.readOnly())
}

/** The prompt (a screen-layer overlay; its own elements take clicks and keys). */
export function DiagramPrompt({ ctx }: { ctx: CanvasFeatureContext }) {
  const { canvas } = ctx
  const open = useValue('flow-diagram-open', () => diagramPrompt(canvas).get(), [canvas])
  if (!open || canvas.readOnly()) return null
  return <DiagramDialog key={open.id} ctx={ctx} />
}

function DiagramDialog({ ctx }: { ctx: CanvasFeatureContext }) {
  const { canvas } = ctx
  const [text, setText] = useState('')
  const [direction, setDirection] = useState<DiagramDirection>('down')
  const fromSelection = useRef(wordyIds(canvas))
  const [useSelection, setUseSelection] = useState(fromSelection.current.length > 0)
  const ref = useRef<HTMLDivElement>(null)
  const titleId = useId()
  const textId = useId()
  const close = () => {
    diagramPrompt(canvas).set(null)
    canvas.focus({ preventScroll: true })
  }
  // keys, pointers and the wheel inside the prompt stay out of the canvas (keys arrive natively)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const stop = (e: Event) => e.stopPropagation()
    const key = (e: KeyboardEvent) => {
      e.stopPropagation()
      if (e.key === 'Escape') {
        e.preventDefault()
        close()
      }
    }
    el.addEventListener('keydown', key)
    el.addEventListener('keyup', stop)
    el.addEventListener('pointerdown', stop)
    el.addEventListener('mousedown', stop)
    el.addEventListener('wheel', stop, { passive: true })
    return () => {
      el.removeEventListener('keydown', key)
      el.removeEventListener('keyup', stop)
      el.removeEventListener('pointerdown', stop)
      el.removeEventListener('mousedown', stop)
      el.removeEventListener('wheel', stop)
    }
  })
  // M4-3: at the top of the view, clear of the board's chrome, in the popover layer above it
  const host = usePopoverLayer(canvas)
  const pos = useBoardPlacement(canvas, ref, () => topCentreAnchor(canvas), { prefer: 'below' })
  const ids = useSelection ? fromSelection.current : []
  const canSend = text.trim().length > 0 || ids.length > 0
  // the prompt closes as the request goes (runAi shows the wait and tells the person when it cannot run)
  const submit = () => {
    if (!canSend) return
    close()
    void runDiagram(ctx, { prompt: text, shapeIds: ids, direction })
  }
  const sendsSelection = ids.length > 0
  return inPopoverLayer(
    canvas,
    host,
    // M4-5 (FTU-11): the AI popover's own shell: the sparkle header with its ×, a segmented control for the direction
    <div
      ref={ref}
      className="dr-ai-pop dr-ai-diagram"
      role="dialog"
      aria-modal="false"
      aria-labelledby={titleId}
      data-testid="diagram-prompt"
      style={
        pos
          ? { left: pos.left, top: pos.top, maxHeight: pos.maxHeight }
          : { left: 0, top: 0, opacity: 0, pointerEvents: 'none' }
      }
    >
      <div className="dr-ai-pop__head">
        <span className="dr-ai-pop__badge" aria-hidden="true">
          <SparkIcon size={14} />
        </span>
        <h2 id={titleId} className="dr-ai-pop__title">
          Diagram from words
        </h2>
        <button
          type="button"
          className="dr-iconbtn dr-iconbtn--sm"
          aria-label="Close"
          data-testid="diagram-prompt-close"
          onClick={close}
        >
          ×
        </button>
      </div>
      <form
        className="dr-ai-form"
        onSubmit={(e) => {
          e.preventDefault()
          submit()
        }}
      >
        <label htmlFor={textId} className="dr-ai-form__label">
          Describe the process
        </label>
        <textarea
          id={textId}
          className="dr-ai-form__input dr-ai-diagram__text"
          data-testid="diagram-prompt-text"
          // biome-ignore lint/a11y/noAutofocus: the prompt opens to be typed in
          autoFocus
          rows={4}
          maxLength={AI_DIAGRAM_PROMPT_MAX_CHARS}
          value={text}
          placeholder="Brief, concept, internal review, client review; if rejected back to concept, else production"
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
              e.preventDefault()
              submit()
            }
          }}
        />
        {fromSelection.current.length > 0 && (
          <label className="dr-ai-form__radio">
            <input
              type="checkbox"
              data-testid="diagram-prompt-selection"
              checked={useSelection}
              onChange={(e) => setUseSelection(e.target.checked)}
            />
            {`Use the ${fromSelection.current.length} selected ${fromSelection.current.length === 1 ? 'item' : 'items'}`}
          </label>
        )}
        <fieldset className="dr-ai-seg" data-testid="diagram-prompt-direction">
          <legend className="dr-ai-form__label">Reads</legend>
          {(['down', 'right'] as const).map((d) => (
            <label key={d} className="dr-ai-seg__opt" data-checked={direction === d ? '' : undefined}>
              <input
                type="radio"
                name={`${titleId}-dir`}
                value={d}
                data-testid={`diagram-prompt-${d}`}
                checked={direction === d}
                onChange={() => setDirection(d)}
              />
              <span>{d === 'down' ? 'Top to bottom' : 'Left to right'}</span>
            </label>
          ))}
        </fieldset>
        <div className="dr-ai-form__row">
          <span className="dr-ai-form__spacer" />
          <button
            type="button"
            className="dr-btn dr-btn--sm"
            data-testid="diagram-prompt-cancel"
            onClick={close}
          >
            Cancel
          </button>
          <button
            type="submit"
            className="dr-btn dr-btn--primary dr-btn--sm"
            data-testid="diagram-prompt-create"
            disabled={!canSend}
          >
            Create diagram
          </button>
        </div>
      </form>
      <p className="dr-ai-pop__foot" data-testid="diagram-prompt-note">
        {/* the selected text is named only when it is what goes along (M4-5) */}
        {sendsSelection
          ? 'Sends the description and the selected text to OpenAI.'
          : 'Sends the description to OpenAI.'}
      </p>
    </div>,
  )
}
