// K7-4: run something once the browser is idle, never in the burst of a board opening (pure but for the
// environment it is handed). The AI status read used to start the moment the AI overlay mounted: with the
// board's other reads, on every open (43 times, p50 264 ms in 72 hours of staging logs) inside the burst that
// queues on a small database. It now waits for the board to be live and the browser idle (the entry points
// appear a moment later, none is needed during the open), and a person opening the AI menu asks again anyway.

/** The longest the first read waits for an idle moment. */
export const STATUS_IDLE_TIMEOUT_MS = 2500
/** Where there is no requestIdleCallback (Safari): a short pause instead. */
export const STATUS_FALLBACK_DELAY_MS = 1500

export interface IdleEnv {
  requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number
  cancelIdleCallback?: (handle: number) => void
  setTimeout: (cb: () => void, ms: number) => unknown
  clearTimeout: (handle: unknown) => void
}

export function browserIdleEnv(): IdleEnv {
  const g = globalThis as unknown as Partial<IdleEnv>
  return {
    requestIdleCallback: g.requestIdleCallback?.bind(globalThis),
    cancelIdleCallback: g.cancelIdleCallback?.bind(globalThis),
    setTimeout: (cb, ms) => globalThis.setTimeout(cb, ms),
    clearTimeout: (h) => globalThis.clearTimeout(h as ReturnType<typeof setTimeout>),
  }
}

/**
 * Runs `run` when the browser is next idle (at the latest after `timeoutMs`), never synchronously. Returns a
 * cancel: nothing runs once it has been called.
 */
export function deferUntilIdle(
  run: () => void,
  env: IdleEnv = browserIdleEnv(),
  timeoutMs: number = STATUS_IDLE_TIMEOUT_MS,
): () => void {
  let live = true
  const once = () => {
    if (!live) return
    live = false
    run()
  }
  if (env.requestIdleCallback) {
    const handle = env.requestIdleCallback(once, { timeout: timeoutMs })
    return () => {
      live = false
      env.cancelIdleCallback?.(handle)
    }
  }
  const handle = env.setTimeout(once, Math.min(timeoutMs, STATUS_FALLBACK_DELAY_MS))
  return () => {
    live = false
    env.clearTimeout(handle)
  }
}
