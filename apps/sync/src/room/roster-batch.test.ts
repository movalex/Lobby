// roster-batch.ts: the roster events of one batch (at most ROSTER_FLUSH_MS, or until the room's presence tick
// flushes it) go out as one frame per recipient, in order; a session whose join is in the batch gets the frame
// without its own join; the batch flushes on demand; a join spread over time (CAP-L1) still costs one frame per
// recipient per 100 ms.

import { describe, expect, it, vi } from 'vitest'
import { ROSTER_FLUSH_MS, RosterBatch, type RosterRecipient } from './roster-batch.ts'

const entry = (sid: string) => ({
  sid,
  uid: sid.split(':')[0] as string,
  name: sid,
  color: '#000',
  role: 'editor' as const,
  guest: false,
})

function setup() {
  const recipients = new Map<string, { sid: string; frames: string[] }>()
  const add = (sid: string) => {
    const r = { sid, frames: [] as string[] }
    recipients.set(sid, r)
    return r
  }
  let scheduled: (() => void) | null = null
  const batch = new RosterBatch(
    () =>
      [...recipients.values()].map((r): RosterRecipient => ({ sid: r.sid, send: (f) => r.frames.push(f) })),
    (fn) => {
      scheduled = fn
      return 0 as unknown as ReturnType<typeof setImmediate>
    },
  )
  const runScheduled = () => {
    const fn = scheduled
    scheduled = null
    fn?.()
  }
  return {
    batch,
    add,
    remove: (sid: string) => recipients.delete(sid),
    runScheduled,
    isScheduled: () => scheduled !== null,
  }
}
const events = (frames: string[]) =>
  frames.flatMap(
    (f) =>
      (JSON.parse(f) as { events: ({ k: 'join'; p: { sid: string } } | { k: 'leave'; sid: string })[] })
        .events,
  )
const sids = (frames: string[]) => events(frames).map((e) => (e.k === 'join' ? `+${e.p.sid}` : `-${e.sid}`))

describe('roster batch', () => {
  it('several joins and a leave of one macrotask: one frame per recipient, every event, in order', () => {
    const { batch, add, runScheduled, isScheduled } = setup()
    const old = add('old:1')
    batch.push({ k: 'join', p: entry('a:1') })
    batch.push({ k: 'join', p: entry('b:1') })
    batch.push({ k: 'leave', sid: 'gone:1' })
    batch.push({ k: 'join', p: entry('c:1') })
    expect(isScheduled()).toBe(true)
    expect(old.frames).toHaveLength(0) // nothing before the flush
    runScheduled()
    expect(old.frames).toHaveLength(1)
    expect(sids(old.frames)).toEqual(['+a:1', '+b:1', '-gone:1', '+c:1'])
    expect(batch.frames).toBe(1)
    expect(batch.queued).toBe(0)
    // nothing left: a flush sends nothing
    batch.flush()
    expect(old.frames).toHaveLength(1)
  })

  it('a joiner of the batch gets the frame without its own join; one whose only event is its own gets none', () => {
    const { batch, add, runScheduled } = setup()
    const old = add('old:1')
    const a = add('a:1')
    const b = add('b:1')
    batch.push({ k: 'join', p: entry('a:1') })
    batch.push({ k: 'join', p: entry('b:1') })
    runScheduled()
    expect(sids(old.frames)).toEqual(['+a:1', '+b:1'])
    expect(sids(a.frames)).toEqual(['+b:1'])
    expect(sids(b.frames)).toEqual(['+a:1'])
    const { batch: solo, add: addSolo, runScheduled: runSolo } = setup()
    const only = addSolo('only:1')
    solo.push({ k: 'join', p: entry('only:1') })
    runSolo()
    expect(only.frames).toHaveLength(0)
  })

  it('a join and a leave of the same session keep their order across flushes', () => {
    const { batch, add, runScheduled } = setup()
    const w = add('w:1')
    batch.push({ k: 'join', p: entry('x:1') })
    runScheduled()
    batch.push({ k: 'leave', sid: 'x:1' })
    batch.push({ k: 'join', p: entry('x:1') })
    runScheduled()
    expect(sids(w.frames)).toEqual(['+x:1', '-x:1', '+x:1'])
    expect(w.frames).toHaveLength(2)
  })

  it('flush() on demand sends what is queued before a caller’s own frame; close() drops the rest', () => {
    const { batch, add, runScheduled, isScheduled } = setup()
    const w = add('w:1')
    batch.push({ k: 'join', p: entry('y:1') })
    batch.flush()
    expect(sids(w.frames)).toEqual(['+y:1'])
    runScheduled() // the earlier schedule runs into an empty batch
    expect(w.frames).toHaveLength(1)
    batch.push({ k: 'leave', sid: 'y:1' })
    batch.close()
    expect(batch.queued).toBe(0)
    expect(isScheduled()).toBe(true) // the fake scheduler cannot be cancelled; the real one is cleared
    runScheduled()
    expect(w.frames).toHaveLength(1)
  })
})

describe('roster batch timing (CAP-L1)', () => {
  it('joins spread over time (a restart’s reconnects coming back with their backoff) go out at most once per ROSTER_FLUSH_MS, not once per join; each within it', () => {
    vi.useFakeTimers()
    try {
      const old = { sid: 'old:1', frames: [] as string[] }
      const batch = new RosterBatch(() => [{ sid: old.sid, send: (f: string) => old.frames.push(f) }])
      // 40 joins, one every 5 ms (200 ms): before, each went out alone (40 frames to every recipient)
      for (let i = 0; i < 40; i++) {
        batch.push({ k: 'join', p: entry(`j${i}:1`) })
        vi.advanceTimersByTime(5)
      }
      vi.advanceTimersByTime(ROSTER_FLUSH_MS)
      expect(sids(old.frames)).toEqual(Array.from({ length: 40 }, (_, i) => `+j${i}:1`))
      expect(old.frames.length).toBeLessThanOrEqual(Math.ceil(200 / ROSTER_FLUSH_MS) + 1)
      // a lone join is seen at most ROSTER_FLUSH_MS later
      const before = old.frames.length
      batch.push({ k: 'leave', sid: 'j0:1' })
      vi.advanceTimersByTime(ROSTER_FLUSH_MS - 1)
      expect(old.frames).toHaveLength(before)
      vi.advanceTimersByTime(1)
      expect(sids(old.frames.slice(before))).toEqual(['-j0:1'])
      // close() cancels the pending flush
      batch.push({ k: 'leave', sid: 'j1:1' })
      batch.close()
      vi.advanceTimersByTime(ROSTER_FLUSH_MS * 2)
      expect(old.frames).toHaveLength(before + 1)
    } finally {
      vi.useRealTimers()
    }
  })
})
