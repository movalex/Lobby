// OWNER: W5 (wave L, L5-1 run of show). The agenda: the board's frames in present order with their planned
// minutes (customData.lobby.present.mins), where the live presentation is in it, what the shared timer says
// about the section, and the presenter's actual times. Pure (no canvas, no DOM, no React) and unit-tested in
// Node (agenda.test.ts); the live controller (./ported/agenda-live.ts) and the strips (./ported/AgendaStrip.tsx)
// use it. `agendaActuals` is the cross-workstream export W2's Wrap up reads (frozen at the wave L foundation).
//
// The timer authority stays the api's timer table: this module only reads the timer the board already has and
// says what it means for the live section. Nothing here writes anywhere; the recorder's sessionStorage record is
// the presenter's own tab's (followers never record: drift is presenter-only).

import { PRESENT_MINS_MAX, PRESENT_MINS_MIN } from '@draftroom/canvas-schema/custom-data'
import type { WorkshopTimer } from '@draftroom/contracts'
import { formatClock, timerPhase, timerRemainingMs } from '../../workshops/countdown.ts'

// ---- the frames as sections ------------------------------------------------------------------------------------

/** A frame of the board in present order (skipped ones included: `agendaOf` leaves them out). */
export interface AgendaFrame {
  readonly id: string
  readonly name: string
  /** planned minutes (`present.mins`), or null: none */
  readonly mins: number | null
  readonly skip?: boolean
}

/** One section of the run of show: a frame that is a slide. */
export interface AgendaSection {
  readonly id: string
  readonly name: string
  readonly mins: number | null
}

const MIN_MS = 60_000
export const minsToMs = (mins: number) => mins * MIN_MS

/** The minutes in a `present` value (customData.lobby.present), or null when it holds none. */
export function minsOf(present: unknown): number | null {
  if (typeof present !== 'object' || present === null || Array.isArray(present)) return null
  const m = (present as { mins?: unknown }).mins
  return typeof m === 'number' && Number.isInteger(m) && m >= PRESENT_MINS_MIN && m <= PRESENT_MINS_MAX
    ? m
    : null
}

/** The frames that are sections, in order: skipped frames are not slides, so they are not sections. */
export function sectionsOf(frames: readonly AgendaFrame[]): AgendaSection[] {
  return frames.filter((f) => f.skip !== true).map((f) => ({ id: f.id, name: f.name, mins: f.mins }))
}

/** Whether the run of show has any planned time (otherwise there is no agenda: today's presenting). */
export const hasAgenda = (sections: readonly AgendaSection[]) => sections.some((s) => s.mins !== null)

/** Planned minutes over every section. */
export const totalPlannedMs = (sections: readonly AgendaSection[]) =>
  sections.reduce((n, s) => n + (s.mins === null ? 0 : minsToMs(s.mins)), 0)

// ---- where the presentation is -----------------------------------------------------------------------------------

/** What the shared timer means for the live section. */
export type AgendaTimer =
  /** nothing counts the section: no plan, or no timer of the presenter's is running */
  | { readonly kind: 'none' }
  /** the presenter's timer: time left (0 once finished), and how far past its end it is */
  | {
      readonly kind: 'section'
      readonly status: 'running' | 'paused' | 'finished'
      readonly leftMs: number
      readonly overMs: number
    }
  /** someone else started the timer and it runs: the presenter's slide change never stops it */
  | { readonly kind: 'held'; readonly holderId: string }

export interface AgendaState {
  /** 0-based position among the sections */
  readonly index: number
  readonly total: number
  readonly current: AgendaSection
  readonly next: AgendaSection | null
  /** planned for the current section, or null */
  readonly plannedMs: number | null
  /** planned for the whole run of show */
  readonly totalPlannedMs: number
  readonly timer: AgendaTimer
}

export interface AgendaClock {
  readonly timer: WorkshopTimer | null
  /** this browser's Date.now() */
  readonly nowMs: number
  /** server time minus this browser's time (the workshop store's `serverOffsetMs()`) */
  readonly offsetMs: number
}

