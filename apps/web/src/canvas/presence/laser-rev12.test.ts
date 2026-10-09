// CONTRACTS_REV 12 (wave L foundation, the shared laser; owner W6) on the client: the stale-client pair "a
// rev-12 tab in a rev-11 room". The hub sends the laser fields (`t`, `trail`) only on a socket whose room
// announced PRESENCE_LASER_REV or later; in a rev-11 room (and a room older than rev 10) every message it sends
// is one that room's strict parse accepts, so it never closes its socket. The other pair (a rev-11 tab in a
// rev-12 room) is the room's: apps/sync/test/element-room/presence-rev12.test.ts. W6 adds the sending (L6-1);
// these cases hold before and after it.
import { PRESENCE_LASER_REV, type RosterEntry, type ServerMessage } from '@draftroom/canvas-schema/protocol'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import type { LobbyEngineCore } from '../sync/core/engine.ts'
import { setPresenceFollow } from './follow-target.ts'
import { PresenceHub } from './hub.ts'

/** Rev 11's `presence` in, as a rev-11 room parses it (strict: `f` and `view.z`, no `t`, no `trail`). */
const PresenceIn11 = z.strictObject({
  type: z.literal('presence'),
  pointer: z.strictObject({ x: z.number(), y: z.number() }).nullable(),
  button: z.enum(['up', 'down']),
  sel: z.union([z.array(z.string()), z.strictObject({ count: z.number() })]),
  view: z
    .strictObject({ x: z.number(), y: z.number(), w: z.number(), h: z.number(), z: z.number().optional() })
    .nullable(),
  idle: z.boolean(),
  editing: z.string().nullable(),
  drag: z.unknown().optional(),
  f: z.string().nullable().optional(),
})

const ME = 'usr_me:tab-1'
const BOB = 'usr_bob:tab-1'

function fakeCore() {
  const listeners = new Set<(e: { kind: string; message?: ServerMessage }) => void>()
  const sent: Record<string, unknown>[] = []
  const roster = new Map<string, RosterEntry>([
    [ME, { sid: ME, uid: 'usr_me', name: 'Me', color: '#111111', role: 'editor', guest: false }],
    [BOB, { sid: BOB, uid: 'usr_bob', name: 'Bob', color: '#222222', role: 'editor', guest: false }],
  ])
  const core = {
    sid: ME as string | null,
    on(l: (e: { kind: string; message?: ServerMessage }) => void) {
      listeners.add(l)
      return () => listeners.delete(l)
    },
    roster: () => roster,
    sendPresence: (p: Record<string, unknown>) => void sent.push({ type: 'presence', ...p }),
  }
  const deliver = (message: unknown) => {
    for (const l of [...listeners]) l({ kind: 'message', message: message as ServerMessage })
  }
  return { core, sent, deliver, welcome: () => deliver({ type: 'welcome', drags: [] }) }
}

const hubOn = (core: ReturnType<typeof fakeCore>['core']) =>
  new PresenceHub({
    core: core as unknown as LobbyEngineCore,
    overrides: null,
    elements: () => [],
    view: () => ({ x: 10, y: 20, w: 800, h: 600, z: 1.5 }),
    readOnly: () => false,
  })

const press = (hub: PresenceHub, x: number, button: 'up' | 'down') =>
  hub.onPointer({ pointer: { x, y: 1 }, button, source: 'pointermove', pointerType: 'mouse' })

describe('a rev-12 tab in an older room (CONTRACTS_REV 12, deploy order)', () => {
  for (const rev of [null, 10, 11] as const) {
    it(`a ${rev === null ? 'pre-rev-10 room (no contracts frame)' : `rev-${rev} room`}: no laser field, every message one that room accepts`, () => {
      const c = fakeCore()
      const hub = hubOn(c.core)
      c.welcome()
      if (rev !== null) c.deliver({ type: 'contracts', rev })
      press(hub, 1, 'down')
      press(hub, 2, 'down')
      setPresenceFollow(c.core, BOB)
      press(hub, 3, 'up')
      expect(c.sent.length).toBeGreaterThanOrEqual(3)
      for (const m of c.sent) {
        expect(PresenceIn11.safeParse(m).success, JSON.stringify(m)).toBe(true)
        expect(m).not.toHaveProperty('t')
        expect(m).not.toHaveProperty('trail')
      }
      expect(rev === null ? 9 : rev).toBeLessThan(PRESENCE_LASER_REV)
      hub.dispose()
      setPresenceFollow(c.core, null)
    })
  }

  it('a reconnect from a rev-12 room to a rev-11 room (a rollback) sends rev-11 messages again', () => {
    const c = fakeCore()
    const hub = hubOn(c.core)
    c.welcome()
    c.deliver({ type: 'contracts', rev: PRESENCE_LASER_REV })
    press(hub, 1, 'down')
    const atRev11 = c.sent.length
    c.welcome()
    c.deliver({ type: 'contracts', rev: 11 })
    press(hub, 2, 'down')
    press(hub, 3, 'up')
    for (const m of c.sent.slice(atRev11)) {
      expect(PresenceIn11.safeParse(m).success, JSON.stringify(m)).toBe(true)
      expect(m).not.toHaveProperty('t')
    }
    hub.dispose()
  })
})
