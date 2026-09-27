// Top-bar slot for the workshops feature: the timer pill (countdown for everyone), a vote chip while a
// vote is open, and the facilitation popover (timer controls, start a vote, gather everyone).
// Controls are hidden for people who cannot edit; the API refuses them anyway.

import { useEffect, useId, useRef, useState } from 'react'
import type { FeatureContext } from '../types.ts'
import { installAudioUnlock, playChime, readMuted, writeMuted } from './chime.ts'
import {
  crossedZero,
  describeClock,
  formatClock,
  parseDurationInput,
  type TimerPhase,
  timerPhase,
  timerRemainingMs,
} from './countdown.ts'
import { isFacilitator, useNow, useWorkshop } from './hooks.ts'
import type { WorkshopStore } from './store.ts'
import { VoteSetupDialog } from './VoteSetupDialog.tsx'

const PRESETS_MIN = [1, 3, 5, 10, 15]
const MIN = 60_000

export function StopwatchIcon({ size = 14 }: { size?: number }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} aria-hidden="true">
      <circle cx="12" cy="13.5" r="7.5" fill="none" stroke="currentColor" strokeWidth="2" />
      <path
        d="M12 13.5V9.5M9.5 2.5h5M18.5 6.5l1.5-1.5"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
      />
    </svg>
  )
}

export function WorkshopBar({ ctx }: { ctx: FeatureContext }) {
  const { store, snap } = useWorkshop(ctx)
  const facilitator = isFacilitator(ctx)
  const [open, setOpen] = useState(false)
  const [muted, setMuted] = useState(readMuted)
  const wrap = useRef<HTMLDivElement>(null)
  const pill = useRef<HTMLButtonElement>(null)
  const popId = useId()

  const running = snap.timer?.status === 'running'
  const now = useNow(running)
  const offset = store.serverOffsetMs()
  const remaining = timerRemainingMs(snap.timer, now, offset)
  const phase = timerPhase(snap.timer, now, offset)

  useEffect(() => installAudioUnlock(), [])

  // The end signal: only when this tab saw it running with time left (not for boards opened later).
  const prev = useRef<{ phase: TimerPhase; endsAt: string | null } | null>(null)
  const mutedRef = useRef(muted)
  mutedRef.current = muted
  useEffect(() => {
    const endsAt = snap.timer?.endsAt ?? null
    if (crossedZero(prev.current, phase) && prev.current?.endsAt === endsAt) {
      store.raiseTimerAlert()
      playChime({ muted: mutedRef.current })
      ctx.notify({ key: 'timer-finished', text: "Time's up", testId: 'timer-finished', timeoutMs: 8000 })
    }
    prev.current = { phase, endsAt }
  }, [phase, snap.timer?.endsAt, store, ctx])

  // Close on outside press / Escape. Escape is handled on the document because the focused control
  // can disappear under the user (Resume turns into Pause), which drops focus to <body>.
  useEffect(() => {
    if (!open) return
    const onDown = (e: PointerEvent) => {
      if (!wrap.current?.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      const inside = wrap.current?.contains(document.activeElement)
      if (!inside && document.activeElement !== document.body) return // someone else's Escape
      e.stopPropagation()
      setOpen(false)
      pill.current?.focus()
    }
    document.addEventListener('pointerdown', onDown, true)
    document.addEventListener('keydown', onKey, true)
    return () => {
      document.removeEventListener('pointerdown', onDown, true)
      document.removeEventListener('keydown', onKey, true)
    }
  }, [open])

  const vote = snap.vote
  const voteOpen = vote?.session.status === 'open'
  const shown = phase === 'running' || phase === 'paused' || phase === 'finished'
  const label = shown
    ? `Timer: ${phase === 'finished' ? "time's up" : `${describeClock(remaining)} left${phase === 'paused' ? ', paused' : ''}`}. Workshop tools`
    : 'Timer and workshop tools'

  return (
    <div className="dr-wk-bar" ref={wrap}>
      <button
        ref={pill}
        type="button"
        className="dr-wk-pill"
        data-testid="timer-pill"
        data-state={phase}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? popId : undefined}
        aria-label={label}
        title={label}
        onClick={() => setOpen((o) => !o)}
      >
        <StopwatchIcon />
        {shown ? (
          <span className="dr-wk-pill__time" data-testid="timer-remaining">
            {formatClock(remaining)}
          </span>
        ) : (
          <span className="dr-wk-pill__label">Timer</span>
        )}
      </button>
      {voteOpen && snap.ballot && (
        <button
          type="button"
          className="dr-wk-chip"
          data-testid="vote-chip"
          title="Open the voting panel"
          onClick={() => ctx.openPanel('voting')}
        >
          <span className="dr-wk-chip__dot" aria-hidden="true" />
          Voting · {snap.ballot.myRemaining} left
        </button>
      )}
      {open && (
        <WorkshopPopover
          id={popId}
          ctx={ctx}
          store={store}
          facilitator={facilitator}
          phase={phase}
          remaining={remaining}
          muted={muted}
          onMuted={(m) => {
            setMuted(m)
            writeMuted(m)
          }}
          onClose={(refocus) => {
            setOpen(false)
            if (refocus) pill.current?.focus()
          }}
        />
      )}
      {snap.setupOpen && (
        <VoteSetupDialog ctx={ctx} store={store} onClose={() => store.setSetupOpen(false)} />
      )}
    </div>
  )
}