/**
 * Where the live presentation is in the run of show, or null when there is no agenda (no section has
 * minutes) or `slideId` is no section. `presenterId` is who presents: a timer they started is the section's,
 * one someone else started and still runs is that person's (`held`), and a finished one of someone else's is
 * nobody's now. A section with no minutes shows no timer at all (a leftover from the section before is not
 * its own).
 */
export function agendaOf(
  frames: readonly AgendaFrame[],
  slideId: string | null,
  clock: AgendaClock,
  presenterId: string | null,
): AgendaState | null {
  const sections = sectionsOf(frames)
  if (!hasAgenda(sections) || !slideId) return null
  const index = sections.findIndex((s) => s.id === slideId)
  const current = sections[index]
  if (!current) return null
  const plannedMs = current.mins === null ? null : minsToMs(current.mins)
  return {
    index,
    total: sections.length,
    current,
    next: sections[index + 1] ?? null,
    plannedMs,
    totalPlannedMs: totalPlannedMs(sections),
    timer: plannedMs === null ? { kind: 'none' } : timerOf(clock, presenterId),
  }
}

function timerOf(clock: AgendaClock, presenterId: string | null): AgendaTimer {
  const { timer, nowMs, offsetMs } = clock
  if (!timer) return { kind: 'none' }
  const phase = timerPhase(timer, nowMs, offsetMs)
  if (phase !== 'running' && phase !== 'paused' && phase !== 'finished') return { kind: 'none' }
  const other = timer.startedBy !== null && presenterId !== null && timer.startedBy !== presenterId
  if (other)
    return phase === 'finished' ? { kind: 'none' } : { kind: 'held', holderId: timer.startedBy as string }
  const ends = Date.parse(timer.endsAt ?? '')
  const overMs = phase === 'finished' && !Number.isNaN(ends) ? Math.max(0, nowMs + offsetMs - ends) : 0
  return { kind: 'section', status: phase, leftMs: timerRemainingMs(timer, nowMs, offsetMs), overMs }
}

/** "+0:42 over" */
export const overText = (overMs: number) => `+${formatClock(overMs)} over`

/**
 * The strip's line: "Section 1 of 2 · Ideas · 1:58 left · next: Vote". `nameOf` names the timer's holder
 * (a user id; people on the board).
 */
export function agendaLine(state: AgendaState, nameOf: (userId: string) => string): string {
  const parts = [`Section ${state.index + 1} of ${state.total}`, state.current.name]
  const t = state.timer
  if (t.kind === 'held') parts.push(`${nameOf(t.holderId)} holds the timer`)
  else if (t.kind === 'section') {
    if (t.status === 'finished') parts.push(overText(t.overMs))
    else parts.push(`${formatClock(t.leftMs)} left${t.status === 'paused' ? ' (paused)' : ''}`)
  } else if (state.current.mins !== null) parts.push(`${state.current.mins} min planned`)
  if (state.next) parts.push(`next: ${state.next.name}`)
  return parts.join(' · ')
}

// ---- the stepper's steps ------------------------------------------------------------------------------------------

/**
 * The minutes after one press of a stepper button: 5 from none; +1 below 10, +5 from there to the most;
 * back down the same way, and below 1 none again (null removes the plan).
 */
export function stepMins(current: number | null, direction: 1 | -1): number | null {
  if (direction === 1) {
    if (current === null) return 5
    return Math.min(PRESENT_MINS_MAX, current < 10 ? current + 1 : current + 5)
  }
  if (current === null || current <= PRESENT_MINS_MIN) return null
  return current <= 10 ? current - 1 : Math.max(10, current - 5)
}

// ---- drift (presenter only) ------------------------------------------------------------------------------------------

export interface Drift {
  readonly plannedMs: number
  /** what the whole run of show will take at this pace */
  readonly projectedMs: number
  /** projected minus planned: above 0 is behind */
  readonly behindMs: number
}

