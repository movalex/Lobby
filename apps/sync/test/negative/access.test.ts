// The negative security suite, part 4: who may write what (§2.4.3 steps 1, 5, 6, 8; §3.5 guests; §3.4 doc
// keys), tickets and old clients (§2.4.2 closes), identity (never from the client) and the abuse close.
// Raw frames against the real server process (DRAFTROOM_ENGINE=excalidraw).

import { describe, expect, it } from 'vitest'
import { newBoardId, sharedElementStack } from '../harness/element-stack.ts'
import { note, noteWithLabel, rect, text } from '../harness/elements.ts'
import { mintTicket, tamperTicket } from '../harness/tickets.ts'
import { expectAccepted, expectNotStored, expectRefused, storedEl } from './support.ts'

const shared = sharedElementStack()

describe('§2.4.3 step 1: read-only roles write nothing', () => {
  for (const role of ['viewer', 'commenter'] as const)
    it(`${role}: create, patch, delete and doc writes are READ_ONLY; a lease is denied; the socket stays open`, async () => {
      const st = shared.get()
      const b = newBoardId()
      const a = await st.client({ boardId: b, user: 'alice' })
      await a.create(noteWithLabel('n1', 'owner'))
      const r = await st.client({ boardId: b, user: `reader-${role}`, role })
      expect(r.welcome?.readonly).toBe(true)
      expectRefused(await r.createOne(rect('forged')), 'READ_ONLY', r)
      expectRefused(await r.patch('n1', { g: { style: { backgroundColor: '#ff0000' } } }), 'READ_ONLY', r)
      expectRefused(await r.patch('n1', { g: { life: { isDeleted: true } } }), 'READ_ONLY', r)
      const docAck = await r.push([], { doc: { set: { 'tagDef:x': { name: 'x', color: 'red' } } } })
      expect(docAck.docDenied).toMatchObject({ code: 'READ_ONLY' })
      expect((await r.acquire('n1')).type).toBe('lease.deny')
      expect(r.isOpen).toBe(true)
      await expectNotStored(st, b, ['forged'])
      const n = await storedEl(st, b, 'n1')
      expect([n.backgroundColor, n.isDeleted]).toEqual(['#fff3bf', false])
      expect((await st.snapshot(b)).elements.length).toBe(2)
    })
})

