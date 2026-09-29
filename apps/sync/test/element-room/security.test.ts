// The negative security suite (§6.2) and the server half of B6 F1–F17, with raw frames against the real
// server process: one test per server rule (customData classes, cross-element invariants, links, files,
// types, limits, fonts, coordinates, VOTE_OPEN, the abuse close, the drag caps). Nothing refused may be
// stored; the socket stays open unless the rule says it closes.

import { describe, expect, it } from 'vitest'
import type { RawClient } from './support/client.ts'
import {
  arrow,
  assetId,
  bindArrow,
  frame,
  image,
  label,
  note,
  rect,
  text,
  versionId,
  withLabel,
} from './support/elements.ts'
import { newBoardId, useElementHarness } from './support/stack.ts'

const h = useElementHarness()

const patch = (c: RawClient, id: string, rest: Record<string, unknown>) => ({
  k: 'p',
  id,
  pv: c.confirmed.get(id)?.version ?? 1,
  ...rest,
})
const r0 = (ack: { r: unknown[] }) =>
  ack.r[0] as { ok: boolean; code?: string; fix?: Record<string, unknown> }

describe('customData classes (§3.3)', () => {
  it('F1 a +1 for another uid is INVALID; the own +1 is kept', async () => {
    const st = await h.stack()
    const b = newBoardId()
    const a = await st.client({ boardId: b, user: 'alice' })
    await a.create([rect('r1')])
    expect(r0(await a.push([patch(a, 'r1', { c: { 'plusOne:bob': true } })]))).toMatchObject({
      ok: false,
      code: 'INVALID',
    })
    expect(r0(await a.push([patch(a, 'r1', { c: { 'plusOne:alice': true } })]))).toMatchObject({ ok: true })
    const s = await st.snapshot(b)
    expect(s.elements.find((e) => e.id === 'r1')?.customData?.lobby).toEqual({ 'plusOne:alice': true })
  })

  it('F2, F3: lobbyServer in a create is replaced (createdBy from the ticket; privateNote never from a socket)', async () => {
    const st = await h.stack()
    const b = newBoardId()
    const a = await st.client({ boardId: b, user: 'alice' })
    const forged = rect('r1', {
      customData: {
        lobbyServer: {
          createdBy: { uid: 'mallory', name: 'Mallory', guest: false },
          createdAt: 1,
          lastEditedBy: null,
          lastEditedAt: 1,
          privateNote: { session: 'sess1', author: 'mallory' },
        },
      },
    })
    expect(r0(await a.create([forged]))).toMatchObject({ ok: true })
    const s = await st.snapshot(b)
    const ls = s.elements.find((e) => e.id === 'r1')?.customData?.lobbyServer
    expect(ls?.createdBy).toEqual({ uid: 'alice', name: 'alice-name', guest: false })
    expect(ls?.privateNote).toBeUndefined()
  })

  it('F4 privateFrame added to an existing frame is INVALID; in a create it needs by = the writer', async () => {
    const st = await h.stack()
    const b = newBoardId()
    const a = await st.client({ boardId: b, user: 'alice' })
    await a.create([frame('f1')])
    expect(
      r0(await a.push([patch(a, 'f1', { c: { privateFrame: { session: 's1', by: 'alice' } } })])),
    ).toMatchObject({ ok: false, code: 'INVALID' })
    expect(
      r0(
        await a.create([
          frame('f2', { customData: { lobby: { privateFrame: { session: 's1', by: 'bob' } } } }),
        ]),
      ),
    ).toMatchObject({ ok: false, code: 'INVALID' })
    expect(
      r0(
        await a.create([
          frame('f3', { customData: { lobby: { privateFrame: { session: 's1', by: 'alice' } } } }),
        ]),
      ),
    ).toMatchObject({ ok: true })
  })

  it('a tag needs its tagDef in the doc; the same push may define it', async () => {
    const st = await h.stack()
    const b = newBoardId()
    const a = await st.client({ boardId: b, user: 'alice' })
    await a.create([rect('r1')])
    const tag = { 'tag:x': { name: 'x', color: 'red' } }
    expect(r0(await a.push([patch(a, 'r1', { c: tag })]))).toMatchObject({ ok: false, code: 'INVALID' })
    const ack = await a.push([patch(a, 'r1', { c: tag })], {
      doc: { set: { 'tagDef:x': { name: 'x', color: 'red' } } },
    })
    expect(r0(ack)).toMatchObject({ ok: true })
    expect(ack.docDenied).toBeUndefined()
  })

  it('F13 a +1 while a dot vote is open is VOTE_OPEN (the api pushed the state to sync)', async () => {
    const st = await h.stack()
    const b = newBoardId()
    const a = await st.client({ boardId: b, user: 'alice' })
    await a.create([rect('r1')])
    const res = await fetch(`${st.server.url}/internal/boards/${b}/workshop-state`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-draftroom-internal': 'test-only-internal-secret-0123456789-abcdef',
      },
      body: JSON.stringify({ voteOpen: true, anonymous: false }),
    })
    expect(res.status).toBe(204)
    await a.until(() => a.of('workshop').some((w) => w.voteOpen), 'workshop broadcast')
    expect(r0(await a.push([patch(a, 'r1', { c: { 'plusOne:alice': true } })]))).toMatchObject({
      ok: false,
      code: 'VOTE_OPEN',
    })
  })
})

