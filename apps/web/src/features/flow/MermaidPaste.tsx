// OWNER: W4 (wave L, L4-3). Paste Mermaid flowchart text as a native diagram, with no AI: a `text` content
// handler asked before bulk paste (priority 60 over its 50, so before K7-2's outline paste too) that takes the
// paste only when the text is a flowchart (../ai/diagram/mermaid-lite.ts; anything else goes on to the handlers
// after it, exactly as before), and asks "Paste as diagram?" (wave M: at the top of the view). The diagram is the graph laid
// out and written as L4-2's (../ai/diagram/apply.ts), without AI provenance; it works with AI off and for
// guests who can edit. "Paste as text" keeps the words as one text element (bulk paste's). The diagram keeps the
// AI path's caps (../ai/diagram/graph.ts normalizeGraph), so the prompt says, before anything is written, how many
// long labels it shortens and how many links (repeated, or from a shape to itself) it leaves out.
import { MAX_ITEMS } from '@draftroom/canvas-schema/limits'
import { useEffect, useId, useRef } from 'react'
import {
  type CanvasFeatureContext,
  type ContentHandlerSpec,
  items,
  type ScenePoint,
} from '../../canvas/api/index.ts'
import { type Atom, atom, useValue } from '../../lib/signals.ts'
import { countUsage } from '../../lib/usage.ts'
import { topCentreAnchor } from '../ai/board-chrome.ts'
import { inPopoverLayer, useBoardPlacement, usePopoverLayer } from '../ai/board-popover.tsx'
import { applyDiagram, measureDiagram, planDiagram, planSize } from '../ai/diagram/apply.ts'
import type { DiagramGraph } from '../ai/diagram/graph.ts'
import { readMermaid } from '../ai/diagram/mermaid-lite.ts'
import { revealResult } from '../ai/reveal.ts'
import { pasteAsText } from '../canvas-ux/ported/navigation/bulk-paste.tsx'
import { placeDiagram } from './place.ts'
import { freshId } from './runtime.ts'
import './flow.css'

interface PendingMermaid {
  readonly id: number
  readonly text: string
  readonly graph: DiagramGraph
  readonly center: ScenePoint
  /** labels the diagram's caps shorten, and links left out (../ai/diagram/mermaid-lite.ts readMermaid) */
  readonly shortened: number
  readonly dropped: number
}

