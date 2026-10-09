// CONTRACTS_REV 12 (wave L foundation, the shared laser; owner W6) through the real server process: the stale-
// client pair "a rev-11 tab in a rev-12 room". The room announces 12; a rev-12 sender's laser fields (`t`,
// `trail`) are accepted (no INVALID_MESSAGE close), and a rev-11 tab (it sends `f`, never `t`) keeps cursors
// and follow working and gets only frames its rev-11 strict schemas accept: never `t` or `trail`. The other
// pair (a rev-12 tab in a rev-11 room) is the web's gate (apps/web/src/canvas/presence/laser-rev12.test.ts)
// and the protocol layer's (packages/canvas-schema/src/protocol.test.ts). Relaying the laser to rev-12
// readers is W6's (L6-1); these cases hold before and after it.

import {
  CONTRACTS_REV,
  MAX_LASER_TRAIL_POINTS_WIRE,
  PRESENCE_LASER_REV,
} from '@draftroom/canvas-schema/protocol'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import type { RawClient } from './support/client.ts'
import { newBoardId, useElementHarness } from './support/stack.ts'

const h = useElementHarness()
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** Rev 11's presence frame, as a rev-11 client's strict parse goes (`f`, `view.z`, `followers`; no laser). */
const Rect11 = z.strictObject({
  x: z.number(),
  y: z.number(),
  w: z.number(),
  h: z.number(),
  z: z.number().positive().optional(),
})
const PresenceOut11 = z.strictObject({
  type: z.literal('presence'),
  peers: z.array(
    z.strictObject({
      sid: z.string(),
      pointer: z.strictObject({ x: z.number(), y: z.number() }).nullable(),
      button: z.enum(['up', 'down']),
      sel: z.unknown(),
      view: Rect11.nullable(),
      idle: z.boolean(),
      editing: z.string().nullable(),
      f: z.string().nullable().optional(),
    }),
  ),
  off: z.array(z.string()).optional(),
  drags: z.array(z.unknown()).optional(),
  followers: z.array(z.string()).optional(),
})

const sidOf = (c: RawClient) => c.welcome?.sid as string

interface Say {
  pointer?: { x: number; y: number } | null
  view?: Record<string, number> | null
  f?: string | null
  /** rev 12: present (null included) makes it a rev-12 sender's message */
  t?: 'laser' | null
  trail?: { x: number; y: number }[]
}
function say(c: RawClient, p: Say) {
  c.send({
    type: 'presence',
    pointer: p.pointer === undefined ? { x: 1, y: 1 } : p.pointer,
    button: p.t === 'laser' ? 'down' : 'up',
    sel: [],
    view: p.view ?? null,
    idle: false,
    editing: null,
    ...('f' in p ? { f: p.f ?? null } : {}),
    ...('t' in p ? { t: p.t ?? null } : {}),
    ...(p.trail ? { trail: p.trail } : {}),
  })
}

interface WireFrame {
  type: string
  peers: Record<string, unknown>[]
}
const presenceFrames = (c: RawClient) =>
  c.rawFrames.map((f) => JSON.parse(f) as WireFrame).filter((m) => m.type === 'presence')

describe('presence CONTRACTS_REV 12 through the room (the stale-client pair: a rev-11 tab in a rev-12 room)', () => {
  it('the room says 12; a rev-11 tab keeps cursors and follow, and never gets a laser field', async () => {
    const st = await h.stack()
    const b = newBoardId()
    const laser = await st.client({ boardId: b, user: 'laser' }) // a rev-12 tab
    const old = await st.client({ boardId: b, user: 'stale11' }) // a rev-11 tab: f, never t
    expect(old.of('contracts').at(-1)).toEqual({ type: 'contracts', rev: CONTRACTS_REV })
    expect(CONTRACTS_REV).toBeGreaterThanOrEqual(PRESENCE_LASER_REV)
    // the rev-11 tab follows the laser's sender and says so (a rev-10/11 reader)
    say(old, { pointer: { x: 9, y: 9 }, view: { x: 0, y: 0, w: 400, h: 300 }, f: sidOf(laser) })
    await sleep(150)
    for (let i = 0; i < 4; i++) {
      say(laser, {
        pointer: { x: 100 + i * 10, y: 50 },
        view: { x: i, y: 0, w: 800, h: 600, z: 1.5 },
        f: null,
        t: 'laser',
        trail: [
          { x: 90 + i * 10, y: 50 },
          { x: 95 + i * 10, y: 50 },
          { x: 100 + i * 10, y: 50 },
        ],
      })
      await sleep(120)
    }
    say(laser, { pointer: { x: 140, y: 50 }, view: { x: 4, y: 0, w: 800, h: 600, z: 1.5 }, f: null, t: null })
    await old.until(
      () =>
        presenceFrames(old).some((m) =>
          m.peers.some((p) => p.sid === sidOf(laser) && JSON.stringify(p).includes('"x":140')),
        ),
      'the last move',
    )
    // cursors and follow still work for the rev-11 tab: the pointer moves and the followed view with its zoom
    const mine = presenceFrames(old).flatMap((m) => m.peers.filter((p) => p.sid === sidOf(laser)))
    expect(mine.length).toBeGreaterThan(1)
    expect(mine.some((p) => (p.view as { z?: number } | null)?.z === 1.5)).toBe(true)
    // ... and every frame is one its strict rev-11 parse accepts: no `t`, no `trail`
    for (const m of presenceFrames(old))
      expect(PresenceOut11.safeParse(m).success, JSON.stringify(m)).toBe(true)
    for (const p of mine) {
      expect(p).not.toHaveProperty('t')
      expect(p).not.toHaveProperty('trail')
    }
    expect(old.schemaErrors).toEqual([])
    // neither socket was closed: the rev-12 fields are valid input to a rev-12 room
    expect(old.closeCode).toBeNull()
    expect(laser.closeCode).toBeNull()
    expect(laser.schemaErrors).toEqual([])
    // the rev-12 sender still gets the rev-11 tab's entries
    expect(presenceFrames(laser).some((m) => m.peers.some((p) => p.sid === sidOf(old)))).toBe(true)
  })

  it('a presence message with more laser samples than the wire allows is INVALID (the socket closes 4099)', async () => {
    const st = await h.stack()
    const b = newBoardId()
    const c = await st.client({ boardId: b, user: 'flood' })
    const trail = Array.from({ length: MAX_LASER_TRAIL_POINTS_WIRE + 1 }, (_, i) => ({ x: i, y: i }))
    say(c, { f: null, t: 'laser', trail })
    const closed = await c.untilClosed()
    expect(closed.code).toBe(4099)
    expect(closed.reason).toBe('INVALID_MESSAGE')
  })
})
