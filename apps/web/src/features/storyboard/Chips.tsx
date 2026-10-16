// OWNER: WS2 (wave T, storyboards). The storyboard's chrome on the canvas, in a `scene` layer of the overlay root
// (never an element: shot numbers are derived from `sb:pos`, so two tabs with the same keys always show the same
// numbers, and a tab that receives a reorder writes nothing):
//  - each panel's chip in its header band, "SH 03" and its duration, scaled with the zoom;
//  - the head's line: how many panels, the running time and the aspect;
//  - for the one selected panel (an editor in a rev-14 room only): the "+" handles at its sides that insert a panel
//    before or after it.
// Focus mode (presenting) hides the layer. On a big board the work per camera frame is the cull only: the rows are
// in scene coordinates (chip-model.ts, each storyboard's reused while its elements keep their versions), one
// container carries the camera's transform, and only the rows on screen are drawn.
import { formatDuration } from '@draftroom/canvas-schema/planning'
import { type CSSProperties, memo, useMemo } from 'react'
import type { CanvasFeatureContext } from '../../canvas/api/index.ts'
import { computed, useValue } from '../../lib/signals.ts'
import { type ChipModel, ChipModelCache, type ChipRow, type HeadRow, visibleRows } from './chip-model.ts'
import { shotLabel } from './model.ts'
import { insertPanel } from './ops.ts'
import { offered, selectedPanelIndex, selectedStoryboard, shown } from './state.ts'

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v))
const EMPTY: ChipModel = { chips: [], heads: [] }

export function StoryboardChipsLayer({ ctx }: { ctx: CanvasFeatureContext }) {
  const { canvas } = ctx
  // the rows: recomputed on a scene change (and then only for a storyboard whose elements changed), never per frame
  const model = useValue(
    useMemo(() => {
      const cache = new ChipModelCache()
      return computed('storyboard.chip-model', () => (shown() ? cache.build(canvas) : EMPTY))
    }, [canvas]),
  )
  const v = useValue('storyboard.viewport', () => canvas.viewport.get(), [canvas])
  const chips = useMemo(() => visibleRows(model.chips, v), [model, v])
  const heads = useMemo(() => visibleRows(model.heads, v), [model, v])
  if (!model.chips.length && !model.heads.length) return null
  // the chips keep their screen size between 70 % and 160 % of the zoom, inside the camera's one transform
  const s = clamp(v.zoom, 0.7, 1.6) / Math.max(v.zoom, 0.01)
  return (
    <div className="dr-sb-layer" data-testid="sb-chips">
      <div
        className="dr-sb-scene"
        style={
          {
            transform: `scale(${v.zoom}) translate(${-v.x}px, ${-v.y}px)`,
            '--dr-sb-s': s,
          } as CSSProperties
        }
      >
        {chips.map((c) => (
          <Chip key={c.id} c={c} />
        ))}
        {heads.map((h) => (
          <HeadLine key={h.id} h={h} />
        ))}
      </div>
      <InsertHandles ctx={ctx} />
    </div>
  )
}

const Chip = memo(function Chip({ c }: { c: ChipRow }) {
  return (
    <div
      className="dr-sb-chip"
      data-testid="sb-chip"
      data-panel-id={c.id}
      data-shot={c.n}
      aria-hidden="true"
      style={{ transform: `translate(${c.x}px, ${c.y}px) scale(var(--dr-sb-s))` }}
    >
      <span className="dr-sb-chip__num">{shotLabel(c.n)}</span>
      <span className="dr-sb-chip__dur">{formatDuration(c.ms)}</span>
    </div>
  )
})

const HeadLine = memo(function HeadLine({ h }: { h: HeadRow }) {
  return (
    <div
      className="dr-sb-headline"
      data-testid="sb-head-meta"
      data-head-id={h.id}
      aria-hidden="true"
      style={{ transform: `translate(${h.x}px, ${h.y}px) translateY(-50%) scale(var(--dr-sb-s))` }}
    >
      {h.text}
    </div>
  )
})

/** The "+" handles of the one selected panel. */
function InsertHandles({ ctx }: { ctx: CanvasFeatureContext }) {
  const { canvas } = ctx
  const at = useValue('storyboard.handles', () => {
    if (!shown() || !offered(canvas) || canvas.selection.length !== 1) return null
    const sb = selectedStoryboard(canvas)
    if (!sb) return null
    const i = selectedPanelIndex(canvas, sb)
    const f = i >= 0 ? canvas.get(sb.panels[i]?.id ?? '') : undefined
    if (!f || f.isDeleted || f.locked) return null
    canvas.viewport.get()
    const left = canvas.sceneToOverlay({ x: f.x, y: f.y + f.height / 2 })
    const right = canvas.sceneToOverlay({ x: f.x + f.width, y: f.y + f.height / 2 })
    return { sb, i, left, right, n: i + 1 }
  }, [canvas])
  if (!at) return null
  const add = (index: number) => {
    const id = insertPanel(canvas, at.sb, index)
    if (!id) ctx.notify({ key: 'storyboard', tone: 'error', text: 'The panel could not be added.' })
  }
  return (
    <>
      <button
        type="button"
        className="dr-sb-plus"
        data-testid="sb-insert-before"
        aria-label={`Insert a panel before shot ${at.n}`}
        title="Insert a panel before"
        style={{
          transform: `translate(${Math.round(at.left.x)}px, ${Math.round(at.left.y)}px) translate(-50%, -50%)`,
        }}
        onPointerDown={(e) => e.stopPropagation()}
        onClick={() => add(at.i)}
      >
        <PlusIcon />
      </button>
      <button
        type="button"
        className="dr-sb-plus"
        data-testid="sb-insert-after"
        aria-label={`Insert a panel after shot ${at.n}`}
        title="Insert a panel after"
        style={{
          transform: `translate(${Math.round(at.right.x)}px, ${Math.round(at.right.y)}px) translate(-50%, -50%)`,
        }}
        onPointerDown={(e) => e.stopPropagation()}
        onClick={() => add(at.i + 1)}
      >
        <PlusIcon />
      </button>
    </>
  )
}

export function PlusIcon() {
  return (
    <svg viewBox="0 0 16 16" width={14} height={14} aria-hidden="true" focusable="false">
      <path d="M8 3v10M3 8h10" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  )
}
