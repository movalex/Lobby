// CONTRACTS_REV 10 (wave A, A2: CR-3C-1, CR-3CF-1) through the real server process: the room announces
// rev 10 in a `contracts` frame after every welcome; a client that then sends `f` gets the rev-10 fields
// (`f`, `view.z`, `followers`) and always the peer it follows; a rev-9 client (a tab loaded before the
// deploy: it never sends `f`) gets only frames its rev-9 schema accepts, apart from the `contracts` frame,
// which its transport drops as unknown; a reconnect starts each socket over as rev 9 until it sends `f`.

import { CURSORS_PER_RECIPIENT } from '@draftroom/canvas-schema/limits'
import { CONTRACTS_REV, PRESENCE_FOLLOW_REV } from '@draftroom/canvas-schema/protocol'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import type { RawClient } from './support/client.ts'
import { newBoardId, useElementHarness } from './support/stack.ts'

const h = useElementHarness()
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** Rev 9's server messages as far as a rev-9 client's strict parse goes for presence. */
const Rect9 = z.strictObject({ x: z.number(), y: z.number(), w: z.number(), h: z.number() })
const PresenceOut9 = z.strictObject({
  type: z.literal('presence'),
  peers: z.array(
    z.strictObject({
      sid: z.string(),
      pointer: z.strictObject({ x: z.number(), y: z.number() }).nullable(),
      button: z.enum(['up', 'down']),
      sel: z.unknown(),
      view: Rect9.nullable(),
      idle: z.boolean(),
      editing: z.string().nullable(),
    }),
  ),
  off: z.array(z.string()).optional(),
  drags: z.array(z.unknown()).optional(),
})

const sidOf = (c: RawClient) => c.welcome?.sid as string

/** A presence message; `f` present makes it a rev-10 sender's. */
function say(
  c: RawClient,
  p: { pointer?: { x: number; y: number } | null; view?: Record<string, number> | null; f?: string | null },
) {
  c.send({
    type: 'presence',
    pointer: p.pointer === undefined ? { x: 1, y: 1 } : p.pointer,
    button: 'up',
    sel: [],
    view: p.view ?? null,
    idle: false,
    editing: null,
    ...('f' in p ? { f: p.f ?? null } : {}),
  })
}

/** A presence frame as it came off the wire (unparsed: what a rev-9 client would read). */
interface WireFrame {
  type: string
  peers: { sid: string; view?: { z?: number } | null }[]
  off?: string[]
  followers?: string[]
}

const presenceFrames = (c: RawClient) =>
  c.rawFrames.map((f) => JSON.parse(f) as WireFrame).filter((m) => m.type === 'presence')

