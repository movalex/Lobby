// The negative security suite, part 3: element validation and limits of §3.5 (links, fileId, fonts,
// coordinates, point and text caps, groups, the path unit, unknown ids, message limits) and the fields the
// server owns. Raw frames against the real server process (DRAFTROOM_ENGINE=excalidraw).

import { describe, expect, it } from 'vitest'
import { fileRef } from '../harness/element-api.ts'
import { newBoardId, sharedElementStack } from '../harness/element-stack.ts'
import { arrow, assetId, freedraw, image, rect, text, versionId } from '../harness/elements.ts'
import { expectAccepted, expectNotStored, expectRefused, storedEl } from './support.ts'

const shared = sharedElementStack()

describe('§3.5 links', () => {
  it('javascript:, data:, vbscript:, signed URLs and links over 2 KiB are INVALID; https, mailto and Lobby paths are kept', async () => {
    const st = shared.get()
    const b = newBoardId()
    const a = await st.client({ boardId: b, user: 'alice' })
    await a.create([rect('r1')])
    for (const link of [
      'javascript:alert(1)',
      'JavaScript:alert(1)',
      'data:text/html,<b>x</b>',
      'vbscript:msgbox(1)',
      'https://bucket.r2.cloudflarestorage.com/x.png?X-Amz-Signature=abc',
      'https://cdn.example.com/x.png?Expires=1&Signature=abc&Key-Pair-Id=k',
      `https://example.com/${'a'.repeat(2100)}`,
    ])
      expectRefused(await a.patch('r1', { g: { meta: { link } } }), 'INVALID', a)
    expect((await storedEl(st, b, 'r1')).link).toBeNull()
    for (const link of ['https://example.com/a', 'mailto:team@example.com', '/b/b-0000000001'])
      expectAccepted(await a.patch('r1', { g: { meta: { link } } }))
    expectRefused(await a.createOne(rect('r2', { link: 'javascript:alert(2)' })), 'INVALID', a)
    await expectNotStored(st, b, ['r2'])
  })

  it('a guest may only set Lobby-relative links', async () => {
    const st = shared.get()
    const b = newBoardId()
    const a = await st.client({ boardId: b, user: 'alice' })
    await a.create([rect('r1')])
    const g = await st.client({ boardId: b, user: 'guesty', guest: true })
    expectRefused(await g.patch('r1', { g: { meta: { link: 'https://example.com/b' } } }), 'INVALID', g)
    expectAccepted(await g.patch('r1', { g: { meta: { link: '/b/other' } } }))
  })
})

describe('§3.5 files: fileId must resolve through file-refs to the board’s workspace', () => {
  it('a malformed fileId, a foreign version and a missing one are INVALID; with the api down, UNAVAILABLE (fail closed)', async () => {
    const st = shared.get()
    const b = newBoardId()
    st.api.addFile(fileRef(versionId(1), assetId(1)))
    st.api.addForeign(versionId(2))
    const a = await st.client({ boardId: b, user: 'alice' })
    expectAccepted(await a.createOne(image('ok', versionId(1))))
    expectRefused(await a.createOne(image('bad-pattern', 'data:image/png;base64,AAAA')), 'INVALID', a)
    expectRefused(await a.createOne(image('bad-url', '/files/ast_1/ver_1/original')), 'INVALID', a)
    expectRefused(await a.createOne(image('foreign', versionId(2))), 'INVALID', a)
    expectRefused(await a.createOne(image('missing', versionId(3))), 'INVALID', a)
    expectRefused(await a.patch('ok', { g: { file: { fileId: versionId(2) } } }), 'INVALID', a)
    st.api.fileRefsMode = 'error'
    try {
      expectRefused(await a.createOne(image('api-down', versionId(4))), 'UNAVAILABLE', a)
      // a version the room has already resolved is served from its cache
      expectAccepted(await a.createOne(image('cached', versionId(1))))
    } finally {
      st.api.fileRefsMode = 'ok'
    }
    await expectNotStored(st, b, ['bad-pattern', 'bad-url', 'foreign', 'missing', 'api-down'])
    expect((await storedEl(st, b, 'ok')).fileId).toBe(versionId(1))
    expect((await storedEl(st, b, 'ok')).status).toBe('saved')
  })
})

