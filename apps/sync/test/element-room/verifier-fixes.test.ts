// Regressions for the spike B verifiers' room defects (V1 and V2, part-3 round), on the REAL sync server
// process. Each test failed on 37bdfa9 (the verified tree) and passes with the fix it names:
//   - the lease escape through the bind group (V2, high): a non-holder may not detach or move a leased
//     label, or move a leased free text into a note of its own (merge.ts step 6 denies `bind` for text);
//   - the container-to-label one-to-one rule against forged `b` patches (V2): a `b.rm` of a live label is
//     repaired, a second label stays INVALID, a detach leaves the old container's list (invariants.ts);
//   - `hello` floods (V2): a session is closed 4099 RATE_LIMITED past HELLO_LIMIT, and welcomes are built
//     a slice at a time across the process (element-room.ts);
//   - a failed COMMIT takes no lease effect (V1 N7): the table is restored, no lease reply goes out;
//   - an elbow arrow stored at its unrouted create points (V1, B3 L10 6): the room routes it (binding.ts);
//   - the lows: a guest's locked create, a malformed `file` value, lease squatting, the guest cap by uid,
//     a relayed drag that never expired.

import { checkInvariants } from '@draftroom/canvas-schema/invariants'
import { GUEST_ITEM_CAP } from '@draftroom/canvas-schema/limits'
import { ELEMENT_SCHEMA_VERSION, PROTO } from '@draftroom/canvas-schema/protocol'
import { describe, expect, it } from 'vitest'
import { HELLO_LIMIT, MAX_LEASES_PER_SESSION } from '../../src/room/element-room.ts'
import { DRAG_TTL_MS } from '../../src/room/presence.ts'
import { callInternal } from '../harness/tickets.ts'
import type { RawClient } from './support/client.ts'
import {
  arrow,
  assetId,
  image,
  label,
  note,
  pathUnit,
  rect,
  text,
  versionId,
  withLabel,
} from './support/elements.ts'
import { type ElementStack, newBoardId, useElementHarness } from './support/stack.ts'

const h = useElementHarness()
const T = 180_000
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
// biome-ignore lint/suspicious/noExplicitAny: JSON elements
type J = Record<string, any>
type R = { ok: boolean; code?: string; fix?: J; denied?: { groups: string[]; code: string } }
const r0 = (ack: { r: unknown[] }) => ack.r[0] as R
const patch = (c: RawClient, id: string, rest: J) => ({
  k: 'p',
  id,
  pv: c.confirmed.get(id)?.version ?? 1,
  ...rest,
})
async function stored(st: ElementStack, b: string): Promise<Map<string, J>> {
  const s = await st.snapshot(b)
  return new Map(s.elements.map((e) => [(e as J).id as string, e as J]))
}
async function violations(st: ElementStack, b: string): Promise<string[]> {
  const s = await st.snapshot(b)
  return checkInvariants(s.elements as never).map((v) => `${v.code}:${v.id}`)
}

/** alice creates note n with label n.t ("alice text"), mallory joins, alice takes n's lease. */
async function leasedNote(st: ElementStack) {
  const b = newBoardId()
  const a = await st.client({ boardId: b, user: 'alice' })
  const m = await st.client({ boardId: b, user: 'mallory' })
  const t = label('n.t', 'n', { text: 'alice text', originalText: 'alice text' })
  await a.create([withLabel(note('n'), t), t])
  await m.untilClock(a.clock)
  expect((await a.acquire('n')).type).toBe('lease.grant')
  return { b, a, m }
}

