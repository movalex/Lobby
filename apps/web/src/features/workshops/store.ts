// Client state for the workshops feature: one store per open board (per event stream), shared by the
// top-bar timer, the canvas overlay and the voting panel. Framework-free (React subscribes through
// useSyncExternalStore), so the event handling is unit-tested in Node.
//
// Authority: the API. Events are hints: timer events carry the (safe) timer itself; vote events carry
// aggregates only, so a new/ended vote triggers a refetch of the caller's OWN view; every (re)connect
// refetches. Casts are sent one at a time, shown optimistically, and reconciled with each response.

import {
  type CreateVoteInput,
  ListVoteSessionsResponse,
  type TimerActionInput,
  TimerResponse,
  VoteResultsResponse,
  type VoteSessionSummary,
  WORKSHOP_EVENTS,
  WorkshopState,
  type WorkshopTimer,
  WorkshopTimerEvent,
  WorkshopVoteEvent,
  WorkshopVoteResultsEvent,
  WorkshopVoteState,
} from '@draftroom/contracts'
import type { z } from 'zod'
import { localCastCheck, optimisticBallot, type PendingCast } from './voting.ts'

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
  serverOffsetMs(): number
}

export type Participation = 'joined' | 'skipped'

export interface WorkshopSnapshot {
  loaded: boolean
  /** The last refresh failed (the UI keeps showing the previous state). */
  stale: boolean
  timer: WorkshopTimer | null
  vote: WorkshopVoteState | null
  /** The caller's ballot including casts still in flight. */
  ballot: { myVotes: Record<string, number>; myRemaining: number } | null
  pendingCount: number
  participation: Participation | null
  /** Show revealed counts as badges on the board (per person, local). */
  showResults: boolean
  /** Set while following someone because they gathered everyone. */
  summonedBy: { userId: string; name: string } | null
  /** The vote setup dialog is open (it can be opened from the top bar or the panel). */
  setupOpen: boolean
  /** Increments each time the timer reaches zero in this tab (drives the visual alert). */
  alertSeq: number
}

export interface ActionResult {
  ok: boolean
  /** User-safe message when !ok. */
  error?: string
  code?: string
}

export interface KeyValueStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

function safeStorage(): KeyValueStorage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage
  } catch {
    return null
  }
}

const errorOf = (e: unknown): ActionResult => {
  const err = e as { message?: unknown; code?: unknown } | null
  return {
    ok: false,
    error: typeof err?.message === 'string' && err.message ? err.message : 'That did not work. Try again.',
    code: typeof err?.code === 'string' ? err.code : undefined,
  }
}

export class WorkshopStore {
  private readonly boardId: string
  private readonly userId: string
  private readonly request: RequestFn
  private readonly events: EventSource
  private readonly storage: KeyValueStorage | null
  private readonly nowMs: () => number

  private state: WorkshopState | null = null
  private loaded = false
  private stale = false
  private responseOffset = 0
  private pending: PendingCast[] = []
  private queue: Promise<unknown> = Promise.resolve()
  private seq = 0
  private appliedSeq = 0
  private summoned: WorkshopSnapshot['summonedBy'] = null
  private hiddenResults = new Set<string>()
  private readonly memo = new Map<string, Participation>()
  private setupOpen = false
  private alertSeq = 0
  private readonly listeners = new Set<() => void>()
  private snap: WorkshopSnapshot
  private readonly unsubscribers: (() => void)[] = []

  constructor(deps: {
    boardId: string
    userId: string
    request: RequestFn
    events: EventSource
    storage?: KeyValueStorage | null
    nowMs?: () => number
  }) {
    this.boardId = deps.boardId
    this.userId = deps.userId
    this.request = deps.request
    this.events = deps.events
    this.storage = deps.storage === undefined ? safeStorage() : deps.storage
    this.nowMs = deps.nowMs ?? (() => Date.now())
    this.snap = this.compute()
    this.unsubscribers.push(
      this.events.on(WORKSHOP_EVENTS.timer, (d) => this.onTimerEvent(d)),
      this.events.on(WORKSHOP_EVENTS.vote, (d) => this.onVoteEvent(d)),
      this.events.on(WORKSHOP_EVENTS.results, (d) => this.onResultsEvent(d)),
      this.events.onResync(() => void this.refresh()),
    )
  }

  dispose() {
    for (const u of this.unsubscribers.splice(0)) u()
    this.listeners.clear()
  }

  // ---- subscription (useSyncExternalStore) --------------------------------------------------------

  subscribe = (fn: () => void) => {
    this.listeners.add(fn)
    return () => void this.listeners.delete(fn)
  }
  getSnapshot = () => this.snap

  private emit() {
    this.snap = this.compute()
    for (const l of [...this.listeners]) l()
  }

