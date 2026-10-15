// L8-3: a small drawing of a piece for the panel's list: its real elements (the same ones that would be
// inserted) drawn as plain shapes. Words are shown as short bars, not text: at this size they are only a texture.
// Built once per piece, after the builders load.
//
// Wave M (M4-6, FTU-9): in the light theme it is drawn in the piece's own colours on a light paper; in the dark theme
// (./pieces.css) the paper is the panel's own recessed surface, the lines and bars take the theme's ink tokens, and
// each fill is its own colour mixed into that surface (from `--pf`), so no card is a white block in a dark panel.
import type { PieceInfo } from '@draftroom/templates/pieces/catalog'
import { type CSSProperties, memo, type ReactNode } from 'react'

/** The parts of an element the drawing reads. */
export interface PreviewEl {
  readonly type: string
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
  readonly strokeColor: string
  readonly backgroundColor: string
  readonly strokeStyle?: string
  readonly roundness?: { type?: number; value?: number } | null
  readonly points?: readonly (readonly [number, number])[]
  readonly startArrowhead?: string | null
  readonly endArrowhead?: string | null
  readonly containerId?: string | null
  readonly fontSize?: number
  readonly textAlign?: string
  readonly originalText?: string
}

const none = (c: string) => (c === 'transparent' ? 'none' : c)

type Pt = readonly [number, number]

/** A curve through every point (Catmull-Rom as cubic Béziers), as an arrow with roundness draws. */
export function smoothPath(pts: readonly Pt[]): string {
  const at = (i: number) => pts[Math.max(0, Math.min(pts.length - 1, i))] as Pt
  const first = at(0)
  let d = `M${first[0]},${first[1]}`
  for (let i = 0; i + 1 < pts.length; i++) {
    const [a, b, c, e] = [at(i - 1), at(i), at(i + 1), at(i + 2)]
    const c1 = [b[0] + (c[0] - a[0]) / 6, b[1] + (c[1] - a[1]) / 6]
    const c2 = [c[0] - (e[0] - b[0]) / 6, c[1] - (e[1] - b[1]) / 6]
    d += ` C${c1[0]},${c1[1]} ${c2[0]},${c2[1]} ${c[0]},${c[1]}`
  }
  return d
}

/** An open arrowhead (two short strokes) at `tip`, pointing away from `from`. */
function arrowhead(tip: Pt, from: Pt, key: string, stroke: string): ReactNode {
  const dx = tip[0] - from[0]
  const dy = tip[1] - from[1]
  const len = Math.hypot(dx, dy)
  if (!len) return null
  const [ux, uy] = [dx / len, dy / len]
  const size = 16
  const wing = (sign: number) => {
    const a = (sign * 28 * Math.PI) / 180
    const [rx, ry] = [ux * Math.cos(a) - uy * Math.sin(a), ux * Math.sin(a) + uy * Math.cos(a)]
    return `${tip[0] - rx * size},${tip[1] - ry * size}`
  }
  return (
    <polyline
      key={key}
      points={`${wing(1)} ${tip[0]},${tip[1]} ${wing(-1)}`}
      fill="none"
      stroke={stroke}
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      className="dr-pp-line"
    />
  )
}

/** A fill the dark theme can mix into its surface (`--pf`, ./pieces.css), as an inline custom property. */
const fillVar = (fill: string) => (fill === 'none' ? undefined : ({ '--pf': fill } as CSSProperties))

