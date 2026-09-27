// In-process board event hub (server-sent events). Features publish AFTER their database transaction
// commits; subscribers are the open /api/boards/:bid/events streams of this API process.
//
// Scope: one API instance (docs/DEPLOY.md). Several instances would need a shared transport
// (Postgres LISTEN/NOTIFY or Key Value pub/sub) behind this same interface.
//
// Events are hints, never the source of truth: every client refetches authoritative state when its
// stream (re)opens, so a missed event can only delay an update, not lose data. Payloads must be safe
// for EVERY viewer of the board — per-user secrets (e.g. unrevealed ballots) never go through here;
// publish a "changed" hint and let each client refetch its own view.

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

const MAX_SUBSCRIBERS_PER_BOARD = 2_000

export class EventHub {
  private readonly boards = new Map<string, Set<EventListener>>()
  private seq = 0

  /** Returns an unsubscribe function, or null when the board is at its subscriber cap. */
  subscribe(boardId: string, listener: EventListener): (() => void) | null {
    let set = this.boards.get(boardId)
    if (!set) {
      set = new Set()
      this.boards.set(boardId, set)
    }
    if (set.size >= MAX_SUBSCRIBERS_PER_BOARD) return null
    set.add(listener)
    return () => {
      const s = this.boards.get(boardId)
      if (!s) return
      s.delete(listener)
      if (s.size === 0) this.boards.delete(boardId)
    }
  }

  /** Call only after the change is committed. A throwing listener never affects the others. */
  publish(boardId: string, event: BoardEvent): void {
    const set = this.boards.get(boardId)
    const delivered: DeliveredEvent = { ...event, seq: ++this.seq, boardId, at: new Date().toISOString() }
    if (!set) return
    for (const listener of [...set]) {
      try {
        listener(delivered)
      } catch {
        // a broken stream is cleaned up by its own close handler
      }
    }
  }

  subscriberCount(boardId: string): number {
    return this.boards.get(boardId)?.size ?? 0
  }
}
