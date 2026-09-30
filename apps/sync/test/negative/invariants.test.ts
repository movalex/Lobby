// The negative security suite, part 1: the cross-element invariants of §2.4.4, one test per row, plus the
// element types of §3.1. Raw frames from the protocol harness against the real server process
// (DRAFTROOM_ENGINE=excalidraw); nothing refused may be stored and the socket stays open.

import { describe, expect, it } from 'vitest'
import { newBoardId, sharedElementStack } from '../harness/element-stack.ts'
import {
  arrow,
  bindArrow,
  ellipse,
  frame,
  freedraw,
  label,
  line,
  note,
  noteWithLabel,
  rect,
  text,
  withLabel,
} from '../harness/elements.ts'
import { expectAccepted, expectNotStored, expectRefused, storedEl } from './support.ts'

const shared = sharedElementStack()

describe('§2.4.4 a text with containerId X needs X live and a text container', () => {
  it('X missing, X deleted, or X not a text container (frame, line, freedraw): INVALID', async () => {
    const st = shared.get()
    const b = newBoardId()
    const a = await st.client({ boardId: b, user: 'alice' })
    await a.create([note('gone'), frame('f1'), line('l1'), freedraw('p1')])
    expectAccepted(await a.patch('gone', { g: { life: { isDeleted: true } } }))
    for (const [id, containerId] of [
      ['t-missing', 'nope'],
      ['t-deleted', 'gone'],
      ['t-frame', 'f1'],
      ['t-line', 'l1'],
      ['t-draw', 'p1'],
    ] as const)
      expectRefused(await a.createOne(label(id, containerId)), 'INVALID', a)
    await expectNotStored(st, b, ['t-missing', 't-deleted', 't-frame', 't-line', 't-draw'])
  })

  it('every text container of §3.1 takes a label (stickynote, rectangle, ellipse, arrow)', async () => {
    const st = shared.get()
    const b = newBoardId()
    const a = await st.client({ boardId: b, user: 'alice' })
    const containers = [note('c-note'), rect('c-rect'), ellipse('c-ell'), arrow('c-arrow')]
    await a.create(containers)
    for (const c of containers) expectAccepted(await a.createOne(label(`${c.id}.t`, c.id)))
  })
})

describe('§2.4.4 container ↔ label is one-to-one, kept in step by the server', () => {
  it('a second label for X is INVALID; the first one stays', async () => {
    const st = shared.get()
    const b = newBoardId()
    const a = await st.client({ boardId: b, user: 'alice' })
    await a.create(noteWithLabel('n1', 'first'))
    expectRefused(await a.createOne(label('n1.t2', 'n1')), 'INVALID', a)
    await expectNotStored(st, b, ['n1.t2'])
    expect((await storedEl(st, b, 'n1')).boundElements).toEqual([{ id: 'n1.t', type: 'text' }])
  })

  it('a label created without its container listing it: the server lists it (repair in the same clock)', async () => {
    const st = shared.get()
    const b = newBoardId()
    const a = await st.client({ boardId: b, user: 'alice' })
    await a.create([note('n1')])
    expectAccepted(await a.createOne(label('n1.t', 'n1')))
    expect((await storedEl(st, b, 'n1')).boundElements).toEqual([{ id: 'n1.t', type: 'text' }])
  })

  it('deleting a container deletes its label in the same clock (cascade)', async () => {
    const st = shared.get()
    const b = newBoardId()
    const a = await st.client({ boardId: b, user: 'alice' })
    await a.create(noteWithLabel('n1', 'bye'))
    const ack = await a.push([a.patchOp('n1', { g: { life: { isDeleted: true } } })])
    expect(ack.r[0]).toMatchObject({ ok: true })
    const lbl = await storedEl(st, b, 'n1.t')
    expect(lbl.isDeleted).toBe(true)
    const change = a.of('changes').find((c) => c.clock === ack.clock)
    expect(change?.ops.map((o) => (o.k === 'p' ? o.id : o.el.id)).sort()).toEqual(['n1', 'n1.t'])
  })
})

