// §6.2 "Prefix invariant" and "Convergence property" (spike subset, raw clients; O2's headless engine-core
// clients take this over in wave 2): 4 clients push random ops (create, move, recolour, text through the
// lease, group, bind an arrow, +1, delete, undelete) from their own, possibly stale, copies, with random
// disconnects and reconnects from `since`, and one SIGKILL and restart. Pass: no client ever receives a
// patch for a version it does not hold (the prefix invariant; RawClient records it), `changes` clocks only
// increase, and at the end every client's element map hashes equal to the test snapshot (tombstones
// included) and the invariant checker finds nothing.

import { hashElements } from '@draftroom/canvas-schema/hash'
import { checkInvariants } from '@draftroom/canvas-schema/invariants'
import { describe, expect, it } from 'vitest'
import type { RawClient } from './support/client.ts'
import { arrow, bindArrow, type El, label, note, rect, withLabel } from './support/elements.ts'
import { type ElementStack, newBoardId, useElementHarness } from './support/stack.ts'

const h = useElementHarness()

function rng(seed: number) {
  let s = seed
  return () => {
    s = (s * 16807) % 2147483647
    return s / 2147483647
  }
}

async function randomRun(st: ElementStack, seed: number, rounds: number, killAt: number | null) {
  const rnd = rng(seed)
  const pick = <T>(xs: readonly T[]): T | undefined => xs[Math.floor(rnd() * xs.length)]
  const b = newBoardId()
  const users = ['u0', 'u1', 'u2', 'u3']
  const clients: RawClient[] = []
  for (const u of users) clients.push(await st.client({ boardId: b, user: u }))
  let n = 0
  const reconnect = async (i: number, fresh = false) => {
    const old = clients[i] as RawClient
    old.close()
    clients[i] = await st.client({
      boardId: b,
      user: users[i] as string,
      ...(fresh ? {} : { since: old.clock, epoch: old.epoch, confirmed: old.confirmed }),
    })
  }
  for (let round = 0; round < rounds; round++) {
    if (killAt === round) {
      await st.server.kill('SIGKILL')
      await st.server.restart()
      for (let i = 0; i < clients.length; i++) await reconnect(i)
    }
    const pending: Promise<unknown>[] = []
    for (let i = 0; i < clients.length; i++) {
      const c = clients[i] as RawClient
      if (rnd() < 0.08) {
        await reconnect(i, rnd() < 0.3)
        continue
      }
      const live = [...c.confirmed.values()].filter((e) => !e.isDeleted)
      const dead = [...c.confirmed.values()].filter((e) => e.isDeleted)
      const shapes = live.filter((e) => ['rectangle', 'stickynote'].includes(e.type))
      const ops: unknown[] = []
      const k = rnd()
      const pvOf = (e: El) => e.version
      if (k < 0.25 || shapes.length < 3) {
        if (rnd() < 0.5) ops.push({ k: 'c', el: rect(`r${seed}-${n++}`, { x: rnd() * 800, y: rnd() * 600 }) })
        else {
          const id = `n${seed}-${n++}`
          const nn = note(id, { x: rnd() * 800 })
          const t = label(`${id}.t`, id, { text: 'hi', originalText: 'hi' })
          withLabel(nn, t)
          ops.push({ k: 'c', el: nn }, { k: 'c', el: t })
        }
      } else if (k < 0.45) {
        const e = pick(shapes) as El
        ops.push({
          k: 'p',
          id: e.id,
          pv: pvOf(e),
          g: { pos: { x: Math.round(rnd() * 800), y: Math.round(rnd() * 600) } },
        })
      } else if (k < 0.55) {
        const e = pick(shapes) as El
        ops.push({
          k: 'p',
          id: e.id,
          pv: pvOf(e),
          g: { style: { backgroundColor: pick(['#ffc9c9', '#b2f2bb', '#a5d8ff']) } },
        })
      } else if (k < 0.62) {
        const [s1, s2] = [pick(shapes) as El, pick(shapes) as El]
        if (s1.id !== s2.id) {
          const a = arrow(`a${seed}-${n++}`, {
            x: s1.x + 100,
            y: s1.y + 50,
            points: [
              [0, 0],
              [s2.x - s1.x, s2.y - s1.y],
            ],
          })
          bindArrow(a, s1, s2)
          ops.push({ k: 'c', el: a })
        }
      } else if (k < 0.7) {
        const e = pick(shapes) as El
        ops.push({ k: 'p', id: e.id, pv: pvOf(e), c: { [`plusOne:${users[i]}`]: rnd() < 0.7 ? true : null } })
      } else if (k < 0.77) {
        const g = `g${seed}-${Math.floor(rnd() * 3)}`
        for (const e of [pick(shapes), pick(shapes)] as El[])
          ops.push({ k: 'p', id: e.id, pv: pvOf(e), g: { membership: { groupIds: rnd() < 0.5 ? [g] : [] } } })
      } else if (k < 0.85) {
        const notes = live.filter((e) => e.type === 'stickynote')
        const nn = pick(notes)
        const lab = nn && live.find((e) => e.containerId === nn.id)
        if (nn && lab) {
          const grant = await c.acquire(nn.id)
          if (grant.type === 'lease.grant') {
            const words = `words ${n++}`
            pending.push(
              c.pushNow([
                {
                  k: 'p',
                  id: lab.id,
                  pv: pvOf(lab),
                  g: { text: { originalText: words }, layout: { text: words } },
                },
              ]).ack,
            )
            c.release(nn.id)
          }
        }
      } else if (k < 0.95) {
        const e = pick(shapes) as El
        ops.push({ k: 'p', id: e.id, pv: pvOf(e), g: { life: { isDeleted: true } } })
      } else {
        const e = pick(dead)
        if (e) ops.push({ k: 'p', id: e.id, pv: pvOf(e), g: { life: { isDeleted: false } } })
      }
      if (ops.length) pending.push(c.pushNow(ops).ack)
    }
    await Promise.all(pending.map((p) => p.catch(() => undefined)))
  }
  const snap = await st.snapshot(b)
  await Promise.all(clients.map((c) => c.untilClock(snap.clock)))
  return { snap, clients }
}