const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`

/**
 * What the prompt asks: the shapes and connectors the paste makes and, before anything is written, what the
 * diagram's caps change ("Text" keeps every word as written).
 */
export function mermaidPromptText(p: Pick<PendingMermaid, 'graph' | 'shortened' | 'dropped'>): string {
  const shapes = count(p.graph.nodes.length, 'shape', 'shapes')
  const links = count(p.graph.edges.length, 'connector', 'connectors')
  let text = `Paste this Mermaid flowchart as a diagram? ${shapes}, ${links}.`
  if (p.shortened > 0) text += ` ${count(p.shortened, 'long label is', 'long labels are')} shortened.`
  if (p.dropped > 0)
    text += ` ${count(p.dropped, 'link is', 'links are')} left out (repeated, or from a shape to itself).`
  return text
}

const pendings = new WeakMap<object, Atom<PendingMermaid | null>>()
/** The paste waiting for its answer on this board, or null. */
export function pendingMermaid(canvas: object): Atom<PendingMermaid | null> {
  let a = pendings.get(canvas)
  if (!a) {
    a = atom<PendingMermaid | null>('flow.pending-mermaid', null)
    pendings.set(canvas, a)
  }
  return a
}

let seq = 0

export const MERMAID_PASTE_HANDLER: ContentHandlerSpec = {
  id: 'flow.mermaid-paste',
  kinds: ['text'],
  // before bulk paste (navigation.bulk-paste, 50), which offers the outline mind map (K7-2)
  priority: 60,
  handle(content, ctx, at, source) {
    if (content.kind !== 'text' || source === 'insert' || ctx.canvas.readOnly()) return false
    const read = readMermaid(content.text)
    if (!read) return false
    const v = ctx.canvas.viewport.get()
    const center = at ?? { x: v.x + v.width / 2, y: v.y + v.height / 2 }
    pendingMermaid(ctx.canvas).set({ id: ++seq, text: content.text, center, ...read })
    return true
  },
}

/** "Paste as diagram": the chart as native shapes and bound connectors at the paste point, one undo step. */
export function pasteAsDiagram(ctx: CanvasFeatureContext, graph: DiagramGraph, center: ScenePoint): string[] {
  const { canvas } = ctx
  if (canvas.readOnly()) return []
  const measured = measureDiagram(graph, (t, s) => canvas.text.measure(t, s))
  const spot = placeDiagram(canvas, { w: measured.layout.width, h: measured.layout.height }, center)
  const plan = planDiagram(measured, {
    origin: spot.origin,
    frameId: spot.frameId,
    provenance: null,
    newId: freshId,
  })
  if (items.contentItems(canvas.items()).length + planSize(plan) > MAX_ITEMS) {
    ctx.notify({
      key: 'flow-mermaid',
      text: 'This board has too many objects to paste that diagram.',
      tone: 'error',
      testId: 'mermaid-paste-notice',
    })
    return []
  }
  const ids = applyDiagram(canvas, plan, 'paste as diagram')
  countUsage('mermaid.paste')
  // M4-4 (FTU-8): shown whole, clear of the board's chrome (this tab's camera only)
  void revealResult(canvas, ids)
  return ids
}

/**
 * The prompt (a screen-layer overlay). Wave M (M4-4, FTU-8): at the top of the view, where the person looks, clear of
 * the board's chrome (it opened at the paste point, often the bottom right corner), in the popover layer above it.
 */
export function MermaidPastePrompt({ ctx }: { ctx: CanvasFeatureContext }) {
  const { canvas } = ctx
  const pending = useValue('flow-mermaid-pending', () => pendingMermaid(canvas).get(), [canvas])
  const ref = useRef<HTMLDivElement>(null)
  const host = usePopoverLayer(canvas)
  const pos = useBoardPlacement(canvas, ref, () => topCentreAnchor(canvas), { prefer: 'below' })
  const titleId = useId()
  // working on the canvas instead of answering dismisses it (nothing is pasted)
  useEffect(
    () =>
      canvas.on('input', (e) => {
        if (e.type === 'pointer-down' && pendingMermaid(canvas).get()) pendingMermaid(canvas).set(null)
      }),
    [canvas],
  )
  useEffect(() => () => pendingMermaid(canvas).set(null), [canvas])
  if (!pending) return null
  const finish = () => {
    pendingMermaid(canvas).set(null)
    canvas.focus({ preventScroll: true })
  }
  return inPopoverLayer(
    canvas,
    host,
    <div
      key={pending.id}
      ref={ref}
      className="dr-flow-paste"
      role="dialog"
      aria-labelledby={titleId}
      data-testid="mermaid-paste-prompt"
      style={
        pos
          ? { left: pos.left, top: pos.top, transform: 'none', maxHeight: pos.maxHeight, overflowY: 'auto' }
          : { left: 0, top: 0, transform: 'none', opacity: 0, pointerEvents: 'none' }
      }
      onKeyDown={(e) => {
        if (e.key !== 'Escape') return
        e.preventDefault()
        e.stopPropagation()
        finish()
      }}
    >
      <p id={titleId} className="dr-flow-paste__title">
        {mermaidPromptText(pending)}
      </p>
      <div className="dr-flow-paste__actions">
        <button
          type="button"
          className="dr-btn dr-btn--primary dr-btn--sm"
          data-testid="mermaid-paste-diagram"
          // biome-ignore lint/a11y/noAutofocus: the prompt exists to take this one decision
          autoFocus
          onClick={() => {
            const p = pendingMermaid(canvas).get()
            pendingMermaid(canvas).set(null)
            if (p) pasteAsDiagram(ctx, p.graph, p.center)
            canvas.focus({ preventScroll: true })
          }}
        >
          Paste as diagram
        </button>
        <button
          type="button"
          className="dr-btn dr-btn--sm"
          data-testid="mermaid-paste-text"
          onClick={() => {
            const p = pendingMermaid(canvas).get()
            pendingMermaid(canvas).set(null)
            if (p) pasteAsText(ctx, p.text, p.center)
            canvas.focus({ preventScroll: true })
          }}
        >
          Text
        </button>
        <button
          type="button"
          className="dr-iconbtn dr-iconbtn--sm"
          data-testid="mermaid-paste-cancel"
          aria-label="Cancel paste"
          onClick={finish}
        >
          ×
        </button>
      </div>
    </div>,
  )
}