  private compute(): WorkshopSnapshot {
    const vote = this.state?.vote ?? null
    const sid = vote?.session.id
    return {
      loaded: this.loaded,
      stale: this.stale,
      timer: this.state?.timer ?? null,
      vote,
      ballot: vote ? optimisticBallot(vote, this.pending) : null,
      pendingCount: this.pending.length,
      participation: sid ? this.readParticipation(sid, vote) : null,
      showResults: sid ? !this.hiddenResults.has(sid) : true,
      summonedBy: this.summoned,
      setupOpen: this.setupOpen,
      alertSeq: this.alertSeq,
    }
  }

  /** Server time minus local time: the event stream's measurement, else the last response's. */
  serverOffsetMs(): number {
    const e = this.events.serverOffsetMs()
    return e !== 0 ? e : this.responseOffset
  }

  // ---- loading and events --------------------------------------------------------------------------

  async refresh(): Promise<void> {
    const seq = ++this.seq
    try {
      const s = await this.request('GET', `/api/boards/${encodeURIComponent(this.boardId)}/workshop`, {
        schema: WorkshopState,
      })
      if (seq < this.appliedSeq) return
      this.appliedSeq = seq
      const serverNow = Date.parse(s.serverNow)
      if (!Number.isNaN(serverNow)) this.responseOffset = serverNow - this.nowMs()
      const timer = this.newerTimer(s.timer) ? s.timer : (this.state?.timer ?? null)
      this.state = { ...s, timer }
      this.loaded = true
      this.stale = false
    } catch {
      this.stale = true
    }
    this.emit()
  }

  /** Server `updatedAt` only moves forward: an older timer (a slow response) never replaces a newer one. */
  private newerTimer(t: WorkshopTimer | null): boolean {
    const cur = this.state?.timer
    if (!cur) return true
    if (!t) return false
    return Date.parse(t.updatedAt) >= Date.parse(cur.updatedAt)
  }

  private onTimerEvent(data: unknown) {
    const p = WorkshopTimerEvent.safeParse(data)
    if (!p.success) return
    if (!this.state) return void this.refresh()
    if (!this.newerTimer(p.data.timer)) return
    this.state = { ...this.state, timer: p.data.timer }
    this.emit()
  }

  private onVoteEvent(data: unknown) {
    const p = WorkshopVoteEvent.safeParse(data)
    if (!p.success) return
    const vote = this.state?.vote
    if (!this.state || !vote || vote.session.id !== p.data.sessionId) return void this.refresh()
    const statusChanged = vote.session.status !== p.data.status
    this.state = {
      ...this.state,
      vote: {
        ...vote,
        totalVotesCast: p.data.totalVotesCast,
        participants: p.data.participants,
        participantsDone: p.data.participantsDone,
        session: { ...vote.session, status: p.data.status, endsAt: p.data.endsAt },
      },
    }
    this.emit()
    // Ended or revealed: fetch the final view (results come only from the server's own response).
    if (statusChanged) void this.refresh()
  }

  private onResultsEvent(data: unknown) {
    const p = WorkshopVoteResultsEvent.safeParse(data)
    if (!p.success) return
    const vote = this.state?.vote
    if (!this.state || !vote || vote.session.id !== p.data.sessionId) return void this.refresh()
    this.state = {
      ...this.state,
      vote: {
        ...vote,
        results: p.data.results,
        totalVotesCast: p.data.totalVotesCast,
        participants: p.data.participants,
        session: { ...vote.session, status: 'revealed' },
      },
    }
    this.emit()
  }

  /** Applies the caller's vote state from a mutation response (ordered by request start). */
  private applyVote(vote: WorkshopVoteState, seq: number) {
    if (seq < this.appliedSeq) return
    this.appliedSeq = seq
    const base = this.state ?? { timer: null, vote: null, serverNow: new Date().toISOString() }
    this.state = { ...base, vote }
    this.loaded = true
  }

  // ---- timer ---------------------------------------------------------------------------------------

  async timerAction(action: TimerActionInput): Promise<ActionResult> {
    try {
      const r = await this.request('POST', `/api/boards/${encodeURIComponent(this.boardId)}/timer`, {
        body: action,
        schema: TimerResponse,
      })
      if (this.state && this.newerTimer(r.timer)) this.state = { ...this.state, timer: r.timer }
      else if (!this.state) this.state = { timer: r.timer, vote: null, serverNow: r.serverNow }
      this.emit()
      return { ok: true }
    } catch (e) {
      return errorOf(e)
    }
  }

  // ---- voting --------------------------------------------------------------------------------------

  private async voteMutation(path: string, body?: unknown): Promise<ActionResult> {
    const seq = ++this.seq
    try {
      const vote = await this.request('POST', path, { body, schema: WorkshopVoteState })
      this.applyVote(vote, seq)
      this.emit()
      return { ok: true }
    } catch (e) {
      const r = errorOf(e)
      if (r.code === 'VOTE_CLOSED' || r.code === 'VOTE_ALREADY_OPEN' || r.code === 'NOT_FOUND')
        void this.refresh()
      return r
    }
  }

  startVote(input: CreateVoteInput): Promise<ActionResult> {
    return this.voteMutation(`/api/boards/${encodeURIComponent(this.boardId)}/votes`, input).then((r) => {
      const sid = this.state?.vote?.session.id
      if (r.ok && sid) this.setParticipation(sid, 'joined') // the facilitator is in by default
      return r
    })
  }

