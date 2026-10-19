// OWNER: WS2 (wave V, V1; docs/WAVE-V-CONTRACTS.md §2). The board's live activity (a poll, a scale or a word cloud) as
// this tab knows it: one store per board event stream, shared by the Facilitate entry, the panel, the setup dialog
// and the pill. Framework-free (React subscribes through useSyncExternalStore), so it is unit-tested in Node against
// a fake api.
//
// Authority: the api (WS1). This store holds the caller's own view only (`ActivityState`: the activity, aggregates,
// the CALLER's own answer); nobody else's answer ever reaches it, and it never writes to the board (./to-board.ts
// does, from the facilitator's press). Events (`workshop.activity`, `workshop.activity.results`) carry aggregates:
// a new activity or a status change refetches this person's own view (their answer, whether they manage it); a
// manager's live counts without `resultsLive` come with that refetch (at most one event per tally window).
//
// "Not here": an api whose DRAFTROOM_LIVE_ACTIVITIES is off (or one before wave V) answers every route 404 like an
// unknown route: the store is `absent` and offers nothing (a later resync asks again). A refetch that fails otherwise
// is retried with a backoff, as the workshop stores do.

import {
  ACTIVITY_ERROR_CODES,
  type ActivityAnswer,
  ActivityState,
  type ActivityStatus,
  activitiesPath,
  activityActionPath,
  activityPath,
  LIVE_ACTIVITY_EVENTS,
  type LiveActivity,
  NamedAnswersResponse,
  type StartActivityInput,
  WorkshopActivityEvent,
  WorkshopActivityResultsEvent,
} from '@draftroom/contracts'
import type { z } from 'zod'
import { takeOpenState } from '../../lib/open-state.ts'
import { firstLoad, REFRESH_RETRY_MAX_MS, REFRESH_RETRY_MIN_MS, retryableError } from '../workshops/store.ts'

type Method = 'GET' | 'POST'
/** The subset of ApiClient['request'] the store needs (tests pass a fake). */
export type RequestFn = <S extends z.ZodType | null>(
  method: Method,
  path: string,
  opts: { body?: unknown; schema: S },
) => Promise<S extends z.ZodType ? z.output<S> : undefined>

/** The subset of BoardEvents the store needs. */
export interface EventSource {
  on(type: string, listener: (data: unknown) => void): () => void
  onResync(listener: () => void): () => void
}

export interface ActionResult {
  ok: boolean
  /** user-safe words when !ok */
  error?: string
  code?: string
}

export type ActivityAction = 'start' | 'answer' | 'close' | 'reveal' | 'extend' | 'cancel' | 'hide' | 'placed'

export interface ActivitySnapshot {
  readonly loaded: boolean
  /** the last refetch failed (the panel keeps what it had) */
  readonly stale: boolean
  /** the api runs no live activities here (its switch is off, or it predates wave V): offer nothing */
  readonly absent: boolean
  readonly activity: LiveActivity | null
  /** the effective status: an open activity past its end time reads closed (the api says so on its next read) */
  readonly status: ActivityStatus | null
  readonly answered: number
  readonly myAnswer: ActivityAnswer | null
  readonly results: ActivityState['results']
  readonly canManage: boolean
  readonly starterLeft: boolean
  readonly hiddenWords: readonly string[]
  /** the api's clock minus this tab's (ms) */
  readonly offsetMs: number
  readonly setupOpen: boolean
  /** a request this tab sent and is waiting for */
  readonly busy: ActivityAction | null
  /**
   * The api said the board is read-only (409 BOARD_READ_ONLY: archived since this page opened it): no answers, nothing
   * to start or manage, until the page reloads the board.
   */
  readonly archived: boolean
}

/** What this tab was told while the board was open, for its notices (./index.tsx). */
export type ActivityNews =
  /** someone else's activity is open and this person has not answered it */
  | { readonly kind: 'started'; readonly activity: LiveActivity }
  /** the results came in (revealed by someone else while this tab watched) */
  | { readonly kind: 'revealed'; readonly activity: LiveActivity }