describe('V2: the text lease holds against the bind group', () => {
  it(
    'a non-holder can neither detach the leased label nor move it to its own note; its text and life stay the holder’s',
    async () => {
      const st = await h.stack()
      for (const target of [null, 'm2'] as const) {
        const { b, a, m } = await leasedNote(st)
        if (target) await m.create([note('m2', { x: 500 })])
        const d = r0(await m.push([patch(m, 'n.t', { g: { bind: { containerId: target } } })]))
        expect(d.ok).toBe(false)
        expect(d.code).toBe('LEASED')
        const w = r0(
          await m.push([
            patch(m, 'n.t', { g: { text: { originalText: 'pwned' }, layout: { text: 'pwned' } } }),
          ]),
        )
        expect(w.ok ? w.denied?.code : w.code).toBe('LEASED')
        const del = r0(await m.push([patch(m, 'n.t', { g: { life: { isDeleted: true } } })]))
        expect(del.ok ? del.denied?.code : del.code).toBe('LEASED')
        const els = await stored(st, b)
        expect(els.get('n.t')?.containerId).toBe('n')
        expect(els.get('n.t')?.originalText).toBe('alice text')
        expect(els.get('n.t')?.isDeleted).toBe(false)
        expect(await violations(st, b)).toEqual([])
        // the holder's next typing push lands (it was STALE after the escape)
        await a.untilClock(m.clock)
        const mine = r0(
          await a.push([
            patch(a, 'n.t', { g: { text: { originalText: 'alice 2' }, layout: { text: 'alice 2' } } }),
          ]),
        )
        expect(mine.ok && !mine.denied).toBe(true)
        expect((await stored(st, b)).get('n.t')?.originalText).toBe('alice 2')
        a.close()
        m.close()
      }
    },
    T,
  )

  it(
    'a non-holder cannot move a leased FREE text into a note of its own',
    async () => {
      const st = await h.stack()
      const b = newBoardId()
      const a = await st.client({ boardId: b, user: 'alice' })
      const m = await st.client({ boardId: b, user: 'mallory' })
      await a.create([text('t', { text: 'alice text', originalText: 'alice text' })])
      await m.untilClock(a.clock)
      expect((await a.acquire('t')).type).toBe('lease.grant')
      await m.create([note('m2', { x: 500 })])
      const mv = r0(await m.push([patch(m, 't', { g: { bind: { containerId: 'm2' } } })]))
      expect(mv.ok ? mv.denied?.code : mv.code).toBe('LEASED')
      const w = r0(
        await m.push([patch(m, 't', { g: { text: { originalText: 'pwned' }, layout: { text: 'pwned' } } })]),
      )
      expect(w.ok ? w.denied?.code : w.code).toBe('LEASED')
      const el = (await stored(st, b)).get('t')
      expect(el?.containerId ?? null).toBeNull()
      expect(el?.originalText).toBe('alice text')
      expect(await violations(st, b)).toEqual([])
    },
    T,
  )

  it(
    'the holder may detach its own label: the old container stops listing it',
    async () => {
      const st = await h.stack()
      const { b, a } = await leasedNote(st)
      const d = r0(await a.push([patch(a, 'n.t', { g: { bind: { containerId: null } } })]))
      expect(d.ok && !d.denied).toBe(true)
      const els = await stored(st, b)
      expect(els.get('n.t')?.containerId ?? null).toBeNull()
      expect((els.get('n')?.boundElements ?? []).map((r: J) => r.id)).not.toContain('n.t')
      expect(await violations(st, b)).toEqual([])
    },
    T,
  )
})

describe('V2: a container lists exactly its one label, whatever a `b` patch says', () => {
  it(
    'a b.rm of the label of a leased, a locked and a plain container is repaired in the same clock',
    async () => {
      const st = await h.stack()
      for (const kind of ['leased', 'locked', 'plain'] as const) {
        const b = newBoardId()
        const a = await st.client({ boardId: b, user: 'alice' })
        const m = await st.client({ boardId: b, user: 'mallory' })
        const t = label('n.t', 'n')
        await a.create([withLabel(note('n', kind === 'locked' ? { locked: true } : {}), t), t])
        await m.untilClock(a.clock)
        if (kind === 'leased') expect((await a.acquire('n')).type).toBe('lease.grant')
        await m.push([patch(m, 'n', { b: { add: [], rm: ['n.t'] } })])
        const els = await stored(st, b)
        expect((els.get('n')?.boundElements ?? []).map((r: J) => r.id)).toEqual(['n.t'])
        expect(await violations(st, b)).toEqual([])
        a.close()
        m.close()
      }
    },
    T,
  )

  it(
    'after a b.rm (in an earlier push or the same one) a second label for the container is INVALID',
    async () => {
      const st = await h.stack()
      for (const samePush of [false, true]) {
        const b = newBoardId()
        const a = await st.client({ boardId: b, user: 'alice' })
        const m = await st.client({ boardId: b, user: 'mallory' })
        const t = label('n.t', 'n', { text: 'one', originalText: 'one' })
        await a.create([withLabel(note('n'), t), t])
        await m.untilClock(a.clock)
        const rm = patch(m, 'n', { b: { add: [], rm: ['n.t'] } })
        const second = { k: 'c', el: label('n.t2', 'n', { text: 'two', originalText: 'two' }) }
        if (!samePush) await m.push([rm])
        const ack = await m.push(samePush ? [rm, second] : [second])
        const res = ack.r.at(-1) as R
        expect(res.ok).toBe(false)
        expect(res.code).toBe('INVALID')
        const els = await stored(st, b)
        const labels = [...els.values()]
          .filter((e) => e.type === 'text' && e.containerId === 'n' && !e.isDeleted)
          .map((e) => e.id)
        expect(labels).toEqual(['n.t'])
        expect((els.get('n')?.boundElements ?? []).map((r: J) => r.id)).toEqual(['n.t'])
        expect(await violations(st, b)).toEqual([])
        a.close()
        m.close()
      }
    },
    T,
  )
})