  private sessionPath(action: string): string | null {
    const sid = this.state?.vote?.session.id
    return sid ? `/api/votes/${encodeURIComponent(sid)}/${action}` : null
  }

  closeVote = () => this.sessionAction('close')
  revealVote = () => this.sessionAction('reveal')
  extendVote = (addMs: number) => this.sessionAction('extend', { addMs })
  setDone = (done: boolean) => this.sessionAction('done', { done })

  private sessionAction(action: string, body?: unknown): Promise<ActionResult> {
    const path = this.sessionPath(action)
    if (!path) return Promise.resolve({ ok: false, error: 'There is no vote right now.' })
    return this.voteMutation(path, body)
  }

  /**
   * One +1/-1 on an object, applied optimistically and sent in order. Resolves when the server has
   * answered; a refusal rolls the dot back and explains why.
   */
  cast(shapeId: string, delta: 1 | -1): Promise<ActionResult> {
    const vote = this.state?.vote
    if (vote?.session.status !== 'open')
      return Promise.resolve({ ok: false, error: 'Voting has ended.', code: 'VOTE_CLOSED' })
    const check = localCastCheck(
      optimisticBallot(vote, this.pending),
      shapeId,
      delta,
      vote.session.onePerObject,
    )
    if (!check.ok) return Promise.resolve({ ok: false, error: check.reason, code: 'LOCAL' })
    const item: PendingCast = { shapeId, delta }
    this.pending.push(item)
    this.emit()
    const sid = vote.session.id
    const run = async (): Promise<ActionResult> => {
      const seq = ++this.seq
      try {
        const next = await this.request('POST', `/api/votes/${encodeURIComponent(sid)}/cast`, {
          body: { shapeId, delta },
          schema: WorkshopVoteState,
        })
        this.pending = this.pending.filter((p) => p !== item)
        this.applyVote(next, seq)
        this.emit()
        return { ok: true }
      } catch (e) {
        this.pending = this.pending.filter((p) => p !== item)
        this.emit()
        const r = errorOf(e)
        if (r.code === 'VOTE_CLOSED' || r.code === 'NO_VOTES_LEFT') void this.refresh()
        return r
      }
    }
    const p = this.queue.then(run, run)
    this.queue = p
    return p
  }

  async listVotes(): Promise<VoteSessionSummary[]> {
    const r = await this.request('GET', `/api/boards/${encodeURIComponent(this.boardId)}/votes`, {
      schema: ListVoteSessionsResponse,
    })
    return r.sessions
  }

  results(sessionId: string) {
    return this.request('GET', `/api/votes/${encodeURIComponent(sessionId)}/results`, {
      schema: VoteResultsResponse,
    })
  }

  // ---- gather everyone -------------------------------------------------------------------------------

  async summon(targetUserId?: string): Promise<ActionResult> {
    try {
      await this.request('POST', `/api/boards/${encodeURIComponent(this.boardId)}/summon`, {
        body: targetUserId ? { targetUserId } : {},
        schema: null,
      })
      return { ok: true }
    } catch (e) {
      return errorOf(e)
    }
  }

  setSetupOpen(open: boolean) {
    if (this.setupOpen === open) return
    this.setupOpen = open
    this.emit()
  }

  raiseTimerAlert() {
    this.alertSeq++
    this.emit()
  }

  setSummonedBy(v: WorkshopSnapshot['summonedBy']) {
    if (v?.userId === this.summoned?.userId && v?.name === this.summoned?.name) return
    this.summoned = v
    this.emit()
  }

  // ---- per-person local preferences --------------------------------------------------------------------

  private participationKey(sid: string) {
    return `draftroom:vote:${this.userId}:${sid}`
  }

  private readParticipation(sid: string, vote: WorkshopVoteState): Participation | null {
    // Anyone who already voted or said they're done has joined (e.g. on another tab or after reload).
    if (vote.done || Object.keys(vote.myVotes).length > 0) return 'joined'
    const known = this.memo.get(sid)
    if (known) return known
    try {
      const v = this.storage?.getItem(this.participationKey(sid))
      return v === 'joined' || v === 'skipped' ? v : null
    } catch {
      return null
    }
  }

  setParticipation(sid: string, v: Participation) {
    try {
      this.storage?.setItem(this.participationKey(sid), v)
    } catch {
      // not persisted: the prompt may show again after a reload
    }
    this.memo.set(sid, v)
    this.emit()
  }

  setShowResults(sid: string, show: boolean) {
    if (show) this.hiddenResults.delete(sid)
    else this.hiddenResults.add(sid)
    this.emit()
  }
}

const stores = new WeakMap<object, WorkshopStore>()

/** One store per board event stream (stable for the board session), created on first use. */
export function workshopStoreFor(events: EventSource & object, make: () => WorkshopStore): WorkshopStore {
  let s = stores.get(events)
  if (!s) {
    s = make()
    stores.set(events, s)
    void s.refresh()
  }
  return s
}