/** The board event the sharing feature publishes when grants, links or guests change (starter-left may flip). */
const SHARING_CHANGED = 'sharing.changed'
/** How long after an activity's end time the store asks the api again (it reports it closed then). */
export const END_REFRESH_DELAY_MS = 600

const OFF_MESSAGE = 'Polls and word clouds are not available on this board right now.'
/** What a person is told when the api refuses because the board is archived (409 BOARD_READ_ONLY). */
export const ARCHIVED_MESSAGE = 'This board is archived: answers are closed.'
/** The api's code for a write to an archived board (live-activities answers it on an answer). */
const BOARD_READ_ONLY = 'BOARD_READ_ONLY'

function errorOf(e: unknown): ActionResult {
  const err = e as { message?: unknown; code?: unknown; status?: unknown } | null
  const code = typeof err?.code === 'string' ? err.code : undefined
  if (err?.status === 404 && (code === 'NOT_FOUND' || code === undefined))
    return { ok: false, error: OFF_MESSAGE, code: 'NOT_FOUND' }
  return {
    ok: false,
    error: typeof err?.message === 'string' && err.message ? err.message : 'That did not work. Try again.',
    code,
  }
}

const is404 = (e: unknown) => (e as { status?: unknown } | null)?.status === 404

/** The status as a person sees it now: an open activity whose end time has passed is closed. */
export function effectiveStatus(
  activity: Pick<LiveActivity, 'status' | 'endsAt'> | null,
  nowMs: number,
  offsetMs: number,
): ActivityStatus | null {
  if (!activity) return null
  if (activity.status === 'open' && activity.endsAt && Date.parse(activity.endsAt) <= nowMs + offsetMs)
    return 'closed'
  return activity.status
}

/** The ms left of an open activity with an end time (0 when past; null without one). */
export function remainingMs(activity: Pick<LiveActivity, 'endsAt'> | null, nowMs: number, offsetMs: number) {
  if (!activity?.endsAt) return null
  return Math.max(0, Date.parse(activity.endsAt) - (nowMs + offsetMs))
}

export class ActivityStore {
  private readonly boardId: string
  private readonly request: RequestFn
  private readonly userId: string | null
  private readonly now: () => number
  private state: ActivityState | null = null
  private loaded = false
  private stale = false
  private absent = false
  private archived = false
  private offsetMs = 0
  private setupOpen = false
  private busy: ActivityAction | null = null
  private seq = 0
  private appliedSeq = 0
  private confirmedSeq = 0
  private failedSeq = 0
  private refreshes = 0
  private retryTimer: ReturnType<typeof setTimeout> | null = null
  private retryMs = REFRESH_RETRY_MIN_MS
  private endTimer: ReturnType<typeof setTimeout> | null = null
  private endTimerFor: string | null = null
  private disposed = false
  private cancelFirstLoad: () => void = () => {}
  /** activities this tab already told its person about (started / revealed) */
  private readonly toldStart = new Set<string>()
  private readonly toldReveal = new Set<string>()
  /** activities this tab revealed itself (no "results are in" for its own press) */
  private readonly revealedHere = new Set<string>()
  private readonly listeners = new Set<() => void>()
  private readonly newsListeners = new Set<(n: ActivityNews) => void>()
  private readonly unsubscribers: (() => void)[] = []
  private snap: ActivitySnapshot

  constructor(deps: {
    boardId: string
    request: RequestFn
    events: EventSource
    userId?: string
    now?: () => number
  }) {
    this.boardId = deps.boardId
    this.request = deps.request
    this.userId = deps.userId ?? null
    this.now = deps.now ?? Date.now
    this.snap = this.compute()
    this.unsubscribers.push(
      deps.events.on(LIVE_ACTIVITY_EVENTS.activity, (d) => this.onActivityEvent(d)),
      deps.events.on(LIVE_ACTIVITY_EVENTS.results, (d) => this.onResultsEvent(d)),
      deps.events.onResync(() => void this.refresh()),
      deps.events.on(SHARING_CHANGED, () => {
        if (this.state?.activity) void this.refresh()
      }),
    )
  }

