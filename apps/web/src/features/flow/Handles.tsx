// OWNER: W4 (wave L, L4-1). The + handles: four small buttons on the sides of the shape under the pointer (or
// the one selected shape) that flows can be built from. A screen-layer overlay of DOM buttons over the canvas
// (the layer takes no clicks; the buttons do).
//
//  - click: the next connected shape that way (./runtime.ts `next`, the same as Ctrl/Cmd+Arrow), its editor open;
//  - drag: a ghost of the shape follows the pointer; dropped on another shape, it connects the two (a bound
//    connector, one undo step); dropped anywhere else, the connected shape is made there.
// Off for read-only roles, frames, locked shapes and mind-map topics (./planner.ts flowKindOf), while a gesture
// or an editor is in progress, and while a new shape's editor is on its way. The keyboard's way is Ctrl/Cmd+Arrow
// (the buttons say so), so they are not tab stops. They never cover the engine's rotation handle of the selection
// (a button that would moves out past it), so rotating a selected shape by its handle still works.
import { type PointerEvent as ReactPointerEvent, useEffect, useRef, useState } from 'react'
import { type CanvasFeatureContext, currentPlatform, formatChord, items } from '../../canvas/api/index.ts'
import { useValue } from '../../lib/signals.ts'
import { FLOW_DIRS, type FlowDir } from './connector.ts'
import { boxOfElement, flowKindOf, flowSourceOf } from './planner.ts'
import { flowRuntimeOf } from './runtime.ts'
import './flow.css'

/** Screen px between a shape's side and its + button's centre. */
export const HANDLE_OFFSET = 22
/** A press that moves this far (screen px) is a drag. */
const DRAG_PX = 6
/** How long the handles of a shape the pointer just left stay, so the pointer can reach them (ms). */
const LINGER_MS = 700

/**
 * The engine draws the selection's rotation handle this many screen px beyond its top edge (rotated with it):
 * Excalidraw's transformHandles.ts, a 16 px gap plus the handle's margins, at any zoom; the handle is 8 px across
 * for a mouse and 28 px on a touch screen. A + button never covers it: one whose centre is closer than
 * ROTATION_CLEARANCE moves out along its own direction until it is clear (the up button of a selected shape sits
 * above the rotation handle).
 */
export const ROTATION_HANDLE_GAP = 20
export const ROTATION_CLEARANCE = 30

type Pt = { readonly x: number; readonly y: number }
const OUTWARD: Readonly<Record<FlowDir, Pt>> = {
  right: { x: 1, y: 0 },
  left: { x: -1, y: 0 },
  down: { x: 0, y: 1 },
  up: { x: 0, y: -1 },
}

/** `p` (the centre of the + button going `dir`), moved out along `dir` until it is clear of `rotation`. */
export function clearOfRotation(p: Pt, dir: FlowDir, rotation: Pt | null): Pt {
  if (!rotation) return p
  const u = OUTWARD[dir]
  let q = p
  for (let i = 0; i < 60 && Math.hypot(q.x - rotation.x, q.y - rotation.y) < ROTATION_CLEARANCE; i++)
    q = { x: q.x + 2 * u.x, y: q.y + 2 * u.y }
  return q
}

/** Where the engine draws the selection's rotation handle (overlay px), or null when it draws none. */
export function rotationHandleAt(
  canvas: Pick<
    CanvasFeatureContext['canvas'],
    'selection' | 'get' | 'isLocked' | 'editingId' | 'viewport' | 'boundsOf' | 'sceneToOverlay'
  >,
): Pt | null {
  const sel = canvas.selection
  if (!sel.length || canvas.editingId() !== null) return null
  const gap = ROTATION_HANDLE_GAP / (canvas.viewport.get().zoom || 1)
  if (sel.length === 1) {
    const el = canvas.get(sel[0] as string)
    if (!el || el.isDeleted || canvas.isLocked(el.id) || el.type === 'arrow' || el.type === 'line')
      return null
    // its own box turned about its centre: the handle is `gap` beyond its top edge, turned with it
    const angle = (el as { angle?: number }).angle ?? 0
    const d = el.height / 2 + gap
    const cx = el.x + el.width / 2
    const cy = el.y + el.height / 2
    return canvas.sceneToOverlay({ x: cx + d * Math.sin(angle), y: cy - d * Math.cos(angle) })
  }
  const b = canvas.boundsOf(sel)
  return b ? canvas.sceneToOverlay({ x: b.x + b.width / 2, y: b.y - gap }) : null
}

const WORDS: Readonly<Record<FlowDir, string>> = { right: 'right', left: 'left', down: 'below', up: 'above' }
const KEY: Readonly<Record<FlowDir, string>> = {
  right: 'mod+arrowright',
  left: 'mod+arrowleft',
  down: 'mod+arrowdown',
  up: 'mod+arrowup',
}

interface Drag {
  readonly dir: FlowDir
  readonly source: string
  readonly start: { x: number; y: number }
  moved: boolean
  pointerId: number
}