describe('cross-element invariants (§2.4.4)', () => {
  it('F5 a second label for a container is INVALID; F12 a label keyed below its container is re-keyed', async () => {
    const st = await h.stack()
    const b = newBoardId()
    const a = await st.client({ boardId: b, user: 'alice' })
    const n = note('n1', { index: 'a5' })
    const t = label('n1.t', 'n1', { index: 'a1' })
    withLabel(n, t)
    const ack = await a.create([n, t])
    expect(ack.r.every((r) => r.ok)).toBe(true)
    const fixIndex = (ack.r[1] as { fix?: { index?: string } }).fix?.index
    expect(fixIndex).toBeDefined()
    expect((fixIndex as string) > 'a5').toBe(true)
    expect(r0(await a.create([label('n1.t2', 'n1')]))).toMatchObject({ ok: false, code: 'INVALID' })
    const s = await st.snapshot(b)
    expect(s.elements.map((e) => e.id).sort()).toEqual(['n1', 'n1.t'])
  })

  it('F6 a text pointed at a note leased by another user is LEASED; at a locked note LOCKED', async () => {
    const st = await h.stack()
    const b = newBoardId()
    const a = await st.client({ boardId: b, user: 'alice' })
    const m = await st.client({ boardId: b, user: 'mallory' })
    await a.create([note('n1'), note('n2', { locked: true })])
    await m.untilClock(a.clock)
    expect((await a.acquire('n1')).type).toBe('lease.grant')
    expect(r0(await m.create([label('t1', 'n1')]))).toMatchObject({ ok: false, code: 'LEASED' })
    expect(r0(await m.create([label('t2', 'n2')]))).toMatchObject({ ok: false, code: 'LOCKED' })
    // a containerId switch to the leased note too
    await m.create([text('t3')])
    expect(r0(await m.push([patch(m, 't3', { g: { bind: { containerId: 'n1' } } })]))).toMatchObject({
      ok: false,
      code: 'LEASED',
    })
    const s = await st.snapshot(b)
    expect(
      (s.elements.find((e) => e.id === 't3') as { containerId?: unknown } | undefined)?.containerId,
    ).toBeNull()
  })

  it('F7 an arrow bound to a missing id: the binding is set to null (fix); the target lists a bound arrow', async () => {
    const st = await h.stack()
    const b = newBoardId()
    const a = await st.client({ boardId: b, user: 'alice' })
    const r1 = rect('r1')
    const a1 = arrow('a1', { x: 105, y: 50 })
    bindArrow(a1, r1, null)
    a1.endBinding = { elementId: 'nope', fixedPoint: [0, 0.5], mode: 'orbit' }
    r1.boundElements = null // the server keeps it symmetric
    const ack = await a.create([r1, a1])
    expect(ack.r[1]).toMatchObject({ ok: true, fix: { endBinding: null } })
    const s = await st.snapshot(b)
    expect(s.elements.find((e) => e.id === 'r1')?.boundElements).toEqual([{ id: 'a1', type: 'arrow' }])
  })

  it('F8 frameId naming a rectangle is INVALID; a frame in a frame too', async () => {
    const st = await h.stack()
    const b = newBoardId()
    const a = await st.client({ boardId: b, user: 'alice' })
    await a.create([rect('r1'), frame('f1')])
    expect(r0(await a.create([rect('r2', { frameId: 'r1' })]))).toMatchObject({ ok: false, code: 'INVALID' })
    expect(r0(await a.create([frame('f2', { frameId: 'f1' })]))).toMatchObject({ ok: false, code: 'INVALID' })
    expect(r0(await a.create([rect('r3', { frameId: 'f1' })]))).toMatchObject({ ok: true })
  })

  it('a boundElements injection is removed by the server (entries must be bound back)', async () => {
    const st = await h.stack()
    const b = newBoardId()
    const a = await st.client({ boardId: b, user: 'alice' })
    await a.create([rect('r1'), rect('r2')])
    const ack = await a.push([patch(a, 'r1', { b: { add: [{ id: 'r2', type: 'arrow' }], rm: [] } })])
    expect(r0(ack).ok).toBe(true)
    const s = await st.snapshot(b)
    expect(s.elements.find((e) => e.id === 'r1')?.boundElements ?? null).toBeNull()
  })

  it('a group id with two parents is INVALID', async () => {
    const st = await h.stack()
    const b = newBoardId()
    const a = await st.client({ boardId: b, user: 'alice' })
    await a.create([rect('r1', { groupIds: ['g1', 'g2'] })])
    expect(r0(await a.create([rect('r2', { groupIds: ['g1', 'g3'] })]))).toMatchObject({
      ok: false,
      code: 'INVALID',
    })
    expect(r0(await a.create([rect('r3', { groupIds: ['g1', 'g2'] })]))).toMatchObject({ ok: true })
  })
})