/**
 * How the run of show is going: sections already left count what they took, the live one what it has taken
 * or its plan if that is more, the rest their plan (a section with no minutes plans nothing). `actualMs` is
 * the time spent per visited section before the live one's current visit.
 */
export function driftOf(
  sections: readonly AgendaSection[],
  actualMs: Readonly<Record<string, number>>,
  currentId: string | null,
  currentElapsedMs: number,
): Drift | null {
  if (!hasAgenda(sections)) return null
  let planned = 0
  let projected = 0
  for (const s of sections) {
    const plan = s.mins === null ? 0 : minsToMs(s.mins)
    planned += plan
    if (s.id === currentId) {
      const used = (actualMs[s.id] ?? 0) + Math.max(0, currentElapsedMs)
      projected += s.mins === null ? used : Math.max(plan, used)
    } else if (s.id in actualMs) projected += actualMs[s.id] ?? 0
    else projected += plan
  }
  return { plannedMs: planned, projectedMs: projected, behindMs: projected - planned }
}

/** Minutes, rounded: 3780000 -> "63". */
export const minutesText = (ms: number) => String(Math.round(ms / MIN_MS))

/** "planned 60 · projected 63" */
export function driftLine(d: Drift): string {
  return `planned ${minutesText(d.plannedMs)} · projected ${minutesText(d.projectedMs)}`
}

// ---- the presenter's record (sessionStorage) ----------------------------------------------------------------------------------

/** What this tab recorded of one run of show. */
interface AgendaRecord {
  v: 1
  /** the sections as of the last update, with their plan */
  sections: { id: string; name: string; mins: number | null }[]
  /** ms spent per visited section, before the visit in progress */
  actual: Record<string, number>
  /** the visit in progress: the section and when it began (this browser's clock) */
  current: { id: string; since: number } | null
}

export interface AgendaStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

const KEY = (boardId: string) => `draftroom:agenda:${boardId}`

function sessionStorageOrNull(): AgendaStorage | null {
  try {
    return typeof sessionStorage === 'undefined' ? null : sessionStorage
  } catch {
    return null
  }
}

function parseRecord(raw: string | null): AgendaRecord | null {
  if (!raw) return null
  try {
    const v = JSON.parse(raw) as Partial<AgendaRecord> | null
    if (v?.v !== 1 || !Array.isArray(v.sections) || typeof v.actual !== 'object' || v.actual === null)
      return null
    const sections = v.sections.filter(
      (s): s is AgendaRecord['sections'][number] =>
        !!s &&
        typeof s.id === 'string' &&
        typeof s.name === 'string' &&
        (s.mins === null || typeof s.mins === 'number'),
    )
    const actual: Record<string, number> = {}
    for (const [id, ms] of Object.entries(v.actual))
      if (typeof ms === 'number' && Number.isFinite(ms) && ms >= 0) actual[id] = ms
    const cur = v.current
    const current =
      cur && typeof cur.id === 'string' && typeof cur.since === 'number' && Number.isFinite(cur.since)
        ? { id: cur.id, since: cur.since }
        : null
    return { v: 1, sections, actual, current }
  } catch {
    return null
  }
}

/**
 * The presenter's stopwatch over the sections: which section the live presentation is in and for how long,
 * kept in sessionStorage (try/catch everywhere: the page works without it) so a reload of the presenting tab
 * carries on. One run of show at a time per board; `begin` starts a fresh one.
 */
export class AgendaRecorder {
  private record: AgendaRecord | null
  private readonly storage: AgendaStorage | null
  private readonly boardId: string
  private readonly now: () => number

  constructor(boardId: string, opts: { storage?: AgendaStorage | null; now?: () => number } = {}) {
    this.boardId = boardId
    this.storage = opts.storage === undefined ? sessionStorageOrNull() : opts.storage
    this.now = opts.now ?? (() => Date.now())
    this.record = this.load()
  }

  private load(): AgendaRecord | null {
    try {
      return parseRecord(this.storage?.getItem(KEY(this.boardId)) ?? null)
    } catch {
      return null
    }
  }

