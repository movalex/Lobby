/**
 * Re-layout helpers for the roll-forward's validation step (docs/EXCALIDRAW-MIGRATION.md §5.9 g): after a
 * field-group merge, text containers whose layout inputs changed on either side are re-fitted in Node
 * (§2.11), and arrows bound to changed targets are re-snapped (§2.9.4 rule 7).
 *
 * - `refitLabel`: a sticky note with the engine's `getStickyNoteLayout`; a rectangle, ellipse or diamond
 *   label with Excalidraw's wrap, measure and position (text-layout.ts).
 * - `approxResnap`: a stand-in for the room's `resnapArrow` (canvas-schema/engine binding.ts, O1) while
 *   it is a stub: each bound end is put back on its target (orbit: where the segment toward the adjacent
 *   point leaves the grown outline; inside: the fixed point), every other point keeps its scene position.
 *   Unrotated arrows only (converted and merged arrows are unrotated); the result is rounded as limits.ts
 *   says. The roll-forward uses the room's helper whenever it is implemented.
 */
import type { WireElement } from '@draftroom/canvas-schema/elements'
import {
  type LobbyFontFamily,
  layoutStickyNote,
  type ServerTextMetrics,
  type StickyNoteElement,
  type TextElement,
} from '@draftroom/canvas-schema/engine'
import { fixedPointOnTarget, linearGeometry, orbitPoint, type Pt, type TargetShape } from './geometry.ts'
import {
  boundTextMaxWidth,
  boundTextPosition,
  type ContainerBox,
  lineHeightOf,
  measureText,
  useMetrics,
  wrapText,
} from './text-layout.ts'

type El = Record<string, unknown>

/** The container's and label's fields after a re-fit (only the layout fields change). */
export function refitLabel(
  container: WireElement,
  label: WireElement,
  metrics: ServerTextMetrics,
): { container: WireElement; label: WireElement } {
  useMetrics(metrics)
  if (label.type !== 'text') return { container, label }
  if (container.type === 'stickynote') {
    const lay = layoutStickyNote(container as unknown as StickyNoteElement, label as unknown as TextElement)
    return {
      container: { ...container, ...lay.container } as WireElement,
      label: (lay.text ? { ...label, ...lay.text } : label) as WireElement,
    }
  }
  if (container.type !== 'rectangle' && container.type !== 'ellipse' && container.type !== 'diamond')
    return { container, label }
  const fam = label.fontFamily as LobbyFontFamily
  const text = wrapText(
    label.originalText,
    fam,
    label.fontSize,
    boundTextMaxWidth(container.type, container.width, label.fontSize),
  )
  const dims = measureText(metrics, text, fam, label.fontSize, label.lineHeight ?? lineHeightOf(fam))
  const box: ContainerBox = {
    type: container.type,
    x: container.x,
    y: container.y,
    width: container.width,
    height: container.height,
    angle: container.angle,
  }
  const pos = boundTextPosition(box, {
    width: dims.width,
    height: dims.height,
    textAlign: label.textAlign,
    verticalAlign: label.verticalAlign,
    fontSize: label.fontSize,
  })
  return {
    container,
    label: {
      ...label,
      text,
      width: dims.width,
      height: dims.height,
      x: pos.x,
      y: pos.y,
      angle: container.angle,
    },
  }
}

const outlineOf = (t: WireElement): TargetShape['outline'] =>
  t.type === 'ellipse' ? 'ellipse' : t.type === 'diamond' ? 'diamond' : 'rect'

const targetShape = (t: WireElement): TargetShape => ({
  x: t.x,
  y: t.y,
  w: t.width,
  h: t.height,
  angle: t.angle,
  cx: t.x + t.width / 2,
  cy: t.y + t.height / 2,
  outline: outlineOf(t),
  strokeWidth: t.strokeWidth,
})

/**
 * Re-snaps an unrotated arrow's bound ends against `elements` (see the file comment). Returns the arrow
 * unchanged when it is rotated, unbound, or its targets are missing or deleted.
 */
export function approxResnap(arrow: WireElement, elements: ReadonlyMap<string, WireElement>): WireElement {
  if (arrow.type !== 'arrow' || arrow.angle !== 0) return arrow
  const pts: Pt[] = arrow.points.map(([x, y]) => ({ x: arrow.x + x, y: arrow.y + y }))
  if (pts.length < 2) return arrow
  const live = (id: string | undefined) => {
    const t = id ? elements.get(id) : undefined
    return t && !t.isDeleted ? t : null
  }
  const st = live(arrow.startBinding?.elementId)
  const en = live(arrow.endBinding?.elementId)
  if (!st && !en) return arrow
  const focus = (t: WireElement, fp: readonly [number, number]) => fixedPointOnTarget(targetShape(t), fp)
  const sFocus = st && arrow.startBinding ? focus(st, arrow.startBinding.fixedPoint) : (pts[0] as Pt)
  const eFocus = en && arrow.endBinding ? focus(en, arrow.endBinding.fixedPoint) : (pts[pts.length - 1] as Pt)
  const two = pts.length === 2
  const next: Pt[] = [...pts]
  if (st && arrow.startBinding) {
    const toward = two ? eFocus : (pts[1] as Pt)
    next[0] = arrow.startBinding.mode === 'inside' ? sFocus : orbitPoint(targetShape(st), sFocus, toward)
  }
  if (en && arrow.endBinding) {
    const toward = two ? sFocus : (pts[pts.length - 2] as Pt)
    next[pts.length - 1] =
      arrow.endBinding.mode === 'inside' ? eFocus : orbitPoint(targetShape(en), eFocus, toward)
  }
  const geom = linearGeometry(next)
  const out: El = { ...arrow, ...geom }
  return out as unknown as WireElement
}
