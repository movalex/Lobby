// OWNER: W2 (wave L, L2-1c). The AI lens: a board-menu toggle ("Show what AI made") that outlines every element AI
// made (`customData.lobby.ai`) and, on hover, says who it was made for and when: "Made with AI for Dana · 8 Oct".
// An overlay only (a screen layer): it reads the board and writes nothing; the toggle is this tab's own, never
// stored or sent. "Hide note authors" (the board's session setting) leaves the name out. Under reduced motion the
// outline stands still.
//
// Wave M (W4, M4-2): while it is on, a banner says how much AI made ("Showing 3 things AI made · Hide") and turns
// it off; turning it on is counted (usage `ai.open:lens`, the event name only).

import { useRef } from 'react'
import type { CanvasElement, CanvasFeatureContext, LobbyCanvas } from '../../../canvas/api/index.ts'
import { items } from '../../../canvas/api/index.ts'
import { type Atom, atom, useValue } from '../../../lib/signals.ts'
import { countUsage } from '../../../lib/usage.ts'
import { topCentreAnchor } from '../board-chrome.ts'
import { inPopoverLayer, useBoardPlacement, usePopoverLayer } from '../board-popover.tsx'
import { SparkIcon } from '../icons.tsx'
import { useReducedMotion } from './Placeholders.tsx'
import { aiOf, stampsOf } from './provenance.ts'
import { perCanvas } from './runtime.ts'
import { onScreen, type Rect, toPixels } from './shimmer.ts'

/** Whether the lens is on in this tab, per canvas (off on every open). */
export const aiLens = perCanvas<Atom<boolean>>(() => atom('lobby-ai-lens', false))

/** Most AI-made elements outlined at once. */
export const LENS_MAX_BOXES = 300

/** "Hide note authors" (the board's `workshop` doc value, as canvas-ux's session settings read it). */
export function authorsHidden(canvas: Pick<LobbyCanvas, 'doc'>): boolean {
  const raw = canvas.doc.get('workshop')
  return (
    typeof raw === 'object' && raw !== null && (raw as { hideNoteAuthors?: unknown }).hideNoteAuthors === true
  )
}

/** A server time as "8 Oct" (this year) or "8 Oct 2025". */
export function lensDate(ms: number, now: number = Date.now()): string {
  const d = new Date(ms)
  const sameYear = d.getFullYear() === new Date(now).getFullYear()
  return d.toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'short',
    ...(sameYear ? {} : { year: 'numeric' }),
  })
}

/**
 * The lens's hover line for an AI-made element (pure): "Made with AI for <who made it> · <date>"; with authors
 * hidden, or no server stamp yet, the parts it cannot say are left out. Null for anything AI did not make.
 */
export function lensLine(
  el: CanvasElement | undefined,
  opts: { hideAuthors: boolean; now?: number },
): string | null {
  if (!aiOf(el)) return null
  const s = stampsOf(el)
  const who = !opts.hideAuthors && s.createdBy?.name ? ` for ${s.createdBy.name}` : ''
  const when = s.createdAt !== null ? ` · ${lensDate(s.createdAt, opts.now)}` : ''
  return `Made with AI${who}${when}`
}

/** The AI-made objects of the board (labels are their containers'), in paint order. */
export function aiMadeIds(canvas: Pick<LobbyCanvas, 'items' | 'isHidden'>): string[] {
  const out: string[] = []
  for (const el of canvas.items()) {
    if (el.type === 'text' && (el as { containerId?: string | null }).containerId) continue
    if (canvas.isHidden(el.id) || !aiOf(el)) continue
    out.push(el.id)
    if (out.length >= LENS_MAX_BOXES) break
  }
  return out
}

/** How many things on the board AI made (labels are their containers'; the lens draws at most LENS_MAX_BOXES). */
export function aiMadeCount(canvas: Pick<LobbyCanvas, 'items' | 'isHidden'>): number {
  let n = 0
  for (const el of canvas.items()) {
    if (el.type === 'text' && (el as { containerId?: string | null }).containerId) continue
    if (!canvas.isHidden(el.id) && aiOf(el)) n++
  }
  return n
}

/** The lens banner's words (wave M, M4-2): "Showing 3 things AI made", "Showing 1 thing AI made", none. */
export function lensBannerText(n: number): string {
  if (n <= 0) return 'Nothing on this board was made with AI'
  return `Showing ${n} ${n === 1 ? 'thing' : 'things'} AI made`
}