describe('presence CONTRACTS_REV 10 through the room', () => {
  it('the contracts frame follows the welcome (before the late joiner presence); a rev-9 client is served rev 9', async () => {
    const st = await h.stack()
    const b = newBoardId()
    const leader = await st.client({ boardId: b, user: 'leader' })
    say(leader, { pointer: { x: 5, y: 5 }, view: { x: 0, y: 0, w: 800, h: 600, z: 1.5 }, f: null })
    await sleep(250)
    const old = await st.client({ boardId: b, user: 'stale' }) // a rev-9 tab: never sends `f`
    await old.until(() => old.of('presence').length > 0, 'the late joiner presence')
    const types = old.rawFrames.map((f) => (JSON.parse(f) as { type: string }).type)
    const w = types.indexOf('welcome')
    const c = types.indexOf('contracts')
    expect(w).toBeGreaterThanOrEqual(0)
    expect(c).toBeGreaterThan(w)
    // the room's revision (11 since wave C's push receipts); a rev-10 tab reads it as rev 10 or later
    expect(JSON.parse(old.rawFrames[c] as string)).toEqual({ type: 'contracts', rev: CONTRACTS_REV })
    expect(CONTRACTS_REV).toBeGreaterThanOrEqual(PRESENCE_FOLLOW_REV)
    const firstPresence = types.indexOf('presence')
    expect(firstPresence).toBeGreaterThan(c)
    // the rev-10 leader follows the stale tab and zooms: the stale tab still gets every frame as rev 9
    say(old, { pointer: { x: 9, y: 9 }, view: { x: 0, y: 0, w: 100, h: 100 } })
    for (let i = 0; i < 3; i++) {
      say(leader, {
        pointer: { x: 10 + i, y: 5 },
        view: { x: i, y: 0, w: 800, h: 600, z: 1.5 + i },
        f: sidOf(old),
      })
      await sleep(150)
    }
    await old.until(
      () => presenceFrames(old).some((m) => JSON.stringify(m).includes('"x":12')),
      'the last move',
    )
    expect(presenceFrames(old).length).toBeGreaterThan(1)
    for (const m of presenceFrames(old))
      expect(PresenceOut9.safeParse(m).success, JSON.stringify(m)).toBe(true)
    // nothing else new reaches it: the one rev-10 frame type is `contracts` (its transport drops that one)
    const REV9_TYPES = ['welcome', 'changes', 'ack', 'lease.grant', 'lease.deny', 'lease', 'roster']
    const others = old.rawFrames.map((f) => (JSON.parse(f) as { type: string }).type)
    expect(others.filter((t) => t !== 'contracts' && t !== 'presence' && !REV9_TYPES.includes(t))).toEqual([])
    expect(others.filter((t) => t === 'contracts')).toHaveLength(1)
    expect(old.schemaErrors).toEqual([])
    // the rev-10 leader (it sent `f`) got the stale tab's entries in the rev-10 form, and its followers list
    // names nobody (the stale tab follows nobody it can say)
    expect(presenceFrames(leader).some((m) => JSON.stringify(m).includes(sidOf(old)))).toBe(true)
  })

  it('a rev-10 follower gets the leader (f, view.z) past 40 cursors, and the leader the list of followers', async () => {
    const st = await h.stack()
    const b = newBoardId()
    const leader = await st.client({ boardId: b, user: 'leader' })
    const follower = await st.client({ boardId: b, user: 'follower' })
    const crowd = await Promise.all(
      Array.from({ length: CURSORS_PER_RECIPIENT + 4 }, (_, i) => st.client({ boardId: b, user: `c${i}` })),
    )
    // the crowd's cursors fill the follower's view; the leader's pointer is off the canvas, elsewhere
    crowd.forEach((c, i) => {
      say(c, { pointer: { x: 10 + i, y: 10 }, f: sidOf(leader) })
    })
    say(follower, { view: { x: 0, y: 0, w: 1_000, h: 1_000 }, f: sidOf(leader) })
    await sleep(250)
    say(leader, { pointer: null, view: { x: 50_000, y: 50_000, w: 640, h: 480, z: 2.5 }, f: null })
    await follower.until(
      () =>
        presenceFrames(follower).some((m) =>
          m.peers.some((p) => p.sid === sidOf(leader) && p.view?.z === 2.5),
        ),
      'the leader view with its zoom',
    )
    // the leader holds at most 40 cursors and the whole list of who follows it
    await leader.until(
      () => presenceFrames(leader).some((m) => (m.followers ?? []).length === crowd.length + 1),
      'every follower listed',
    )
    const held = new Map<string, unknown>()
    for (const m of presenceFrames(leader)) {
      for (const p of m.peers) held.set(p.sid, p)
      for (const o of m.off ?? []) held.delete(o)
    }
    expect(held.size).toBeLessThanOrEqual(CURSORS_PER_RECIPIENT)
    for (const c of [leader, follower, ...crowd]) expect(c.schemaErrors).toEqual([])
  })

  it('a reconnect starts the socket over: the contracts frame again, rev-9 entries until it sends f', async () => {
    const st = await h.stack()
    const b = newBoardId()
    const peer = await st.client({ boardId: b, user: 'peer' })
    const tab = await st.client({ boardId: b, user: 'tab', tab: 'tab-1' })
    say(tab, { f: null })
    say(peer, { view: { x: 0, y: 0, w: 10, h: 10, z: 4 }, f: sidOf(tab) })
    await tab.until(
      () => presenceFrames(tab).some((m) => JSON.stringify(m).includes('"z":4')),
      'rich peer entry',
    )
    tab.terminate()
    await sleep(200)
    const again = await st.client({ boardId: b, user: 'tab', tab: 'tab-1' })
    expect(again.rawFrames.some((f) => JSON.parse(f).type === 'contracts')).toBe(true)
    // before it says `f` on this socket it holds rev-9 entries (the late joiner frame, then the ticks)
    say(peer, { pointer: { x: 3, y: 3 }, view: { x: 0, y: 0, w: 10, h: 10, z: 4 }, f: sidOf(again) })
    await again.until(
      () => presenceFrames(again).some((m) => JSON.stringify(m).includes('"x":3')),
      'the peer move',
    )
    for (const m of presenceFrames(again)) expect(PresenceOut9.safeParse(m).success).toBe(true)
    // it says `f`: what it holds comes again with the rev-10 fields, and its followers
    say(again, { f: null })
    await again.until(
      () =>
        presenceFrames(again).some((m) => JSON.stringify(m).includes('"z":4') && m.followers?.length === 1),
      'rich again',
    )
    expect(again.schemaErrors).toEqual([])
  })
})
