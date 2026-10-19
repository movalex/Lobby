// OWNER: WS4 (wave V, breakouts). The breakouts chip in the board's top-centre stack (slot 'breakout', right under the
// session timer): "Group 2 · 8:30 left · Go to my frame" for a member; "Breakouts · 4 groups · 8:30 left · Manage"
// for the facilitator; "Pick your group" in choose mode; "Breakouts ended" for a minute after the end. It wraps at
// phone width, its buttons are 44 px for a finger, and a screen reader hears the group when it changes (not every
// second of the clock).
import { useEffect, useState } from 'react'
import type { CanvasFeatureContext } from '../../canvas/api/index.ts'
import { useValue } from '../../lib/signals.ts'
import { liveEnabled } from '../live/index.ts'
import { TopCentreItem } from '../workshops/top-centre.ts'
import { frameExists, goToFrame } from './camera.ts'
import { chipModel, groupOf } from './model.ts'
import { type BreakoutStore, breakoutStoreOf } from './store.ts'

export const BREAKOUTS_PANEL_ID = 'breakouts'

/** Re-renders every second while `on` (the clock is drawn from the server's end time each time). */
export function useSecondTick(on: boolean): void {
  const [, setN] = useState(0)
  useEffect(() => {
    if (!on) return
    const t = setInterval(() => setN((n) => n + 1), 1000)
    return () => clearInterval(t)
  }, [on])
}

export function BreakoutChipLayer({ ctx }: { ctx: CanvasFeatureContext }) {
  const store = breakoutStoreOf(ctx.canvas)
  const on = useValue('dr-brk-on', () => liveEnabled('breakouts'), [])
  if (!store || !on) return null
  return <BreakoutChip ctx={ctx} store={store} />
}

export function BreakoutChip({ ctx, store }: { ctx: CanvasFeatureContext; store: BreakoutStore }) {
  const state = useValue(store.state)
  const saw = useValue(store.sawRunning)
  const [dismissed, setDismissed] = useState<string | null>(null)
  const running = state?.session?.status === 'running'
  useSecondTick(!!state?.session)
  const mine = state ? groupOf(state, state.myGroupId) : null
  const exists = useValue(
    'dr-brk-frame-exists',
    () => (mine ? frameExists(ctx.canvas, mine.frameId) : true),
    [ctx.canvas, mine?.frameId],
  )
  const model = chipModel(state, {
    nowMs: store.serverNow(),
    frameExists: () => exists,
    sawRunning: saw,
  })
  if (!model || !state?.session) return null
  if (model.kind === 'ended' && dismissed === state.session.id) return null
  return (
    <TopCentreItem slot="breakout">
      <section
        className="dr-brk-chip"
        data-testid="breakout-chip"
        data-kind={model.kind}
        data-group={state.myGroupId ?? ''}
        aria-label="Breakouts"
      >
        <span className="dr-sr-only" aria-live="polite">
          {model.kind === 'member' ? `You are in ${model.title}` : model.title}
        </span>
        <span className="dr-brk-chip__title" data-testid="breakout-chip-title" aria-hidden="true">
          {model.title}
        </span>
        {model.time && (
          <span className="dr-brk-chip__time" data-testid="breakout-chip-time">
            {model.time}
          </span>
        )}
        {model.frameRemoved && (
          <span className="dr-brk-chip__warn" data-testid="breakout-frame-removed">
            Frame removed
          </span>
        )}
        {model.canGo && mine && (
          <button
            type="button"
            className="dr-brk-chip__btn dr-brk-chip__btn--go"
            data-testid="breakout-go"
            onClick={() => {
              goToFrame(ctx.canvas, mine.frameId)
              ctx.canvas.focus({ preventScroll: true })
            }}
          >
            Go to my frame
          </button>
        )}
        {model.kind === 'choose' && (
          <button
            type="button"
            className="dr-brk-chip__btn dr-brk-chip__btn--go"
            data-testid="breakout-pick"
            onClick={() => ctx.openPanel(BREAKOUTS_PANEL_ID)}
          >
            Pick a group
          </button>
        )}
        {(model.kind === 'facilitator' || (running && state.canManage)) && (
          <button
            type="button"
            className="dr-brk-chip__btn"
            data-testid="breakout-manage"
            onClick={() => ctx.openPanel(BREAKOUTS_PANEL_ID)}
          >
            Manage
          </button>
        )}
        {model.kind === 'ended' && (
          <button
            type="button"
            className="dr-brk-chip__x"
            data-testid="breakout-dismiss"
            aria-label="Dismiss"
            onClick={() => setDismissed(state.session?.id ?? null)}
          >
            ×
          </button>
        )}
      </section>
    </TopCentreItem>
  )
}
