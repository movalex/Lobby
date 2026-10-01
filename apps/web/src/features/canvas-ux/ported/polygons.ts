// D4 (the wave-5 review's decision): the tldraw geo shapes Excalidraw has no type for (triangle, hexagon,
// rhombus, star, cloud, heart and the four block arrows) are built as polygons, as the plan says
// (docs/EXCALIDRAW-MIGRATION.md §4.1, §5.1 "geo other kinds"): a closed `line` (`polygon: true`) draws the
// outline and the fill, and a transparent rectangle over the same box holds the label and the connectors'
// bindings, the two grouped. It is the converter's shape (packages/tldraw-import convert.ts `geo`, the same
// points as its `polygonOf`), so a converted board's shapes and new ones are alike.
//
// The tools are canvas-ux's pointer tools (registered in ./index.tsx, in "More" in tldraw's order): a drag
// draws the shape in the dragged box (Shift keeps it square), a click puts a 200 px one centred on the
// click; the tool then goes back to Select with the new shape selected (tldraw's rule). Enter with the tool
// picked places one in the middle of the view (A11Y-07, ./place.ts). One undo step each. The shape takes
// the next shapes' style (colour, fill, dash, size).
import type {
  CanvasElement,
  CanvasFeatureContext,
  FeatureToolSpec,
  LobbyCanvas,
  ScenePoint,
} from '../../../canvas/api/index.ts'
import { type Atom, atom } from '../../../lib/signals.ts'
import { frameAt } from './notes.ts'

export type PolygonKind =
  | 'triangle'
  | 'hexagon'
  | 'rhombus'
  | 'star'
  | 'cloud'
  | 'heart'
  | 'arrow-left'
  | 'arrow-up'
  | 'arrow-down'
  | 'arrow-right'

/** The polygon tools, in tldraw's toolbar order. */
export const POLYGON_TOOLS: readonly { readonly id: PolygonKind; readonly label: string }[] = [
  { id: 'triangle', label: 'Triangle' },
  { id: 'hexagon', label: 'Hexagon' },
  { id: 'rhombus', label: 'Rhombus' },
  { id: 'star', label: 'Star' },
  { id: 'cloud', label: 'Cloud' },
  { id: 'heart', label: 'Heart' },
  { id: 'arrow-left', label: 'Arrow left' },
  { id: 'arrow-up', label: 'Arrow up' },
  { id: 'arrow-down', label: 'Arrow down' },
  { id: 'arrow-right', label: 'Arrow right' },
]

const KINDS: ReadonlySet<string> = new Set(POLYGON_TOOLS.map((t) => t.id))
export const isPolygonTool = (tool: string | null | undefined): tool is PolygonKind =>
  !!tool && KINDS.has(tool)

/** A clicked (not dragged) polygon's size, as a clicked rectangle (./place.ts SHAPE_SIZE). */
export const POLYGON_SIZE = 200
/** A drag shorter than this (scene units) is a click. */
const DRAG_MIN = 4

type Pt = [number, number]

/**
 * The closed outline of `kind` in a `w` × `h` box (the last point equals the first): the converter's
 * `polygonOf` (packages/tldraw-import geometry.ts), point for point. Pure.
 */
export function polygonPoints(kind: PolygonKind, w: number, h: number): Pt[] {
  const reg = (n: number, rot = -Math.PI / 2): Pt[] =>
    Array.from({ length: n }, (_, i) => {
      const a = rot + (i * 2 * Math.PI) / n
      return [w / 2 + (w / 2) * Math.cos(a), h / 2 + (h / 2) * Math.sin(a)] as Pt
    })
  const open = (k: PolygonKind, w: number, h: number) => polygonPoints(k, w, h).slice(0, -1)
  let pts: Pt[]
  switch (kind) {
    case 'triangle':
      pts = [
        [w / 2, 0],
        [w, h],
        [0, h],
      ]
      break
    case 'hexagon':
      pts = reg(6, 0)
      break
    case 'star':
      pts = Array.from({ length: 10 }, (_, i) => {
        const a = -Math.PI / 2 + (i * Math.PI) / 5
        const r = i % 2 ? 0.4 : 1
        return [w / 2 + (w / 2) * r * Math.cos(a), h / 2 + (h / 2) * r * Math.sin(a)] as Pt
      })
      break
    case 'rhombus':
      pts = [
        [w * 0.25, 0],
        [w, 0],
        [w * 0.75, h],
        [0, h],
      ]
      break
    case 'arrow-right':
      pts = [
        [0, h * 0.25],
        [w * 0.6, h * 0.25],
        [w * 0.6, 0],
        [w, h / 2],
        [w * 0.6, h],
        [w * 0.6, h * 0.75],
        [0, h * 0.75],
      ]
      break
    case 'arrow-left':
      pts = open('arrow-right', w, h).map(([x, y]) => [w - x, y] as Pt)
      break
    case 'arrow-down':
      pts = open('arrow-right', h, w).map(([x, y]) => [y, x] as Pt)
      break
    case 'arrow-up':
      pts = open('arrow-down', w, h).map(([x, y]) => [x, h - y] as Pt)
      break
    case 'heart':
      pts = [
        [w / 2, h * 0.25],
        [w * 0.8, 0],
        [w, h * 0.3],
        [w / 2, h],
        [0, h * 0.3],
        [w * 0.2, 0],
      ]
      break
    case 'cloud':
      pts = reg(12).map(
        ([x, y], i) => (i % 2 ? [w / 2 + (x - w / 2) * 0.85, h / 2 + (y - h / 2) * 0.85] : [x, y]) as Pt,
      )
      break
  }
  const first = pts[0] ?? [0, 0]
  return [...pts, [first[0], first[1]]]
}

