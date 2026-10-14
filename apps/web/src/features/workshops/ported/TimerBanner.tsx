// P-016: the running session timer, big enough to read for everyone. The Facilitate button's small figure was the only
// sign of a timer for a participant. This is a pill at the top centre of the canvas, in the board's top-centre stack
// in its own `timer` slot (above the spotlight's box, so the two never overlap; the box is only there while the pill
// is, so an idle timer leaves no gap), with the last ten seconds emphasised.
// Read-only: the timer is still set in the Facilitate popover. While presenting, and on phones, the floating
// read-only timers of ./WorkshopOverlay.tsx stay (the stack is not drawn over the slides; a phone has no room).
import type { CanvasFeatureContext } from '../../../canvas/api/index.ts'
import { TopCentreItem } from '../../../canvas/overlay/top-centre.tsx'
import { PHONE_QUERY, useMediaQuery } from '../../../ui/useMedia.ts'
import { formatClock, inLastSeconds, timerDisplayPhase, timerRemainingMs } from '../countdown.ts'
import { useNow, useWorkshop } from '../workshop-context.ts'
import { usePresentingHere } from './presenting.ts'
import { StopwatchIcon } from './WorkshopBar.tsx'

export function TimerBanner({ ctx }: { ctx: CanvasFeatureContext }) {
  const { store, snap } = useWorkshop(ctx)
  const presenting = usePresentingHere(ctx.canvas)
  const phone = useMediaQuery(PHONE_QUERY)
  const now = useNow(snap.timer?.status === 'running')
  if (!snap.timer || presenting || phone) return null
  const offset = store.serverOffsetMs()
  const phase = timerDisplayPhase(snap.timer, now, offset)
  if (phase !== 'running' && phase !== 'paused' && phase !== 'finished') return null
  const left = timerRemainingMs(snap.timer, now, offset)
  const urgent = phase === 'running' && inLastSeconds(left)
  return (
    <TopCentreItem slot="timer">
      <div
        className="dr-wk-banner-timer"
        data-testid="timer-banner"
        data-state={phase}
        data-urgent={urgent ? 'true' : 'false'}
        role="timer"
        aria-live="off"
        aria-label="Session timer"
      >
        <StopwatchIcon size={20} />
        <span className="dr-wk-banner-timer__clock" data-testid="timer-banner-clock">
          {formatClock(left)}
        </span>
        {phase === 'paused' && <span className="dr-wk-banner-timer__note">Paused</span>}
      </div>
    </TopCentreItem>
  )
}
