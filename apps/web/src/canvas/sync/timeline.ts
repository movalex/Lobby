/**
 * Wave N (WS1): the board page's user-timing marks (`lobby.snapshot.received` / `.decoded`, `lobby.welcome`,
 * `lobby.chunks.start` / `.end`, `lobby.features.start` / `.end`), which the N1 specs read from the page's timeline
 * (e2e/excalidraw/support/big-board.ts `readOpen`). One helper for the socket, the board session and the board page.
 *
 * NODE-SAFE and dependency-free: in a page only (the headless clients of a load run, hundreds per process, never
 * accumulate marks, as engine.ts `measure` does not); never throws.
 */
export function timelineMark(name: string): void {
  if (typeof (globalThis as { document?: unknown }).document === 'undefined') return
  try {
    globalThis.performance?.mark?.(name)
  } catch {
    // no user timing: no mark
  }
}