const round2 = (v: number) => Math.round(v * 100) / 100

/** The polygon line's geometry for `kind` in the scene box: `x`, `y` = the first point, points relative. */
export function polygonGeometry(
  kind: PolygonKind,
  box: { x: number; y: number; width: number; height: number },
): { x: number; y: number; width: number; height: number; points: Pt[] } {
  const abs = polygonPoints(kind, box.width, box.height).map(([x, y]) => [box.x + x, box.y + y] as Pt)
  const [x0, y0] = abs[0] as Pt
  const points = abs.map(([x, y]) => [round2(x - round2(x0)), round2(y - round2(y0))] as Pt)
  points[0] = [0, 0]
  const xs = points.map((p) => p[0])
  const ys = points.map((p) => p[1])
  return {
    x: round2(x0),
    y: round2(y0),
    points,
    width: Math.max(...xs) - Math.min(...xs),
    height: Math.max(...ys) - Math.min(...ys),
  }
}

/** The drag box from `a` to `b` (Shift: a square on the longer side, from `a`). Pure. */
export function dragBox(a: ScenePoint, b: ScenePoint, square: boolean) {
  let w = b.x - a.x
  let h = b.y - a.y
  if (square) {
    const s = Math.max(Math.abs(w), Math.abs(h))
    w = Math.sign(w || 1) * s
    h = Math.sign(h || 1) * s
  }
  return {
    x: Math.min(a.x, a.x + w),
    y: Math.min(a.y, a.y + h),
    width: Math.abs(w),
    height: Math.abs(h),
  }
}

const randomGroupId = () => `g${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36).slice(-4)}`

/** The next shapes' style fields a polygon takes (./place.ts's for shapes). */
function polygonStyle(canvas: LobbyCanvas): Record<string, unknown> {
  const n = canvas.styles.next()
  const out: Record<string, unknown> = {}
  for (const f of [
    'strokeColor',
    'backgroundColor',
    'fillStyle',
    'strokeWidth',
    'strokeStyle',
    'roughness',
    'opacity',
  ] as const)
    if (n[f] !== undefined) out[f] = n[f]
  return out
}

/**
 * Creates `kind` in `box` (scene units; inside the unlocked frame under its centre), one undo step.
 * Returns the line's and the holder's ids (the holder is what a label and a connector attach to).
 */
export function createPolygon(
  canvas: LobbyCanvas,
  kind: PolygonKind,
  box: { x: number; y: number; width: number; height: number },
  label = `create ${kind}`,
): { line: string; holder: string } | null {
  if (canvas.readOnly() || box.width <= 0 || box.height <= 0) return null
  const frame = frameAt(
    canvas,
    { x: box.x + box.width / 2, y: box.y + box.height / 2 },
    { unlockedOnly: true },
  )
  const groupIds = [randomGroupId()]
  const frameId = frame?.id ?? null
  const style = polygonStyle(canvas)
  return canvas.transact(label, (tx) => {
    const line = tx.create('line', {
      ...style,
      ...polygonGeometry(kind, box),
      polygon: true,
      roundness: kind === 'cloud' || kind === 'heart' ? { type: 2 } : null,
      startArrowhead: null,
      endArrowhead: null,
      groupIds,
      frameId,
    })
    const holder = tx.create('rectangle', {
      x: box.x,
      y: box.y,
      width: box.width,
      height: box.height,
      strokeColor: 'transparent',
      backgroundColor: 'transparent',
      fillStyle: 'solid',
      roundness: null,
      ...(style.opacity !== undefined ? { opacity: style.opacity } : {}),
      groupIds,
      frameId,
    })
    return { line, holder }
  })
}

/** Whether `el` is a polygon's outline (a closed line). */
export const isPolygonLine = (el: CanvasElement | undefined): boolean =>
  el?.type === 'line' && (el as { polygon?: boolean }).polygon === true

