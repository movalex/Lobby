// Wave N.1 (wave M follow-up 5): the share badge's first read waits for the board stream's first hello, so a board open
// makes the open-state read and no GET /sharing of its own (the hello no longer reads a second time). ./badge-reads.ts.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BADGE_HELLO_WAIT_MS, badgeReads } from './badge-reads.ts'

beforeEach(() => {
  vi.useFakeTimers()
})
afterEach(() => {
  vi.useRealTimers()
})

describe('badgeReads', () => {
  it('nothing at mount; ONE read at the first hello (not one at mount and another at the hello)', () => {
    const read = vi.fn()
    const r = badgeReads(read)
    expect(read).not.toHaveBeenCalled()
    r.hello()
    expect(read).toHaveBeenCalledTimes(1)
    // the wait's end changes nothing once the hello came
    vi.advanceTimersByTime(BADGE_HELLO_WAIT_MS * 2)
    expect(read).toHaveBeenCalledTimes(1)
    r.stop()
  })

  it('a stream already connected says hello at once (onResync): one read, at once', () => {
    const read = vi.fn()
    const r = badgeReads(read)
    r.hello() // what onResync does for a connected stream, inside the effect that subscribes
    expect(read).toHaveBeenCalledTimes(1)
    r.stop()
  })

  it('a late hello: one read when the wait ends, and the hello reads again (the first may predate it)', () => {
    const read = vi.fn()
    const r = badgeReads(read)
    vi.advanceTimersByTime(BADGE_HELLO_WAIT_MS - 1)
    expect(read).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(read).toHaveBeenCalledTimes(1)
    r.hello()
    expect(read).toHaveBeenCalledTimes(2)
    r.stop()
  })

  it('every later hello (a reconnect) and every change reads; a change before the first read waits for it', () => {
    const read = vi.fn()
    const r = badgeReads(read)
    r.changed() // a sharing event before the hello: the first read will see it
    expect(read).not.toHaveBeenCalled()
    r.hello()
    r.changed()
    r.hello()
    expect(read).toHaveBeenCalledTimes(3)
    r.stop()
  })

  it('stopped (the badge unmounted): nothing more, not even the wait’s end', () => {
    const read = vi.fn()
    const r = badgeReads(read)
    r.stop()
    vi.advanceTimersByTime(BADGE_HELLO_WAIT_MS * 2)
    r.hello()
    r.changed()
    expect(read).not.toHaveBeenCalled()
  })
})
