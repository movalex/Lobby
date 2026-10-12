// OWNER: WS4 (wave N, N4-3). "Mark all seen" is a beacon the server writes at most once per 10 seconds per person and
// board: since wave N.1 one inside that interval is kept and written when it ends (apps/api visits/gate.ts), so every
// device holds it from then on. But a reload inside the interval is still answered with the visit it already answered
// (the earlier previous time). So this tab remembers, for the life of the tab (sessionStorage, never shared, never
// sent), which visit it acknowledged: a reload that gets the same visit back does not show the chip again. Storage that
// is blocked or throws means no memory: the chip may come back once, which is all that was ever at stake.

export const ackKey = (boardId: string) => `lobby-visit-ack:${boardId}`

export type AckStorage = Pick<Storage, 'getItem' | 'setItem'>

const tabStorage = (): AckStorage | null => {
  try {
    return globalThis.sessionStorage ?? null
  } catch {
    return null
  }
}

/** Remembers that the visit stored at `seenAt` was acknowledged on this tab. */
export function acknowledge(
  boardId: string,
  seenAt: number,
  storage: AckStorage | null = tabStorage(),
): void {
  try {
    storage?.setItem(ackKey(boardId), String(seenAt))
  } catch {
    // no memory
  }
}

/** Whether this tab acknowledged the visit stored at `seenAt`. */
export function wasAcknowledged(
  boardId: string,
  seenAt: number,
  storage: AckStorage | null = tabStorage(),
): boolean {
  try {
    return storage?.getItem(ackKey(boardId)) === String(seenAt)
  } catch {
    return false
  }
}
