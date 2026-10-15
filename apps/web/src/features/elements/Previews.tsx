// OWNER: WS3 (wave Q). The small drawings on the Elements panel's tiles: an icon from its own geometry (the 24-unit
// grid, in the theme's ink or the chosen colour), a shape from its real elements (../pieces/Preview.tsx), and a library
// item from its stored elements, its images from the item's thumb route (same origin; never a data: or blob: URL).
import type { IconGeometry } from '@draftroom/contracts'
import { memo, type ReactNode } from 'react'
import { drawn, type PreviewEl } from '../pieces/Preview.tsx'

/** An icon as SVG on its own grid: strokes in `color` (default: the text colour), fills where the icon fills. */
export const IconGlyph = memo(function IconGlyph({
  geometry,
  color,
  size = 28,
}: {
  geometry: IconGeometry | null | undefined
  color?: string | null
  size?: number
}) {
  const ink = color ?? 'currentColor'
  return (
    <svg
      className="dr-el-glyph"
      viewBox="-1 -1 26 26"
      width={size}
      height={size}
      fill="none"
      stroke={ink}
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {geometry?.map((p, i) => {
        const key = `${p.t}${i}`
        if (p.t === 'line') {
          const pts: string[] = []
          for (let j = 0; j + 1 < p.p.length; j += 2) pts.push(`${p.p[j]},${p.p[j + 1]}`)
          return p.closed ? (
            <polygon key={key} points={pts.join(' ')} />
          ) : (
            <polyline key={key} points={pts.join(' ')} />
          )
        }
        const fill = p.f ? ink : 'none'
        if (p.t === 'ellipse')
          return (
            <ellipse key={key} cx={p.x + p.w / 2} cy={p.y + p.h / 2} rx={p.w / 2} ry={p.h / 2} fill={fill} />
          )
        return <rect key={key} x={p.x} y={p.y} width={p.w} height={p.h} rx={p.r ?? 0} fill={fill} />
      })}
    </svg>
  )
})

/** The parts of a stored element an item's drawing reads (PreviewEl plus images and free lines). */
export interface ItemPreviewEl extends PreviewEl {
  readonly id?: string
  readonly fileId?: string | null
  readonly isDeleted?: boolean
}

/** One stored element as SVG (images from `thumb`, free lines as polylines, the rest as a shape's). */
function drawnItem(el: ItemPreviewEl, key: number, thumb: (fileId: string) => string | null): ReactNode {
  if (el.isDeleted) return null
  if (el.type === 'image') {
    const href = el.fileId ? thumb(el.fileId) : null
    return href ? (
      <image
        key={key}
        href={href}
        x={el.x}
        y={el.y}
        width={el.width}
        height={el.height}
        preserveAspectRatio="xMidYMid slice"
      />
    ) : (
      <rect
        key={key}
        x={el.x}
        y={el.y}
        width={el.width}
        height={el.height}
        className="dr-pp-shape"
        fill="#e9edf2"
        stroke="#9fa8b2"
        strokeWidth={2}
      />
    )
  }
  if (el.type === 'freedraw') return drawn({ ...el, type: 'line', backgroundColor: 'transparent' }, key)
  return drawn(el, key)
}

/** A library item drawn from its elements (item-local coordinates, the box at the origin). */
export const ItemPreview = memo(function ItemPreview({
  elements,
  width,
  height,
  thumb,
  id,
}: {
  elements: readonly ItemPreviewEl[] | null | undefined
  width: number
  height: number
  thumb(fileId: string): string | null
  id: string
}) {
  const pad = Math.max(8, Math.max(width, height) * 0.06)
  return (
    <svg
      className="dr-el-preview"
      viewBox={`${-pad} ${-pad} ${Math.max(1, width) + 2 * pad} ${Math.max(1, height) + 2 * pad}`}
      preserveAspectRatio="xMidYMid meet"
      aria-hidden="true"
      focusable="false"
      data-item-preview={id}
    >
      {elements ? elements.map((el, i) => drawnItem(el, i, thumb)) : null}
    </svg>
  )
})
