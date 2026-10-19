// In-process board event hub (server-sent events). Features publish AFTER their database transaction
// commits; subscribers are the open /api/boards/:bid/events streams of this API process (and, in
// tests or features, plain in-process listeners).
//
// Scope: one API instance (docs/DEPLOY.md). Several instances would need a shared transport
// (Postgres LISTEN/NOTIFY or Key Value pub/sub) behind this same interface.
//
// Events are hints, never the source of truth: every client refetches authoritative state when its
// stream (re)opens, so a missed event can only delay an update, not lose data. Payloads must be safe
// for EVERY viewer of the board — per-user secrets (e.g. unrevealed ballots) never go through here;
// publish a "changed" hint and let each client refetch its own view.
//
// Capacity (docs/SECURITY-REVIEW-2026-09-27.md authz-003): streams belong to a signed-in person and
// are capped per person per board, per person overall, per board and per process. A person over one
// of their own caps loses THEIR oldest stream ('replaced'); a full board or process refuses newcomers
// and never pushes anyone else out. So one viewer with a script can hold at most `perUserPerBoard`
// slots of a board, however many streams they open.
//
// Revocation (authz-005): `accessChanged` is called wherever the sync server is told that access
// changed (app.ts wraps the notifier), and hands the affected streams to the revalidator that the
// stream route installs; `endSessions` ends the streams of revoked sessions (logout, sign out
// everywhere) at once.

/**
 * REVIEW-6: what ONE person's stream hears, and nobody else's, when someone else changed their access
 * (a role set or removed, a request approved, a link revoked, the workspace role, an email invite). It
 * names who did it so the role-change toast can say whom to ask. The name is of a person who manages
 * this board's access, sent only to the affected person (for a change of the board's visibility, to
 * everyone on the board but that person: a page whose role stayed the same drops it); `sharing.changed`
 * stays an identity-free hint for everyone. Published only for a change that changed something.
 */
export const ACCESS_CHANGED_EVENT = 'access.changed'

/** Longest actor name put on the wire (display names are free text). */
const ACTOR_NAME_MAX = 80

/** Boards whose last event position is remembered (least recently changed forgotten first; see boardPosition). */
const BOARD_POSITIONS_MAX = 50_000

export interface BoardEvent {
  /** Namespaced type, e.g. 'comments.thread', 'workshop.timer'. */
  type: string
  data: unknown
}

export interface DeliveredEvent extends BoardEvent {
  /** Monotonic per API process (for ordering and debugging; not a resume token). */
  seq: number
  boardId: string
  at: string
}

export type EventListener = (event: DeliveredEvent) => void

export interface StreamLimits {
  /** Open streams one person may hold on one board (a few tabs); past it their oldest is replaced. */
  perUserPerBoard: number
  /** Open streams one person may hold across boards; past it their oldest is replaced. */
  perUser: number
  /** Open streams per board; past it newcomers are refused (503). */
  perBoard: number
  /** Open streams in this process; past it newcomers are refused (503). */
  total: number
}

export const DEFAULT_STREAM_LIMITS: Readonly<StreamLimits> = {
  perUserPerBoard: 5,
  perUser: 50,
  perBoard: 2_000,
  total: 5_000,
}

/**
 * Why the hub ended a stream: 'replaced' (the same person opened a newer one past a cap),
 * 'access-lost' (the board's access check failed), 'session-ended' (logout, sign out everywhere,
 * expiry or revocation).
 */
export type StreamEndReason = 'replaced' | 'access-lost' | 'session-ended'

/** What the stream route hands the hub for one open SSE response. */
export interface StreamHandle {
  userId: string
  /** sessions.id_hash of the session that opened the stream. */
  sessionId: string
  deliver: EventListener
  /** The hub ended the stream (already unsubscribed when this runs): write the reason and close. */
  end(reason: StreamEndReason): void
}

/** An open stream as the hub's users see it (identity only). */
export interface StreamInfo {
  readonly boardId: string
  readonly userId: string
  readonly sessionId: string
}

export type OpenStreamResult =
  | { ok: true; stream: StreamInfo; close(): void }
  | { ok: false; code: 'TOO_MANY_SUBSCRIBERS' }

/** Re-checks streams (session + board access) and ends the ones that must end. */
export type StreamRevalidator = (streams: readonly StreamInfo[]) => Promise<void>