/**
 * Whether `el` is a polygon's holder: a transparent rectangle grouped with a polygon line (the converter's
 * and the tools' shape). The style panel styles the line and leaves the holder see-through.
 */
export function isPolygonHolder(el: CanvasElement | undefined, canvas: Pick<LobbyCanvas, 'items'>): boolean {
  if (el?.type !== 'rectangle') return false
  const r = el as { strokeColor?: string; backgroundColor?: string }
  if (r.strokeColor !== 'transparent' || r.backgroundColor !== 'transparent') return false
  const g = el.groupIds[0]
  if (!g) return false
  return canvas
    .items()
    .some(
      (x) =>
        x.id !== el.id &&
        isPolygonLine(x) &&
        x.groupIds[0] === g &&
        !(x as { isDeleted?: boolean }).isDeleted,
    )
}

/** The drag in progress with a polygon tool (the preview overlay draws it). */
export interface PolygonDrag {
  readonly kind: PolygonKind
  readonly from: ScenePoint
  readonly to: ScenePoint
  readonly square: boolean
}

const drags = new WeakMap<LobbyCanvas, Atom<PolygonDrag | null>>()
export function polygonDrag(canvas: LobbyCanvas): Atom<PolygonDrag | null> {
  let a = drags.get(canvas)
  if (!a) {
    a = atom<PolygonDrag | null>('cux-polygon-drag', null)
    drags.set(canvas, a)
  }
  return a
}

/** Creates the shape for a finished press (a drag box, or a click's default box), selects it, tool → Select. */
export function finishPolygon(
  ctx: CanvasFeatureContext,
  kind: PolygonKind,
  from: ScenePoint,
  to: ScenePoint,
  square: boolean,
) {
  const { canvas } = ctx
  const dragged = Math.hypot(to.x - from.x, to.y - from.y) >= DRAG_MIN
  const box = dragged
    ? dragBox(from, to, square)
    : {
        x: from.x - POLYGON_SIZE / 2,
        y: from.y - POLYGON_SIZE / 2,
        width: POLYGON_SIZE,
        height: POLYGON_SIZE,
      }
  const made = createPolygon(canvas, kind, box)
  canvas.setTool('select')
  if (made) canvas.select([made.line, made.holder])
  return made
}

/** canvas-ux's polygon pointer tools (./index.tsx registers them; the toolbar lists them in More). */
export function polygonTools(): FeatureToolSpec[] {
  return POLYGON_TOOLS.map(
    (t): FeatureToolSpec => ({
      id: t.id,
      label: t.label,
      readOnlyAllowed: false,
      cursor: 'crosshair',
      onPointerDown: (e, ctx) => {
        const drag = polygonDrag(ctx.canvas)
        drag.set({ kind: t.id, from: e.point, to: e.point, square: e.shiftKey })
        const off = ctx.canvas.on('input', (ev) => {
          if (ev.type === 'pointer-move') {
            const d = drag.get()
            if (d) drag.set({ ...d, to: ev.scene, square: ev.shift })
          } else if (ev.type === 'pointer-up') off()
        })
      },
      onPointerUp: (e, ctx) => {
        const drag = polygonDrag(ctx.canvas)
        const d = drag.get()
        drag.set(null)
        if (!d || ctx.canvas.tool() !== t.id) return
        // the engine's pointer-up point of a custom tool is its press point: the drag's own last point counts
        const far = (q: ScenePoint) => Math.hypot(q.x - d.from.x, q.y - d.from.y)
        const to = far(d.to) >= far(e.point) ? d.to : e.point
        finishPolygon(ctx, t.id, d.from, to, e.shiftKey || d.square)
      },
      onExit: (ctx) => polygonDrag(ctx.canvas).set(null),
    }),
  )
}

/**
 * The polygon holder a double-click at `point` labels (D4): the holder hit or the one of the line hit, else
 * the topmost holder whose box holds the point (a polygon with no fill is hit by its outline only).
 */
export function polygonHolderAt(
  canvas: Pick<LobbyCanvas, 'items' | 'bounds'>,
  point: ScenePoint,
  hit: CanvasElement | null,
): CanvasElement | null {
  const all = canvas.items()
  if (hit && isPolygonHolder(hit, canvas)) return hit
  if (hit && isPolygonLine(hit)) {
    const g = hit.groupIds[0]
    return all.find((e) => e.groupIds[0] === g && isPolygonHolder(e, canvas)) ?? null
  }
  if (hit) return null
  for (let i = all.length - 1; i >= 0; i--) {
    const e = all[i] as CanvasElement
    if (!isPolygonHolder(e, canvas)) continue
    const b = canvas.bounds(e.id)
    if (b && point.x >= b.x && point.x <= b.x + b.width && point.y >= b.y && point.y <= b.y + b.height)
      return e
  }
  return null
}