describe('V2: hello floods', () => {
  it(
    'a viewer sending hellos is closed RATE_LIMITED past the limit, and an editor on another board is not stalled',
    async () => {
      const st = await h.stack()
      const b = newBoardId()
      const e = await st.client({ boardId: b, user: 'eddie' })
      for (let k = 0; k < 2000; k += 500)
        await e.create(Array.from({ length: 500 }, (_, j) => rect(`r${k + j}`, { x: (k + j) * 3 })))
      const b2 = newBoardId()
      const o = await st.client({ boardId: b2, user: 'otto' })
      await o.create([rect('o0')])
      const v = await st.client({ boardId: b, user: 'vic', role: 'viewer' })
      const epoch = v.welcome?.epoch ?? null
      for (let k = 0; k < 400; k++)
        v.send({ type: 'hello', proto: PROTO, schema: ELEMENT_SCHEMA_VERSION, since: 0, epoch, tab: v.tab })
      const lat: number[] = []
      const t0 = Date.now()
      let n = 0
      while (Date.now() - t0 < 3000) {
        const s = Date.now()
        await o.push([
          { k: 'p', id: 'o0', pv: o.confirmed.get('o0')?.version ?? 1, g: { pos: { x: ++n, y: 0 } } },
        ])
        lat.push(Date.now() - s)
      }
      const closed = await v.untilClosed(5000)
      expect(closed).toEqual({ code: 4099, reason: 'RATE_LIMITED' })
      // the first welcome plus at most the limit's burst (the connect's own hello counts toward it)
      expect(v.of('welcome').length).toBeLessThanOrEqual(HELLO_LIMIT.burst)
      // before the fix: 8-9 s on a 3,000-element board (V2 P-H1)
      expect(Math.max(...lat)).toBeLessThan(1500)
    },
    T,
  )
})

describe('V1 N7: a failed COMMIT takes no lease effect', () => {
  it(
    "the holder's release in a failed batch does not take effect; another session is not granted; the retried text lands",
    async () => {
      const st = await h.stack()
      const b = newBoardId()
      const a = await st.client({ boardId: b, user: 'alice', tab: 'ta' })
      const bob = await st.client({ boardId: b, user: 'bob', tab: 'tb' })
      const t = label('n1.t', 'n1', { text: 'memo', originalText: 'memo' })
      await a.create([withLabel(note('n1'), t), t])
      await bob.untilClock(a.clock)
      expect((await a.acquire('n1')).type).toBe('lease.grant')
      await st.failCommit(b, 1)
      const words = 'final text'
      const p = a.pushNow([
        {
          k: 'p',
          id: 'n1.t',
          pv: a.confirmed.get('n1.t')?.version ?? 1,
          g: { text: { originalText: words }, layout: { text: words } },
        },
      ])
      a.release('n1')
      const bAsk = bob.acquireNow('n1')
      const ack = await p.ack
      expect(ack.r[0]?.ok).toBe(false)
      await a.untilClosed()
      await bob.untilClosed()
      // no lease reply of the failed batch went out
      const bFirst = await Promise.race([
        bAsk.answer.then(() => 'answered').catch(() => 'none'),
        sleep(500).then(() => 'none'),
      ])
      expect(bFirst).toBe('none')
      expect(bob.of('lease').some((l) => l.holder?.uid === 'bob')).toBe(false)
      const b2 = await st.client({ boardId: b, user: 'bob', tab: 'tb' })
      expect(b2.welcome?.leases.find((l) => l.id === 'n1')?.holder.uid).toBe('alice')
      expect((await b2.acquire('n1')).type).toBe('lease.deny')
      const a2 = await st.client({ boardId: b, user: 'alice', tab: 'ta' })
      const retry = r0(
        await a2.push([
          {
            k: 'p',
            id: 'n1.t',
            pv: a2.confirmed.get('n1.t')?.version ?? 1,
            g: { text: { originalText: words }, layout: { text: words } },
          },
        ]),
      )
      expect(retry.ok && !retry.denied).toBe(true)
      expect((await stored(st, b)).get('n1.t')?.originalText).toBe(words)
      a2.release('n1')
      await b2.until(() => b2.of('lease').some((l) => l.id === 'n1' && l.holder === null), 'release')
      expect((await b2.acquire('n1')).type).toBe('lease.grant')
    },
    T,
  )
})

