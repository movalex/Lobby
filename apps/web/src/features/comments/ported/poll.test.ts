// K2-6 (wave K, F8): the notifications poll skips a hidden tab and refreshes once when it is shown again.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { startNotificationsPoll } from './poll.ts'

/** A document whose visibility the test sets, with the one event the poll listens to. */
function fakeDoc(initial: DocumentVisibilityState) {
  const listeners = new Set<() => void>()
  const doc = {
    visibilityState: initial,
    addEventListener: (type: string, fn: () => void) => {
      if (type === 'visibilitychange') listeners.add(fn)
    },
    removeEventListener: (type: string, fn: () => void) => {
      if (type === 'visibilitychange') listeners.delete(fn)
    },
  }
  const set = (v: DocumentVisibilityState) => {
    doc.visibilityState = v
    for (const fn of listeners) fn()
  }
  return { doc: doc as unknown as Document, set, listeners }
}

describe('the notifications poll (K2-6)', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('polls every interval while the tab is visible', () => {
    const d = fakeDoc('visible')
    const poll = vi.fn()
    const wake = vi.fn()
    const stop = startNotificationsPoll({ poll, wake, doc: d.doc, intervalMs: 60_000 })
    vi.advanceTimersByTime(60_000 * 3)
    expect(poll).toHaveBeenCalledTimes(3)
    expect(wake).not.toHaveBeenCalled()
    stop()
  })

  it('skips every poll while document.visibilityState is hidden', () => {
    const d = fakeDoc('visible')
    const poll = vi.fn()
    const wake = vi.fn()
    const stop = startNotificationsPoll({ poll, wake, doc: d.doc, intervalMs: 60_000 })
    d.set('hidden')
    vi.advanceTimersByTime(60_000 * 16 * 60) // a tab left hidden for 16 h
    expect(poll).not.toHaveBeenCalled()
    expect(wake).not.toHaveBeenCalled()
    stop()
  })

  it('refreshes once on visibilitychange to visible, then polls again', () => {
    const d = fakeDoc('hidden')
    const poll = vi.fn()
    const wake = vi.fn()
    const stop = startNotificationsPoll({ poll, wake, doc: d.doc, intervalMs: 60_000 })
    vi.advanceTimersByTime(180_000)
    expect(poll).not.toHaveBeenCalled()
    d.set('visible')
    expect(wake).toHaveBeenCalledTimes(1)
    // a second "visible" without a hide in between is not a wake
    d.set('visible')
    expect(wake).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(60_000)
    expect(poll).toHaveBeenCalledTimes(1)
    stop()
  })

  it('stops: no more polls and the listener is gone', () => {
    const d = fakeDoc('visible')
    const poll = vi.fn()
    const stop = startNotificationsPoll({ poll, wake: vi.fn(), doc: d.doc, intervalMs: 1_000 })
    stop()
    vi.advanceTimersByTime(10_000)
    expect(poll).not.toHaveBeenCalled()
    expect(d.listeners.size).toBe(0)
  })
})