/** Turns the lens on or off in this tab (counted when it turns on: usage `ai.open:lens`, the event name only). */
export function toggleAiLens(canvas: LobbyCanvas, on: boolean = !aiLens(canvas).get()): void {
  if (on && !aiLens(canvas).get()) countUsage('ai.open:lens')
  aiLens(canvas).set(on)
}

/** The lens layer (a screen overlay of the AI feature). Nothing while the lens is off. */
export function AiLensOverlay({ ctx }: { ctx: CanvasFeatureContext }) {
  const { canvas } = ctx
  const on = useValue('lobby-ai-lens-on', () => aiLens(canvas).get(), [canvas])
  if (!on) return null
  return (
    <>
      <LensView canvas={canvas} />
      <LensBanner canvas={canvas} />
    </>
  )
}

/**
 * Wave M (M4-2): while the lens is on, a banner says how much AI made and turns it off: "Showing 3 things AI made ·
 * Hide". In the popover layer at the top of the view, clear of the board's chrome; a status a screen reader hears.
 */
function LensBanner({ canvas }: { canvas: LobbyCanvas }) {
  const n = useValue('lobby-ai-lens-count', () => aiMadeCount(canvas), [canvas])
  const ref = useRef<HTMLDivElement>(null)
  const host = usePopoverLayer(canvas)
  const pos = useBoardPlacement(canvas, ref, () => topCentreAnchor(canvas), {
    prefer: 'below',
    coverStylePanel: false,
  })
  return inPopoverLayer(
    canvas,
    host,
    <div
      ref={ref}
      className="dr-ai-lens-banner"
      data-testid="ai-lens-banner"
      data-count={n}
      style={pos ? { left: pos.left, top: pos.top } : { left: 0, top: 0, visibility: 'hidden' }}
    >
      <span className="dr-ai-pop__badge" aria-hidden="true">
        <SparkIcon size={13} />
      </span>
      <span role="status" data-testid="ai-lens-banner-text">
        {lensBannerText(n)}
      </span>
      <span aria-hidden="true">·</span>
      <button
        type="button"
        className="dr-ai-lens-banner__hide"
        data-testid="ai-lens-hide"
        onClick={() => {
          toggleAiLens(canvas, false)
          canvas.focus({ preventScroll: true })
        }}
      >
        Hide
      </button>
    </div>,
  )
}

function LensView({ canvas }: { canvas: LobbyCanvas }) {
  const doc = canvas.container()?.ownerDocument ?? document
  const still = useReducedMotion(doc)
  const json = useValue('lobby-ai-lens-boxes', () => {
    canvas.viewport.get()
    const screen = canvas.viewport.screenRect()
    const boxes: (Rect & { id: string })[] = []
    for (const id of aiMadeIds(canvas)) {
      const b = canvas.bounds(id)
      if (!b) continue
      const px = toPixels({ x: b.x, y: b.y, w: b.width, h: b.height }, (p) => canvas.sceneToOverlay(p))
      if (onScreen(px, screen.width, screen.height)) boxes.push({ ...px, id })
    }
    return JSON.stringify(boxes)
  }, [canvas])
  const boxes = JSON.parse(json) as (Rect & { id: string })[]
  const card = useValue('lobby-ai-lens-card', () => {
    const hovered = canvas.hovered()
    if (!hovered) return null
    const el = canvas.get(hovered)
    const root = el ? items.containerOf(el, (id) => canvas.get(id)) : undefined
    const line = lensLine(root, { hideAuthors: authorsHidden(canvas) })
    if (!root || !line) return null
    canvas.viewport.get()
    const b = canvas.bounds(root.id)
    if (!b) return null
    const p = canvas.sceneToOverlay({ x: b.x, y: b.y + b.height })
    return JSON.stringify({ line, x: Math.round(p.x), y: Math.round(p.y) })
  }, [canvas])
  const shown = card ? (JSON.parse(card) as { line: string; x: number; y: number }) : null
  return (
    <div
      className="dr-ai-lens"
      data-testid="ai-lens"
      data-motion={still ? 'still' : 'pulse'}
      aria-hidden="true"
    >
      {boxes.map((b) => (
        <span
          key={b.id}
          className="dr-ai-lens__box"
          data-testid="ai-lens-box"
          data-id={b.id}
          style={{ left: b.x - 3, top: b.y - 3, width: b.w + 6, height: b.h + 6 }}
        />
      ))}
      {shown && (
        <span
          className="dr-ai-lens__card"
          data-testid="ai-lens-card"
          style={{ left: shown.x, top: shown.y + 6 }}
        >
          {shown.line}
        </span>
      )}
    </div>
  )
}
