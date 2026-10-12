// When the share badge reads GET /api/boards/:bid/sharing (wave N.1, wave M follow-up 5: "the share badge's hello
// refetch"). The badge read its state at mount (the board-open read's 'sharing' part, lib/open-state.ts) and again at
// the board stream's first hello (its resync), so every board open made one GET /sharing besides the open-state read.
//
// The first read now waits for the stream's first hello, at most BADGE_HELLO_WAIT_MS: taken at the hello, the
// open-state part is handed out only when its answer already holds everything the stream has shown (lib/open-state.ts
// compares the hello's position), so that one read is enough and the hello needs no other. Until then the badge shows
// what the board itself says (its visibility), as it did while the first read was on its way. A hello that comes later
// than the wait reads again (the first read may predate it), and so does every later hello (a reconnect), a sharing
// event, a change made in this tab, and the visible tab's slow poll: as before.

/** How long the first read waits for the stream's first hello (the export gates' HELLO_WAIT_MS, export-policy.ts). */
export const BADGE_HELLO_WAIT_MS = 1_500

export interface BadgeReads {
  /** The board stream said hello (onResync: at once when it is already connected, then at every reconnect). */
  hello(): void
  /** Something may have changed the badge (an event, this tab's dialog, the poll, the board's visibility). */
  changed(): void
  stop(): void
}

export function badgeReads(read: () => void, helloWaitMs: number = BADGE_HELLO_WAIT_MS): BadgeReads {
  /** the first read has not been made: it waits for the hello (or the wait's end) */
  let waiting = true
  let stopped = false
  let timer: ReturnType<typeof setTimeout> | null = setTimeout(() => {
    timer = null
    if (!waiting || stopped) return
    waiting = false
    read() // the hello is late (or the stream is broken): read without it; the hello reads again when it comes
  }, helloWaitMs)
  const first = () => {
    waiting = false
    if (timer) clearTimeout(timer)
    timer = null
  }
  return {
    hello() {
      if (stopped) return
      if (waiting) first()
      read()
    },
    changed() {
      if (stopped || waiting) return // the first read is still to come, and reads the state as it is then
      read()
    },
    stop() {
      stopped = true
      if (timer) clearTimeout(timer)
      timer = null
    },
  }
}
