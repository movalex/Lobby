// OWNER: W2 (wave L, L2-1b). The AI preview: what a plan would change, drawn over the board before anything is
// written (destination outlines and move arrows, recolour swatches, the bounds of new elements and a count line
// such as "Moves 23 notes into 5 themes"), with Apply, Try again and Discard. A screen-layer overlay: it reads the
// camera and the elements' bounds and writes nothing to the board, ever; the caller writes on 'apply' (one
// transact), makes a new budgeted call on 'retry' and does nothing on 'discard'. Used by Group into themes (here),
// and through public.ts `showAiPreview` by W3's command 'do', W8's sort and score and W4's diagrams over 20
// elements. Static under reduced motion.
//
// One preview at a time per canvas: a second one resolves the first with 'discard'. Escape, closing the board,
// and losing edit rights (a role change, an archived board) are 'discard' too.

import type { LobbyColorName } from '@draftroom/board-ops/elements'
import { LOBBY_PALETTE } from '@draftroom/board-ops/elements'
import { useEffect, useId, useRef } from 'react'
import type { CanvasFeatureContext, LobbyCanvas } from '../../../canvas/api/index.ts'
import { type Atom, atom, useValue } from '../../../lib/signals.ts'
import { SparkIcon } from '../icons.tsx'
import { useReducedMotion } from './Placeholders.tsx'
import { perCanvas, setAiCtx } from './runtime.ts'
import { onScreen, type Rect, toPixels } from './shimmer.ts'

/** What an AI (or a grammar) plan would change (public.ts AiPreviewPlan, the frozen shape). */
export interface PreviewPlan {
  readonly runId: string
  readonly title: string
  readonly summary: string
  readonly moves: readonly { readonly id: string; readonly x: number; readonly y: number }[]
  readonly recolors: readonly { readonly id: string; readonly to: string }[]
  readonly creates: readonly {
    readonly x: number
    readonly y: number
    readonly w: number
    readonly h: number
    readonly kind: string
  }[]
}

export type PreviewChoice = 'apply' | 'retry' | 'discard'

interface PreviewEntry {
  readonly plan: PreviewPlan
  /** the person's choice; only the first call counts */
  readonly choose: (choice: PreviewChoice) => void
}

/** The open preview of each canvas (null: none). Never stored, never sent. */
export const aiPreview = perCanvas<Atom<PreviewEntry | null>>(() =>
  atom<PreviewEntry | null>('lobby-ai-preview', null),
)

/** Most outlines, arrows and swatches drawn at once (a plan can name up to 200 elements per op). */
export const PREVIEW_MAX_MARKS = 240

/**
 * Shows `plan` and resolves the person's choice (see the header). Writes nothing. A read-only canvas resolves
 * 'discard' at once (nothing could be applied).
 */
export function showPreview(ctx: CanvasFeatureContext, plan: PreviewPlan): Promise<PreviewChoice> {
  setAiCtx(ctx)
  const { canvas } = ctx
  const slot = aiPreview(canvas)
  slot.get()?.choose('discard')
  if (canvas.readOnly()) return Promise.resolve('discard')
  return new Promise<PreviewChoice>((resolve) => {
    let done = false
    const entry: PreviewEntry = {
      plan,
      choose: (choice) => {
        if (done) return
        done = true
        if (slot.get() === entry) slot.set(null)
        resolve(choice)
      },
    }
    slot.set(entry)
  })
}

/** Ends the canvas's open preview as discarded (the board closing). */
export function discardPreview(canvas: LobbyCanvas): void {
  aiPreview(canvas).get()?.choose('discard')
}

/** A recolour target as a CSS colour: a Lobby palette name's fill, else the literal the styles part takes. */
export function swatchColor(to: string): string {
  const named = (LOBBY_PALETTE as Record<string, { noteFill?: string; solid?: string } | undefined>)[
    to as LobbyColorName
  ]
  return named?.noteFill ?? named?.solid ?? to
}