describe('links, files, types, limits (§3.5)', () => {
  it('F10 javascript:, data: and signed links are INVALID; a Lobby path or https is kept', async () => {
    const st = await h.stack()
    const b = newBoardId()
    const a = await st.client({ boardId: b, user: 'alice' })
    await a.create([rect('r1')])
    for (const link of [
      'javascript:alert(1)',
      'data:text/html,<b>x</b>',
      'https://bucket.r2.cloudflarestorage.com/x.png?X-Amz-Signature=abc',
    ])
      expect(r0(await a.push([patch(a, 'r1', { g: { meta: { link } } })]))).toMatchObject({
        ok: false,
        code: 'INVALID',
      })
    expect(
      r0(await a.push([patch(a, 'r1', { g: { meta: { link: 'https://example.com/a' } } })])),
    ).toMatchObject({ ok: true })
    const g = await st.client({ boardId: b, user: 'guesty', guest: true })
    expect(
      r0(await g.push([patch(g, 'r1', { g: { meta: { link: 'https://example.com/b' } } })])),
    ).toMatchObject({
      ok: false,
      code: 'INVALID',
    })
    expect(r0(await g.push([patch(g, 'r1', { g: { meta: { link: '/b/other' } } })]))).toMatchObject({
      ok: true,
    })
  })

  it('F9 a fileId of another workspace is INVALID; with the api down, UNAVAILABLE (fail closed)', async () => {
    const st = await h.stack()
    const b = newBoardId()
    st.api.addFile({
      versionId: versionId(1),
      assetId: assetId(1),
      kind: 'image',
      name: 'a.png',
      mimeType: 'image/png',
      sizeBytes: 10,
      pageCount: null,
    })
    st.api.addForeign(versionId(2))
    const a = await st.client({ boardId: b, user: 'alice' })
    expect(r0(await a.create([image('i1', versionId(1))]))).toMatchObject({ ok: true })
    expect(r0(await a.create([image('i2', versionId(2))]))).toMatchObject({ ok: false, code: 'INVALID' })
    expect(r0(await a.create([image('i3', versionId(3))]))).toMatchObject({ ok: false, code: 'INVALID' })
    st.api.fileRefsMode = 'error'
    expect(r0(await a.create([image('i4', versionId(4))]))).toMatchObject({ ok: false, code: 'UNAVAILABLE' })
    // a known id is still served from the cache
    expect(r0(await a.create([image('i5', versionId(1))]))).toMatchObject({ ok: true })
    const s = await st.snapshot(b)
    expect(s.elements.map((e) => e.id).sort()).toEqual(['i1', 'i5'])
    expect(s.elements.every((e) => e.type !== 'image' || e.status === 'saved')).toBe(true)
  })

  it('file metadata is canonicalized from the api; a mismatched versionId is INVALID', async () => {
    const st = await h.stack()
    const b = newBoardId()
    st.api.addFile({
      versionId: versionId(7),
      assetId: assetId(7),
      kind: 'pdf',
      name: 'real.pdf',
      mimeType: 'application/pdf',
      sizeBytes: 999,
      pageCount: 3,
    })
    const a = await st.client({ boardId: b, user: 'alice' })
    const forgedFile = {
      assetId: assetId(8),
      versionId: versionId(7),
      kind: 'image',
      name: 'mine.pdf',
      mimeType: 'text/html',
      sizeBytes: 1,
    }
    const ack = await a.create([
      image('p1', `${versionId(7)}.p2`, { customData: { lobby: { file: forgedFile } } }),
    ])
    expect(r0(ack).ok).toBe(true)
    const s = await st.snapshot(b)
    const lobby = s.elements.find((e) => e.id === 'p1')?.customData?.lobby
    expect(lobby).toEqual({
      file: {
        assetId: assetId(7),
        versionId: versionId(7),
        kind: 'pdf',
        name: 'mine.pdf',
        mimeType: 'application/pdf',
        sizeBytes: 999,
      },
      pdfPage: 2,
    })
    expect(r0(await a.create([image('p2', `${versionId(7)}.p9`)]))).toMatchObject({
      ok: false,
      code: 'INVALID',
    })
    const wrong = { ...forgedFile, versionId: versionId(1) }
    st.api.addFile({
      versionId: versionId(1),
      assetId: assetId(1),
      kind: 'image',
      name: 'a',
      mimeType: 'image/png',
      sizeBytes: 1,
      pageCount: null,
    })
    expect(
      r0(await a.create([image('p3', versionId(7), { customData: { lobby: { file: wrong } } })])),
    ).toMatchObject({
      ok: false,
      code: 'INVALID',
    })
  })

  it('F11 embeddable and iframe are INVALID; a create over a live id of another type is TYPE_CHANGE', async () => {
    const st = await h.stack()
    const b = newBoardId()
    const a = await st.client({ boardId: b, user: 'alice' })
    await a.create([rect('r1')])
    for (const type of ['embeddable', 'iframe'])
      expect(r0(await a.push([{ k: 'c', el: { ...rect(`x-${type}`), type } }]))).toMatchObject({
        ok: false,
        code: 'INVALID',
      })
    expect(r0(await a.push([{ k: 'c', el: ellipseLike('r1') }]))).toMatchObject({
      ok: false,
      code: 'TYPE_CHANGE',
    })
  })

  it('F15 fontFamily 9, 10 and 1 are INVALID; F16 x = 2e6 is INVALID', async () => {
    const st = await h.stack()
    const b = newBoardId()
    const a = await st.client({ boardId: b, user: 'alice' })
    for (const fontFamily of [9, 10, 1])
      expect(r0(await a.create([text(`t${fontFamily}`, { fontFamily })]))).toMatchObject({
        ok: false,
        code: 'INVALID',
      })
    expect(r0(await a.create([rect('far', { x: 2e6 })]))).toMatchObject({ ok: false, code: 'INVALID' })
    expect((await st.snapshot(b)).elements).toEqual([])
  })

  it('a path patch with a field missing is INVALID', async () => {
    const st = await h.stack()
    const b = newBoardId()
    const a = await st.client({ boardId: b, user: 'alice' })
    await a.create([arrow('a1')])
    for (const missing of ['x', 'angle', 'elbowed', 'points']) {
      const unit: Record<string, unknown> = {
        x: 0,
        y: 0,
        points: [
          [0, 0],
          [50, 50],
        ],
        width: 50,
        height: 50,
        angle: 0,
        elbowed: false,
      }
      delete unit[missing]
      expect(r0(await a.push([patch(a, 'a1', { g: { path: unit } })]))).toMatchObject({
        ok: false,
        code: 'INVALID',
      })
    }
  })
})