  dispose() {
    this.disposed = true
    this.clearRetry()
    this.clearEndTimer()
    this.cancelFirstLoad()
    for (const u of this.unsubscribers.splice(0)) u()
    this.listeners.clear()
    this.newsListeners.clear()
  }

  // ---- subscription ----------------------------------------------------------------------------------------------

  subscribe = (fn: () => void) => {
    this.listeners.add(fn)
    if (this.stale && !this.retryTimer) this.scheduleRetry()
    return () => void this.listeners.delete(fn)
  }
  getSnapshot = () => this.snap

  /** Told once per activity: someone else's started, the results came in. */
  onNews(fn: (n: ActivityNews) => void): () => void {
    this.newsListeners.add(fn)
    return () => void this.newsListeners.delete(fn)
  }

  private emit() {
    this.snap = this.compute()
    for (const l of [...this.listeners]) l()
  }

  private compute(): ActivitySnapshot {
    const s = this.state
    const activity = s?.activity ?? null
    return {
      loaded: this.loaded,
      stale: this.stale,
      absent: this.absent,
      activity,
      status: effectiveStatus(activity, this.now(), this.offsetMs),
      answered: s?.answered ?? 0,
      myAnswer: s?.myAnswer ?? null,
      results: s?.results ?? null,
      canManage: s?.canManage ?? false,
      starterLeft: s?.starterLeft ?? false,
      hiddenWords: s?.hiddenWords ?? [],
      offsetMs: this.offsetMs,
      setupOpen: this.setupOpen,
      busy: this.busy,
      archived: this.archived,
    }
  }

  private tell(n: ActivityNews) {
    for (const l of [...this.newsListeners]) {
      try {
        l(n)
      } catch (err) {
        console.error('live-activities news listener failed', err)
      }
    }
  }

  /** The news a state brings: someone else's open activity not answered yet; results revealed while watching. */
  private notice(prev: ActivityState | null, next: ActivityState) {
    const a = next.activity
    if (!a) return
    if (
      a.status === 'open' &&
      !this.toldStart.has(a.id) &&
      a.createdBy !== this.userId &&
      next.myAnswer === null &&
      !next.canManage
    ) {
      this.toldStart.add(a.id)
      this.tell({ kind: 'started', activity: a })
    } else if (a.status === 'open') this.toldStart.add(a.id)
    const was = prev?.activity
    if (
      a.status === 'revealed' &&
      was?.id === a.id &&
      was.status !== 'revealed' &&
      !this.toldReveal.has(a.id) &&
      !this.revealedHere.has(a.id)
    ) {
      this.toldReveal.add(a.id)
      this.tell({ kind: 'revealed', activity: a })
    }
  }

  // ---- loading and events -------------------------------------------------------------------------------------------

  refreshAsked = () => this.refreshes > 0

  /** The first load (K3-6): the stream's resync, or a fetch after `fallbackMs` without one. */
  startFirstLoad(fallbackMs?: number) {
    this.cancelFirstLoad()
    this.cancelFirstLoad = firstLoad(this, fallbackMs)
  }

  async refresh(): Promise<void> {
    if (this.disposed) return
    this.refreshes++
    const seq = ++this.seq
    const sent = this.now()
    try {
      // the board-open read may hold this answer already (handed over once, for the first fetch)
      const s =
        takeOpenState(this.boardId, 'activity') ??
        (await this.request('GET', activityPath(this.boardId), { schema: ActivityState }))
      this.absent = false
      this.apply(s, seq, sent)
      this.confirmed(seq)
    } catch (e) {
      if (seq < this.confirmedSeq) return
      if (is404(e)) {
        // the feature is off here (or the api predates it): nothing to show, nothing to retry
        this.absent = true
        this.state = null
        this.loaded = true
        this.stale = false
        this.confirmed(seq)
      } else {
        this.failedSeq = Math.max(this.failedSeq, seq)
        this.stale = true
        if (retryableError(e)) this.scheduleRetry()
      }
    }
    this.emit()
  }