/** The marks of a plan in overlay pixels (pure: unit-tested), capped at PREVIEW_MAX_MARKS in all. */
export function previewMarks(
  plan: PreviewPlan,
  boundsOf: (id: string) => { x: number; y: number; width: number; height: number } | null,
  toOverlay: (p: { x: number; y: number }) => { x: number; y: number },
  screen: { width: number; height: number },
): {
  outlines: (Rect & { id: string })[]
  arrows: { x1: number; y1: number; x2: number; y2: number }[]
  swatches: { x: number; y: number; color: string }[]
  creates: (Rect & { kind: string })[]
} {
  const outlines: (Rect & { id: string })[] = []
  const arrows: { x1: number; y1: number; x2: number; y2: number }[] = []
  const swatches: { x: number; y: number; color: string }[] = []
  const creates: (Rect & { kind: string })[] = []
  let left = PREVIEW_MAX_MARKS
  for (const m of plan.moves) {
    if (left <= 0) break
    const b = boundsOf(m.id)
    if (!b) continue
    const to = toPixels({ x: m.x, y: m.y, w: b.width, h: b.height }, toOverlay)
    const from = toPixels({ x: b.x, y: b.y, w: b.width, h: b.height }, toOverlay)
    if (!onScreen(to, screen.width, screen.height) && !onScreen(from, screen.width, screen.height)) continue
    outlines.push({ ...to, id: m.id })
    arrows.push({
      x1: from.x + from.w / 2,
      y1: from.y + from.h / 2,
      x2: to.x + to.w / 2,
      y2: to.y + to.h / 2,
    })
    left--
  }
  for (const r of plan.recolors) {
    if (left <= 0) break
    const b = boundsOf(r.id)
    if (!b) continue
    const px = toPixels({ x: b.x, y: b.y, w: b.width, h: b.height }, toOverlay)
    if (!onScreen(px, screen.width, screen.height)) continue
    swatches.push({ x: px.x + px.w, y: px.y, color: swatchColor(r.to) })
    left--
  }
  for (const c of plan.creates) {
    if (left <= 0) break
    const px = toPixels({ x: c.x, y: c.y, w: c.w, h: c.h }, toOverlay)
    if (!onScreen(px, screen.width, screen.height)) continue
    creates.push({ ...px, kind: c.kind })
    left--
  }
  return { outlines, arrows, swatches, creates }
}

/** The preview layer (a screen overlay of the AI feature): marks over the board, and the panel. */
export function AiPreviewOverlay({ ctx }: { ctx: CanvasFeatureContext }) {
  const { canvas } = ctx
  const entry = useValue('lobby-ai-preview-entry', () => aiPreview(canvas).get(), [canvas])
  if (!entry) return null
  return <PreviewView canvas={canvas} entry={entry} />
}

