// Client state for the workshops feature: one store per open board (per event stream), shared by the
// top-bar timer, the canvas overlay and the voting panel. Framework-free (React subscribes through
// useSyncExternalStore), so the event handling is unit-tested in Node.
//
// Authority: the API. Events are hints: timer events carry the (safe) timer itself; vote events carry
// aggregates only, so a new/ended vote triggers a refetch of the caller's OWN view; every (re)connect
// refetches. Casts are sent one at a time, shown optimistically, and reconciled with each response.

import {
  type CreateVoteInput,
  type HandChange,
  HandsResponse,
  type HandsVersion,
  isNewerHands,
  ListVoteSessionsResponse,
  type RaisedHand,
  type ReactionEmoji,
  type SummonScreen,
  type TimerActionInput,
  TimerResponse,
  VoteResultsResponse,
  type VoteSessionSummary,
  WORKSHOP_EVENTS,
  WorkshopHandEvent,
  WorkshopReactionEvent,
  WorkshopState,
  type WorkshopTimer,
  WorkshopTimerEvent,
  WorkshopVoteEvent,
  WorkshopVoteResultsEvent,
  WorkshopVoteState,
} from '@draftroom/contracts'
import type { z } from 'zod'
import { ReactionThrottle } from './reactions.ts'
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
  /**
   * Set when this tab SAW a vote's results come in (revealed while the board was open, not a vote
   * revealed before it was opened): drives the "Results are in" card until dismissed.
   */
  resultsNews: { sessionId: string; seq: number } | null
  /** The latest message for screen readers about the caller's own votes ("Voted. 2 of 3 left"). */
  announcement: { text: string; seq: number } | null
  /** Raised hands on the board, first raised first (the API's in-memory queue). */
  hands: RaisedHand[]
  /** The caller's own raised hand, if it is up. */
  myHand: RaisedHand | null
  /** A request (from a toast or the hands chip) to open the workshop tools at a section. */
  toolsRequest: { seq: number; section: 'hands' | null } | null
}