describe('V1 B3 L10 6: an elbow arrow is stored routed', () => {
  it(
    'an elbow arrow created with its two drawn points (a diagonal) is routed by the room, and the ack says so',
    async () => {
      const st = await h.stack()
      const b = newBoardId()
      const a = await st.client({ boardId: b, user: 'alice' })
      const el = arrow('e1', {
        x: 100,
        y: 100,
        elbowed: true,
        points: [
          [0, 0],
          [340, 410],
        ],
        width: 340,
        height: 410,
        fixedSegments: [],
        startIsSpecial: false,
        endIsSpecial: false,
      })
      const r = r0(await a.create([el]))
      expect(r.ok).toBe(true)
      expect(r.fix?.points).toBeDefined()
      const s = (await stored(st, b)).get('e1') as J
      const pts = s.points as [number, number][]
      expect(pts.length).toBeGreaterThan(2)
      for (let i = 1; i < pts.length; i++) {
        const p = pts[i - 1] as [number, number]
        const q = pts[i] as [number, number]
        expect(Math.abs(p[0] - q[0]) < 1e-6 || Math.abs(p[1] - q[1]) < 1e-6).toBe(true)
      }
      // the route is a fixed point: pushing the stored unit back changes nothing
      await a.untilClock(a.clock)
      const again = r0(await a.push([patch(a, 'e1', { g: { path: pathUnit(s) } })]))
      expect(again.ok).toBe(true)
      expect(again.fix?.points).toBeUndefined()
    },
    T,
  )
})

