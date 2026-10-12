// Client state for the workshops feature: one store per open board (per event stream), shared by the
// top-bar timer, the canvas overlay and the voting panel. Framework-free (React subscribes through
// useSyncExternalStore), so the event handling is unit-tested in Node.
//
// Authority: the API. Events are hints: timer events carry the (safe) timer itself; vote events carry
// aggregates only, so a new/ended vote triggers a refetch of the caller's OWN view; every (re)connect
// refetches. Casts are sent one at a time, shown optimistically, and reconciled with each response.
//
// G1 (found live, 2026-10-05): a refetch that fails is tried again until one succeeds (a vote event
// whose refetch failed left a guest on the previous vote for good: it never saw the next one until a
// reload), and a person acting on the vote (joining it, or clicking an object it does not take) has
// this tab's copy confirmed by the server first when nothing confirmed it lately (`confirm`): an event
// stream that dropped or went silent misses the end of one vote and the start of the next.

import {
  type CreateVoteInput,
  type HandChange,
  HandsResponse,
  type HandsVersion,
  isNewerHands,
  isNewerSpotlight,
  ListVoteSessionsResponse,
  type RaisedHand,
  type ReactionEmoji,
  type Spotlight,
  type SpotlightEndReason,
  SpotlightState,
  type SpotlightVersion,
  type SummonScreen,
  type TimerActionInput,
  TimerResponse,
  VoteResultsResponse,
  type VoteSessionSummary,
  WORKSHOP_EVENTS,
  WorkshopHandEvent,
  WorkshopReactionEvent,
  WorkshopSpotlightEvent,
  WorkshopState,
  type WorkshopTimer,
  WorkshopTimerEvent,
  WorkshopVoteEvent,
  WorkshopVoteResultsEvent,
  WorkshopVoteState,
} from '@draftroom/contracts'
import type { z } from 'zod'
import { openStateRoundTrip, takeOpenState } from '../../lib/open-state.ts'
import type { VoteSetupArgs } from './commands.ts'
import { ReactionThrottle } from './reactions.ts'
import { nextResultsNews, type ResultsCardDismissal } from './results-card.ts'
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
  /** L5-3: what the open dialog starts from (a run-off's objects, the coach's scope), or null: its own defaults */
  setupPrefill: VoteSetupPrefill | null
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
  /**
   * K3-1: the "Vote started" banner: an open vote this person has neither joined nor skipped, while they may
   * vote here (`setVoteEligible`). `seq` is the vote's: it comes up once per vote (the banner's entrance and
   * its announcement), not again for every count update, refetch or a stretch of not being eligible.
   */
  voteBanner: VoteBanner | null
  /** K3-1: an object this person clicked before joining: the banner offers to join and give it a dot. */
  joinOffer: { sessionId: string; shapeId: string } | null
  /** L5-2: the board's spotlight (the objects a facilitator is talking about), or null */
  spotlight: Spotlight | null
  /** L5-2: this person pressed Esc (or Hide) for this spotlight: it is dimmed for them no more, for nobody else */
  spotlightHidden: boolean
  /** L5-2: the last spotlight that ended in front of this tab, and why (a notice; null before any) */
  spotlightEnded: SpotlightEnded | null
}

/**
 * L5-3: what the vote setup dialog opens with: the command's args (workshops.vote.setup, ./commands.ts), plus a
 * title and a number of votes when the caller knows better than the dialog's defaults (a run-off).
 */
export interface VoteSetupPrefill extends VoteSetupArgs {
  readonly title?: string
  readonly votesPerPerson?: number
}

/** A spotlight that ended while this tab had the board open. */
export interface SpotlightEnded {
  seq: number
  reason: SpotlightEndReason
  /** whose it was */
  starterName: string
  /** M2-1: its starter's user id (the viewer who started it is told "You ended the spotlight.") */
  starterUserId: string
  /** who ended it (null: the api did) */
  byName: string | null
  /** M2-1: who ended it, by user id (null: the api did) */
  byUserId: string | null
}

/** One spotlight's identity: a new one has a new key (a person who hid the last one sees this one). */
export const spotlightKey = (s: Spotlight) => `${s.version.epoch}:${s.version.n}`