describe('§2.4.2 tickets: identity and role come from the api-signed ticket only', () => {
  it('a tampered ticket (role raised), a ticket for another board and an expired one are refused before any room opens', async () => {
    const st = shared.get()
    const b = newBoardId()
    const good = mintTicket(b, 'mallory', 'viewer')
    const cases: [string, string, string][] = [
      ['tampered role', tamperTicket(good, { role: 'owner' }), 'NOT_AUTHENTICATED'],
      ['tampered uid', tamperTicket(good, { uid: 'alice' }), 'NOT_AUTHENTICATED'],
      ['another board', mintTicket(newBoardId(), 'mallory', 'editor'), 'FORBIDDEN'],
      [
        'expired',
        mintTicket(b, 'mallory', 'editor', { now: Date.now() - 3_600_000, ttlMs: 60_000 }),
        'NOT_AUTHENTICATED',
      ],
      [
        'wrong secret',
        mintTicket(b, 'mallory', 'editor', { secret: 'not-the-servers-secret-0123456789abcdef' }),
        'NOT_AUTHENTICATED',
      ],
      ['not a ticket', 'v1.nope.nope', 'NOT_AUTHENTICATED'],
    ]
    for (const [name, ticket, reason] of cases) {
      const c = await st.socket({ boardId: b, user: 'mallory', ticket, tab: `t-${name.replace(/ /g, '-')}` })
      expect(await c.untilClosed(), name).toMatchObject({ code: 4099, reason })
    }
    expect(st.server.logs()).not.toContain(good)
  })

  it('identity in hello or presence closes the session (4099 INVALID_MESSAGE); the roster names the ticket’s user', async () => {
    const st = shared.get()
    const b = newBoardId()
    const a = await st.client({ boardId: b, user: 'alice' })
    const m = await st.client({ boardId: b, user: 'mallory' })
    await a.until(
      () => a.of('roster').some((r) => r.events.some((e) => e.k === 'join' && e.p.uid === 'mallory')),
      'mallory in the roster',
    )
    const names = a.of('roster').flatMap((r) => r.events.flatMap((e) => (e.k === 'leave' ? [] : [e.p.name])))
    expect(names).toContain('mallory-name')
    m.send({
      type: 'presence',
      pointer: { x: 1, y: 1 },
      button: 'up',
      sel: [],
      view: null,
      idle: false,
      editing: null,
      uid: 'alice',
      name: 'Alice',
    })
    expect(await m.untilClosed()).toMatchObject({ code: 4099, reason: 'INVALID_MESSAGE' })
    const h = await st.socket({ boardId: b, user: 'mallory', tab: 'tab-mallory-2' })
    h.send({ type: 'hello', proto: 1, schema: 1, since: 0, epoch: null, tab: 't', uid: 'alice' })
    expect(await h.untilClosed()).toMatchObject({ code: 4099, reason: 'INVALID_MESSAGE' })
  })

  it('an old tldraw tab (connect, or a tldraw-framed message) is told CLIENT_TOO_OLD', async () => {
    const st = shared.get()
    const b = newBoardId()
    const c1 = await st.socket({ boardId: b, user: 'alice', tab: 'old-1' })
    c1.send({ type: 'connect', protocolVersion: 7, connectRequestId: 'x', schema: {}, lastServerClock: 0 })
    expect(await c1.untilClosed()).toMatchObject({ code: 4099, reason: 'CLIENT_TOO_OLD' })
    const c2 = await st.socket({ boardId: b, user: 'alice', tab: 'old-2' })
    c2.send('1_{"type":"ping"}')
    expect(await c2.untilClosed()).toMatchObject({ code: 4099, reason: 'CLIENT_TOO_OLD' })
    const c3 = await st.socket({ boardId: b, user: 'alice', tab: 'old-3' })
    c3.send({ type: 'hello', proto: 0, schema: 1, since: 0, epoch: null, tab: 't' })
    expect(await c3.untilClosed()).toMatchObject({ code: 4099, reason: 'CLIENT_TOO_OLD' })
  })
})

describe('§3.5 guests', () => {
  it('a guest can neither lock nor unlock (the meta group is denied LOCKED); an editor can', async () => {
    const st = shared.get()
    const b = newBoardId()
    const a = await st.client({ boardId: b, user: 'alice' })
    await a.create([rect('open'), rect('shut', { locked: true, x: 300 })])
    const g = await st.client({ boardId: b, user: 'guesty', guest: true })
    for (const [id, locked] of [
      ['open', true],
      ['shut', false],
    ] as const) {
      const r = await g.patch(id, { g: { meta: { locked } } })
      if (r.ok) expect(r.denied, id).toMatchObject({ code: 'LOCKED', groups: ['meta'] })
      else expectRefused(r, 'LOCKED', g)
    }
    expect([(await storedEl(st, b, 'open')).locked, (await storedEl(st, b, 'shut')).locked]).toEqual([
      false,
      true,
    ])
    expectAccepted(await a.patch('shut', { g: { meta: { locked: false } } }))
  })

  it('a guest may create at most 500 items (GUEST_LIMIT after that); bound labels do not count', async () => {
    const st = shared.get()
    const b = newBoardId()
    const g = await st.client({ boardId: b, user: 'guesty2', guest: true })
    const first = await g.push(Array.from({ length: 499 }, (_, i) => ({ k: 'c', el: rect(`g${i}`) })))
    expect(first.r.every((r) => r.ok)).toBe(true)
    // a note and its label are one item: the 500th
    const [n, t] = noteWithLabel('g-note')
    const pair = await g.create([n, t])
    expect(pair.r.map((r) => r.ok)).toEqual([true, true])
    const over = await g.push([{ k: 'c', el: rect('g-over') }])
    expectRefused(over.r[0] as never, 'GUEST_LIMIT', g)
    await expectNotStored(st, b, ['g-over'])
  })
})