  private save() {
    try {
      if (this.record) this.storage?.setItem(KEY(this.boardId), JSON.stringify(this.record))
      else this.storage?.removeItem(KEY(this.boardId))
    } catch {
      // storage blocked or full: the record lives in this page only
    }
  }

  /** Starts a fresh run of show over `sections` (the earlier record is dropped). */
  begin(sections: readonly AgendaSection[]) {
    this.record = { v: 1, sections: sections.map((s) => ({ ...s })), actual: {}, current: null }
    this.save()
  }

  /** Whether a run of show is on record (a reload of the presenting tab finds it). */
  active(): boolean {
    return this.record !== null
  }

  /** The section the visit in progress is in, or null. */
  currentId(): string | null {
    return this.record?.current?.id ?? null
  }

  /**
   * The presentation is on section `id` now. The visit before it is closed (its time added up); entering the
   * section already being visited changes nothing (a reload of the tab). Returns whether it was a new visit.
   */
  enter(id: string, sections: readonly AgendaSection[]): boolean {
    const at = this.now()
    if (!this.record) this.begin(sections)
    const rec = this.record as AgendaRecord
    rec.sections = sections.map((s) => ({ ...s }))
    if (rec.current?.id === id) {
      this.save()
      return false
    }
    this.close(rec, at)
    rec.actual[id] ??= 0
    rec.current = { id, since: at }
    this.save()
    return true
  }

  /** The presentation ended: the visit in progress is closed. The record stays for the recap. */
  stop() {
    if (!this.record) return
    this.close(this.record, this.now())
    this.save()
  }

  /** Forgets the run of show. */
  clear() {
    this.record = null
    this.save()
  }

  private close(rec: AgendaRecord, at: number) {
    const cur = rec.current
    if (!cur) return
    rec.actual[cur.id] = (rec.actual[cur.id] ?? 0) + Math.max(0, at - cur.since)
    rec.current = null
  }

  /** Time spent per visited section before the visit in progress, and that visit's time so far. */
  snapshot(): { actualMs: Record<string, number>; currentId: string | null; currentElapsedMs: number } {
    const rec = this.record
    if (!rec) return { actualMs: {}, currentId: null, currentElapsedMs: 0 }
    return {
      actualMs: { ...rec.actual },
      currentId: rec.current?.id ?? null,
      currentElapsedMs: rec.current ? Math.max(0, this.now() - rec.current.since) : 0,
    }
  }

  /** The visited sections in present order with the time each took (the visit in progress included). */
  actuals(): AgendaActual[] | null {
    const rec = this.record
    if (!rec) return null
    const live = rec.current ? Math.max(0, this.now() - rec.current.since) : 0
    const out = rec.sections
      .filter((s) => s.id in rec.actual)
      .map((s) => ({
        frameId: s.id,
        name: s.name,
        plannedMin: s.mins,
        actualMs: Math.round((rec.actual[s.id] ?? 0) + (rec.current?.id === s.id ? live : 0)),
      }))
    return out.length ? out : null
  }
}

// ---- the cross-workstream export -------------------------------------------------------------------------------------

/** One section of the run of show as it went: planned minutes (null: none set) and the time it really took. */
export interface AgendaActual {
  readonly frameId: string
  /** the frame's name as shown in the frames panel */
  readonly name: string
  readonly plannedMin: number | null
  readonly actualMs: number
}

/**
 * The presenter's actual time per section of the run of show on `boardId`, in present order, as this tab
 * recorded it (sessionStorage, presenter-only), or null when this tab presented no agenda on that board (a
 * follower, a fresh tab, storage blocked, nothing visited). Only sections the presentation reached are in it;
 * the one in progress counts up to now. W2's Wrap up shows "Planned vs actual" from it when it is not null.
 */
export function agendaActuals(boardId: string): readonly AgendaActual[] | null {
  return new AgendaRecorder(boardId).actuals()
}
