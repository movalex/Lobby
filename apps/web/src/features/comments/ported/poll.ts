// K2-6 (wave K, F8): the notifications poll. A board tab polled /api/me/notifications every minute whatever it
// was doing; one hidden tab left open for 16 h made 57% of all api traffic on staging. The poll now skips a
// hidden tab and asks once when the tab is shown again (the dashboard bell already did). The board's event
// stream still pushes the news that matters (a mention, a reply, an access request) while hidden.
// Pure: the document, the timers and what a poll does are injected (fake timers in the unit test).

export interface NotificationsPollDeps {
  /** One poll (a fetch of the inbox). */
  poll(): void
  /** The tab became visible again: one refresh (the caller folds it with a window focus into one fetch). */
  wake(): void
  readonly doc: Pick<Document, 'visibilityState' | 'addEventListener' | 'removeEventListener'>
  readonly intervalMs: number
  readonly timers?: {
    setInterval(fn: () => void, ms: number): unknown
    clearInterval(handle: unknown): void
  }
}

/** Starts the poll; returns the stop. */
export function startNotificationsPoll(d: NotificationsPollDeps): () => void {
  const timers = d.timers ?? {
    setInterval: (fn: () => void, ms: number) => setInterval(fn, ms),
    clearInterval: (h: unknown) => clearInterval(h as ReturnType<typeof setInterval>),
  }
  const handle = timers.setInterval(() => {
    if (d.doc.visibilityState === 'hidden') return
    d.poll()
  }, d.intervalMs)
  let wasHidden = d.doc.visibilityState === 'hidden'
  const onVisibility = () => {
    const hidden = d.doc.visibilityState === 'hidden'
    if (wasHidden && !hidden) d.wake()
    wasHidden = hidden
  }
  d.doc.addEventListener('visibilitychange', onVisibility)
  return () => {
    timers.clearInterval(handle)
    d.doc.removeEventListener('visibilitychange', onVisibility)
  }
}