describe('abuse and rates (F14)', () => {
  it('more than 50 INVALID ops in a minute close the session with 4099 INVALID_MESSAGE', async () => {
    const st = await h.stack()
    const b = newBoardId()
    const a = await st.client({ boardId: b, user: 'alice' })
    const bad = Array.from({ length: 60 }, (_, i) => ({
      k: 'c',
      el: { ...rect(`bad${i}`), type: 'embeddable' },
    }))
    a.pushNow(bad)
    expect(await a.untilClosed()).toMatchObject({ code: 4099, reason: 'INVALID_MESSAGE' })
  })

  it('RATE rejects (a flood beyond the op budget) never close the session', async () => {
    const st = await h.stack()
    const b = newBoardId()
    const a = await st.client({ boardId: b, user: 'alice' })
    const pushes = []
    for (let p = 0; p < 12; p++)
      pushes.push(a.pushNow(Array.from({ length: 500 }, (_, i) => ({ k: 'c', el: rect(`p${p}-${i}`) }))).ack)
    const acks = await Promise.all(pushes)
    const rate = acks.flatMap((k) => k.r).filter((r) => !r.ok && r.code === 'RATE').length
    expect(rate).toBeGreaterThanOrEqual(60)
    expect(a.of('notice').some((n) => n.code === 'SLOW_DOWN')).toBe(true)
    expect(a.closeCode).toBeNull()
    await a.push([{ k: 'c', el: rect('after') }])
  })
})