describe('V2 lows', () => {
  it(
    'a guest cannot lock by creating, nor by undeleting a tombstone as locked',
    async () => {
      const st = await h.stack()
      const b = newBoardId()
      const e = await st.client({ boardId: b, user: 'eddie' })
      const g = await st.client({ boardId: b, user: 'guest1', guest: true })
      const c = r0(await g.create([rect('g-locked', { locked: true })]))
      expect(c.ok).toBe(true)
      expect(c.fix?.locked).toBe(false)
      await e.create([rect('t1', { x: 400 })])
      await e.push([patch(e, 't1', { g: { life: { isDeleted: true } } })])
      await g.untilClock(e.clock)
      const u = r0(await g.create([rect('t1', { x: 400, locked: true, version: 5 })]))
      expect(u.ok).toBe(true)
      const els = await stored(st, b)
      expect(els.get('g-locked')?.locked).toBe(false)
      expect(els.get('t1')?.locked).toBe(false)
    },
    T,
  )

  it(
    'a malformed customData.lobby.file on an image create is INVALID, not UNAVAILABLE',
    async () => {
      const st = await h.stack()
      st.api.addFile({
        versionId: versionId(1),
        assetId: assetId(1),
        kind: 'image',
        name: 'f1',
        mimeType: 'image/png',
        sizeBytes: 10,
        pageCount: null,
      })
      const b = newBoardId()
      const m = await st.client({ boardId: b, user: 'mallory' })
      const r = r0(
        await m.create([image('i-str', versionId(1), { customData: { lobby: { file: 'ver_x' } } })]),
      )
      expect(r.ok).toBe(false)
      expect(r.code).toBe('INVALID')
    },
    T,
  )

  it(
    'one session holds at most MAX_LEASES_PER_SESSION leases, and a label id is no lease id',
    async () => {
      const st = await h.stack()
      const b = newBoardId()
      const a = await st.client({ boardId: b, user: 'alice' })
      const els = []
      for (let k = 0; k < 8; k++) {
        const t = label(`n${k}.t`, `n${k}`)
        els.push(withLabel(note(`n${k}`, { x: k * 250 }), t), t)
      }
      await a.create(els)
      const m = await st.client({ boardId: b, user: 'mallory' })
      await m.untilClock(a.clock)
      for (let k = 0; k < 8; k++) expect((await m.acquire(`n${k}`)).type).toBe('lease.grant')
      expect((await m.acquire('n0.t')).type).toBe('lease.deny')
      const w = await st.client({ boardId: b, user: 'walt' })
      const held = w.welcome?.leases.filter((l) => l.holder.uid === 'mallory').map((l) => l.id) ?? []
      expect(held.length).toBe(MAX_LEASES_PER_SESSION)
      expect(held).toEqual(['n4', 'n5', 'n6', 'n7'])
      expect((await a.acquire('n0')).type).toBe('lease.grant')
    },
    T,
  )

  it(
    'the guest creation cap counts the guest, not its tab',
    async () => {
      const st = await h.stack()
      const b = newBoardId()
      const g = await st.client({ boardId: b, user: 'gina', guest: true, tab: 'tab-0' })
      const first = await g.push(
        Array.from({ length: GUEST_ITEM_CAP }, (_, k) => ({ k: 'c', el: rect(`g0-${k}`) })),
      )
      expect(first.r.every((r) => r.ok)).toBe(true)
      g.close()
      const g2 = await st.client({ boardId: b, user: 'gina', guest: true, tab: 'tab-1' })
      const more = r0(await g2.push([{ k: 'c', el: rect('g1-0') }]))
      expect(more.ok).toBe(false)
      expect(more.code).toBe('GUEST_LIMIT')
    },
    T,
  )

  it(
    'a relayed drag with no frame for DRAG_TTL_MS ends, and is not in a late joiner’s welcome',
    async () => {
      const st = await h.stack()
      const b = newBoardId()
      const a = await st.client({ boardId: b, user: 'alice' })
      await a.create([note('n1')])
      const m = await st.client({ boardId: b, user: 'mallory' })
      const obs = await st.client({ boardId: b, user: 'obs' })
      await obs.untilClock(a.clock)
      m.presence({ drag: { d: 1, ids: ['n1'], dx: 5, dy: 5 } })
      const drags = () =>
        obs
          .of('presence')
          .flatMap((p) => p.drags ?? [])
          .filter((d) => d.sid.startsWith('mallory:'))
      await obs.until(() => drags().some((d) => 'ids' in d && d.ids), 'drag start', 5000)
      const late1 = await st.client({ boardId: b, user: 'late1' })
      expect(late1.welcome?.drags.length).toBe(1)
      await obs.until(() => drags().some((d) => 'end' in d && d.end), 'drag end', DRAG_TTL_MS + 5000)
      const late2 = await st.client({ boardId: b, user: 'late2' })
      expect(late2.welcome?.drags).toEqual([])
    },
    T,
  )
})

describe('V2: a server write keeps the invariants and the lease (CR 2F-2)', () => {
  it(
    'a label of a missing container, a frameId on a rectangle, and text someone is typing are refused; the holder’s next push lands',
    async () => {
      const st = await h.stack()
      const b = newBoardId()
      const a = await st.client({ boardId: b, user: 'alice' })
      const t = label('n.t', 'n', { text: 'alice', originalText: 'alice' })
      await a.create([withLabel(note('n'), t), t, rect('r', { x: 500 })])
      expect((await a.acquire('n')).type).toBe('lease.grant')
      const sw = (body: unknown) =>
        callInternal(st.server.url, 'POST', `/internal/test/boards/${b}/server-write`, { body })
      expect((await sw({ put: [label('o.t', 'nope', { index: 'a8', x: 900 })] })).status).toBe(500)
      expect((await sw({ put: [rect('rf', { frameId: 'r', index: 'a9', x: 1200 })] })).status).toBe(500)
      expect(
        (await sw({ put: [{ ...a.confirmed.get('n.t'), text: 'server', originalText: 'server' }] })).status,
      ).toBe(409)
      const els = await stored(st, b)
      expect(els.has('o.t')).toBe(false)
      expect(els.has('rf')).toBe(false)
      expect(els.get('n.t')?.originalText).toBe('alice')
      const mine = r0(
        await a.push([
          patch(a, 'n.t', { g: { text: { originalText: 'alice more' }, layout: { text: 'alice more' } } }),
        ]),
      )
      expect(mine.ok && !mine.denied).toBe(true)
      expect(await violations(st, b)).toEqual([])
    },
    T,
  )
})