interface Entry extends StreamInfo {
  readonly handle: StreamHandle
  /**
   * While an access re-check of this stream is in flight, events are held here instead of delivered:
   * nothing published after a revocation committed reaches the revoked person, however long the
   * re-check takes. Released in order when it settles (dropped if the stream ended).
   */
  held: DeliveredEvent[] | null
  holds: number
}

/** Events held per stream during a re-check (hints only; a re-check takes milliseconds). */
const MAX_HELD = 1_000

function deliverTo(e: Entry, event: DeliveredEvent): void {
  try {
    e.handle.deliver(event)
  } catch {
    // a broken stream is cleaned up by its own close handler
  }
}

const firstOf = <T>(items: Iterable<T>, pred: (x: T) => boolean = () => true): T | undefined => {
  for (const x of items) if (pred(x)) return x
  return undefined
}

export class EventHub {
  private readonly limits: StreamLimits
  private readonly listeners = new Map<string, Set<EventListener>>()
  /** Insertion order = open order, so the first entry of each set is the oldest. */
  private readonly byBoard = new Map<string, Set<Entry>>()
  private readonly byUser = new Map<string, Set<Entry>>()
  private total = 0
  private seq = 0
  /** Wave M (M5-1): per board, the seq of the last event published to it or access change on it. */
  private readonly positions = new Map<string, number>()
  /** A new hub (a new process) starts new positions: one from before a restart never equals one after it. */
  private readonly epoch = Math.floor(Math.random() * 0xffffffff)
    .toString(16)
    .padStart(8, '0')
  private generation = 0
  private revalidator: StreamRevalidator | null = null
  /** Features told of every access change after it committed (a board's breakouts republish their members). */
  private readonly accessListeners = new Set<(boardId: string) => void>()

  constructor(opts: { limits?: Partial<StreamLimits> } = {}) {
    const l = { ...DEFAULT_STREAM_LIMITS, ...opts.limits }
    const atLeastOne = (n: number) => Math.max(1, Math.floor(n))
    this.limits = {
      perUserPerBoard: atLeastOne(l.perUserPerBoard),
      perUser: atLeastOne(l.perUser),
      perBoard: atLeastOne(l.perBoard),
      total: atLeastOne(l.total),
    }
  }

  /**
   * A plain in-process listener (features, tests). Not a person's stream: no caps apply beyond the
   * board's. Returns an unsubscribe function, or null when the board is full.
   */
  subscribe(boardId: string, listener: EventListener): (() => void) | null {
    if (this.subscriberCount(boardId) >= this.limits.perBoard) return null
    let set = this.listeners.get(boardId)
    if (!set) {
      set = new Set()
      this.listeners.set(boardId, set)
    }
    set.add(listener)
    return () => {
      const s = this.listeners.get(boardId)
      if (!s) return
      s.delete(listener)
      if (s.size === 0) this.listeners.delete(boardId)
    }
  }

  /**
   * Admits one person's SSE stream on a board. Synchronous: the caller writes the response head in
   * the same tick, so no event can be delivered before it.
   */
  openStream(boardId: string, handle: StreamHandle): OpenStreamResult {
    const { userId } = handle
    const mine = () => this.byUser.get(userId) ?? new Set<Entry>()
    // 1. The person's own caps: replace their oldest stream(s), never anyone else's.
    for (;;) {
      const oldest = firstOf(mine(), (e) => e.boardId === boardId)
      if (!oldest || this.userStreamCount(userId, boardId) < this.limits.perUserPerBoard) break
      this.evict(oldest)
    }
    for (;;) {
      const oldest = firstOf(mine())
      if (!oldest || mine().size < this.limits.perUser) break
      this.evict(oldest)
    }
    // 2. Shared caps: a person already on the board (or anywhere, for the process cap) makes room by
    //    giving up their own oldest stream; a newcomer is refused.
    if (this.subscriberCount(boardId) >= this.limits.perBoard) {
      const own = firstOf(mine(), (e) => e.boardId === boardId)
      if (!own) return { ok: false, code: 'TOO_MANY_SUBSCRIBERS' }
      this.evict(own)
    }
    if (this.total >= this.limits.total) {
      const own = firstOf(mine())
      if (!own) return { ok: false, code: 'TOO_MANY_SUBSCRIBERS' }
      this.evict(own)
    }

    const entry: Entry = { boardId, userId, sessionId: handle.sessionId, handle, held: null, holds: 0 }
    this.add(this.byBoard, boardId, entry)
    this.add(this.byUser, userId, entry)
    this.total++
    return { ok: true, stream: entry, close: () => void this.remove(entry) }
  }