describe('§2.4.4 a label inherits its container’s lease and lock', () => {
  it('a label for a note leased by someone else is LEASED; for a locked note LOCKED; so is pointing a text at them', async () => {
    const st = shared.get()
    const b = newBoardId()
    const a = await st.client({ boardId: b, user: 'alice' })
    const m = await st.client({ boardId: b, user: 'mallory' })
    await a.create([note('leased'), note('locked', { locked: true }), text('free')])
    await m.untilClock(a.clock)
    expect((await a.acquire('leased')).type).toBe('lease.grant')
    expectRefused(await m.createOne(label('x1', 'leased')), 'LEASED', m)
    expectRefused(await m.createOne(label('x2', 'locked')), 'LOCKED', m)
    expectRefused(await m.patch('free', { g: { bind: { containerId: 'leased' } } }), 'LEASED', m)
    expectRefused(await m.patch('free', { g: { bind: { containerId: 'locked' } } }), 'LOCKED', m)
    await expectNotStored(st, b, ['x1', 'x2'])
    expect((await storedEl(st, b, 'free')).containerId).toBeNull()
  })

  it('deleting a container whose label someone else is typing in is LEASED; the note and its label stay', async () => {
    const st = shared.get()
    const b = newBoardId()
    const a = await st.client({ boardId: b, user: 'alice' })
    const m = await st.client({ boardId: b, user: 'mallory' })
    await a.create(noteWithLabel('n1', 'typing'))
    await m.untilClock(a.clock)
    expect((await a.acquire('n1')).type).toBe('lease.grant')
    const r = await m.patch('n1', { g: { life: { isDeleted: true } } })
    // a partial accept names the refused group; a whole refusal the code: either way nothing is deleted
    if (r.ok) expect(r.denied).toMatchObject({ code: 'LEASED' })
    else expectRefused(r, 'LEASED', m)
    expect((await storedEl(st, b, 'n1')).isDeleted).toBe(false)
    expect((await storedEl(st, b, 'n1.t')).isDeleted).toBe(false)
  })
})

describe('§2.4.4 a label sorts after its container', () => {
  it('a label keyed below its container is re-keyed (fix)', async () => {
    const st = shared.get()
    const b = newBoardId()
    const a = await st.client({ boardId: b, user: 'alice' })
    const n = note('n1', { index: 'a5' })
    const t = label('n1.t', 'n1', { index: 'a1' })
    withLabel(n, t)
    const ack = await a.create([n, t])
    const fix = (ack.r[1] as { fix?: { index?: string } }).fix?.index
    expect(fix, 'the label comes back re-keyed').toBeDefined()
    expect((await storedEl(st, b, 'n1.t')).index > (await storedEl(st, b, 'n1')).index).toBe(true)
  })
})

describe('§2.4.4 bindings: the target exists, is live and bindable; bindings are symmetric', () => {
  it('a binding to a missing, a deleted or an unbindable element (a line) is set to null (fix); the arrow keeps its points', async () => {
    const st = shared.get()
    const b = newBoardId()
    const a = await st.client({ boardId: b, user: 'alice' })
    await a.create([rect('dead', { x: 400 }), line('ln', { x: 400, y: 300 })])
    expectAccepted(await a.patch('dead', { g: { life: { isDeleted: true } } }))
    for (const [id, target] of [
      ['a-missing', 'nope'],
      ['a-deleted', 'dead'],
      ['a-line', 'ln'],
    ] as const) {
      const el = arrow(id, { x: 0, y: 0 })
      el.endBinding = { elementId: target, fixedPoint: [0, 0.5], mode: 'orbit' }
      const r = expectAccepted(await a.createOne(el))
      expect(r.fix, `${id}: the binding comes back as null`).toMatchObject({ endBinding: null })
      const stored = await storedEl(st, b, id)
      expect(stored.endBinding).toBeNull()
      expect(stored.points).toEqual(el.points)
    }
    expect((await storedEl(st, b, 'ln')).boundElements ?? null).toBeNull()
  })

  it('an arrow bound to a target that does not list it: the server lists it on the target (repair)', async () => {
    const st = shared.get()
    const b = newBoardId()
    const a = await st.client({ boardId: b, user: 'alice' })
    const r1 = rect('r1')
    const a1 = bindArrow(arrow('a1', { x: 105, y: 50 }), r1, null)
    r1.boundElements = null
    await a.create([r1, a1])
    expect((await storedEl(st, b, 'r1')).boundElements).toEqual([{ id: 'a1', type: 'arrow' }])
  })

  it('a boundElements entry nothing binds back is removed by the server (no injected references)', async () => {
    const st = shared.get()
    const b = newBoardId()
    const a = await st.client({ boardId: b, user: 'alice' })
    await a.create([rect('r1'), rect('r2', { x: 300 })])
    expectAccepted(await a.patch('r1', { b: { add: [{ id: 'r2', type: 'arrow' }], rm: [] } }))
    expect((await storedEl(st, b, 'r1')).boundElements ?? null).toBeNull()
  })

  it('deleting a bound target sets the binding to null; that end stays where it is', async () => {
    const st = shared.get()
    const b = newBoardId()
    const a = await st.client({ boardId: b, user: 'alice' })
    const r1 = rect('r1')
    const a1 = bindArrow(arrow('a1', { x: 105, y: 50 }), r1, null)
    await a.create([r1, a1])
    const before = await storedEl(st, b, 'a1')
    expectAccepted(await a.patch('r1', { g: { life: { isDeleted: true } } }))
    const after = await storedEl(st, b, 'a1')
    expect(after.startBinding).toBeNull()
    expect([after.x, after.y, after.points]).toEqual([before.x, before.y, before.points])
  })
})