export interface VoteBanner {
  sessionId: string
  title: string
  votesPerPerson: number
  scope: WorkshopVoteState['session']['scope']
  /** who started it (a user id; the UI names them from the people on the board) */
  createdBy: string
  seq: number
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

/** A failed refetch is tried again after this long, then twice as long each time, up to the max (G1). */
export const REFRESH_RETRY_MIN_MS = 1_000
export const REFRESH_RETRY_MAX_MS = 15_000

/**
 * K3-6: a board open fetched /workshop (and /private-brainstorm) twice: once when the store was made and
 * once at the event stream's first resync, which comes at once or a moment later. The first load is now
 * that resync's refetch alone; only a stream that has not connected after this long (slow or down) makes
 * the store fetch on its own (and its later resync fetches again, as every reconnect does).
 */
export const FIRST_LOAD_FALLBACK_MS = 3_000

/**
 * The first load of a store fed by an event stream (K3-6): nothing when a refetch was already asked for
 * (the stream was connected, so its resync ran as the store subscribed), else one fetch after `fallbackMs`
 * unless the resync (or anything else) asked first. Returns the cancel.
 */
export function firstLoad(
  store: { refreshAsked(): boolean; refresh(): Promise<void> },
  fallbackMs = FIRST_LOAD_FALLBACK_MS,
): () => void {
  if (store.refreshAsked()) return () => {}
  const t = setTimeout(() => {
    if (!store.refreshAsked()) void store.refresh()
  }, fallbackMs)
  return () => clearTimeout(t)
}

/**
 * Whether a failed request may succeed if sent again: no answer at all, a server error, a rate limit or
 * an answer that was not the api's (a proxy's page). Not a 401/403/404 (signed out, access lost, gone)
 * or another refusal. Errors without a status (not the api client's) count as retryable.
 */
export function retryableError(e: unknown): boolean {
  const err = e as { kind?: unknown; status?: unknown } | null
  if (typeof err?.kind === 'string')
    return (
      err.kind === 'network' ||
      err.kind === 'server' ||
      err.kind === 'rate-limited' ||
      err.kind === 'bad-response'
    )
  const status = err?.status
  return typeof status !== 'number' || status === 0 || status === 429 || status >= 500
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
  /** Best clock sample from this store's own round trips (see noteServerTime). */
  private clock: { offsetMs: number; rttMs: number; at: number } | null = null
  private pending: PendingCast[] = []
  private queue: Promise<unknown> = Promise.resolve()
  private seq = 0
  private appliedSeq = 0
  /**
   * RT-03 (wave J3): the seq taken when the last vote event's counts arrived. The server moves an open
   * vote's counts once per counting window, and a response to a request that started before that event
   * can carry the window before it: its counts must not undo the event's (no later event would fix them
   * when nothing else changes). The caller's own ballot in such a response still applies.
   */
  private countsSeq = 0
  private summoned: WorkshopSnapshot['summonedBy'] = null
  private hiddenResults = new Set<string>()
  private readonly memo = new Map<string, Participation>()
  private setupOpen = false
  private setupPrefill: VoteSetupPrefill | null = null
  /** L5-3: the last vote this tab saw revealed, kept when a newer vote opens (lastRevealedResults) */
  private lastRevealed: LastRevealedResults | null = null
  /** M2-2: who started the vote `lastRevealed` is of (a user id) */
  private lastRevealedBy: { sessionId: string; startedBy: string; at: number | null } | null = null
  private alertSeq = 0
  private resultsNews: WorkshopSnapshot['resultsNews'] = null
  private newsSeq = 0
  private announcement: WorkshopSnapshot['announcement'] = null
  private hands: RaisedHand[] = []
  private handsVersion: HandsVersion | null = null
  private toolsRequest: WorkshopSnapshot['toolsRequest'] = null
  /** K3-1: whether this person may vote here now (an active board, not presenting): the UI says. */
  private voteEligible = true
  /** K3-1: the banner's seq per vote, given the first time the vote's banner came up. */
  private readonly bannerSeqs = new Map<string, number>()
  private bannerSeq = 0
  private joinOffer: WorkshopSnapshot['joinOffer'] = null
  /** L5-2: the spotlight, the version of that state and which spotlight this person hid (spotlightKey) */
  private spotlight: Spotlight | null = null
  private spotlightVersion: SpotlightVersion | null = null
  private spotlightHiddenKey: string | null = null
  private spotlightEnded: SpotlightEnded | null = null
  private endedSeq = 0
  private readonly throttle = new ReactionThrottle()
  private readonly reactionListeners = new Set<(r: ReactionShown) => void>()
  private readonly handListeners = new Set<(changes: HandChange[]) => void>()
  private readonly listeners = new Set<() => void>()
  private snap: WorkshopSnapshot
  private readonly unsubscribers: (() => void)[] = []
  /** When the server last answered with this person's vote state (a refetch or a vote request). */
  private confirmedAt = Number.NEGATIVE_INFINITY
  private retryTimer: ReturnType<typeof setTimeout> | null = null
  private retryMs = REFRESH_RETRY_MIN_MS
  /** The request seq of the last refetch that succeeded. */
  private refreshedSeq = 0
  /** The highest refetch seq that failed: an older answer does not make the store current again (as private-notes/store.ts). */
  private failedSeq = 0
  private disposed = false
  /** Refetches asked for so far (K3-6: the first load waits for the stream's resync to ask). */
  private refreshes = 0
  private cancelFirstLoad: () => void = () => {}

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
      this.events.on(WORKSHOP_EVENTS.spotlight, (d) => this.onSpotlightEvent(d)),
      this.events.onResync(() => void this.refresh()),
    )
  }

  dispose() {
    this.disposed = true
    this.clearRetry()
    this.cancelFirstLoad()
    for (const u of this.unsubscribers.splice(0)) u()
    this.listeners.clear()
    this.reactionListeners.clear()
    this.handListeners.clear()
  }

  // ---- subscription (useSyncExternalStore) --------------------------------------------------------

  subscribe = (fn: () => void) => {
    this.listeners.add(fn)
    // A retry that found nobody showing this store was dropped: whoever shows it now needs the truth.
    if (this.stale && !this.retryTimer) this.scheduleRetry()
    return () => void this.listeners.delete(fn)
  }
  getSnapshot = () => this.snap

  private emit() {
    this.snap = this.compute()
    for (const l of [...this.listeners]) l()
  }

  private compute(): WorkshopSnapshot {
    const vote = this.state?.vote ?? null
    // L5-3: a revealed vote is remembered, so a newer vote opening does not take its results away
    if (vote?.session.status === 'revealed' && vote.results) {
      this.lastRevealed = {
        sessionId: vote.session.id,
        participants: vote.participants,
        results: vote.results.map((r) => ({ ref: r.shapeId, count: r.count, rank: r.rank })),
      }
      this.lastRevealedBy = {
        sessionId: vote.session.id,
        startedBy: vote.session.createdBy,
        at: voteActivityMs(vote.session),
      }
    }
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
      setupPrefill: this.setupOpen ? this.setupPrefill : null,
      alertSeq: this.alertSeq,
      resultsNews: this.resultsNews && this.resultsNews.sessionId === sid ? this.resultsNews : null,
      announcement: this.announcement,
      hands: this.hands,
      myHand: this.hands.find((h) => h.userId === this.userId) ?? null,
      toolsRequest: this.toolsRequest,
      ...this.bannerAndOffer(vote, sid ? this.readParticipation(sid, vote) : null),
      spotlight: this.spotlight,
      spotlightHidden: !!this.spotlight && this.spotlightHiddenKey === spotlightKey(this.spotlight),
      spotlightEnded: this.spotlightEnded,
    }
  }

  /** K3-1: the banner for `vote` (see WorkshopSnapshot.voteBanner), and the click offer that goes with it. */
  private bannerAndOffer(
    vote: WorkshopVoteState | null,
    participation: Participation | null,
  ): Pick<WorkshopSnapshot, 'voteBanner' | 'joinOffer'> {
    if (vote?.session.status !== 'open' || participation !== null || !this.voteEligible)
      return { voteBanner: null, joinOffer: null }
    const s = vote.session
    let seq = this.bannerSeqs.get(s.id)
    if (seq === undefined) {
      seq = ++this.bannerSeq
      this.bannerSeqs.set(s.id, seq)
    }
    return {
      voteBanner: {
        sessionId: s.id,
        title: s.title,
        votesPerPerson: s.votesPerPerson,
        scope: s.scope,
        createdBy: s.createdBy,
        seq,
      },
      joinOffer: this.joinOffer?.sessionId === s.id ? this.joinOffer : null,
    }
  }

  /** K3-1: whether this person may vote here now (the board is active and they are not presenting). */
  setVoteEligible(eligible: boolean) {
    if (this.voteEligible === eligible) return
    this.voteEligible = eligible
    this.emit()
  }

  /**
   * K3-1: a click on an object the open vote takes, before joining it: the banner offers to join and give it
   * a dot. Nothing is sent (no cast before the join); only while the banner is up.
   */
  offerJoin(sessionId: string, shapeId: string) {
    const banner = this.snap.voteBanner
    if (banner?.sessionId !== sessionId) return
    if (this.joinOffer?.sessionId === sessionId && this.joinOffer.shapeId === shapeId) return
    this.joinOffer = { sessionId, shapeId }
    this.emit()
  }

  clearJoinOffer() {
    if (!this.joinOffer) return
    this.joinOffer = null
    this.emit()
  }

  /**
   * K3-1: the banner's "Join and vote" with an object picked: joins (the vote confirmed with the server
   * first, G1), then casts one dot on it if that vote is still the open one. The cast is sent after the join.
   */
  async joinAndCast(): Promise<ActionResult | null> {
    const offer = this.joinOffer
    if (!offer) return null
    this.joinOffer = null
    await this.joinVote(offer.sessionId)
    const vote = this.state?.vote
    if (vote?.session.id !== offer.sessionId || vote.session.status !== 'open') return null
    return this.cast(offer.shapeId, 1)
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
      this.resultsNews = nextResultsNews(this.resultsNews, {
        kind: 'results',
        sessionId: next.session.id,
        seq: ++this.newsSeq,
      })
    this.resultsNews = nextResultsNews(this.resultsNews, {
      kind: 'vote',
      sessionId: next?.session.id ?? null,
    })
  }

  /**
   * The "Results are in" card is done (./results-card.ts): closed, run out, "See all results", or "Results to
   * board" (M2-4: the person has acted on the results, the card must not wait for them to come back).
   */
  dismissResultsNews(reason: ResultsCardDismissal = 'close') {
    const next = nextResultsNews(this.resultsNews, { kind: reason })
    if (next === this.resultsNews) return
    this.resultsNews = next
    this.emit()
  }

  /** M2-4: the dock's open panel (null: none). Opening the Voting panel ends the card (it shows the same ranking). */
  panelChanged(panel: string | null) {
    const next = nextResultsNews(this.resultsNews, { kind: 'panel', panel })
    if (next === this.resultsNews) return
    this.resultsNews = next
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

  /** Whether a refetch was asked for yet (K3-6 `firstLoad`). */
  refreshAsked = () => this.refreshes > 0

  /** The first load (K3-6): the stream's resync, or a fetch after `fallbackMs` without one. */
  startFirstLoad(fallbackMs?: number) {
    this.cancelFirstLoad()
    this.cancelFirstLoad = firstLoad(this, fallbackMs)
  }

  /**
   * Fetches the workshop state (the caller's own view of the vote). A failure keeps the state shown
   * (marked stale) and is tried again, sooner or later, until a refetch succeeds (G1): the event that
   * asked for it does not come twice.
   */
  async refresh(): Promise<void> {
    this.refreshes++
    const seq = ++this.seq
    try {
      const sentAt = this.nowMs()
      // M5-1/M2: the board-open read may already hold this answer (lib/open-state.ts hands it over once, for the
      // first fetch; null or nothing: this route is asked, as it always was)
      const seeded = takeOpenState(this.boardId, 'workshop') ?? null
      const s =
        seeded ??
        (await this.request('GET', `/api/boards/${encodeURIComponent(this.boardId)}/workshop`, {
          schema: WorkshopState,
        }))
      // a clock sample from a body that was read earlier would be wrong by its age: only an answer to this request
      // counts, or a seeded part with the board-open read's own round trip (its serverNow was stamped within it)
      if (!seeded)
        this.noteServerTime(s.serverNow, sentAt, this.nowMs()) // a valid clock sample even if superseded
      else {
        const trip = openStateRoundTrip(this.boardId)
        if (trip) this.noteServerTime(s.serverNow, trip.sentAt, trip.receivedAt)
      }
      if (seq < this.appliedSeq) return
      this.appliedSeq = seq
      const timer = this.newerTimer(s.timer) ? s.timer : (this.state?.timer ?? null)
      const vote = this.withNewerCounts(s.vote, seq)
      this.setVote(vote)
      this.state = { ...s, timer, vote }
      this.applyHands(s.hands, s.handsVersion)
      // L5-2: an api from before wave L sends no spotlight (no version): none then
      this.applySpotlight(s.spotlight ?? null, s.spotlightVersion ?? null)
      this.loaded = true
      this.refreshedSeq = seq
      this.confirmedAt = this.nowMs()
      // A refetch sent after this one failed: this answer may predate what that one was asked for (a vote
      // that started meanwhile). It is shown, but the store stays stale and its retry keeps running.
      if (seq >= this.failedSeq) {
        this.stale = false
        this.clearRetry()
        this.retryMs = REFRESH_RETRY_MIN_MS
      }
    } catch (e) {
      // A later refetch already succeeded: nothing is missing.
      if (seq < this.refreshedSeq) return
      this.failedSeq = Math.max(this.failedSeq, seq)
      this.stale = true
      if (retryableError(e)) this.scheduleRetry()
    }
    this.emit()
  }

  /**
   * Makes sure this tab acts on the vote the server has open now (G1): refetches unless the server
   * answered with this person's vote state within `maxAgeMs` (and the last refetch did not fail).
   * Resolves once the answer is in, or the refetch failed (the state then stays as it was, stale, and
   * the retry takes over).
   */
  async confirm(maxAgeMs = 0): Promise<void> {
    if (!this.stale && this.nowMs() - this.confirmedAt < maxAgeMs) return
    await this.refresh()
  }

  /** One retry at a time, each failure doubling the wait; nobody showing the store means no retry. */
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
    this.countsSeq = ++this.seq // RT-03: answers to requests sent before this keep these counts
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

  // ---- spotlight (L5-2) ---------------------------------------------------------------------------------

  /**
   * Takes a spotlight state from any path (event, response, refetch) unless it is older than the one held
   * (same API process, lower version). `end`: why it ended, when an event says so. Returns whether it was taken.
   */
  private applySpotlight(
    spotlight: Spotlight | null,
    version: SpotlightVersion | null,
    end?: { reason: SpotlightEndReason | null; endedBy: { userId: string; name: string } | null },
  ): boolean {
    if (!version || !isNewerSpotlight(this.spotlightVersion, version)) return false
    const prev = this.spotlight
    this.spotlight = spotlight
    this.spotlightVersion = version
    if (!spotlight && prev && end?.reason)
      this.spotlightEnded = {
        seq: ++this.endedSeq,
        reason: end.reason,
        starterName: prev.by.name,
        starterUserId: prev.by.userId,
        byName: end.endedBy?.name ?? null,
        byUserId: end.endedBy?.userId ?? null,
      }
    return true
  }

  private onSpotlightEvent(data: unknown) {
    const p = WorkshopSpotlightEvent.safeParse(data)
    if (!p.success) return
    const { spotlight, version, reason, endedBy } = p.data
    if (this.applySpotlight(spotlight, version, { reason, endedBy })) this.emit()
  }

  /** Starts a spotlight on these objects (api refs, `shape:<id>`) for everyone (a facilitator; the api checks). */
  async startSpotlight(refs: readonly string[], bringEveryone = false): Promise<ActionResult> {
    try {
      const r = await this.request('POST', `/api/boards/${encodeURIComponent(this.boardId)}/spotlight`, {
        body: { refs, bringEveryone },
        schema: SpotlightState,
      })
      if (this.applySpotlight(r.spotlight, r.version)) this.emit()
      return { ok: true }
    } catch (e) {
      return errorOf(e)
    }
  }

  /** Ends the board's spotlight for everyone (its starter or a board owner; the api checks). */
  async endSpotlight(): Promise<ActionResult> {
    try {
      const r = await this.request('POST', `/api/boards/${encodeURIComponent(this.boardId)}/spotlight/end`, {
        body: {},
        schema: SpotlightState,
      })
      // M2-1: the person who ended it is told so by this answer, if it comes before the event (the older of the
      // two is not applied again): "You ended the spotlight." (./ported/spotlight.ts endedText)
      const prev = this.spotlight
      const end =
        r.spotlight === null && prev
          ? {
              reason: (prev.by.userId === this.userId ? 'ended' : 'ended-by-owner') as SpotlightEndReason,
              endedBy: { userId: this.userId, name: '' },
            }
          : undefined
      if (this.applySpotlight(r.spotlight, r.version, end)) this.emit()
      return { ok: true }
    } catch (e) {
      return errorOf(e)
    }
  }

  /** This person's Esc: the spotlight is dimmed for them no more (for nobody else), until a new one starts. */
  hideSpotlight() {
    if (!this.spotlight) return
    this.spotlightHiddenKey = spotlightKey(this.spotlight)
    this.emit()
  }

  /** The chip that brings a hidden spotlight back for this person. */
  showSpotlight() {
    if (this.spotlightHiddenKey === null) return
    this.spotlightHiddenKey = null
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

  /**
   * RT-03: `vote` from an answer to the request `seq`, with the shared counts this tab already has when a
   * vote event brought them after that request was sent (the same vote only).
   */
  private withNewerCounts<V extends WorkshopVoteState | null>(vote: V, seq: number): V {
    const cur = this.state?.vote
    if (!vote || !cur || seq > this.countsSeq || cur.session.id !== vote.session.id) return vote
    return {
      ...vote,
      totalVotesCast: cur.totalVotesCast,
      participants: cur.participants,
      participantsDone: cur.participantsDone,
    }
  }

  /** Applies the caller's vote state from a mutation response (ordered by request start). */
  private applyVote(answer: WorkshopVoteState, seq: number) {
    if (seq < this.appliedSeq) return
    this.appliedSeq = seq
    const vote = this.withNewerCounts(answer, seq)
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
    this.confirmedAt = this.nowMs()
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
    if (!open) this.setupPrefill = null
    this.emit()
  }

  /** L5-3: opens the vote setup dialog started from `prefill` (null: its own defaults). */
  openSetup(prefill: VoteSetupPrefill | null) {
    this.setupPrefill = prefill
    this.setupOpen = true
    this.emit()
  }

  /** L5-3: the results of the last revealed vote this tab saw, or null (see lastRevealedResults). */
  lastRevealedResults(): LastRevealedResults | null {
    return this.lastRevealed
  }

  /** M2-2: who started vote `sessionId` (a user id), if it is the vote this store holds or the last it saw revealed. */
  voteStarter(sessionId: string): string | null {
    const vote = this.state?.vote
    if (vote?.session.id === sessionId) return vote.session.createdBy
    return this.lastRevealedBy?.sessionId === sessionId ? this.lastRevealedBy.startedBy : null
  }

  /**
   * N1: when vote `sessionId` last moved (it was started, closed or revealed; ms since the epoch), if it is the vote this
   * store holds or the last it saw revealed, else null.
   */
  voteActivityAt(sessionId: string): number | null {
    const vote = this.state?.vote
    if (vote?.session.id === sessionId) return voteActivityMs(vote.session)
    return this.lastRevealedBy?.sessionId === sessionId ? this.lastRevealedBy.at : null
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
    let stored: string | null = null
    try {
      stored = this.storage?.getItem(this.participationKey(sid)) ?? null
    } catch {
      // not readable: as if nothing was stored
    }
    if (stored === 'joined' || stored === 'skipped') return stored
    // K3-1: whoever started the vote is in it, on every tab of theirs and after a reload (no banner for them)
    return vote.session.createdBy === this.userId ? 'joined' : null
  }

  /**
   * "Join vote": in, and the vote confirmed with the server (G1). A join card can outlive its vote when
   * this tab missed the vote's end (a dropped event stream, a failed refetch): the answer then shows the
   * vote that is open now, with its own join card, instead of a vote that takes no more votes.
   */
  joinVote(sid: string): Promise<void> {
    this.setParticipation(sid, 'joined')
    return this.confirm(0)
  }

  setParticipation(sid: string, v: Participation) {
    if (this.joinOffer?.sessionId === sid) this.joinOffer = null
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

/**
 * One store per board event stream (stable for the board session), created on first use. It loads with
 * the stream's first resync (K3-6: one /workshop request per board open), or on its own when the stream
 * has not connected after FIRST_LOAD_FALLBACK_MS.
 */
export function workshopStoreFor(events: EventSource & object, make: () => WorkshopStore): WorkshopStore {
  let s = stores.get(events)
  if (!s) {
    s = make()
    stores.set(events, s)
    s.startFirstLoad()
  }
  return s
}

// ---- wave L (owner W5; W2's Wrap up and W8's "Sort by votes" import it) -----------------------------------

/** The last revealed vote this tab knows on a board: who took part and the ranked results (ties share a rank). */
export interface LastRevealedResults {
  readonly sessionId: string
  readonly participants: number
  /** `ref` is the voted object's shape ref (`shape:<element id>`, canvas-schema refs.ts) */
  readonly results: readonly { readonly ref: string; readonly count: number; readonly rank: number }[]
}

/**
 * The results of the most recent revealed vote of the board whose event stream is `events` (the board's
 * `ctx.events`), as this tab's workshop store holds them, or null: no store yet (the workshops feature has not
 * loaded on this board), or this tab has not seen a vote revealed. It never fetches and never creates a store.
 * The last revealed vote stays after a newer vote opens (a coach's "vote-weighted action items" and a sort by
 * votes are asked for right when the next vote may already be open); a board opened with a newer vote already
 * open knows only what this tab saw.
 */
export function lastRevealedResults(events: object): LastRevealedResults | null {
  return stores.get(events)?.lastRevealedResults() ?? null
}

/**
 * M2-2: who started the vote `sessionId` on the board whose event stream is `events` (a user id), as this tab's
 * workshop store knows it, or null (no store yet, or that vote is neither the current one nor the last revealed).
 * Reads only; the session coach shows its chip to the vote's starter.
 */
export function voteStarterOf(events: object, sessionId: string): string | null {
  return stores.get(events)?.voteStarter(sessionId) ?? null
}

/**
 * Wave N.1: the server's clock now (ms since the epoch) as this tab estimates it: its own clock plus the offset the workshop
 * store of `events` keeps (measured on its own requests), else the stream's (`serverOffsetMs`). What a server's stamp (a vote's
 * `createdAt`, the stream's times) is compared with: this browser's clock may be minutes or hours off.
 */
export function serverNowOf(events: Pick<EventSource, 'serverOffsetMs'> & object): number {
  return Date.now() + (stores.get(events)?.serverOffsetMs() ?? events.serverOffsetMs())
}

/** N1: when vote `sessionId` last moved (ms since the epoch), as far as this tab's store knows; null when it does not. */
export function voteActivityAtOf(events: object, sessionId: string): number | null {
  return stores.get(events)?.voteActivityAt(sessionId) ?? null
}

/** The latest of a vote session's own stamps (started, closed, revealed), ms since the epoch, or null if none parse. */
function voteActivityMs(session: {
  createdAt: string
  closedAt: string | null
  revealedAt: string | null
}): number | null {
  const times = [session.createdAt, session.closedAt, session.revealedAt]
    .map((t) => (t === null ? Number.NaN : Date.parse(t)))
    .filter((n) => Number.isFinite(n))
  return times.length ? Math.max(...times) : null
}
