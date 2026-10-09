// L8-2: the optional "Show scores" overlay: a small chip on each placed note with the two scores the AI gave
// it, and a legend naming the axes with a way to hide it. Local to this tab: nothing here is written to the
// board, sent to anyone or kept past the tab (./scores.ts holds the scores in memory).
import type { CanvasFeatureContext } from '../../canvas/api/index.ts'
import { useValue } from '../../lib/signals.ts'
import { THEME_FILTER } from '../canvas-ux/ported/style-vocabulary.ts'
import { clearScores, scoresOf, showScores } from './scores.ts'
import './sort.css'

const signed = (n: number) => (n > 0 ? `+${n}` : String(n))

/** The chips, in scene units inside one box the camera moves and scales (a pan re-renders one transform). */
export function ScoresLayer({ ctx }: { ctx: CanvasFeatureContext }) {
  const { canvas } = ctx
  const state = useValue('lobby-sort-scores-state', () => scoresOf(canvas).get(), [canvas])
  const chips = useValue('lobby-sort-scores-chips', () => {
    const st = scoresOf(canvas).get()
    if (!st?.shown) return []
    const out: { id: string; x: number; y: number; text: string; title: string }[] = []
    for (const [id, s] of st.scores) {
      const el = canvas.get(id)
      if (!el || (el as { isDeleted?: boolean }).isDeleted) continue
      out.push({
        id,
        x: el.x + el.width - 8,
        y: el.y + 16,
        text: `${signed(s.x)} · ${signed(s.y)}`,
        title: `${st.axes[0]}: ${signed(s.x)}, ${st.axes[1]}: ${signed(s.y)}`,
      })
    }
    return out
  }, [canvas])
  const transform = useValue('lobby-sort-scores-camera', () => {
    const o = canvas.sceneToOverlay({ x: 0, y: 0 })
    return `translate(${o.x}px, ${o.y}px) scale(${canvas.viewport.get().zoom})`
  }, [canvas])
  const dark = useValue('lobby-sort-scores-theme', () => canvas.theme() === 'dark', [canvas])
  if (!state?.shown || chips.length === 0) return null
  return (
    <div
      className="dr-sort-scores"
      data-testid="sort-scores"
      style={{ transform, filter: dark ? THEME_FILTER : undefined }}
    >
      {chips.map((c) => (
        <span
          key={c.id}
          className="dr-sort-score"
          data-testid="sort-score"
          data-note-id={c.id}
          title={c.title}
          style={{ left: c.x, top: c.y }}
        >
          {c.text}
        </span>
      ))}
    </div>
  )
}

/** The legend: what the chips say, and Hide. */
export function ScoresLegend({ ctx }: { ctx: CanvasFeatureContext }) {
  const { canvas } = ctx
  const state = useValue('lobby-sort-scores-legend', () => scoresOf(canvas).get(), [canvas])
  if (!state?.shown) return null
  return (
    <div className="dr-sort-scores-legend" data-testid="sort-scores-legend">
      <span>
        Scores: {state.axes[0]} across, {state.axes[1]} up
      </span>
      <button
        type="button"
        className="dr-btn dr-btn--ghost"
        data-testid="sort-scores-hide"
        onClick={() => {
          showScores(canvas, false)
          canvas.focus({ preventScroll: true })
        }}
      >
        Hide
      </button>
      <button
        type="button"
        className="dr-btn dr-btn--ghost"
        data-testid="sort-scores-clear"
        onClick={() => clearScores(canvas)}
      >
        Forget
      </button>
    </div>
  )
}
