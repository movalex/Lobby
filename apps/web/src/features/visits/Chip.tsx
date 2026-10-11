// OWNER: WS4 (wave N, N4-3). The "Since you were here" chip, in the board's top-centre stack, and the highlights'
// outlines (a scene layer). Both read ./view.ts and draw only: nothing here writes the board, and the outlines take no
// clicks. The chip hides for a first visit or zero changes (there is no view then), after Mark all seen or ×, and while
// presenting or following someone.
//
//   Since you were here (Tue 3:40 pm): 5 added · 3 changed · 1 removed     [Next change] [Mark all seen] [×]
import { useEffect, useRef } from 'react'
import type { CanvasFeatureContext } from '../../canvas/api/index.ts'
import { TOP_CENTRE_SLOTS, type TopCentreSlot } from '../../canvas/overlay/top-centre.ts'
import { TopCentreItem } from '../../canvas/overlay/top-centre.tsx'
import { useValue } from '../../lib/signals.ts'
import { countUsage } from '../../lib/usage.ts'
import { getLive } from '../present-export/live/ported/controller.ts'
import { chipText, countsText } from './model.ts'
import { planOutlines, tourStops, visitsView } from './view.ts'

/**
 * The chip's place in the stack. A slot of its own ('since', between 'follow' and 'coach') is a one-word change in
 * canvas/overlay/top-centre.ts (WS1's file); until it lands the chip sits in the last slot, 'feedback'.
 */
export const VISITS_SLOT: TopCentreSlot = (TOP_CENTRE_SLOTS as readonly string[]).includes('since')
  ? ('since' as unknown as TopCentreSlot)
  : 'feedback'

/** Whether the highlights are out of the way: presenting (present mode, a presentation to everyone) or following. */
export function useQuiet(ctx: CanvasFeatureContext): boolean {
  const { canvas } = ctx
  return useValue(
    'lobby-visits-quiet',
    () =>
      canvas.settings.get().focusMode ||
      canvas.follow.current() !== null ||
      getLive(ctx.registries)?.presentingLive.get() === true,
    [canvas, ctx.registries],
  )
}

export interface ChipActions {
  next(): void
  markSeen(): void
  hide(): void
  toggleRemoved(): void
}

export function VisitsChip({ ctx, actions }: { ctx: CanvasFeatureContext; actions: ChipActions }) {
  const view = useValue(visitsView(ctx.canvas))
  const quiet = useQuiet(ctx)
  const shown = view !== null && !view.hidden && !quiet
  // one count each time the chip first comes up for this visit (how often it is in front of someone, not how long)
  const counted = useRef(false)
  useEffect(() => {
    if (!shown || counted.current) return
    counted.current = true
    countUsage('visits.chip.shown')
  }, [shown])
  if (!view || !shown) return null
  const { changes } = view
  const stops = tourStops(changes, (id) => ctx.canvas.bounds(id))
  const named = changes.removed.some((r) => r.name)
  const text = chipText(changes, Date.now())
  const lead = text.slice(0, text.indexOf('): ') + 2)
  return (
    <TopCentreItem slot={VISITS_SLOT}>
      <div
        className="dr-visits-chip"
        data-testid="visits-chip"
        data-since={changes.seenAt}
        data-added={changes.counts.added}
        data-changed={changes.counts.changed}
        data-removed={changes.counts.removed}
        role="status"
      >
        <div className="dr-visits-chip__row">
          <span className="dr-visits-chip__text" data-testid="visits-chip-text">
            <span className="dr-visits-chip__lead">{lead.trimEnd()}</span> {countsText(changes.counts)}
          </span>
          {changes.counts.removed > 0 && named ? (
            <button
              type="button"
              className="dr-visits-chip__btn"
              data-testid="visits-removed-toggle"
              aria-expanded={view.removedOpen}
              onClick={actions.toggleRemoved}
            >
              {view.removedOpen ? 'Hide removed' : 'Show removed'}
            </button>
          ) : null}
          {stops.length > 0 ? (
            <button
              type="button"
              className="dr-visits-chip__btn dr-visits-chip__btn--next"
              data-testid="visits-next"
              onClick={actions.next}
            >
              Next change
            </button>
          ) : null}
          <button
            type="button"
            className="dr-visits-chip__btn"
            data-testid="visits-mark-seen"
            onClick={actions.markSeen}
          >
            Mark all seen
          </button>
          <button
            type="button"
            className="dr-iconbtn dr-iconbtn--sm dr-visits-chip__x"
            aria-label="Hide for now"
            title="Hide for now"
            data-testid="visits-dismiss"
            onClick={actions.hide}
          >
            ×
          </button>
        </div>
        {view.removedOpen && named ? (
          <ul className="dr-visits-chip__removed" data-testid="visits-removed-list">
            {changes.removed.map((r) => (
              <li key={r.id}>{r.name ?? 'An item'}</li>
            ))}
          </ul>
        ) : null}
      </div>
    </TopCentreItem>
  )
}

interface Box {
  id: string
  kind: string
  x: number
  y: number
  w: number
  h: number
  ring: boolean
}

/** The outlines: a scene layer drawing a box over each added and changed element (at most 200), the tour's stop ringed. */
export function VisitsOutlines({ ctx }: { ctx: CanvasFeatureContext }) {
  const { canvas } = ctx
  const quiet = useQuiet(ctx)
  const json = useValue('lobby-visits-outlines', () => {
    const view = visitsView(canvas).get()
    if (!view || view.hidden) return '[]'
    canvas.viewport.get() // follow the camera
    const screen = canvas.viewport.screenRect()
    const out: Box[] = []
    const box = (
      id: string,
      kind: string,
      b: { x: number; y: number; width: number; height: number },
      ring: boolean,
    ) => {
      const a = canvas.sceneToOverlay({ x: b.x, y: b.y })
      const z = canvas.sceneToOverlay({ x: b.x + b.width, y: b.y + b.height })
      const x = Math.min(a.x, z.x)
      const y = Math.min(a.y, z.y)
      const w = Math.abs(z.x - a.x)
      const h = Math.abs(z.y - a.y)
      if (x > screen.width || y > screen.height || x + w < 0 || y + h < 0) return // off screen
      out.push({ id, kind, x, y, w, h, ring })
    }
    const stops = view.tour >= 0 ? tourStops(view.changes, (id) => canvas.bounds(id)) : []
    const ringed = view.tour >= 0 ? stops[view.tour] : undefined
    if (view.outlines) {
      for (const o of planOutlines(view.changes).shown) {
        const b = canvas.bounds(o.id)
        if (b) box(o.id, o.kind, b, ringed?.id === o.id)
      }
      for (const r of view.changes.removed) if (r.bounds) box(r.id, 'removed', r.bounds, ringed?.id === r.id)
    } else if (ringed) box(ringed.id, ringed.kind, ringed.bounds, true)
    return JSON.stringify(out)
  }, [canvas])
  if (quiet) return null
  const boxes = JSON.parse(json) as Box[]
  if (!boxes.length) return null
  return (
    <div className="dr-visits-outlines" data-testid="visits-outlines">
      {boxes.map((b) => (
        <div
          key={`${b.kind}:${b.id}`}
          className={`dr-visits-outline dr-visits-outline--${b.kind}${b.ring ? ' dr-visits-outline--ring' : ''}`}
          data-testid="visit-outline"
          data-kind={b.kind}
          data-id={b.id}
          style={{ left: b.x - 4, top: b.y - 4, width: b.w + 8, height: b.h + 8 }}
        />
      ))}
    </div>
  )
}