describe('the drag relay caps (F17)', () => {
  it('a drag with 501 ids and a second active drag are dropped; the editor sees no preview of them', async () => {
    const st = await h.stack()
    const b = newBoardId()
    const a = await st.client({ boardId: b, user: 'alice' })
    const e = await st.client({ boardId: b, user: 'eve' })
    await a.create([rect('r1'), rect('r2')])
    a.presence({ drag: { d: 1, ids: Array.from({ length: 501 }, (_, i) => `x${i}`), dx: 5, dy: 5 } })
    await new Promise((r) => setTimeout(r, 400))
    expect(e.of('presence').flatMap((p) => p.drags ?? [])).toEqual([])
    a.presence({ drag: { d: 2, ids: ['r1'], dx: 1, dy: 1 } })
    await e.until(() => e.of('presence').some((p) => (p.drags ?? []).some((d) => d.d === 2)), 'drag 2')
    a.presence({ drag: { d: 3, ids: ['r2'], dx: 1, dy: 1 } })
    await new Promise((r) => setTimeout(r, 400))
    expect(
      e
        .of('presence')
        .flatMap((p) => p.drags ?? [])
        .some((d) => d.d === 3),
    ).toBe(false)
  })
})

function ellipseLike(id: string) {
  return { ...rect(id), type: 'ellipse' }
}

describe('caps and fail-closed lookups', () => {
  it('a guest may create at most 500 items; the cap counts the same push', async () => {
    const st = await h.stack()
    const b = newBoardId()
    const g = await st.client({ boardId: b, user: 'guest', guest: true })
    const ack = await g.push(Array.from({ length: 500 }, (_, i) => ({ k: 'c', el: rect(`g${i}`) })))
    expect(ack.r.every((r) => r.ok)).toBe(true)
    const more = await g.push([
      { k: 'c', el: rect('g500') },
      { k: 'c', el: rect('g501') },
    ])
    expect(more.r.map((r) => (r.ok ? 'ok' : r.code))).toEqual(['GUEST_LIMIT', 'GUEST_LIMIT'])
    const g2 = await st.client({ boardId: b, user: 'guest2', guest: true })
    // the cap counts the push's own earlier creates: 400, then 101 in one push → the last one refused
    const first = await g2.push(Array.from({ length: 400 }, (_, i) => ({ k: 'c', el: rect(`h${i}`) })))
    expect(first.r.every((r) => r.ok)).toBe(true)
    const second = await g2.push(Array.from({ length: 101 }, (_, i) => ({ k: 'c', el: rect(`k${i}`) })))
    expect(second.r.filter((r) => r.ok)).toHaveLength(100)
    expect(second.r.at(-1)).toMatchObject({ ok: false, code: 'GUEST_LIMIT' })
  })

  it('a file-refs lookup that hangs fails closed after 3 s (UNAVAILABLE) and does not block the session', async () => {
    const st = await h.stack()
    const b = newBoardId()
    st.api.fileRefsMode = 'hang'
    const a = await st.client({ boardId: b, user: 'alice' })
    const t0 = Date.now()
    const hung = a.pushNow([{ k: 'c', el: image('i1', versionId(9)) }])
    const after = a.pushNow([{ k: 'c', el: rect('r-after') }])
    expect((await hung.ack).r[0]).toMatchObject({ ok: false, code: 'UNAVAILABLE' })
    expect(Date.now() - t0).toBeGreaterThanOrEqual(2_900)
    expect((await after.ack).r[0]).toMatchObject({ ok: true })
  })
})