/** A reaction to show: from the event stream (someone else) or from this tab (`mine`). */
export interface ReactionShown {
  userId: string
  name: string
  emoji: ReactionEmoji
  mine: boolean
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

/** A clock sample older than this is replaced by the next one, even with a longer round trip. */
const CLOCK_SAMPLE_MAX_AGE_MS = 60_000

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
  /** Best clock sample from this store's own round trips (see noteServerTime). */
  private clock: { offsetMs: number; rttMs: number; at: number } | null = null
  private pending: PendingCast[] = []
  private queue: Promise<unknown> = Promise.resolve()
  private seq = 0
  private appliedSeq = 0
  private summoned: WorkshopSnapshot['summonedBy'] = null
  private hiddenResults = new Set<string>()
  private readonly memo = new Map<string, Participation>()
  private setupOpen = false
  private alertSeq = 0
  private resultsNews: WorkshopSnapshot['resultsNews'] = null
  private newsSeq = 0
  private announcement: WorkshopSnapshot['announcement'] = null
  private hands: RaisedHand[] = []
  private handsVersion: HandsVersion | null = null
  private toolsRequest: WorkshopSnapshot['toolsRequest'] = null
  private readonly throttle = new ReactionThrottle()
  private readonly reactionListeners = new Set<(r: ReactionShown) => void>()
  private readonly handListeners = new Set<(changes: HandChange[]) => void>()
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
      this.events.on(WORKSHOP_EVENTS.reaction, (d) => this.onReactionEvent(d)),
      this.events.on(WORKSHOP_EVENTS.hand, (d) => this.onHandEvent(d)),
      this.events.onResync(() => void this.refresh()),
    )
  }

  dispose() {
    for (const u of this.unsubscribers.splice(0)) u()
    this.listeners.clear()
    this.reactionListeners.clear()
    this.handListeners.clear()
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
      resultsNews: this.resultsNews && this.resultsNews.sessionId === sid ? this.resultsNews : null,
      announcement: this.announcement,
      hands: this.hands,
      myHand: this.hands.find((h) => h.userId === this.userId) ?? null,
      toolsRequest: this.toolsRequest,
    }
  }

  /**
   * Every change of the vote state goes through here: results that arrive for the vote this tab
   * already knew (an open or ended vote that is now revealed with its ranking) are news. The first
   * load (a board opened after the reveal) and other sessions are not.
   */
  private setVote(next: WorkshopVoteState | null) {
    const prev = this.state?.vote ?? null
    if (
      this.loaded &&
      prev &&
      next &&
      prev.session.id === next.session.id &&
      !prev.results &&
      next.results &&
      next.session.status === 'revealed'
    )
      this.resultsNews = { sessionId: next.session.id, seq: ++this.newsSeq }
    if (next?.session.id !== this.resultsNews?.sessionId) this.resultsNews = null
  }

  dismissResultsNews() {
    if (!this.resultsNews) return
    this.resultsNews = null
    this.emit()
  }

  /** A message for the screen-reader live region (the same text twice is announced twice). */
  announce(text: string) {
    this.announcement = { text, seq: (this.announcement?.seq ?? 0) + 1 }
    this.emit()
  }

  /**
   * Server time minus local time, for countdowns. Measured on this store's own requests: the server
   * stamps `serverNow` while the request is in flight, so `serverNow - midpoint(sent, received)` is
   * off by at most half the round trip. The event stream's value (`hello.serverNow - arrival`) is
   * one-way and absorbs every delay before the message is handled (a page still loading can take a
   * second or more), which made a 5:00 timer read 5:01 and late joiners disagree; it is only used
   * until the first response is in.
   */
  serverOffsetMs(): number {
    return this.clock ? this.clock.offsetMs : this.events.serverOffsetMs()
  }

  /** Keeps the tightest sample (smallest round trip); a sample older than a minute is replaced. */
  private noteServerTime(serverNow: string, sentAt: number, receivedAt: number) {
    const server = Date.parse(serverNow)
    if (Number.isNaN(server)) return
    const rttMs = Math.max(0, receivedAt - sentAt)
    const best = this.clock
    if (best && rttMs > best.rttMs && receivedAt - best.at < CLOCK_SAMPLE_MAX_AGE_MS) return
    this.clock = { offsetMs: Math.round(server - (sentAt + receivedAt) / 2), rttMs, at: receivedAt }
  }

  // ---- loading and events --------------------------------------------------------------------------

  async refresh(): Promise<void> {
    const seq = ++this.seq
    try {
      const sentAt = this.nowMs()
      const s = await this.request('GET', `/api/boards/${encodeURIComponent(this.boardId)}/workshop`, {
        schema: WorkshopState,
      })
      this.noteServerTime(s.serverNow, sentAt, this.nowMs()) // a valid clock sample even if superseded
      if (seq < this.appliedSeq) return
      this.appliedSeq = seq
      const timer = this.newerTimer(s.timer) ? s.timer : (this.state?.timer ?? null)
      this.setVote(s.vote)
      this.state = { ...s, timer }
      this.applyHands(s.hands, s.handsVersion)
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
    this.setVote({ ...vote, session: { ...vote.session, status: p.data.status } })
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
    this.setVote({ ...vote, results: p.data.results, session: { ...vote.session, status: 'revealed' } })
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

  // ---- reactions and hands: events -------------------------------------------------------------------

  private onReactionEvent(data: unknown) {
    const p = WorkshopReactionEvent.safeParse(data)
    // This tab showed its own reaction when it was clicked; other tabs of the same person skip it too.
    if (!p.success || p.data.userId === this.userId) return
    this.showReaction({ ...p.data, mine: false })
  }

  private showReaction(r: ReactionShown) {
    for (const l of [...this.reactionListeners]) {
      try {
        l(r)
      } catch (e) {
        console.error('reaction listener failed', e)
      }
    }
  }

  private onHandEvent(data: unknown) {
    const p = WorkshopHandEvent.safeParse(data)
    if (!p.success) return
    if (!this.applyHands(p.data.hands, p.data.version)) return
    this.emit()
    for (const l of [...this.handListeners]) {
      try {
        l(p.data.changes)
      } catch (e) {
        console.error('hand listener failed', e)
      }
    }
  }

  /**
   * Takes a hand list from any path (event, response, refetch) unless it is older than the one held
   * (same API process, lower version). Returns whether it was taken.
   */
  private applyHands(list: RaisedHand[] | undefined, version: HandsVersion | null | undefined): boolean {
    const v = version ?? null
    const newer = v === null ? this.handsVersion === null : isNewerHands(this.handsVersion, v)
    if (!newer) return false
    this.hands = Array.isArray(list) ? list : []
    this.handsVersion = v
    return true
  }

  /** Applies the caller's vote state from a mutation response (ordered by request start). */
  private applyVote(vote: WorkshopVoteState, seq: number) {
    if (seq < this.appliedSeq) return
    this.appliedSeq = seq
    const base = this.state ?? {
      timer: null,
      vote: null,
      hands: [],
      handsVersion: null,
      serverNow: new Date().toISOString(),
    }
    this.setVote(vote)
    this.state = { ...base, vote }
    this.loaded = true
  }

  // ---- timer ---------------------------------------------------------------------------------------

  async timerAction(action: TimerActionInput): Promise<ActionResult> {
    try {
      const sentAt = this.nowMs()
      const r = await this.request('POST', `/api/boards/${encodeURIComponent(this.boardId)}/timer`, {
        body: action,
        schema: TimerResponse,
      })
      this.noteServerTime(r.serverNow, sentAt, this.nowMs())
      if (this.state && this.newerTimer(r.timer)) this.state = { ...this.state, timer: r.timer }
      else if (!this.state)
        this.state = { timer: r.timer, vote: null, hands: [], handsVersion: null, serverNow: r.serverNow }
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

  /**
   * Everyone (or `targetUserId`) follows this person's view. `screen`: this canvas's size, so followers
   * can tell this person's zoom from their presence view (the Excalidraw board; R2-04, SummonScreen).
   */
  async summon(targetUserId?: string, screen?: SummonScreen): Promise<ActionResult> {
    try {
      await this.request('POST', `/api/boards/${encodeURIComponent(this.boardId)}/summon`, {
        body: { ...(targetUserId ? { targetUserId } : {}), ...(screen ? { screen } : {}) },
        schema: null,
      })
      return { ok: true }
    } catch (e) {
      return errorOf(e)
    }
  }

  // ---- reactions -------------------------------------------------------------------------------------

  /** Called for every reaction to show (someone else's from the stream, this tab's own at once). */
  onReaction(fn: (r: ReactionShown) => void): () => void {
    this.reactionListeners.add(fn)
    return () => void this.reactionListeners.delete(fn)
  }

  /**
   * Sends a reaction. Shown here at once (if this tab's own rate limit allows it); everyone else sees
   * it when the server relays it. The server applies the same limit and the emoji allowlist.
   */
  async react(emoji: ReactionEmoji, name: string): Promise<ActionResult> {
    if (!this.throttle.tryTake(this.nowMs()))
      return { ok: false, code: 'RATE_LIMITED', error: 'That is a lot of reactions. Wait a moment.' }
    this.showReaction({ userId: this.userId, name, emoji, mine: true })
    try {
      await this.request('POST', `/api/boards/${encodeURIComponent(this.boardId)}/reactions`, {
        body: { emoji },
        schema: null,
      })
      return { ok: true }
    } catch (e) {
      return errorOf(e)
    }
  }

  // ---- raise hand ------------------------------------------------------------------------------------

  /** Called with what changed whenever a newer hand list arrives by event (toasts). */
  onHandChanges(fn: (changes: HandChange[]) => void): () => void {
    this.handListeners.add(fn)
    return () => void this.handListeners.delete(fn)
  }

  private async handMutation(path: string, body?: unknown): Promise<ActionResult> {
    try {
      const r = await this.request('POST', path, { body, schema: HandsResponse })
      if (this.applyHands(r.hands, r.version)) this.emit()
      return { ok: true }
    } catch (e) {
      const r = errorOf(e)
      void this.refresh()
      return r
    }
  }

  /** Raises or lowers the caller's own hand. */
  setHand(raised: boolean): Promise<ActionResult> {
    return this.handMutation(`/api/boards/${encodeURIComponent(this.boardId)}/hand`, { raised })
  }

  /** Lowers someone's hand (facilitators; anyone for their own). */
  lowerHand(userId: string): Promise<ActionResult> {
    return this.handMutation(
      `/api/boards/${encodeURIComponent(this.boardId)}/hands/${encodeURIComponent(userId)}/lower`,
    )
  }

  /** Lowers every hand (facilitators). */
  clearHands(): Promise<ActionResult> {
    return this.handMutation(`/api/boards/${encodeURIComponent(this.boardId)}/hands/clear`)
  }

  /** Asks the top bar to open the workshop tools (optionally at the raised-hands queue). */
  requestTools(section: 'hands' | null = null) {
    this.toolsRequest = { seq: (this.toolsRequest?.seq ?? 0) + 1, section }
    this.emit()
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