describe('§2.4.3 step 5: locks', () => {
  it('a locked element refuses every group but meta.locked, z and bound (LOCKED); so does its label', async () => {
    const st = shared.get()
    const b = newBoardId()
    const a = await st.client({ boardId: b, user: 'alice' })
    // a label cannot be created for a locked note (it inherits the lock), so lock after creating both
    await a.create(noteWithLabel('n1', 'locked words'))
    expectAccepted(await a.patch('n1', { g: { meta: { locked: true } } }))
    const m = await st.client({ boardId: b, user: 'mallory' })
    const writes: Record<string, Record<string, unknown>>[] = [
      { pos: { x: 500, y: 500 } },
      { style: { backgroundColor: '#ff0000' } },
      { life: { isDeleted: true } },
      { meta: { link: 'https://example.com' } },
    ]
    for (const g of writes) {
      const r = await m.patch('n1', { g })
      if (r.ok) expect(r.denied, JSON.stringify(g)).toMatchObject({ code: 'LOCKED' })
      else expectRefused(r, 'LOCKED', m)
    }
    const lr = await m.patch('n1.t', {
      g: {
        text: { originalText: 'changed' },
        layout: { text: 'changed', x: 10, y: 10, width: 60, height: 25, fontSize: 20 },
      },
    })
    if (lr.ok) expect(lr.denied).toMatchObject({ code: 'LOCKED' })
    else expectRefused(lr, 'LOCKED', m)
    const s = await storedEl(st, b, 'n1')
    expect([s.x, s.backgroundColor, s.isDeleted, s.link]).toEqual([0, '#fff3bf', false, null])
    expect((await storedEl(st, b, 'n1.t')).originalText).toBe('locked words')
    // an editor may unlock it
    expectAccepted(await m.patch('n1', { g: { meta: { locked: false } } }))
    expectAccepted(await m.patch('n1', { g: { pos: { x: 40, y: 40 } } }))
  })
})

describe('§2.4.3 step 6: the text lease', () => {
  it('under another session’s lease, text, layout and life are denied LEASED (partial accept keeps a move); a fit is dropped', async () => {
    const st = shared.get()
    const b = newBoardId()
    const a = await st.client({ boardId: b, user: 'alice' })
    const m = await st.client({ boardId: b, user: 'mallory' })
    await a.create(noteWithLabel('n1', 'alice types'))
    await m.untilClock(a.clock)
    expect((await a.acquire('n1')).type).toBe('lease.grant')
    // mallory's label write: refused (the label follows its container's lease)
    const lr = await m.patch('n1.t', {
      g: {
        text: { originalText: 'mallory' },
        layout: { text: 'mallory', x: 10, y: 10, width: 60, height: 25, fontSize: 20 },
      },
    })
    if (lr.ok) expect(lr.denied).toMatchObject({ code: 'LEASED' })
    else expectRefused(lr, 'LEASED', m)
    // a move with a delete: the move is kept, the delete denied
    const mv = await m.patch('n1', { g: { pos: { x: 90, y: 90 }, life: { isDeleted: true } } })
    expect(mv).toMatchObject({ ok: true, denied: { code: 'LEASED' } })
    // a fit from anyone but the holder is dropped silently
    const fit = await m.patch('n1', { fit: { height: 400 } })
    expect(fit).toMatchObject({ ok: true, fitDropped: true })
    const s = await storedEl(st, b, 'n1')
    expect([s.x, s.isDeleted, s.height]).toEqual([90, false, 200])
    expect((await storedEl(st, b, 'n1.t')).originalText).toBe('alice types')
    expect(m.isOpen).toBe(true)
  })

  it('a second tab of the holder’s own user is denied the lease too (leases are per session)', async () => {
    const st = shared.get()
    const b = newBoardId()
    const a = await st.client({ boardId: b, user: 'alice' })
    const a2 = await st.client({ boardId: b, user: 'alice', tab: 'tab-alice-2' })
    await a.create([note('n1')])
    await a2.untilClock(a.clock)
    expect((await a.acquire('n1')).type).toBe('lease.grant')
    expect((await a2.acquire('n1')).type).toBe('lease.deny')
  })
})

