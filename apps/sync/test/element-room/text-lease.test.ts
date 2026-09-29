// §6.2 `text-lease` and "Text lease, container fit" (spike subset), and the server half of B3 L8,
// through the real server process: grant/deny, a second tab refused, renewal by presence and expiry,
// the release ordered after the last push (also a push parked in stage 0 on a delayed file-refs lookup),
// an acquire for a just-created id, partial accept, inheritance through `containerId`, the conditional
// fit (dropped after a newer pos/shape write or from a non-holder; accepted on a newer base; advancing
// only gclock.fit), and a leased free text's own x as its fit.

import { describe, expect, it } from 'vitest'
import type { RawClient } from './support/client.ts'
import { assetId, image, label, note, text, versionId, withLabel } from './support/elements.ts'
import { newBoardId, useElementHarness } from './support/stack.ts'

const h = useElementHarness()
const pv = (c: RawClient, id: string) => c.confirmed.get(id)?.version ?? 1
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function noteWithLabel(c: RawClient, id = 'n1') {
  const n = note(id)
  const t = label(`${id}.t`, id, { text: 'memo', originalText: 'memo', x: 70, y: 87, width: 60, height: 25 })
  withLabel(n, t)
  await c.create([n, t])
}

describe('the text lease', () => {
  it('grant, deny with the holder, broadcasts, a second tab refused, release', async () => {
    const st = await h.stack()
    const b = newBoardId()
    const a = await st.client({ boardId: b, user: 'alice' })
    const bob = await st.client({ boardId: b, user: 'bob' })
    await noteWithLabel(a)
    expect(await a.acquire('n1')).toMatchObject({ type: 'lease.grant', id: 'n1', ttlMs: 10_000 })
    await bob.until(
      () => bob.of('lease').some((l) => l.id === 'n1' && l.holder?.uid === 'alice'),
      'lease broadcast',
    )
    expect(await bob.acquire('n1')).toMatchObject({
      type: 'lease.deny',
      holder: { uid: 'alice', name: 'alice-name' },
    })
    const tab2 = await st.client({ boardId: b, user: 'alice', tab: 'second' })
    expect((await tab2.acquire('n1')).type).toBe('lease.deny')
    a.release('n1')
    await bob.until(
      () => bob.of('lease').some((l) => l.id === 'n1' && l.holder === null),
      'release broadcast',
    )
    expect((await bob.acquire('n1')).type).toBe('lease.grant')
    const late = await st.client({ boardId: b, user: 'carol' })
    expect(late.welcome?.leases).toEqual([{ id: 'n1', holder: expect.objectContaining({ uid: 'bob' }) }])
  })

  it('presence `editing` renews the lease; without it the lease expires and is broadcast free', async () => {
    const st = await h.stack({ env: { TEXT_LEASE_MS: '1200' } })
    const b = newBoardId()
    const a = await st.client({ boardId: b, user: 'alice' })
    const bob = await st.client({ boardId: b, user: 'bob' })
    await noteWithLabel(a)
    expect((await a.acquire('n1')).type).toBe('lease.grant')
    for (let i = 0; i < 6; i++) {
      a.presence({ editing: 'n1' })
      await sleep(400)
    }
    expect((await bob.acquire('n1')).type).toBe('lease.deny')
    await bob.until(() => bob.of('lease').some((l) => l.id === 'n1' && l.holder === null), 'expiry', 5_000)
    expect((await bob.acquire('n1')).type).toBe('lease.grant')
  })

  it('a release takes effect after the push sent before it, even when that push waits on a file-refs lookup', async () => {
    const st = await h.stack()
    const b = newBoardId()
    st.api.addFile({
      versionId: versionId(1),
      assetId: assetId(1),
      kind: 'image',
      name: 'a.png',
      mimeType: 'image/png',
      sizeBytes: 5,
      pageCount: null,
    })
    const a = await st.client({ boardId: b, user: 'alice' })
    const bob = await st.client({ boardId: b, user: 'bob' })
    await noteWithLabel(a)
    expect((await a.acquire('n1')).type).toBe('lease.grant')
    st.api.fileRefsDelayMs = 1_500
    const final = a.pushNow([
      { k: 'c', el: image('i1', versionId(1)) },
      {
        k: 'p',
        id: 'n1.t',
        pv: pv(a, 'n1.t'),
        g: { text: { originalText: 'final words' }, layout: { text: 'final words' } },
      },
    ])
    a.release('n1')
    await sleep(300)
    // the release waits behind the parked push: the lease is still Alice's
    expect((await bob.acquire('n1')).type).toBe('lease.deny')
    const ack = await final.ack
    expect(ack.r.every((r) => r.ok)).toBe(true)
    await bob.until(
      () => bob.of('lease').some((l) => l.id === 'n1' && l.holder === null),
      'release after push',
    )
    const s = await st.snapshot(b)
    expect(
      (s.elements.find((e) => e.id === 'n1.t') as { originalText?: string } | undefined)?.originalText,
    ).toBe('final words')
    const relAt = bob.received.findIndex((m) => m.type === 'lease' && m.id === 'n1' && m.holder === null)
    const chAt = bob.received.findIndex(
      (m) => m.type === 'changes' && m.ops.some((o) => (o.k === 'p' ? o.id : o.el.id) === 'n1.t'),
    )
    expect(chAt).toBeGreaterThanOrEqual(0)
    expect(chAt).toBeLessThan(relAt)
  })

  it('an acquire for a just-created id is denied while another session holds a live lease on it', async () => {
    const st = await h.stack()
    const b = newBoardId()
    const a = await st.client({ boardId: b, user: 'alice' })
    const bob = await st.client({ boardId: b, user: 'bob' })
    expect((await bob.acquire('future1')).type).toBe('lease.grant') // not stored yet: free
    await a.create([note('future1')])
    expect(await a.acquire('future1')).toMatchObject({ type: 'lease.deny', holder: { uid: 'bob' } })
  })

  it('L8: while A holds N, B gets LEASED for its label text, a new label and a delete of N, and its fit is dropped', async () => {
    const st = await h.stack()
    const b = newBoardId()
    const a = await st.client({ boardId: b, user: 'alice' })
    const bob = await st.client({ boardId: b, user: 'bob' })
    await noteWithLabel(a)
    await bob.untilClock(a.clock)
    expect((await a.acquire('n1')).type).toBe('lease.grant')
    const before = JSON.stringify((await st.snapshot(b)).elements)
    const ack = await bob.push([
      { k: 'p', id: 'n1.t', pv: pv(bob, 'n1.t'), g: { text: { originalText: 'bob was here' } } },
      { k: 'c', el: label('n1.t2', 'n1') },
      { k: 'p', id: 'n1', pv: pv(bob, 'n1'), g: { life: { isDeleted: true } } },
      { k: 'p', id: 'n1', pv: pv(bob, 'n1'), fit: { height: 400 } },
    ])
    expect(ack.r.slice(0, 3).map((r) => (r.ok ? 'ok' : r.code))).toEqual(['LEASED', 'LEASED', 'LEASED'])
    expect(ack.r[3]).toMatchObject({ ok: true, fitDropped: true })
    expect(JSON.stringify((await st.snapshot(b)).elements)).toBe(before)
  })

  it('partial accept: under the lease, a move of N is kept and its delete refused', async () => {
    const st = await h.stack()
    const b = newBoardId()
    const a = await st.client({ boardId: b, user: 'alice' })
    const bob = await st.client({ boardId: b, user: 'bob' })
    await noteWithLabel(a)
    await bob.untilClock(a.clock)
    expect((await a.acquire('n1')).type).toBe('lease.grant')
    const ack = await bob.push([
      { k: 'p', id: 'n1', pv: pv(bob, 'n1'), g: { pos: { x: 77, y: 88 }, life: { isDeleted: true } } },
    ])
    expect(ack.r[0]).toMatchObject({ ok: true, denied: { groups: ['life'], code: 'LEASED' } })
    const n = (await st.snapshot(b)).elements.find((e) => e.id === 'n1')
    expect(n).toMatchObject({ x: 77, y: 88, isDeleted: false })
  })
})