describe('§2.4.4 frameId names a live frame', () => {
  it('frameId naming a rectangle, a missing id, or a frame inside a frame: INVALID', async () => {
    const st = shared.get()
    const b = newBoardId()
    const a = await st.client({ boardId: b, user: 'alice' })
    await a.create([rect('r1'), frame('f1')])
    expectRefused(await a.createOne(rect('in-rect', { frameId: 'r1' })), 'INVALID', a)
    expectRefused(await a.createOne(rect('in-nothing', { frameId: 'nope' })), 'INVALID', a)
    expectRefused(await a.createOne(frame('f-in-f', { frameId: 'f1' })), 'INVALID', a)
    expectRefused(await a.patch('r1', { g: { membership: { groupIds: [], frameId: 'r1' } } }), 'INVALID', a)
    expectAccepted(await a.createOne(rect('in-frame', { frameId: 'f1' })))
    await expectNotStored(st, b, ['in-rect', 'in-nothing', 'f-in-f'])
  })

  it('a frame deleted concurrently: a child written on the older view gets frameId null (fix), not INVALID', async () => {
    const st = shared.get()
    const b = newBoardId()
    const a = await st.client({ boardId: b, user: 'alice' })
    const m = await st.client({ boardId: b, user: 'bob' })
    await a.create([frame('f1'), rect('r1')])
    await m.untilClock(a.clock)
    const base = m.clock
    expectAccepted(await a.patch('f1', { g: { life: { isDeleted: true } } }))
    // bob moves r1 into f1 on his view from before the delete (base below the delete's clock)
    const r = await m.one(m.patchOp('r1', { g: { membership: { groupIds: [], frameId: 'f1' } } }), { base })
    expect(r).toMatchObject({ ok: true, fix: { frameId: null } })
    expect((await storedEl(st, b, 'r1')).frameId).toBeNull()
  })
})

describe('§2.4.4 group nesting is consistent', () => {
  it('a group id with two different parents is INVALID', async () => {
    const st = shared.get()
    const b = newBoardId()
    const a = await st.client({ boardId: b, user: 'alice' })
    await a.create([rect('r1', { groupIds: ['g1', 'g2'] })])
    expectRefused(await a.createOne(rect('r2', { groupIds: ['g1', 'g3'] })), 'INVALID', a)
    expectAccepted(await a.createOne(rect('r3', { groupIds: ['g1', 'g2'] })))
    await expectNotStored(st, b, ['r2'])
  })
})

describe('§3.1 element types', () => {
  it('selection, magicframe, iframe, embeddable and an unknown type are INVALID', async () => {
    const st = shared.get()
    const b = newBoardId()
    const a = await st.client({ boardId: b, user: 'alice' })
    const ids: string[] = []
    for (const type of ['selection', 'magicframe', 'iframe', 'embeddable', 'banana']) {
      ids.push(`x-${type}`)
      expectRefused(await a.one({ k: 'c', el: { ...rect(`x-${type}`), type } }), 'INVALID', a)
    }
    await expectNotStored(st, b, ids)
  })

  it('a create over a live id of another type is TYPE_CHANGE; the stored element keeps its type', async () => {
    const st = shared.get()
    const b = newBoardId()
    const a = await st.client({ boardId: b, user: 'alice' })
    await a.create([rect('r1')])
    expectRefused(await a.one({ k: 'c', el: ellipse('r1') }), 'TYPE_CHANGE', a)
    expect((await storedEl(st, b, 'r1')).type).toBe('rectangle')
  })
})
