// Wave V (WS4): what the breakouts chip, pill and recap say, the "Make N frames" grid, and the cursor choice (pure).
import { BREAKOUT_LIMITS, BreakoutGroupName } from '@draftroom/contracts'
import { describe, expect, it } from 'vitest'
import { cursorFilter, visibleUsers } from './cursors.ts'
import {
  chipModel,
  clockText,
  countText,
  framesPlan,
  groupNameOf,
  MADE_FRAME_GAP,
  MADE_FRAME_SIZE,
  pillPart,
  spokenClock,
} from './model.ts'
import { recapSection } from './recap.ts'

import { iso, ME, OTHER, STARTER, sample, T0 } from './test-kit.ts'

const opts = (nowMs: number, more: Partial<Parameters<typeof chipModel>[1]> = {}) => ({
  nowMs,
  frameExists: () => true,
  sawRunning: true,
  ...more,
})

describe('the clock', () => {
  it('reads m:ss (h:mm:ss past an hour), rounded up', () => {
    expect(clockText(510_000)).toBe('8:30')
    expect(clockText(200)).toBe('0:01')
    expect(clockText(0)).toBe('0:00')
    expect(clockText(-5)).toBe('0:00')
    expect(clockText(3_900_000)).toBe('1:05:00')
    expect(spokenClock(510_000)).toBe('8 minutes 30 seconds')
    expect(spokenClock(61_000)).toBe('1 minute 1 second')
    expect(spokenClock(0)).toBe('0 seconds')
  })
})

describe('the chip', () => {
  it('a member: their group, the time left, Go to my frame', () => {
    const m = chipModel(sample(), opts(T0 + 90_000))
    expect(m).toMatchObject({
      kind: 'member',
      title: 'Group 2',
      time: '8:30 left',
      canGo: true,
      frameRemoved: false,
    })
    expect(m?.spoken).toBe('Breakouts: you are in Group 2, 8 minutes 30 seconds left')
    expect(chipModel(sample(), opts(T0 + 11 * 60_000))?.time).toBe("Time's up")
    expect(chipModel(sample({}, { endsAt: null }), opts(T0))?.time).toBeNull()
  })

  it('a member whose frame was removed: says so and offers no Go', () => {
    const m = chipModel(sample(), opts(T0, { frameExists: () => false }))
    expect(m).toMatchObject({ kind: 'member', frameRemoved: true, canGo: false })
    expect(m?.spoken).toMatch(/Its frame was removed$/)
  })

  it('the facilitator in no group sees the session; choose mode asks to pick; anyone else waits', () => {
    expect(chipModel(sample({ myGroupId: null, canManage: true }), opts(T0))).toMatchObject({
      kind: 'facilitator',
      title: 'Breakouts · 2 groups',
    })
    expect(chipModel(sample({ myGroupId: null }, { mode: 'choose' }), opts(T0))).toMatchObject({
      kind: 'choose',
      title: 'Pick your group',
    })
    expect(chipModel(sample({ myGroupId: null }), opts(T0))?.kind).toBe('waiting')
  })

  it('ended: "Breakouts ended" for a minute, only on a page that saw it run; nothing without a session', () => {
    const ended = sample({ myGroupId: null }, { status: 'ended', endedAt: iso(T0 + 60_000) })
    expect(chipModel(ended, opts(T0 + 90_000))?.kind).toBe('ended')
    expect(chipModel(ended, opts(T0 + 60_000 + 61_000))).toBeNull()
    expect(chipModel(ended, opts(T0 + 90_000, { sawRunning: false }))).toBeNull()
    expect(chipModel(sample({ session: null }), opts(T0))).toBeNull()
    expect(chipModel(null, opts(T0))).toBeNull()
  })
})

describe('the Facilitate pill', () => {
  it('"Group 2 · 8:30" for a member, "Breakouts · 8:30" otherwise, nothing when none runs', () => {
    expect(pillPart(sample(), T0 + 90_000)).toEqual({
      text: 'Group 2 · 8:30',
      spoken: 'breakouts, you are in Group 2, 8 minutes 30 seconds left',
    })
    expect(pillPart(sample({ myGroupId: null }), T0)?.text).toBe('Breakouts · 10:00')
    expect(pillPart(sample({}, { endsAt: null }), T0)?.text).toBe('Group 2')
    expect(pillPart(sample({}, { status: 'ended', endedAt: iso(T0) }), T0)).toBeNull()
    expect(pillPart(null, T0)).toBeNull()
  })
})

