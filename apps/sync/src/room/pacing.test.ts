// pacing.ts: a quiet room drains at once (the 25 ms floor after a commit aside); a busy room holds the
// first push of a batch for DRAIN_PACING.busyHoldMs, never the rest of a batch; busy is a sliding second.

import { describe, expect, it } from 'vitest'
import { CommitPacer, DRAIN_PACING } from './pacing.ts'

describe('commit pacing', () => {
  it('quiet: no hold; the floor since the last commit still applies', () => {
    const p = new CommitPacer()
    expect(p.delay(1_000, 0, 25, true)).toBe(0)
    p.noteCommit(1_000)
    expect(p.delay(1_010, 1_000, 25, true)).toBe(15) // the floor: 25 ms after the commit
    expect(p.delay(1_030, 1_000, 25, true)).toBe(0)
    expect(p.busy(1_030)).toBe(false)
  })

  it('busy after busyCommitsPerSecond commits in a second: the first entry of a batch waits busyHoldMs', () => {
    const p = new CommitPacer()
    let t = 10_000
    for (let i = 0; i < DRAIN_PACING.busyCommitsPerSecond; i++) {
      p.noteCommit(t)
      t += 100
    }
    expect(p.busy(t)).toBe(true)
    expect(p.recentCommits(t)).toBe(DRAIN_PACING.busyCommitsPerSecond)
    expect(p.delay(t, t - 100, 25, true)).toBe(DRAIN_PACING.busyHoldMs)
    // the rest of a batch the drain cut (not fresh): the floor only
    expect(p.delay(t, t - 10, 25, false)).toBe(15)
    expect(p.delay(t, t - 100, 25, false)).toBe(0)
    // the hold never shortens the floor
    expect(p.delay(t, t - 5, 25, true)).toBe(Math.max(20, DRAIN_PACING.busyHoldMs))
  })

  it('busy is a sliding second: a room that went quiet drains at once again', () => {
    const p = new CommitPacer()
    for (let i = 0; i < 6; i++) p.noteCommit(20_000 + i * 50)
    expect(p.busy(20_300)).toBe(true)
    expect(p.busy(21_300)).toBe(false)
    expect(p.recentCommits(21_300)).toBe(0)
    expect(p.delay(21_300, 20_250, 25, true)).toBe(0)
  })

  it('one busy commit short of the threshold: no hold', () => {
    const p = new CommitPacer({ busyCommitsPerSecond: 3, busyHoldMs: 40 })
    p.noteCommit(1_000)
    p.noteCommit(1_100)
    expect(p.delay(1_200, 1_100, 25, true)).toBe(0)
    p.noteCommit(1_200)
    expect(p.delay(1_300, 1_200, 25, true)).toBe(40)
  })
})