  private confirmed(seq: number) {
    this.confirmedSeq = Math.max(this.confirmedSeq, seq)
    if (seq < this.failedSeq) return
    this.stale = false
    this.clearRetry()
    this.retryMs = REFRESH_RETRY_MIN_MS
  }

  private scheduleRetry() {
    if (this.disposed || this.retryTimer) return
    const ms = this.retryMs
    this.retryMs = Math.min(this.retryMs * 2, REFRESH_RETRY_MAX_MS)
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null
      if (this.disposed || this.listeners.size === 0) return
      void this.refresh()
    }, ms)
  }

  private clearRetry() {
    if (this.retryTimer) clearTimeout(this.retryTimer)
    this.retryTimer = null
  }

  private clearEndTimer() {
    if (this.endTimer) clearTimeout(this.endTimer)
    this.endTimer = null
    this.endTimerFor = null
  }

  /** An open activity with an end time: redraw at the end (it reads closed) and ask the api a moment after. */
  private armEndTimer() {
    const a = this.state?.activity
    if (a?.status !== 'open' || !a.endsAt) {
      this.clearEndTimer()
      return
    }
    const key = `${a.id}|${a.endsAt}`
    if (this.endTimerFor === key) return
    this.clearEndTimer()
    this.endTimerFor = key
    const left = Math.max(0, Date.parse(a.endsAt) - (this.now() + this.offsetMs))
    this.endTimer = setTimeout(() => {
      this.endTimer = null
      if (this.disposed) return
      this.emit()
      setTimeout(() => {
        if (!this.disposed) void this.refresh()
      }, END_REFRESH_DELAY_MS)
    }, left)
  }

  /** Applies a whole view from any answer, unless a newer request's answer is in already. */
  private apply(s: ActivityState, seq: number, sentAt: number) {
    if (seq < this.appliedSeq) return
    this.appliedSeq = seq
    const prev = this.state
    this.state = s
    this.loaded = true
    const server = Date.parse(s.serverNow)
    // the answer's clock, against the middle of the request's round trip
    if (Number.isFinite(server)) this.offsetMs = server - (sentAt + this.now()) / 2
    this.armEndTimer()
    this.notice(prev, s)
  }

  private onActivityEvent(data: unknown) {
    const p = WorkshopActivityEvent.safeParse(data)
    if (!p.success || this.disposed) return
    const ev = p.data
    const cur = this.state
    const same = cur?.activity?.id === ev.activity.id
    // a new activity, or a status change: refetch this person's own view (their answer, what they may do)
    if (!cur || !same || cur.activity?.status !== ev.activity.status) {
      void this.refresh()
      return
    }
    const prev = cur
    this.state = {
      ...cur,
      activity: ev.activity,
      answered: ev.answered,
      results: ev.results ?? (cur.canManage ? cur.results : null),
    }
    this.armEndTimer()
    this.notice(prev, this.state)
    this.emit()
    // a manager's live counts without resultsLive are theirs alone: they come with their own read
    if (cur.canManage && ev.results === null && ev.activity.status !== 'revealed') void this.refresh()
  }

  private onResultsEvent(data: unknown) {
    const p = WorkshopActivityResultsEvent.safeParse(data)
    if (!p.success || !this.state || this.state.activity?.id !== p.data.activityId) return
    this.state = { ...this.state, results: p.data.results }
    this.emit()
  }

  // ---- actions -------------------------------------------------------------------------------------------------------

  private async mutate(action: ActivityAction, path: string, body?: unknown): Promise<ActionResult> {
    if (this.busy) return { ok: false, error: 'One moment: the last request is still running.' }
    const seq = ++this.seq
    const sent = this.now()
    this.busy = action
    this.emit()
    try {
      const s = await this.request('POST', path, { body, schema: ActivityState })
      this.absent = false
      this.apply(s, seq, sent)
      this.confirmed(seq)
      return { ok: true }
    } catch (e) {
      const r = errorOf(e)
      // the board was archived meanwhile: say so plainly, and read what is true (the api then lets nobody manage)
      if (r.code === BOARD_READ_ONLY) {
        this.archived = true
        void this.refresh()
        return { ok: false, error: ARCHIVED_MESSAGE, code: r.code }
      }
      // the activity moved on (closed, revealed, someone else started one) or the feature went: show what is true
      if (
        r.code === ACTIVITY_ERROR_CODES.activityOpen ||
        r.code === ACTIVITY_ERROR_CODES.notOpen ||
        r.code === ACTIVITY_ERROR_CODES.notYours ||
        r.code === 'NOT_FOUND' ||
        r.code === 'CONFLICT' ||
        // a manage route on a board that went read-only (403): what this person may do changed
        r.code === 'FORBIDDEN'
      )
        void this.refresh()
      return r
    } finally {
      this.busy = null
      this.emit()
    }
  }

  private aid(): string | null {
    return this.state?.activity?.id ?? null
  }

  private onActivity(
    action: Exclude<ActivityAction, 'start'>,
    body?: unknown,
    want?: readonly ActivityStatus[],
  ): Promise<ActionResult> {
    const aid = this.aid()
    const status = this.snap.status
    if (!aid || (want && (!status || !want.includes(status))))
      return Promise.resolve({ ok: false, error: 'There is no poll to do that with right now.' })
    return this.mutate(action, activityActionPath(aid, action), body)
  }

  start(input: StartActivityInput): Promise<ActionResult> {
    return this.mutate('start', activitiesPath(this.boardId), input)
  }

  answer(answer: ActivityAnswer): Promise<ActionResult> {
    return this.onActivity('answer', { answer }, ['open'])
  }

  close(): Promise<ActionResult> {
    return this.onActivity('close', undefined, ['open'])
  }

  reveal(): Promise<ActionResult> {
    const aid = this.aid()
    if (aid) this.revealedHere.add(aid)
    return this.onActivity('reveal', undefined, ['open', 'closed'])
  }

  extend(addMs: number): Promise<ActionResult> {
    return this.onActivity('extend', { addMs }, ['open'])
  }

  cancel(): Promise<ActionResult> {
    return this.onActivity('cancel', undefined, ['open', 'closed'])
  }

  hide(word: string, hidden: boolean): Promise<ActionResult> {
    return this.onActivity('hide', { word, hidden })
  }

  /** Tells the api the results are on the board (idempotent; the summary counts it). */
  placed(): Promise<ActionResult> {
    return this.onActivity('placed', undefined, ['revealed'])
  }

  /** A named activity's answers, after the reveal (managers only; the api decides). */
  async namedAnswers(): Promise<{ ok: true; answers: NamedAnswersResponse['answers'] } | ActionResult> {
    const aid = this.aid()
    if (!aid) return { ok: false, error: 'There is no poll right now.' }
    try {
      const r = await this.request('GET', activityActionPath(aid, 'answers'), {
        schema: NamedAnswersResponse,
      })
      return { ok: true, answers: r.answers }
    } catch (e) {
      return errorOf(e)
    }
  }

  setSetupOpen(open: boolean) {
    if (this.setupOpen === open) return
    this.setupOpen = open
    this.emit()
  }
}

const stores = new WeakMap<object, ActivityStore>()

/** One store per board event stream (stable for the board page), made on first use; it loads with the first resync. */
export function activityStoreOn(events: EventSource & object, make: () => ActivityStore): ActivityStore {
  let s = stores.get(events)
  if (!s) {
    s = make()
    stores.set(events, s)
    s.startFirstLoad()
  }
  return s
}

/** The store of this stream, if one was made (no side effect). */
export const existingActivityStore = (events: object): ActivityStore | null => stores.get(events) ?? null

/** Disposes and forgets the stream's store (the feature's unmount, or its switch going off). */
export function forgetActivityStore(events: object): void {
  stores.get(events)?.dispose()
  stores.delete(events)
}
