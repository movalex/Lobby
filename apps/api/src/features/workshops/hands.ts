// Raise hand (FAC-08): per-board, in-memory only (never written to the database, like presence). A
// hand goes down when its owner lowers it, when a facilitator lowers it (one or all), after
// HAND_AUTO_LOWER_MS, or when its owner has had no open event stream on the board for
// `disconnectGraceMs` (a reload or a replaced stream within the grace keeps the hand up).
//
// Scope: one API process (docs/DEPLOY.md runs one instance); a restart lowers every hand, and the
// clients' refetch on reconnect shows that. Every decision uses the app clock (`now`), so tests can
// age hands and disconnects deterministically; `sweep` runs on every read/write of a board and on a
// periodic timer (see startSweeper) so a hand that expires while nobody touches the board still goes
// down for everyone.

import {
  HAND_AUTO_LOWER_MS,
  type HandChange,
  type HandChangeReason,
  type HandsVersion,
  type RaisedHand,
  type WorkshopHandEvent,
} from '@draftroom/contracts'

export const HAND_DISCONNECT_GRACE_MS = 5_000
/** No board holds more raised hands than this (a 409 beyond; there are rarely that many people). */
export const MAX_HANDS_PER_BOARD = 500

interface Hand {
  userId: string
  name: string
  raisedAt: Date
  /** Order of raising: the queue order (two clock readings can tie, or step back). */
  seq: number
}

/** Someone acting on hands (from the session). */
export interface Actor {
  id: string
  name: string
}

/** Open event streams of one person on one board; `goneSince` is set while there are none. */
interface Presence {
  streams: number
  goneSince: Date | null
}

export interface HandRegistryOptions {
  now: () => Date
  /** Receives every change (already applied): publish it to the board. */
  publish(boardId: string, event: WorkshopHandEvent): void
  autoLowerMs?: number
  disconnectGraceMs?: number
  maxPerBoard?: number
}

export class HandLimitError extends Error {
  constructor() {
    super('Too many hands are raised on this board.')
  }
}

export class HandRegistry {
  private readonly hands = new Map<string, Map<string, Hand>>()
  private readonly presence = new Map<string, Map<string, Presence>>()
  private readonly now: () => Date
  private readonly publish: HandRegistryOptions['publish']
  private readonly autoLowerMs: number
  private readonly graceMs: number
  private readonly maxPerBoard: number
  private seq = 0
  /** This process's hand lists are ordered by `changes`; a restart has another epoch. */
  private readonly epoch = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
  private changes = 0

  constructor(opts: HandRegistryOptions) {
    this.now = opts.now
    this.publish = opts.publish
    this.autoLowerMs = opts.autoLowerMs ?? HAND_AUTO_LOWER_MS
    this.graceMs = opts.disconnectGraceMs ?? HAND_DISCONNECT_GRACE_MS
    this.maxPerBoard = opts.maxPerBoard ?? MAX_HANDS_PER_BOARD
  }

  /** The queue (first raised first), after lowering whatever is due. */
  list(boardId: string): RaisedHand[] {
    this.sweep(boardId)
    return this.view(boardId)
  }

  /** Raises the person's hand (idempotent: an already raised hand keeps its place in the queue). */
  raise(boardId: string, user: Actor): { hands: RaisedHand[]; changed: boolean } {
    this.sweep(boardId)
    let board = this.hands.get(boardId)
    if (board?.has(user.id)) return { hands: this.view(boardId), changed: false }
    if (board && board.size >= this.maxPerBoard) throw new HandLimitError()
    if (!board) {
      board = new Map()
      this.hands.set(boardId, board)
    }
    const at = this.now()
    board.set(user.id, { userId: user.id, name: user.name, raisedAt: at, seq: ++this.seq })
    // Raised without an open stream (e.g. a script): it goes down after the grace like a disconnect.
    const p = this.presenceOf(boardId, user.id, true)
    if (p && p.streams === 0 && !p.goneSince) p.goneSince = at
    this.emit(boardId, [
      { userId: user.id, name: user.name, raised: true, reason: 'raised', byUserId: null, byName: null },
    ])
    return { hands: this.view(boardId), changed: true }
  }

  /**
   * Lowers one hand. `by` = the person lowering it: someone else (a facilitator; the route checks
   * that) or its owner (`by` null or the owner). Idempotent.
   */
  lower(boardId: string, userId: string, by: Actor | null): { hands: RaisedHand[]; changed: boolean } {
    this.sweep(boardId)
    const other = by && by.id !== userId ? by : null
    const changes = this.drop(boardId, [userId], other ? 'lowered_by_facilitator' : 'lowered', other)
    return { hands: this.view(boardId), changed: changes.length > 0 }
  }