function WorkshopPopover({
  id,
  ctx,
  store,
  facilitator,
  phase,
  remaining,
  muted,
  onMuted,
  onClose,
}: {
  id: string
  ctx: FeatureContext
  store: WorkshopStore
  facilitator: boolean
  phase: TimerPhase
  remaining: number
  muted: boolean
  onMuted(m: boolean): void
  onClose(refocus: boolean): void
}) {
  const snap = store.getSnapshot()
  const [duration, setDuration] = useState(() => formatClock(snap.timer?.durationMs || 5 * MIN))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const ref = useRef<HTMLDivElement>(null)
  const durationId = useId()
  const parsed = parseDurationInput(duration)

  useEffect(() => {
    ref.current?.querySelector<HTMLElement>('button, input')?.focus()
  }, [])

  const act = async (fn: () => Promise<{ ok: boolean; error?: string }>) => {
    setBusy(true)
    setError(null)
    const r = await fn()
    setBusy(false)
    if (!r.ok) setError(r.error ?? 'That did not work.')
    return r.ok
  }
  const timer = (action: Parameters<WorkshopStore['timerAction']>[0]) => act(() => store.timerAction(action))
  const step = (deltaMin: number) => {
    const base = parsed ?? 5 * MIN
    const next = Math.min(24 * 60 * MIN, Math.max(MIN, Math.round((base + deltaMin * MIN) / MIN) * MIN))
    setDuration(formatClock(next))
  }
  const vote = snap.vote
  const voteOpen = vote?.session.status === 'open'
  const canStart = phase === 'idle' || phase === 'stopped' || phase === 'finished'

  return (
    <div
      id={id}
      ref={ref}
      role="dialog"
      aria-label="Workshop tools"
      className="dr-wk-pop"
      data-testid="workshop-popover"
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.stopPropagation()
          onClose(true)
        }
      }}
    >
      <section className="dr-wk-pop__section" aria-label="Timer">
        <div className="dr-wk-pop__head">
          <h3>Timer</h3>
          <span className="dr-wk-pop__clock" data-state={phase}>
            {phase === 'idle' ? 'Not set' : phase === 'finished' ? "Time's up" : formatClock(remaining)}
            {phase === 'paused' && <span className="dr-muted"> · paused</span>}
          </span>
        </div>
        {facilitator ? (
          <>
            {canStart && (
              <>
                <fieldset className="dr-wk-presets">
                  <legend className="dr-sr-only">Preset durations</legend>
                  {PRESETS_MIN.map((m) => (
                    <button
                      key={m}
                      type="button"
                      className="dr-wk-preset"
                      aria-pressed={parsed === m * MIN}
                      data-testid={`timer-preset-${m}`}
                      onClick={() => setDuration(formatClock(m * MIN))}
                    >
                      {m} min
                    </button>
                  ))}
                </fieldset>
                <div className="dr-wk-duration">
                  <label htmlFor={durationId}>Duration</label>
                  <button
                    type="button"
                    className="dr-iconbtn dr-wk-step"
                    aria-label="One minute less"
                    onClick={() => step(-1)}
                  >
                    −
                  </button>
                  <input
                    id={durationId}
                    className="dr-input dr-wk-duration__input"
                    data-testid="timer-duration"
                    value={duration}
                    inputMode="numeric"
                    aria-invalid={parsed === null}
                    aria-describedby={`${durationId}-hint`}
                    onChange={(e) => setDuration(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && parsed) void timer({ action: 'start', durationMs: parsed })
                    }}
                  />
                  <button
                    type="button"
                    className="dr-iconbtn dr-wk-step"
                    aria-label="One minute more"
                    onClick={() => step(1)}
                  >
                    +
                  </button>
                </div>
                <p id={`${durationId}-hint`} className="dr-wk-hint">
                  Minutes, or m:ss (for example 2:30).
                </p>
                <button
                  type="button"
                  className="dr-btn dr-btn--primary dr-btn--sm dr-wk-wide"
                  data-testid="timer-start"
                  disabled={!parsed || busy}
                  onClick={() => parsed && void timer({ action: 'start', durationMs: parsed })}
                >
                  Start {parsed ? formatClock(parsed) : ''}
                </button>
              </>
            )}
            {!canStart || phase === 'finished' ? (
              <fieldset className="dr-wk-row">
                <legend className="dr-sr-only">Timer controls</legend>
                {phase === 'running' && (
                  <button
                    type="button"
                    className="dr-btn dr-btn--sm"
                    data-testid="timer-pause"
                    disabled={busy}
                    onClick={() => void timer({ action: 'pause' })}
                  >
                    Pause
                  </button>
                )}
                {phase === 'paused' && (
                  <button
                    type="button"
                    className="dr-btn dr-btn--sm"
                    data-testid="timer-resume"
                    disabled={busy}
                    onClick={() => void timer({ action: 'resume' })}
                  >
                    Resume
                  </button>
                )}
                <button
                  type="button"
                  className="dr-btn dr-btn--sm"
                  data-testid="timer-add-1m"
                  disabled={busy}
                  onClick={() => void timer({ action: 'add', addMs: MIN })}
                >
                  +1 min
                </button>
                <button
                  type="button"
                  className="dr-btn dr-btn--sm"
                  data-testid="timer-add-5m"
                  disabled={busy}
                  onClick={() => void timer({ action: 'add', addMs: 5 * MIN })}
                >
                  +5 min
                </button>
                <button
                  type="button"
                  className="dr-btn dr-btn--sm dr-btn--ghost"
                  data-testid="timer-stop"
                  disabled={busy}
                  onClick={() => void timer({ action: 'stop' })}
                >
                  {phase === 'finished' ? 'Reset' : 'Stop'}
                </button>
              </fieldset>
            ) : null}
          </>
        ) : (
          <p className="dr-wk-hint">
            Only editors and owners can set the timer. Everyone sees the same countdown.
          </p>
        )}
        <label className="dr-wk-check">
          <input
            type="checkbox"
            data-testid="timer-sound"
            checked={!muted}
            onChange={(e) => onMuted(!e.target.checked)}
          />
          Play a sound when time is up
        </label>
      </section>

      {(facilitator || vote) && (
        <section className="dr-wk-pop__section" aria-label="Voting">
          <h3>Voting</h3>
          {voteOpen || (vote && !facilitator) ? (
            <button
              type="button"
              className="dr-btn dr-btn--sm dr-wk-wide"
              data-testid="vote-open-panel"
              onClick={() => {
                onClose(false)
                ctx.openPanel('voting')
              }}
            >
              {voteOpen ? 'Open the voting panel' : 'See the last vote'}
            </button>
          ) : (
            <button
              type="button"
              className="dr-btn dr-btn--sm dr-wk-wide"
              data-testid="vote-start"
              onClick={() => {
                onClose(false)
                store.setSetupOpen(true)
              }}
            >
              Start a vote…
            </button>
          )}
        </section>
      )}

      {facilitator && (
        <section className="dr-wk-pop__section" aria-label="Gather everyone">
          <h3>Gather everyone</h3>
          <p className="dr-wk-hint">
            Everyone on the board follows your view until they move, zoom or click.
          </p>
          <button
            type="button"
            className="dr-btn dr-btn--sm dr-wk-wide"
            data-testid="summon-button"
            disabled={busy}
            onClick={async () => {
              if (await act(() => store.summon())) {
                onClose(false)
                ctx.notify({
                  key: 'summon',
                  text: 'Everyone here now follows your view. They stop following when they move.',
                  testId: 'summon-toast',
                })
              }
            }}
          >
            Gather everyone here
          </button>
        </section>
      )}
      {error && (
        <p className="dr-field-error" role="alert" data-testid="workshop-error">
          {error}
        </p>
      )}
    </div>
  )
}