function PreviewView({ canvas, entry }: { canvas: LobbyCanvas; entry: PreviewEntry }) {
  const doc = canvas.container()?.ownerDocument ?? document
  const still = useReducedMotion(doc)
  const readOnly = useValue('lobby-ai-preview-ro', () => canvas.readOnly(), [canvas])
  const json = useValue('lobby-ai-preview-marks', () => {
    canvas.viewport.get()
    canvas.items()
    const screen = canvas.viewport.screenRect()
    return JSON.stringify(
      previewMarks(
        entry.plan,
        (id) => canvas.bounds(id),
        (p) => canvas.sceneToOverlay(p),
        screen,
      ),
    )
  }, [canvas, entry])
  const marks = JSON.parse(json) as ReturnType<typeof previewMarks>
  const titleId = useId()
  const panel = useRef<HTMLElement>(null)
  // Losing edit rights while it is open: nothing can be applied.
  useEffect(() => {
    if (readOnly) entry.choose('discard')
  }, [readOnly, entry])
  // Escape discards (unless a menu or a dialog above owns it); the panel keeps the canvas's keys off.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented || e.isComposing) return
      if (doc.querySelector('dialog[open]')) return
      e.preventDefault()
      e.stopPropagation()
      entry.choose('discard')
      canvas.focus({ preventScroll: true })
    }
    doc.addEventListener('keydown', onKey, true)
    return () => doc.removeEventListener('keydown', onKey, true)
  }, [doc, entry, canvas])
  useEffect(() => {
    const el = panel.current
    if (!el) return
    const stop = (e: Event) => e.stopPropagation()
    for (const t of ['pointerdown', 'mousedown', 'keyup', 'wheel'] as const) el.addEventListener(t, stop)
    el.querySelector<HTMLElement>('[data-testid="ai-preview-apply"]')?.focus({ preventScroll: true })
    return () => {
      for (const t of ['pointerdown', 'mousedown', 'keyup', 'wheel'] as const) el.removeEventListener(t, stop)
    }
  }, [])
  const choose = (c: PreviewChoice) => {
    entry.choose(c)
    canvas.focus({ preventScroll: true })
  }
  const { plan } = entry
  return (
    <div className="dr-ai-preview" data-testid="ai-preview" data-motion={still ? 'still' : 'move'}>
      <svg className="dr-ai-preview__marks" aria-hidden="true">
        <defs>
          <marker
            id="dr-ai-preview-head"
            viewBox="0 0 8 8"
            refX="7"
            refY="4"
            markerWidth="7"
            markerHeight="7"
            orient="auto-start-reverse"
          >
            <path d="M0 0 8 4 0 8z" className="dr-ai-preview__head" />
          </marker>
        </defs>
        {marks.arrows.map((a, i) => (
          <line
            key={`a${i}`}
            className="dr-ai-preview__arrow"
            x1={a.x1}
            y1={a.y1}
            x2={a.x2}
            y2={a.y2}
            markerEnd="url(#dr-ai-preview-head)"
          />
        ))}
      </svg>
      {marks.outlines.map((o) => (
        <span
          key={`o${o.id}`}
          className="dr-ai-preview__dest"
          data-testid="ai-preview-move"
          style={{ left: o.x, top: o.y, width: o.w, height: o.h }}
        />
      ))}
      {marks.creates.map((c, i) => (
        <span
          key={`c${i}`}
          className="dr-ai-preview__new"
          data-testid="ai-preview-create"
          data-kind={c.kind}
          style={{ left: c.x, top: c.y, width: c.w, height: c.h }}
        />
      ))}
      {marks.swatches.map((s, i) => (
        <span
          key={`s${i}`}
          className="dr-ai-preview__swatch"
          data-testid="ai-preview-recolor"
          style={{ left: s.x - 10, top: s.y - 10, background: s.color }}
        />
      ))}
      <section
        ref={panel}
        className="dr-ai-preview__panel"
        role="dialog"
        aria-labelledby={titleId}
        data-testid="ai-preview-panel"
        data-run={plan.runId}
      >
        <div className="dr-ai-pop__head">
          <span className="dr-ai-pop__badge" aria-hidden="true">
            <SparkIcon size={14} />
          </span>
          <h2 id={titleId} className="dr-ai-pop__title">
            {plan.title}
          </h2>
        </div>
        <p className="dr-ai-preview__summary" data-testid="ai-preview-summary">
          {plan.summary}
        </p>
        <p className="dr-ai-pop__foot">Nothing has changed yet. Apply makes it one step you can undo.</p>
        <div className="dr-ai-panel__actions">
          <button
            type="button"
            className="dr-btn dr-btn--sm"
            data-testid="ai-preview-discard"
            onClick={() => choose('discard')}
          >
            Discard
          </button>
          <span className="dr-ai-form__spacer" />
          <button
            type="button"
            className="dr-btn dr-btn--sm"
            data-testid="ai-preview-retry"
            title="Asks AI again (uses another request)"
            onClick={() => choose('retry')}
          >
            Try again
          </button>
          <button
            type="button"
            className="dr-btn dr-btn--primary dr-btn--sm"
            data-testid="ai-preview-apply"
            onClick={() => choose('apply')}
          >
            Apply
          </button>
        </div>
      </section>
    </div>
  )
}