describe('the container fit (§2.9.4)', () => {
  it("a stale fit is dropped after another session's resize; the holder's re-fit on the new base is applied", async () => {
    const st = await h.stack()
    const b = newBoardId()
    const a = await st.client({ boardId: b, user: 'alice' })
    const bob = await st.client({ boardId: b, user: 'bob' })
    await noteWithLabel(a)
    await bob.untilClock(a.clock)
    expect((await a.acquire('n1')).type).toBe('lease.grant')
    const staleBase = a.clock
    const stalePv = pv(a, 'n1')
    await bob.push([
      { k: 'p', id: 'n1', pv: pv(bob, 'n1'), g: { shape: { width: 300, baseHeight: 300, height: 300 } } },
    ])
    const dropped = await a.push([{ k: 'p', id: 'n1', pv: stalePv, fit: { height: 250 } }], {
      base: staleBase,
    })
    expect(dropped.r[0]).toMatchObject({ ok: true, fitDropped: true })
    expect((await st.snapshot(b)).elements.find((e) => e.id === 'n1')?.height).toBe(300)
    await a.untilClock(bob.clock)
    const refit = await a.push([{ k: 'p', id: 'n1', pv: pv(a, 'n1'), fit: { height: 420 } }])
    expect((refit.r[0] as { fitDropped?: true }).fitDropped).toBeUndefined()
    const n = (await st.snapshot(b)).elements.find((e) => e.id === 'n1')
    expect(n).toMatchObject({ width: 300, height: 420 })
  })

  it("a non-holder's fit is dropped; fit writes advance only gclock.fit (an old-base replay of shape is not STALE)", async () => {
    const st = await h.stack()
    const b = newBoardId()
    const a = await st.client({ boardId: b, user: 'alice' })
    const bob = await st.client({ boardId: b, user: 'bob' })
    await noteWithLabel(a)
    await bob.untilClock(a.clock)
    const bobBase = bob.clock
    const bobPv = pv(bob, 'n1')
    expect((await bob.push([{ k: 'p', id: 'n1', pv: bobPv, fit: { height: 999 } }])).r[0]).toMatchObject({
      fitDropped: true,
    })
    expect((await a.acquire('n1')).type).toBe('lease.grant')
    expect((await a.push([{ k: 'p', id: 'n1', pv: pv(a, 'n1'), fit: { height: 333 } }])).r[0]).toMatchObject({
      ok: true,
    })
    // Bob's offline replay of a resize, based before Alice's fit and 11 minutes old: not STALE
    const replay = await bob.push(
      [{ k: 'p', id: 'n1', pv: bobPv, g: { shape: { width: 260 } }, off: 11 * 60_000 }],
      {
        base: bobBase,
      },
    )
    expect(replay.r[0]).toMatchObject({ ok: true })
    expect((await st.snapshot(b)).elements.find((e) => e.id === 'n1')).toMatchObject({
      width: 260,
      height: 333,
    })
  })

  it("a leased free text's own x goes out as its fit: dropped after B's move of the text, which is kept", async () => {
    const st = await h.stack()
    const b = newBoardId()
    const a = await st.client({ boardId: b, user: 'alice' })
    const bob = await st.client({ boardId: b, user: 'bob' })
    await a.create([text('t1', { x: 100, y: 100, textAlign: 'center' })])
    await bob.untilClock(a.clock)
    expect((await a.acquire('t1')).type).toBe('lease.grant')
    const base = a.clock
    const p = pv(a, 't1')
    await bob.push([{ k: 'p', id: 't1', pv: pv(bob, 't1'), g: { pos: { x: 400, y: 100 } } }])
    const typing = await a.push(
      [
        {
          k: 'p',
          id: 't1',
          pv: p,
          g: { text: { originalText: 'hello there' }, layout: { text: 'hello there', width: 110 } },
          fit: { x: 75 },
        },
      ],
      { base },
    )
    expect(typing.r[0]).toMatchObject({ ok: true, fitDropped: true })
    const t = (await st.snapshot(b)).elements.find((e) => e.id === 't1')
    expect(t).toMatchObject({ x: 400, originalText: 'hello there', width: 110 })
    // re-computed on Bob's position: applied
    await a.untilClock(bob.clock)
    const again = await a.push([{ k: 'p', id: 't1', pv: pv(a, 't1'), fit: { x: 375 } }])
    expect((again.r[0] as { fitDropped?: true }).fitDropped).toBeUndefined()
    expect((await st.snapshot(b)).elements.find((e) => e.id === 't1')?.x).toBe(375)
  })

  it("a text write based below the text group's last write by someone else is STALE at any age", async () => {
    const st = await h.stack()
    const b = newBoardId()
    const a = await st.client({ boardId: b, user: 'alice' })
    const bob = await st.client({ boardId: b, user: 'bob' })
    await a.create([text('t1')])
    await bob.untilClock(a.clock)
    const base = bob.clock
    const p = pv(bob, 't1')
    await a.push([{ k: 'p', id: 't1', pv: pv(a, 't1'), g: { text: { originalText: 'alice' } } }])
    const stale = await bob.push([{ k: 'p', id: 't1', pv: p, g: { text: { originalText: 'bob' } } }], {
      base,
    })
    expect(stale.r[0]).toMatchObject({ ok: false, code: 'STALE' })
  })
})