describe('Make N frames', () => {
  it('a grid of N named frames (at most 5 a row), N clamped to 2-20', () => {
    const p = framesPlan(4)
    expect(p.frames.map((f) => f.name)).toEqual(['Group 1', 'Group 2', 'Group 3', 'Group 4'])
    expect(p.frames.map((f) => [f.x, f.y])).toEqual([
      [0, 0],
      [MADE_FRAME_SIZE.w + MADE_FRAME_GAP, 0],
      [0, MADE_FRAME_SIZE.h + MADE_FRAME_GAP],
      [MADE_FRAME_SIZE.w + MADE_FRAME_GAP, MADE_FRAME_SIZE.h + MADE_FRAME_GAP],
    ])
    expect(p.width).toBe(2 * MADE_FRAME_SIZE.w + MADE_FRAME_GAP)
    expect(framesPlan(1).frames).toHaveLength(BREAKOUT_LIMITS.groupsMin)
    const big = framesPlan(99)
    expect(big.frames).toHaveLength(BREAKOUT_LIMITS.groupsMax)
    expect(Math.max(...big.frames.map((f) => f.x))).toBe(4 * (MADE_FRAME_SIZE.w + MADE_FRAME_GAP))
    // no two frames overlap
    for (const a of big.frames)
      for (const b of big.frames)
        if (a !== b)
          expect(a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y).toBe(true)
  })

  it('a frame name becomes a one-line group name of at most 40 characters, "Group n" when empty', () => {
    expect(groupNameOf('  Team\n Red ', 1)).toBe('Team Red')
    expect(groupNameOf('', 3)).toBe('Group 3')
    expect(groupNameOf(null, 2)).toBe('Group 2')
    expect([...groupNameOf('ab😀'.repeat(20), 1)]).toHaveLength(40)
  })

  it('a frame named with a ZWJ emoji or a Persian word keeps it; stray invisible characters go, so the api takes every name (review m7)', () => {
    const s = (...cps: number[]) => String.fromCodePoint(...cps)
    const coder = `${s(0x1f469, 0x200d, 0x1f4bb)} Devs`
    const rainbow = `${s(0x1f3f3, 0xfe0f, 0x200d, 0x1f308)} Team`
    const persian = s(0x0645, 0x06cc, 0x200c, 0x062e, 0x0648, 0x0627, 0x0647, 0x0645)
    for (const name of [coder, rainbow, persian]) {
      expect(groupNameOf(name, 1)).toBe(name)
      expect(BreakoutGroupName.safeParse(groupNameOf(name, 1)).success).toBe(true)
    }
    // a bidi control, a zero-width space, a joiner next to ASCII: out
    expect(groupNameOf(`Re${s(0x202e)}d${s(0x200b)} Bo${s(0x200d)}b`, 1)).toBe('Red Bob')
    // a cut that would end on a joiner drops it
    const long = `${'x'.repeat(39)}${s(0x1f469, 0x200d, 0x1f4bb)}`
    const cut = groupNameOf(long, 1)
    expect(BreakoutGroupName.safeParse(cut).success).toBe(true)
    expect(cut).toBe(`${'x'.repeat(39)}${s(0x1f469)}`)
  })

  it('counts read as people, or "n of cap"', () => {
    expect(countText(0, null)).toBe('Empty')
    expect(countText(1, null)).toBe('1 person')
    expect(countText(3, null)).toBe('3 people')
    expect(countText(2, 5)).toBe('2 of 5')
  })
})

describe('only my group cursors', () => {
  it('off, or not in a running group: no filter; on: my group and the starter', () => {
    expect(visibleUsers(sample(), false)).toBeNull()
    expect(visibleUsers(sample({ myGroupId: null }), true)).toBeNull()
    expect(visibleUsers(sample({}, { status: 'ended', endedAt: iso(T0) }), true)).toBeNull()
    const users = visibleUsers(sample(), true)
    expect([...(users ?? [])].sort()).toEqual([ME, STARTER].sort())
    const sids: Record<string, string> = { s1: ME, s2: OTHER, s3: STARTER }
    const f = cursorFilter(users ?? new Set(), (sid) => sids[sid] ?? null)
    expect([f('s1'), f('s2'), f('s3'), f('unknown')]).toEqual([true, false, true, true])
  })
})

describe('the recap section', () => {
  it('groups, people and time; per group a count; nobody named', () => {
    const s = sample({}, { status: 'ended', endedAt: iso(T0 + 25 * 60_000), mode: 'auto' })
    const r = recapSection(s, { since: null, now: T0 + 30 * 60_000 })
    expect(r?.title).toBe('Breakouts')
    expect(r?.lines.map((l) => l.text)).toEqual([
      '2 groups, 2 people, 25 min (split automatically)',
      'Group 1: 1 person',
      'Group 2: 1 person',
    ])
    expect(JSON.stringify(r)).not.toMatch(/Me|Other|usr_/)
    // outside the window, or no session: nothing
    expect(recapSection(s, { since: T0 + 26 * 60_000, now: T0 + 30 * 60_000 })).toBeNull()
    expect(recapSection(null, { since: null, now: T0 })).toBeNull()
    expect(recapSection(sample(), { since: null, now: T0 + 5 * 60_000 })?.lines[0]?.text).toMatch(
      /running for 5 min/,
    )
  })
})
