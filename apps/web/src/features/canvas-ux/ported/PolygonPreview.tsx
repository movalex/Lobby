// D4: the outline of the polygon being dragged out with a polygon tool (./polygons.ts), drawn over the canvas
// until the press ends (a scene overlay layer; nothing is written before the release).
import type { CanvasFeatureContext } from '../../../canvas/api/index.ts'
import { useValue } from '../../../lib/signals.ts'
import { dragBox, polygonDrag, polygonPoints } from './polygons.ts'

export function PolygonPreview({ ctx }: { ctx: CanvasFeatureContext }) {
  const { canvas } = ctx
  const shape = useValue('cux-polygon-preview', () => {
    const d = polygonDrag(canvas).get()
    if (!d) return null
    const box = dragBox(d.from, d.to, d.square)
    if (box.width < 2 || box.height < 2) return null
    const z = canvas.viewport.get().zoom
    const at = canvas.sceneToOverlay({ x: box.x, y: box.y })
    const w = box.width * z
    const h = box.height * z
    return {
      left: at.x,
      top: at.y,
      w,
      h,
      d: `M${polygonPoints(d.kind, w, h)
        .map(([x, y]) => `${x.toFixed(1)} ${y.toFixed(1)}`)
        .join('L')}Z`,
    }
  }, [canvas])
  if (!shape) return null
  return (
    <svg
      className="cux-polygon-preview"
      data-testid="polygon-preview"
      aria-hidden="true"
      width={shape.w + 2}
      height={shape.h + 2}
      style={{ left: shape.left - 1, top: shape.top - 1 }}
      viewBox={`-1 -1 ${shape.w + 2} ${shape.h + 2}`}
    >
      <path d={shape.d} />
    </svg>
  )
}
