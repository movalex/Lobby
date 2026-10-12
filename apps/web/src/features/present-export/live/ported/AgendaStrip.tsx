// OWNER: W5 (wave L, L5-1 run of show). What people see of the agenda while a presentation to everyone runs:
//  - the strip, "Section 1 of 2 · Ideas · 1:58 left · next: Vote" (or "+0:42 over", or "<name> holds the timer"),
//    under the banner at the top of the presentation for followers AND the presenter. It is computed from the
//    frames, the live slide and the board's shared timer: nothing about it is stored or sent by a follower.
//  - for the presenter only: "Planned 60 min · 3 min over" (the drift, from this tab's own record; M2-3 reworded it)
//    and the "Times each section" switch in the control bar (Auto-time before M2-3).
// The rules are ../agenda.ts's (pure, unit-tested).

import type { WorkshopTimer } from '@draftroom/contracts'
import { useEffect, useMemo } from 'react'
import { useValue } from '../../../../lib/signals.ts'
import { noteFeedbackMoment } from '../../../feedback/prompt-moments.ts'
import { formatClock } from '../../../workshops/countdown.ts'
import { useNow, useWorkshop } from '../../../workshops/workshop-context.ts'
import {
  type AgendaFrame,
  agendaLine,
  agendaOf,
  agendaShowsTime,
  driftLine,
  driftOf,
  hasAgenda,
  runOfShowEnded,
  sectionsOf,
} from '../agenda.ts'
import { agendaFramesOf, liveSlideOf } from './agenda-live.ts'
import type { LiveController } from './controller.ts'

/** Reactive: the live slide (element id) and who presents, or null when nobody does. */
function presentationOf(live: LiveController): { slideId: string | null; presenterId: string } | null {
  const p = live.store.presentation.get()
  return p ? { slideId: liveSlideOf(p.slideId), presenterId: p.presenter.userId } : null
}

/**
 * Reactive: the strip is drawn (the presentation has planned minutes and its slide is a section). The slide
 * is fitted under it (present-export/ported/insets.ts), so the live chrome asks.
 */
export function agendaShown(live: LiveController | null): boolean {
  if (!live) return false
  const p = presentationOf(live)
  if (!p?.slideId) return false
  const sections = sectionsOf(agendaFramesOf(live.ctx.canvas))
  return hasAgenda(sections) && sections.some((s) => s.id === p.slideId)
}

/**
 * M2-3: whether the strip's line is showing the live section's time now (a countdown, or how far over), so the timer
 * pill over the slides stays out of its way. Reads the frames and the live slide like the strip does.
 */
export function agendaTimeShown(
  live: LiveController | null,
  clock: { timer: WorkshopTimer | null; nowMs: number; offsetMs: number },
): boolean {
  if (!live) return false
  const p = presentationOf(live)
  if (!p?.slideId) return false
  return agendaShowsTime(agendaOf(agendaFramesOf(live.ctx.canvas), p.slideId, clock, p.presenterId))
}

/** The roster's name for a user id ("Someone" when they are not here). */
function nameOf(live: LiveController, userId: string): string {
  const here = live.ctx.canvas.collaborators().find((c) => c.uid === userId)
  if (here?.name) return here.name
  const p = live.store.presentation.get()
  return p?.presenter.userId === userId ? p.presenter.name : 'Someone'
}

export function AgendaStrip({ live, variant }: { live: LiveController; variant: 'presenter' | 'follower' }) {
  const { ctx } = live
  const { store, snap } = useWorkshop(ctx)
  // serialized: the canvas's items change on every edit, the agenda's frames rarely
  const framesKey = useValue('dr-agenda-frames', () => JSON.stringify(agendaFramesOf(ctx.canvas)), [
    ctx.canvas,
  ])
  const frames = useMemo(() => JSON.parse(framesKey) as AgendaFrame[], [framesKey])
  const where = useValue('dr-agenda-where', () => JSON.stringify(presentationOf(live)), [live])
  const place = useMemo(
    () => JSON.parse(where) as { slideId: string | null; presenterId: string } | null,
    [where],
  )
  // The drift reads the recorder when a visit begins or ends and as time passes.
  useValue('dr-agenda-recorded', () => live.agenda.recorded.get(), [live])
  const now = useNow(true, 500)
  // wave N.1: the presenter's record says when the live section was reached, so only a timer started since is its own
  const sinceMs = variant === 'presenter' ? live.agenda.recorder.enteredAt(place?.slideId ?? '') : undefined
  const state = agendaOf(
    frames,
    place?.slideId ?? null,
    { timer: snap.timer, nowMs: now, offsetMs: store.serverOffsetMs(), sinceMs },
    place?.presenterId ?? null,
  )
  // M2-5: the last section ran out: a moment (the presenter's only: a follower records and is asked nothing)
  const over = variant === 'presenter' && runOfShowEnded(state)
  useEffect(() => {
    if (over) noteFeedbackMoment(live.ctx.canvas, 'run-of-show-end')
  }, [over, live])
  if (!state) return null
  const t = state.timer
  const mood =
    t.kind === 'held'
      ? 'held'
      : t.kind === 'section' && t.status === 'finished'
        ? 'over'
        : t.kind === 'section' && t.status === 'running' && t.leftMs <= 60_000
          ? 'low'
          : 'ok'
  const drift =
    variant === 'presenter'
      ? (() => {
          const r = live.agenda.recorder.snapshot()
          return driftOf(sectionsOf(frames), r.actualMs, r.currentId, r.currentElapsedMs)
        })()
      : null
  return (
    <div
      className="dr-live-agenda"
      data-testid="agenda-strip"
      data-variant={variant}
      data-state={mood}
      data-index={state.index}
      data-total={state.total}
    >
      <span className="dr-live-agenda__line" data-testid="agenda-line">
        {agendaLine(state, (id) => nameOf(live, id))}
      </span>
      {drift && (
        <span className="dr-live-agenda__drift" data-testid="agenda-drift" data-behind={drift.behindMs > 0}>
          {driftLine(drift)}
        </span>
      )}
      {/* one announcement per section, not per second */}
      <span className="dr-sr-only" role="status" data-testid="agenda-announce">
        {`Section ${state.index + 1} of ${state.total}: ${state.current.name}${
          state.plannedMs !== null ? `, ${formatClock(state.plannedMs)} planned` : ''
        }`}
      </span>
    </div>
  )
}

/** What the switch says (M2-3; it read "Auto-time on" and "Auto-time off"). */
export const AUTO_TIME_LABEL = { on: 'Times each section', off: 'Sections not timed' } as const

/** The presenter's "Times each section" switch in the control bar: whether a section's timer starts as the slide moves. */
export function AgendaAutoToggle({ live }: { live: LiveController }) {
  const shown = useValue('dr-agenda-shown', () => agendaShown(live), [live])
  const on = useValue('dr-agenda-auto-on', () => live.agenda.autoTime.get(), [live])
  if (!shown) return null
  return (
    <button
      type="button"
      className="dr-present__btn dr-present__btn--text"
      data-testid="agenda-autotime"
      aria-pressed={on}
      title={
        on
          ? 'Each section’s timer starts when you move to it (click to turn off)'
          : 'Start each section’s timer by hand (click to start it as you move)'
      }
      onClick={() => live.agenda.setAutoTime(!on)}
    >
      {AUTO_TIME_LABEL[on ? 'on' : 'off']}
    </button>
  )
}