  /**
   * Call only after the change is committed. A throwing listener never affects the others.
   * `opts.to` (F10, team-only comments): deliver to people's streams only when it returns true for
   * the stream's person (decided at publish time; in-process listeners get every event).
   */
  publish(boardId: string, event: BoardEvent, opts: { to?: (userId: string) => boolean } = {}): void {
    const delivered: DeliveredEvent = { ...event, seq: ++this.seq, boardId, at: new Date().toISOString() }
    this.moved(boardId, delivered.seq)
    for (const listener of [...(this.listeners.get(boardId) ?? [])]) {
      try {
        listener(delivered)
      } catch {
        // a broken listener never affects the others
      }
    }
    for (const e of [...(this.byBoard.get(boardId) ?? [])]) {
      if (opts.to && !opts.to(e.userId)) continue
      if (e.held) {
        if (e.held.length < MAX_HELD) e.held.push(delivered)
      } else deliverTo(e, delivered)
    }
  }

  /**
   * Access to `boardId` changed (for `userId`, or for everyone on it: visibility or status). Called
   * after the change commits, wherever the sync server is told. The affected streams are re-checked
   * now by the stream route's revalidator. With the `actor` of the change (the authenticated session's
   * user, REVIEW-6) the affected people's streams are told who made it, once they have been re-checked
   * (see `accessChangedBy`): a person who just lost the board hears nothing.
   */
  accessChanged(change: { boardId: string; userId?: string; actor?: { id: string; name: string } }): void {
    this.generation++
    this.moved(change.boardId, ++this.seq)
    const affected = [...(this.byBoard.get(change.boardId) ?? [])].filter(
      (e) => change.userId === undefined || e.userId === change.userId,
    )
    void this.recheck(affected)
    // after the re-check has taken hold of the streams: the name waits behind it, in order
    if (change.actor) this.accessChangedBy(change, change.actor)
    for (const fn of this.accessListeners) {
      try {
        fn(change.boardId)
      } catch {
        // a feature's listener never breaks the caller's access change
      }
    }
  }

  /**
   * Calls `fn(boardId)` after every `accessChanged` (so after the change committed), once the affected streams'
   * re-check has started. Returns the unsubscribe function.
   */
  onAccessChanged(fn: (boardId: string) => void): () => void {
    this.accessListeners.add(fn)
    return () => {
      this.accessListeners.delete(fn)
    }
  }

  /**
   * REVIEW-6: tells the affected person's streams (only theirs) who changed their access: for one
   * person's change (`userId`), that person's; for a change of the whole board (its visibility: no
   * `userId`), everyone's but the actor's own. Call after the change commits, with the actor from the
   * authenticated session. Nothing is sent when the person changed their own access: the toast names
   * someone to ask, and that is them. A page whose role did not change by it drops the name (the web's
   * AccessActorHint), so a broadcast naming someone for a visibility change costs a role read, no toast.
   */
  accessChangedBy(change: { boardId: string; userId?: string }, actor: { id: string; name: string }): void {
    const name = actor.name.trim().slice(0, ACTOR_NAME_MAX)
    if (!name || actor.id === change.userId) return
    this.publish(
      change.boardId,
      { type: ACCESS_CHANGED_EVENT, data: { actor: { name } } },
      { to: (userId) => (change.userId === undefined ? userId !== actor.id : userId === change.userId) },
    )
  }

  /**
   * Wave M (M5-1): where the board's events stand now, as `<process>.<seq>`. It only moves forward: two equal
   * positions mean nothing was published to the board, and no access to it changed, between the two reads (an
   * audience-limited event moves it for everyone, which can only make a client refetch). GET
   * /api/boards/:bid/open-state reads it before anything else, and every hello carries it from the moment its stream is
   * subscribed (a delivered event's `seq` is the board's position after it): while the open-state's position is at or
   * after every position the page's stream has shown, the page heard of no event the answer lacks
   * (apps/web/src/lib/open-state.ts), so its answer still holds.
   */
  boardPosition(boardId: string): string {
    return `${this.epoch}.${this.positions.get(boardId) ?? 0}`
  }