describe('convergence and the prefix invariant', () => {
  for (const seed of [11, 23, 37])
    it(`seed ${seed}: 4 clients, 40 rounds, reconnects and one SIGKILL: all maps hash equal to the snapshot, 0 violations`, async () => {
      const st = await h.stack()
      const { snap, clients } = await randomRun(st, seed, 40, 20)
      const digest = await hashElements(snap.elements)
      for (const c of clients) {
        expect(c.schemaErrors).toEqual([])
        expect(await c.hash()).toBe(digest)
        const clocks = c.of('changes').map((m) => m.clock)
        expect(clocks.every((v, i) => i === 0 || v > (clocks[i - 1] as number))).toBe(true)
      }
      expect(snap.elements.length).toBeGreaterThan(10)
      expect(checkInvariants(snap.elements)).toEqual([])
    })
})

describe('join order', () => {
  it('a join storm while a writer streams: the cached snapshot plus a catch-up keeps every joiner on the prefix', async () => {
    const st = await h.stack()
    const b = newBoardId()
    const w = await st.client({ boardId: b, user: 'writer' })
    await w.create(Array.from({ length: 200 }, (_, i) => rect(`seed${i}`, { x: i })))
    const acks: Promise<unknown>[] = []
    let stop = false
    const writer = (async () => {
      for (let i = 0; !stop && i < 400; i++) {
        const e = w.confirmed.get(`seed${i % 200}`) as El
        acks.push(w.pushNow([{ k: 'p', id: e.id, pv: e.version, g: { pos: { x: i, y: i } } }]).ack)
        await new Promise((r) => setTimeout(r, 5))
      }
    })()
    const joiners = await Promise.all(
      Array.from({ length: 30 }, (_, i) => st.client({ boardId: b, user: `j${i}` })),
    )
    stop = true
    await writer
    await Promise.all(acks)
    const snap = await st.snapshot(b)
    const digest = await hashElements(snap.elements)
    for (const j of joiners) {
      await j.untilClock(snap.clock)
      expect(j.schemaErrors).toEqual([])
      expect(await j.hash()).toBe(digest)
    }
  })
})