describe('§2.4.3 step 8: stale offline writes', () => {
  it('a replay older than 10 minutes for a group someone else wrote after its base is STALE; an untouched group still lands', async () => {
    const st = shared.get()
    const b = newBoardId()
    const a = await st.client({ boardId: b, user: 'alice' })
    const m = await st.client({ boardId: b, user: 'bob' })
    await a.create([rect('r1')])
    await m.untilClock(a.clock)
    const base = m.clock
    const pv = m.confirmed.get('r1')?.version as number
    expectAccepted(await a.patch('r1', { g: { pos: { x: 300, y: 300 } } }))
    const off = 11 * 60_000
    expectRefused(await m.one(m.patchOp('r1', { pv, g: { pos: { x: 5, y: 5 } }, off }), { base }), 'STALE', m)
    expectAccepted(
      await m.one(m.patchOp('r1', { pv, g: { style: { strokeColor: '#e03131' } }, off }), { base }),
    )
    const s = await storedEl(st, b, 'r1')
    expect([s.x, s.strokeColor]).toEqual([300, '#e03131'])
  })

  it('a text write based below the text group’s last write by someone else is STALE at any age', async () => {
    const st = shared.get()
    const b = newBoardId()
    const a = await st.client({ boardId: b, user: 'alice' })
    const m = await st.client({ boardId: b, user: 'bob' })
    await a.create([text('t1')])
    await m.untilClock(a.clock)
    const base = m.clock
    const pv = m.confirmed.get('t1')?.version as number
    expectAccepted(
      await a.patch('t1', {
        g: { text: { originalText: 'alice' }, layout: { text: 'alice', width: 60, height: 25 } },
      }),
    )
    expectRefused(
      await m.one(
        m.patchOp('t1', {
          pv,
          g: { text: { originalText: 'bob' }, layout: { text: 'bob', width: 60, height: 25 } },
        }),
        { base },
      ),
      'STALE',
      m,
    )
    expect((await storedEl(st, b, 't1')).originalText).toBe('alice')
  })
})

describe('§3.4 board document keys', () => {
  it('import is server-only; startView is the owner’s; an invalid value is refused; an editor writes tagDef', async () => {
    const st = shared.get()
    const b = newBoardId()
    const e = await st.client({ boardId: b, user: 'eddie' })
    const o = await st.client({ boardId: b, user: 'olga', role: 'owner' })
    const imp = await e.push([], { doc: { set: { import: { from: 'tldraw-5.4.2' } } } })
    expect(imp.docDenied?.keys).toContain('import')
    const ownerImp = await o.push([], { doc: { set: { import: { from: 'tldraw-5.4.2' } } } })
    expect(ownerImp.docDenied?.keys).toContain('import')
    const sv = await e.push([], { doc: { set: { startView: { x: 0, y: 0, w: 100, h: 100 } } } })
    expect(sv.docDenied?.keys).toContain('startView')
    const bad = await e.push([], { doc: { set: { 'tagDef:x': { name: '', color: 'red' } } } })
    expect(bad.docDenied?.keys).toContain('tagDef:x')
    const ok = await e.push([], { doc: { set: { 'tagDef:y': { name: 'y', color: 'red' } } } })
    expect(ok.docDenied).toBeUndefined()
    // what a fresh session is told the doc holds: only the accepted key
    const fresh = await st.client({ boardId: b, user: 'fresh' })
    const doc = (fresh.welcome?.doc ?? {}) as Record<string, unknown>
    expect(doc.import).toBeUndefined()
    expect(doc.startView).toBeUndefined()
    expect(doc['tagDef:x']).toBeUndefined()
    expect(doc['tagDef:y']).toEqual({ name: 'y', color: 'red' })
  })
})

describe('§2.4.2 the abuse close', () => {
  it('more than 50 abuse-counting refusals in a minute close the session with 4099 INVALID_MESSAGE; LOCKED ones do not', async () => {
    const st = shared.get()
    const b = newBoardId()
    const a = await st.client({ boardId: b, user: 'alice' })
    await a.create([rect('shut', { locked: true })])
    // 60 LOCKED refusals: not abuse, the session stays
    for (let i = 0; i < 3; i++)
      await a.push(Array.from({ length: 20 }, () => a.patchOp('shut', { g: { pos: { x: i, y: i } } })))
    expect(a.isOpen).toBe(true)
    const bad = Array.from({ length: 60 }, (_, i) => ({
      k: 'c',
      el: { ...rect(`bad${i}`), type: 'embeddable' },
    }))
    a.pushNow(bad)
    expect(await a.untilClosed()).toMatchObject({ code: 4099, reason: 'INVALID_MESSAGE' })
    await expectNotStored(
      st,
      b,
      bad.map((_, i) => `bad${i}`),
    )
  })
})
