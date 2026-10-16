// OWNER: WS2 (wave T, storyboards). The storyboard's chrome on the canvas, in a `scene` layer of the overlay root
// (never an element: shot numbers are derived from `sb:pos`, so two tabs with the same keys always show the same
// numbers, and a tab that receives a reorder writes nothing):
//  - each panel's chip in its header band, "SH 03" and its duration, scaled with the zoom;
//  - the head's line: how many panels, the running time and the aspect;
//  - for the one selected panel (an editor in a rev-14 room only): the "+" handles at its sides that insert a panel
//    before or after it.
// Focus mode (presenting) hides the layer.
import { formatDuration, formatRunningTime, storyboardTimings } from '@draftroom/canvas-schema/planning'
import type { CanvasFeatureContext } from '../../canvas/api/index.ts'
import { useValue } from '../../lib/signals.ts'
import { PANEL_HEADER, shotLabel } from './model.ts'
import { insertPanel } from './ops.ts'
import { boardsOf, offered, selectedPanelIndex, selectedStoryboard, shown } from './state.ts'

interface PlacedChip {
  readonly id: string
  readonly n: number
  readonly ms: number
  readonly x: number
  readonly y: number
  readonly scale: number
}

interface PlacedHead {
  readonly id: string
  readonly x: number
  readonly y: number
  readonly scale: number
  readonly text: string
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v))

function placed(ctx: CanvasFeatureContext): { chips: PlacedChip[]; heads: PlacedHead[] } {
  const { canvas } = ctx
  if (!shown()) return { chips: [], heads: [] }
  const zoom = canvas.viewport.get().zoom // the camera: chips move with it
  const scale = clamp(zoom, 0.7, 1.6)
  const chips: PlacedChip[] = []
  const heads: PlacedHead[] = []
  for (const sb of boardsOf(canvas).values()) {
    const t = storyboardTimings(sb)
    t.panels.forEach((row) => {
      const f = canvas.get(row.id)
      if (!f || f.isDeleted || canvas.isHidden(row.id)) return
      // inside the header band, its top-left inset by a quarter of the band
      const p = canvas.sceneToOverlay({ x: f.x + 12, y: f.y + (PANEL_HEADER - 26) / 2 })
      chips.push({ id: row.id, n: row.number, ms: row.durationMs, x: p.x, y: p.y, scale })
    })
    const head = sb.head ? canvas.get(sb.head.id) : undefined
    if (head && !head.isDeleted && !canvas.isHidden(head.id)) {
      const p = canvas.sceneToOverlay({ x: head.x + head.width + 16, y: head.y + head.height / 2 })
      const aspect = sb.settings?.aspect ?? '16:9'
      const n = sb.panels.length
      heads.push({
        id: head.id,
        x: p.x,
        y: p.y,
        scale,
        text: `${n} ${n === 1 ? 'panel' : 'panels'} · ${formatRunningTime(t.totalMs)} · ${aspect}`,
      })
    }
  }
  return { chips, heads }
}

export function StoryboardChipsLayer({ ctx }: { ctx: CanvasFeatureContext }) {
  const view = useValue('storyboard.chips', () => placed(ctx), [ctx])
  if (!view.chips.length && !view.heads.length) return null
  return (
    <div className="dr-sb-layer" data-testid="sb-chips">
      {view.chips.map((c) => (
        <div
          key={c.id}
          className="dr-sb-chip"
          data-testid="sb-chip"
          data-panel-id={c.id}
          data-shot={c.n}
          aria-hidden="true"
          style={{ transform: `translate(${Math.round(c.x)}px, ${Math.round(c.y)}px) scale(${c.scale})` }}
        >
          <span className="dr-sb-chip__num">{shotLabel(c.n)}</span>
          <span className="dr-sb-chip__dur">{formatDuration(c.ms)}</span>
        </div>
      ))}
      {view.heads.map((h) => (
        <div
          key={h.id}
          className="dr-sb-headline"
          data-testid="sb-head-meta"
          data-head-id={h.id}
          aria-hidden="true"
          style={{
            transform: `translate(${Math.round(h.x)}px, ${Math.round(h.y)}px) translateY(-50%) scale(${h.scale})`,
          }}
        >
          {h.text}
        </div>
      ))}
      <InsertHandles ctx={ctx} />
    </div>
  )
}

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
