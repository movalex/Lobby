// OWNER: W5 (wave L, L5-1 run of show). The live side of the agenda (../agenda.ts is the pure part): while this
// tab presents to everyone, each time the live slide changes it
//  - records the section's visit in the presenter's sessionStorage record (drift is presenter-only: followers
//    never record, and nothing is written to the board or sent for it), and
//  - when "Auto-time sections" is on and the new section has planned minutes, asks the api's timer to start for
//    that long: the existing POST /api/boards/:bid/timer (workshops store `timerAction`), no new route. The
//    timer authority stays the api's timer table; this only asks.
// Someone else's running or paused timer is theirs: it is never stopped (the api would answer TIMER_NOT_YOURS
// to a facilitator, and this tab does not even ask while it sees it; an owner could override it, and the run of
// show must not). The strips read the timer and say "<name> holds the timer" instead (./AgendaStrip.tsx).
//
// A presentation that has no planned minutes anywhere is today's presenting: nothing here does anything.

import { fromShapeRef } from '@draftroom/canvas-schema/refs'
import type { CanvasFeatureContext, LobbyCanvas } from '../../../../canvas/api/index.ts'
import { type Atom, atom, computed, react, type Signal, untracked } from '../../../../lib/signals.ts'
import { timerPhase } from '../../../workshops/countdown.ts'
import { storeFor } from '../../../workshops/workshop-context.ts'
import { presentationOrder, slidesOf } from '../../ported/frames.ts'
import { slideTitle } from '../../slides.ts'
import {
  type AgendaFrame,
  AgendaRecorder,
  type AgendaSection,
  hasAgenda,
  minsOf,
  minsToMs,
  sectionsOf,
} from '../agenda.ts'
import type { LivePresenter } from './presenter.ts'

/**
 * Reactive: the board's slides in present order with their planned minutes, named as the presentation names
 * them ("Frame 3" for an unnamed one). Skipped and empty frames are not slides, so they are not sections.
 */
export function agendaFramesOf(canvas: LobbyCanvas): AgendaFrame[] {
  const slides = slidesOf(presentationOrder(canvas))
  return slides.map((s, i) => ({
    id: s.id,
    name: slideTitle(s.name, i),
    mins: minsOf(canvas.get(s.id)?.customData?.lobby?.present),
  }))
}

/** The element id of the live slide an api state names (`shape:<id>`), or null. */
export const liveSlideOf = (slideRef: string | null): string | null =>
  slideRef ? fromShapeRef(slideRef) : null

const autoKey = (boardId: string) => `draftroom:agenda-auto:${boardId}`

function sessionPref(boardId: string): boolean | null {
  try {
    const v = typeof sessionStorage === 'undefined' ? null : sessionStorage.getItem(autoKey(boardId))
    return v === 'on' ? true : v === 'off' ? false : null
  } catch {
    return null
  }
}

function saveSessionPref(boardId: string, on: boolean) {
  try {
    if (typeof sessionStorage !== 'undefined') sessionStorage.setItem(autoKey(boardId), on ? 'on' : 'off')
  } catch {
    // not remembered: the choice lasts for this page only
  }
}

export interface AgendaLive {
  /** "Auto-time sections": on by default when any section has minutes; this person's choice after that. */
  readonly autoTime: Signal<boolean>
  setAutoTime(on: boolean): void
  /** The presenter's stopwatch over the sections (drift, and what Wrap up reads). */
  readonly recorder: AgendaRecorder
  /** The recorder changed (a visit began or ended): strips that show drift re-read it. */
  readonly recorded: Signal<number>
  dispose(): void
}

export interface AgendaLiveDeps {
  readonly presenter: Pick<LivePresenter, 'current'>
  /** Reactive: this tab presents to everyone. */
  readonly presentingLive: Signal<boolean>
  /** The live presentation's id (a hand-off keeps it), or null; read when this tab starts presenting. */
  readonly presentationId: () => string | null
}