  private moved(boardId: string, seq: number): void {
    this.positions.delete(boardId)
    this.positions.set(boardId, seq)
    if (this.positions.size > BOARD_POSITIONS_MAX) {
      const oldest = this.positions.keys().next().value
      // a forgotten board reads as 0 again: a position taken before can only differ from it (a refetch)
      if (oldest !== undefined) this.positions.delete(oldest)
    }
  }

  /**
   * Increments on every access change. A stream route reads it before its own access check and
   * re-checks the new stream once subscribed if it moved (a change that committed in between would
   * otherwise miss a stream that was not subscribed yet).
   */
  get accessGeneration(): number {
    return this.generation
  }

  setRevalidator(fn: StreamRevalidator | null): void {
    this.revalidator = fn
  }

  /**
   * Re-checks these streams now, holding their deliveries until the check settles (no-op without a
   * revalidator). Never rejects: a failed check releases the streams (the periodic check decides).
   */
  revalidate(streams: readonly StreamInfo[]): Promise<void> {
    return this.recheck(streams as readonly Entry[])
  }

  private recheck(entries: readonly Entry[]): Promise<void> {
    const revalidator = this.revalidator
    const open = entries.filter((e) => this.isOpen(e))
    if (!open.length || !revalidator) return Promise.resolve()
    for (const e of open) {
      e.holds++
      e.held ??= []
    }
    const release = () => {
      for (const e of open) {
        e.holds--
        if (e.holds > 0) continue
        const held = e.held ?? []
        e.held = null
        if (!this.isOpen(e)) continue
        for (const ev of held) deliverTo(e, ev)
      }
    }
    let settled: Promise<void>
    try {
      settled = revalidator(open)
    } catch {
      settled = Promise.resolve()
    }
    return settled.then(release, release)
  }

  /** Ends every stream opened by one of these sessions; returns how many ended. */
  endSessions(sessionIds: Iterable<string>): number {
    const ids = new Set(sessionIds)
    if (ids.size === 0) return 0
    let n = 0
    for (const set of [...this.byUser.values()])
      for (const e of [...set])
        if (ids.has(e.sessionId)) {
          this.end(e, 'session-ended')
          n++
        }
    return n
  }

  /** Ends one stream (no-op when it already ended). */
  end(stream: StreamInfo, reason: StreamEndReason): void {
    const e = stream as Entry
    if (!this.remove(e)) return
    try {
      e.handle.end(reason)
    } catch {
      // its own close handler cleans up
    }
  }

  /** Every open stream (for the periodic re-check). */
  streams(): StreamInfo[] {
    const out: StreamInfo[] = []
    for (const set of this.byUser.values()) out.push(...set)
    return out
  }

  /** Whether `userId` has an open stream on `boardId` (a tab of the board open in this process). */
  hasStream(boardId: string, userId: string): boolean {
    for (const s of this.byUser.get(userId) ?? []) if (s.boardId === boardId) return true
    return false
  }

  isOpen(stream: StreamInfo): boolean {
    return this.byBoard.get(stream.boardId)?.has(stream as Entry) ?? false
  }

  /** Streams plus in-process listeners on a board. */
  subscriberCount(boardId: string): number {
    return (this.byBoard.get(boardId)?.size ?? 0) + (this.listeners.get(boardId)?.size ?? 0)
  }

  /** Open streams of one person (on one board, or everywhere). */
  userStreamCount(userId: string, boardId?: string): number {
    const set = this.byUser.get(userId)
    if (!set) return 0
    return boardId === undefined ? set.size : [...set].filter((e) => e.boardId === boardId).length
  }

  /** Open streams in this process. */
  streamCount(): number {
    return this.total
  }

  private evict(e: Entry): void {
    this.end(e, 'replaced')
  }

  private add(map: Map<string, Set<Entry>>, key: string, e: Entry): void {
    let set = map.get(key)
    if (!set) {
      set = new Set()
      map.set(key, set)
    }
    set.add(e)
  }

  /** Returns false when the entry was not open. */
  private remove(e: Entry): boolean {
    const board = this.byBoard.get(e.boardId)
    if (!board?.delete(e)) return false
    if (board.size === 0) this.byBoard.delete(e.boardId)
    const user = this.byUser.get(e.userId)
    user?.delete(e)
    if (user?.size === 0) this.byUser.delete(e.userId)
    this.total--
    return true
  }
}