/** One element as SVG, in the piece's own units (null for a bound label: its container shows it). */
export function drawn(el: PreviewEl, key: number): ReactNode {
  const stroke = none(el.strokeColor)
  const fill = none(el.backgroundColor)
  const look = { className: fill === 'none' ? 'dr-pp-line' : 'dr-pp-shape', style: fillVar(fill) }
  const dash = el.strokeStyle === 'dashed' ? '6 5' : el.strokeStyle === 'dotted' ? '2 4' : undefined
  switch (el.type) {
    case 'rectangle':
    case 'frame':
      return (
        <rect
          key={key}
          x={el.x}
          y={el.y}
          width={el.width}
          height={el.height}
          rx={Math.min(el.roundness?.value ?? (el.roundness ? 8 : 0), el.height / 2)}
          fill={el.type === 'frame' ? 'none' : fill}
          stroke={el.type === 'frame' ? '#7d8799' : stroke}
          strokeWidth={2}
          strokeDasharray={el.type === 'frame' ? '8 6' : dash}
          {...(el.type === 'frame' ? { className: 'dr-pp-frame' } : look)}
        />
      )
    case 'stickynote':
      // a sticky note: a square of its colour, no outline (its words are its bound text, drawn by nobody here)
      return (
        <rect
          key={key}
          x={el.x}
          y={el.y}
          width={el.width}
          height={el.height}
          rx={Math.min(6, el.width / 8)}
          fill={fill === 'none' ? '#f6c453' : fill}
          stroke="none"
          className="dr-pp-shape dr-pp-note"
          style={fillVar(fill === 'none' ? '#f6c453' : fill)}
        />
      )
    case 'arrow': {
      const pts = (el.points ?? []).map(([px, py]): Pt => [el.x + px, el.y + py])
      if (pts.length < 2) return null
      const ink = stroke === 'none' ? '#1d1d1d' : stroke
      const curved = el.roundness != null && pts.length > 2
      const line = curved ? (
        <path
          key={`${key}.l`}
          d={smoothPath(pts)}
          fill="none"
          stroke={ink}
          strokeWidth={2}
          strokeDasharray={dash}
          strokeLinecap="round"
          className="dr-pp-line"
        />
      ) : (
        <polyline
          key={`${key}.l`}
          points={pts.map(([px, py]) => `${px},${py}`).join(' ')}
          fill="none"
          stroke={ink}
          strokeWidth={2}
          strokeDasharray={dash}
          strokeLinecap="round"
          strokeLinejoin="round"
          className="dr-pp-line"
        />
      )
      const n = pts.length
      return [
        line,
        el.endArrowhead ? arrowhead(pts[n - 1] as Pt, pts[n - 2] as Pt, `${key}.e`, ink) : null,
        el.startArrowhead ? arrowhead(pts[0] as Pt, pts[1] as Pt, `${key}.s`, ink) : null,
      ]
    }
    case 'ellipse':
      return (
        <ellipse
          key={key}
          cx={el.x + el.width / 2}
          cy={el.y + el.height / 2}
          rx={el.width / 2}
          ry={el.height / 2}
          fill={fill}
          stroke={stroke}
          strokeWidth={2}
          {...look}
        />
      )
    case 'diamond': {
      const { x, y, width: w, height: h } = el
      return (
        <polygon
          key={key}
          points={`${x + w / 2},${y} ${x + w},${y + h / 2} ${x + w / 2},${y + h} ${x},${y + h / 2}`}
          fill={fill}
          stroke={stroke}
          strokeWidth={2}
          {...look}
        />
      )
    }
    case 'line': {
      const pts = (el.points ?? []).map(([px, py]) => `${el.x + px},${el.y + py}`).join(' ')
      return (
        <polyline
          key={key}
          points={pts}
          fill={fill}
          stroke={stroke}
          strokeWidth={2}
          strokeLinejoin="round"
          {...look}
        />
      )
    }
    case 'text': {
      if (el.containerId) return null
      const size = el.fontSize ?? 18
      const lines = String(el.originalText ?? '').split('\n').length
      const w = Math.max(8, Math.min(el.width, (el.originalText?.length ?? 4) * size * 0.5))
      const h = Math.max(4, size * 0.55)
      const x = el.textAlign === 'center' ? el.x + (el.width - w) / 2 : el.x
      return Array.from({ length: Math.min(lines, 2) }, (_, i) => (
        <rect
          key={`${key}.${i}`}
          x={x}
          y={el.y + 3 + i * size * 1.25}
          width={w}
          height={h}
          rx={h / 2}
          fill={stroke === 'none' ? '#5f6b7a' : stroke}
          opacity={0.55}
          className="dr-pp-text"
        />
      ))
    }
    default:
      return null
  }
}

export const PiecePreview = memo(function PiecePreview({
  info,
  elements,
}: {
  info: Pick<PieceInfo, 'id' | 'w' | 'h'>
  elements: readonly PreviewEl[] | undefined
}) {
  const pad = 14
  return (
    <svg
      className="dr-pieces__preview"
      viewBox={`${-pad} ${-pad} ${info.w + 2 * pad} ${info.h + 2 * pad}`}
      preserveAspectRatio="xMidYMid meet"
      aria-hidden="true"
      data-piece-preview={info.id}
    >
      {elements ? elements.map((el, i) => drawn(el, i)) : null}
    </svg>
  )
})