/** Starts section timers one at a time, the latest wish winning, and never over someone else's timer. */
function sectionTimers(ctx: CanvasFeatureContext) {
  const me = ctx.me.user.id
  let sending = false
  let wanted: number | null = null
  const send = async (mins: number) => {
    const store = storeFor(ctx) // when needed: a presentation with no planned time never makes one
    const snap = store.getSnapshot()
    const t = snap.timer
    const phase = timerPhase(t, Date.now(), store.serverOffsetMs())
    // Someone else's running or paused timer is theirs: leave it alone (the strips name its holder).
    if (t?.startedBy && t.startedBy !== me && (phase === 'running' || phase === 'paused')) return
    const r = await store.timerAction({ action: 'start', durationMs: minsToMs(mins) })
    // The api says it is someone else's (this tab's copy was behind): fetch the truth so the strips name them.
    if (!r.ok && r.code === 'TIMER_NOT_YOURS') await store.refresh()
  }
  return {
    start(mins: number) {
      wanted = mins
      if (sending) return
      sending = true
      void (async () => {
        try {
          while (wanted !== null) {
            const next = wanted
            wanted = null
            await send(next)
          }
        } finally {
          sending = false
        }
      })()
    },
  }
}

export function mountAgenda(ctx: CanvasFeatureContext, deps: AgendaLiveDeps): AgendaLive {
  const { canvas } = ctx
  const boardId = ctx.board.id
  const recorder = new AgendaRecorder(boardId)
  const pref: Atom<boolean | null> = atom('dr-agenda-auto-pref', sessionPref(boardId))
  const recorded: Atom<number> = atom('dr-agenda-recorded', 0)
  const autoTime = computed(
    'dr-agenda-auto',
    () => pref.get() ?? hasAgenda(sectionsOf(agendaFramesOf(canvas))),
  )
  const timers = sectionTimers(ctx)

  let wasLive = false
  let lastSlide: string | null = null

  const onSlide = (live: boolean, slideId: string | null) => {
    // A failure here must never stop a presentation: the run of show is an extra on top of it.
    try {
      step(live, slideId)
    } catch (e) {
      console.error('run of show', e)
    }
  }

  const step = (live: boolean, slideId: string | null) => {
    if (!live) {
      if (wasLive) {
        recorder.stop() // keeps the section it left on record (a hand-off)
        recorded.update((n) => n + 1)
      }
      wasLive = false
      lastSlide = null
      return
    }
    if (!slideId) return
    const sections: AgendaSection[] = sectionsOf(agendaFramesOf(canvas))
    if (!hasAgenda(sections)) {
      // no planned time anywhere: today's presenting
      wasLive = true
      lastSlide = slideId
      return
    }
    let resumedOn: string | null = null
    if (!wasLive) {
      wasLive = true
      const pid = deps.presentationId()
      // a reload of the presenting tab finds its visit still on record and carries on; the same presentation
      // taken back (a hand-off) carries its record on, and the section it left is not a new one: its timer is not
      // started over, the room's countdown kept running meanwhile (round 1). Round 2: the presentation and that
      // section are kept in the record, not in memory, so a reload between the hand-off and the take-back keeps
      // them. A new run starts afresh.
      const same = pid !== null && pid === recorder.presentationId() && recorder.active()
      if (recorder.currentId() === null && !same) recorder.begin(sections, pid)
      if (same) resumedOn = recorder.leftOn()
      recorder.resume(pid)
    }
    if (slideId === lastSlide) return
    lastSlide = slideId
    const section = sections.find((s) => s.id === slideId)
    if (!section) return
    const fresh = recorder.enter(slideId, sections) && slideId !== resumedOn
    recorded.update((n) => n + 1)
    if (fresh && autoTime.get() && section.mins !== null) timers.start(section.mins)
  }

  const stop = react('dr-agenda-watch', () => {
    const live = deps.presentingLive.get()
    const slideId = live ? deps.presenter.current().slideId : null
    untracked(() => onSlide(live, slideId))
  })

  return {
    autoTime,
    setAutoTime(on) {
      saveSessionPref(boardId, on)
      pref.set(on)
    },
    recorder,
    recorded,
    dispose: stop,
  }
}