  /** Lowers every hand on the board (a facilitator's "Lower all"). */
  clear(boardId: string, by: Actor): { hands: RaisedHand[]; changed: boolean } {
    this.sweep(boardId)
    const ids = [...(this.hands.get(boardId)?.keys() ?? [])]
    const changes = this.drop(boardId, ids, 'cleared', by)
    return { hands: this.view(boardId), changed: changes.length > 0 }
  }

  // ---- event streams --------------------------------------------------------------------------------

  streamOpened(boardId: string, userId: string) {
    const p = this.presenceOf(boardId, userId, true)
    if (!p) return
    p.streams++
    p.goneSince = null
  }

  streamClosed(boardId: string, userId: string) {
    const p = this.presenceOf(boardId, userId, false)
    if (!p) return
    p.streams = Math.max(0, p.streams - 1)
    if (p.streams > 0) return
    if (this.hands.get(boardId)?.has(userId)) p.goneSince = this.now()
    else this.forgetPresence(boardId, userId)
  }

  /** Open event streams the person has on the board (tests and diagnostics). */
  openStreams(boardId: string, userId: string): number {
    return this.presence.get(boardId)?.get(userId)?.streams ?? 0
  }

  // ---- expiry -----------------------------------------------------------------------------------------

  /** Lowers the hands that are due on one board, or on every board with hands. */
  sweep(boardId?: string) {
    const boards = boardId === undefined ? [...this.hands.keys()] : [boardId]
    const at = this.now().getTime()
    for (const b of boards) {
      const board = this.hands.get(b)
      if (!board) continue
      const expired: string[] = []
      const gone: string[] = []
      for (const h of board.values()) {
        const p = this.presence.get(b)?.get(h.userId)
        if (at - h.raisedAt.getTime() >= this.autoLowerMs) expired.push(h.userId)
        else if (p && p.streams === 0 && p.goneSince && at - p.goneSince.getTime() >= this.graceMs)
          gone.push(h.userId)
      }
      // One event per board and sweep: the queue after both kinds of lowering.
      const changes = [
        ...this.drop(b, expired, 'expired', null, false),
        ...this.drop(b, gone, 'disconnected', null, false),
      ]
      if (changes.length > 0) this.emit(b, changes)
    }
  }

  /** Sweeps every `intervalMs` (unref'd); returns the stop function. */
  startSweeper(intervalMs = 1_000): () => void {
    const t = setInterval(() => this.sweep(), intervalMs)
    t.unref?.()
    return () => clearInterval(t)
  }

  // ---- internals --------------------------------------------------------------------------------------

  private view(boardId: string): RaisedHand[] {
    const board = this.hands.get(boardId)
    if (!board) return []
    return [...board.values()]
      .sort((a, b) => a.seq - b.seq)
      .map((h) => ({ userId: h.userId, name: h.name, raisedAt: h.raisedAt.toISOString() }))
  }

  private drop(
    boardId: string,
    userIds: readonly string[],
    reason: HandChangeReason,
    by: Actor | null,
    emit = true,
  ): HandChange[] {
    const board = this.hands.get(boardId)
    if (!board) return []
    const changes: HandChange[] = []
    for (const id of userIds) {
      const h = board.get(id)
      if (!h) continue
      board.delete(id)
      changes.push({
        userId: id,
        name: h.name,
        raised: false,
        reason,
        byUserId: by?.id ?? null,
        byName: by?.name ?? null,
      })
      const p = this.presence.get(boardId)?.get(id)
      if (p && p.streams === 0) this.forgetPresence(boardId, id)
    }
    if (board.size === 0) this.hands.delete(boardId)
    if (emit && changes.length > 0) this.emit(boardId, changes)
    return changes
  }

  /** The version of every list handed out now (lists taken later are never older). */
  version(): HandsVersion {
    return { epoch: this.epoch, n: this.changes }
  }

  private emit(boardId: string, changes: HandChange[]) {
    this.changes++
    this.publish(boardId, { hands: this.view(boardId), changes, version: this.version() })
  }

  private presenceOf(boardId: string, userId: string, create: boolean): Presence | null {
    let board = this.presence.get(boardId)
    if (!board) {
      if (!create) return null
      board = new Map()
      this.presence.set(boardId, board)
    }
    let p = board.get(userId)
    if (!p) {
      if (!create) return null
      p = { streams: 0, goneSince: null }
      board.set(userId, p)
    }
    return p
  }

  private forgetPresence(boardId: string, userId: string) {
    const board = this.presence.get(boardId)
    if (!board) return
    board.delete(userId)
    if (board.size === 0) this.presence.delete(boardId)
  }
}