describe('§3.5 fonts, coordinates and sizes', () => {
  it('fontFamily outside {5, 6, 7, 8} is INVALID (1 Virgil, 9 Liberation Sans, 10 unregistered); 5, 6, 7 (Lilita One, D3) and 8 are kept', async () => {
    const st = shared.get()
    const b = newBoardId()
    const a = await st.client({ boardId: b, user: 'alice' })
    for (const fontFamily of [1, 2, 3, 4, 9, 10])
      expectRefused(await a.createOne(text(`t${fontFamily}`, { fontFamily })), 'INVALID', a)
    for (const fontFamily of [5, 6, 7, 8])
      expectAccepted(await a.createOne(text(`ok${fontFamily}`, { fontFamily })))
    await a.create([text('t')])
    expectRefused(await a.patch('t', { g: { textStyle: { fontFamily: 9 } } }), 'INVALID', a)
    expect((await storedEl(st, b, 't')).fontFamily).toBe(5)
  })

  it('x, y, width and height beyond ±1e6 are INVALID; 1e6 itself is kept', async () => {
    const st = shared.get()
    const b = newBoardId()
    const a = await st.client({ boardId: b, user: 'alice' })
    for (const [id, o] of [
      ['far-x', { x: 2e6 }],
      ['far-y', { y: -2e6 }],
      ['wide', { width: 1.5e6 }],
      ['tall', { height: 1e7 }],
    ] as const)
      expectRefused(await a.createOne(rect(id, o)), 'INVALID', a)
    expectAccepted(await a.createOne(rect('edge', { x: 1e6 - 100 })))
    expectRefused(await a.patch('edge', { g: { pos: { x: 3e6, y: 0 } } }), 'INVALID', a)
    await expectNotStored(st, b, ['far-x', 'far-y', 'wide', 'tall'])
  })

  it('more than 1,000 arrow points, 2,500 freedraw points, 20,000 characters of text or 32 group ids: refused', async () => {
    const st = shared.get()
    const b = newBoardId()
    const a = await st.client({ boardId: b, user: 'alice' })
    const pts = (n: number) => Array.from({ length: n }, (_, i) => [i % 97, Math.floor(i / 97)])
    const long = 'x'.repeat(20_001)
    for (const el of [
      arrow('many-arrow', { points: pts(1_001), width: 96, height: 10 }),
      freedraw('many-draw', { points: pts(2_501), width: 96, height: 25 }),
      text('long-text', { text: long, originalText: long }),
      rect('many-groups', { groupIds: Array.from({ length: 33 }, (_, i) => `g${i}`) }),
    ]) {
      const r = await a.createOne(el)
      expect(r.ok, el.id).toBe(false)
      expect(['INVALID', 'TOO_LARGE'], el.id).toContain((r as { code: string }).code)
    }
    expect(a.isOpen).toBe(true)
    await expectNotStored(st, b, ['many-arrow', 'many-draw', 'long-text', 'many-groups'])
  })

  it('a value of the wrong type (a string for x, an unknown key) is INVALID in its place; the rest of the push lands', async () => {
    const st = shared.get()
    const b = newBoardId()
    const a = await st.client({ boardId: b, user: 'alice' })
    const ack = await a.push([
      { k: 'c', el: { ...rect('str-x'), x: '10' } },
      { k: 'c', el: { ...rect('extra-key'), onclick: 'alert(1)' } },
      { k: 'c', el: rect('fine') },
    ])
    expect(ack.r.map((r) => (r.ok ? 'ok' : r.code))).toEqual(['INVALID', 'INVALID', 'ok'])
    await expectNotStored(st, b, ['str-x', 'extra-key'])
  })
})

describe('§3.2 / §2.4.2 the path unit, unknown ids and message limits', () => {
  it('a path patch with a field missing is INVALID; the whole unit is accepted', async () => {
    const st = shared.get()
    const b = newBoardId()
    const a = await st.client({ boardId: b, user: 'alice' })
    await a.create([arrow('a1')])
    const unit = {
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
    for (const missing of Object.keys(unit)) {
      const partial: Record<string, unknown> = { ...unit }
      delete partial[missing]
      expectRefused(await a.patch('a1', { g: { path: partial } }), 'INVALID', a)
    }
    expectAccepted(await a.patch('a1', { g: { path: unit } }))
    expect((await storedEl(st, b, 'a1')).points).toEqual([
      [0, 0],
      [50, 50],
    ])
  })

  it('a patch for an id the board never had is GONE', async () => {
    const st = shared.get()
    const b = newBoardId()
    const a = await st.client({ boardId: b, user: 'alice' })
    expectRefused(await a.one({ k: 'p', id: 'never', pv: 1, g: { pos: { x: 1, y: 1 } } }), 'GONE', a)
  })

  it('a push of more than 500 ops is a malformed message (4099 INVALID_MESSAGE); nothing of it is stored', async () => {
    const st = shared.get()
    const b = newBoardId()
    const a = await st.client({ boardId: b, user: 'alice' })
    const ops = Array.from({ length: 501 }, (_, i) => ({ k: 'c', el: rect(`big${i}`) }))
    a.pushNow(ops)
    // the envelope (ClientEnvelope) caps ops at 500: a frame that fails it is malformed, not a per-op refusal
    expect(await a.untilClosed()).toMatchObject({ code: 4099, reason: 'INVALID_MESSAGE' })
    expect(a.of('ack')).toEqual([])
    await expectNotStored(
      st,
      b,
      ops.map((o) => o.el.id),
    )
  })
})

describe('§3.2 server-owned fields are never taken from a client', () => {
  it('updated is the server’s time; lobbyServer is the server’s; an image’s status is stored as saved', async () => {
    const st = shared.get()
    const b = newBoardId()
    st.api.addFile(fileRef(versionId(5), assetId(5)))
    const a = await st.client({ boardId: b, user: 'alice' })
    const before = Date.now()
    await a.create([rect('r1', { updated: 1 }), image('i1', versionId(5), { status: 'error' })])
    const r = await storedEl(st, b, 'r1')
    expect(r.updated).toBeGreaterThanOrEqual(before - 5_000)
    expect(r.customData?.lobbyServer?.createdBy?.uid).toBe('alice')
    expect((await storedEl(st, b, 'i1')).status).toBe('saved')
  })
})