export function FlowHandles({ ctx }: { ctx: CanvasFeatureContext }) {
  const { canvas } = ctx
  // the shape the pointer is over (a label stands for its container) and the one selected source, when they may
  // grow a flow
  const now = useValue('flow-handles-target', () => {
    // a press is not yet a gesture: the board reads a press on a + button as 'pressing' too (its pointer is
    // down), and the button must stay for its own pointerup
    const gesture = canvas.gesture()
    if (canvas.readOnly() || canvas.editingId() !== null || (gesture !== 'idle' && gesture !== 'pressing'))
      return null
    const rt = flowRuntimeOf(canvas)
    if (!rt || rt.waiting) return null
    const h = canvas.hovered()
    const hel = h ? canvas.get(h) : undefined
    const hid = hel ? items.containerOf(hel, (x) => canvas.get(x)).id : null
    const hover = hid && flowKindOf(canvas, canvas.get(hid)) ? hid : null
    const selected = flowSourceOf(canvas, canvas.selection)
    return { hover, selected }
  }, [canvas])
  const [lingering, setLingering] = useState<string | null>(null)
  const [overButton, setOverButton] = useState(false)
  const [ghost, setGhost] = useState<{ x: number; y: number; w: number; h: number } | null>(null)
  const drag = useRef<Drag | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  // the shape the pointer left keeps its handles a moment (and while the pointer is on one of them)
  const hover = now?.hover ?? null
  useEffect(() => {
    if (hover) {
      if (timer.current) clearTimeout(timer.current)
      timer.current = null
      setLingering(hover)
      return
    }
    if (overButton || drag.current) return
    timer.current = setTimeout(() => setLingering(null), LINGER_MS)
    return () => {
      if (timer.current) clearTimeout(timer.current)
    }
  }, [hover, overButton])

  const target = drag.current?.source ?? (now ? (hover ?? lingering ?? now.selected) : null)

  const place = useValue('flow-handles-place', () => {
    if (!target) return null
    const el = canvas.get(target)
    if (!el || el.isDeleted || !flowKindOf(canvas, el)) return null
    canvas.viewport.get()
    const b = boxOfElement(el)
    const at = (x: number, y: number) => canvas.sceneToOverlay({ x, y })
    const tl = at(b.x, b.y)
    const br = at(b.x + b.w, b.y + b.h)
    const cx = (tl.x + br.x) / 2
    const cy = (tl.y + br.y) / 2
    const rotation = rotationHandleAt(canvas)
    return {
      right: clearOfRotation({ x: br.x + HANDLE_OFFSET, y: cy }, 'right', rotation),
      left: clearOfRotation({ x: tl.x - HANDLE_OFFSET, y: cy }, 'left', rotation),
      down: clearOfRotation({ x: cx, y: br.y + HANDLE_OFFSET }, 'down', rotation),
      up: clearOfRotation({ x: cx, y: tl.y - HANDLE_OFFSET }, 'up', rotation),
      size: { w: br.x - tl.x, h: br.y - tl.y },
    }
  }, [canvas, target])
  if (!target || !place) return null

  const platform = currentPlatform()
  const onDown = (dir: FlowDir) => (e: ReactPointerEvent<HTMLButtonElement>) => {
    if (e.button !== 0) return
    e.preventDefault()
    e.stopPropagation()
    e.currentTarget.setPointerCapture?.(e.pointerId)
    drag.current = {
      dir,
      source: target,
      start: { x: e.clientX, y: e.clientY },
      moved: false,
      pointerId: e.pointerId,
    }
  }
  const onMove = (e: ReactPointerEvent<HTMLButtonElement>) => {
    const d = drag.current
    if (!d || d.pointerId !== e.pointerId) return
    if (!d.moved && Math.hypot(e.clientX - d.start.x, e.clientY - d.start.y) < DRAG_PX) return
    d.moved = true
    const root = canvas.container()?.getBoundingClientRect() ?? { left: 0, top: 0 }
    setGhost({ x: e.clientX - root.left, y: e.clientY - root.top, w: place.size.w, h: place.size.h })
  }
  const onUp = (e: ReactPointerEvent<HTMLButtonElement>) => {
    const d = drag.current
    if (!d || d.pointerId !== e.pointerId) return
    drag.current = null
    setGhost(null)
    e.currentTarget.releasePointerCapture?.(e.pointerId)
    const rt = flowRuntimeOf(canvas)
    if (!rt || canvas.readOnly()) return
    canvas.focus({ preventScroll: true })
    if (!d.moved) {
      rt.next(d.source, d.dir)
      return
    }
    const scene = canvas.screenToScene({ x: e.clientX, y: e.clientY })
    const hit = canvas.hitTest(scene, { filter: (el) => el.id !== d.source })
    const onto = hit ? items.containerOf(hit, (x) => canvas.get(x)).id : null
    if (onto && onto !== d.source && rt.connect(d.source, onto)) return
    rt.next(d.source, d.dir, { at: scene })
  }
  const onCancel = () => {
    drag.current = null
    setGhost(null)
  }

  return (
    <div className="dr-flow-handles" data-testid="flow-handles" data-flow-source={target}>
      {FLOW_DIRS.map((dir) => {
        const p = place[dir]
        return (
          <button
            key={dir}
            type="button"
            tabIndex={-1}
            className="dr-flow-handle"
            data-testid={`flow-handle-${dir}`}
            aria-label={`Add a connected shape ${WORDS[dir]}`}
            title={`Add a connected shape ${WORDS[dir]} (${formatChord(KEY[dir], platform)}); drag onto a shape to connect it`}
            style={{ left: p.x, top: p.y }}
            onPointerEnter={() => setOverButton(true)}
            onPointerLeave={() => setOverButton(false)}
            onPointerDown={onDown(dir)}
            onPointerMove={onMove}
            onPointerUp={onUp}
            onPointerCancel={onCancel}
          >
            <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
              <path d="M8 3v10M3 8h10" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
            </svg>
          </button>
        )
      })}
      {ghost && (
        <div
          className="dr-flow-ghost"
          data-testid="flow-ghost"
          aria-hidden="true"
          style={{ left: ghost.x - ghost.w / 2, top: ghost.y - ghost.h / 2, width: ghost.w, height: ghost.h }}
        />
      )}
    </div>
  )
}
