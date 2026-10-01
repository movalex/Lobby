// B6 F1–F17 (docs/EXCALIDRAW-MIGRATION.md §8.3): forged customData, references and links, refused. One
// editor browser (A, the frames go through a socket inside A's page with A's own ticket), a second
// browser (B) that holds a lease for F6, and a watcher (C) for F17's "no preview reaches the editor".
// Owner: O1. The protocol twin is apps/sync/test/element-room/security.test.ts.

import { expect, test } from '@playwright/test'
import { harness } from '../support/harness.ts'
import type { BrowserProcess, SpikeBStack } from '../support/types.ts'
import { codes, type Forged, forge, rectEl, storedElement, textEl } from './b6-forge-kit.ts'

let stack: SpikeBStack
let A: BrowserProcess
let B: BrowserProcess
let C: BrowserProcess
let boardId: string
let a: Forged

const r0 = async (p: Promise<{ r: unknown[] }>) =>
  (await p).r[0] as { ok: boolean; code?: string; fix?: Record<string, unknown>; fitDropped?: true }
const pv = async (id: string) => ((await storedElement(stack, boardId, id)) as { version: number }).version

test.beforeAll(async () => {
  stack = await harness.startStack()
  const ua = harness.devUser('b6-alice')
  const ub = harness.devUser('b6-bob')
  const uc = harness.devUser('b6-carol')
  ;({ boardId } = await stack.createBoard({
    owner: ua,
    members: [
      { user: ub, role: 'editor' },
      { user: uc, role: 'editor' },
    ],
  }))
  A = await harness.launchBrowser(stack, ua, { name: 'A' })
  B = await harness.launchBrowser(stack, ub, { name: 'B' })
  C = await harness.launchBrowser(stack, uc, { name: 'C' })
  for (const p of [A, B, C]) await p.openBoard(boardId)
  a = await forge(A.page, boardId)
  const ack = await a.push([
    { k: 'c', el: rectEl('b6-r1') },
    { k: 'c', el: { ...rectEl('b6-frame'), type: 'frame', name: null } },
    { k: 'c', el: { ...rectEl('b6-note'), type: 'stickynote', baseHeight: 100, created: null } },
    {
      k: 'c',
      el: { ...rectEl('b6-locked'), type: 'stickynote', baseHeight: 100, created: null, locked: true },
    },
  ])
  expect(ack.r.every((r) => r.ok)).toBe(true)
})
test.afterAll(async () => {
  for (const p of [A, B, C]) await p?.close()
  await stack?.stop()
})

test('F1 plusOne for another uid → INVALID', async () => {
  expect(
    await r0(a.push([{ k: 'p', id: 'b6-r1', pv: await pv('b6-r1'), c: { 'plusOne:someone-else': true } }])),
  ).toMatchObject({ ok: false, code: 'INVALID' })
})

test('F2, F3 lobbyServer.createdBy and privateNote in a create are replaced / stripped', async () => {
  const forged = rectEl('b6-f2', {
    customData: {
      lobbyServer: {
        createdBy: { uid: 'mallory', name: 'Mallory', guest: false },
        createdAt: 1,
        lastEditedBy: null,
        lastEditedAt: 1,
        privateNote: { session: 's', author: 'mallory' },
      },
    },
  })
  expect(await r0(a.push([{ k: 'c', el: forged }]))).toMatchObject({ ok: true })
  const cd = ((await storedElement(stack, boardId, 'b6-f2'))?.customData ?? {}) as {
    lobbyServer?: Record<string, unknown>
  }
  const ls = cd.lobbyServer ?? {}
  expect(ls.createdBy).toMatchObject({ uid: a.welcome.you.uid })
  expect(ls.privateNote).toBeUndefined()
})

test('F4 privateFrame added to an existing frame → INVALID', async () => {
  expect(
    await r0(
      a.push([
        {
          k: 'p',
          id: 'b6-frame',
          pv: await pv('b6-frame'),
          c: { privateFrame: { session: 's', by: a.welcome.you.uid } },
        },
      ]),
    ),
  ).toMatchObject({ ok: false, code: 'INVALID' })
})

test('F5 a second label for a container → INVALID', async () => {
  expect(await r0(a.push([{ k: 'c', el: textEl('b6-l1', { containerId: 'b6-note' }) }]))).toMatchObject({
    ok: true,
  })
  expect(await r0(a.push([{ k: 'c', el: textEl('b6-l2', { containerId: 'b6-note' }) }]))).toMatchObject({
    ok: false,
    code: 'INVALID',
  })
})

test('F6 a text pointed at a note leased by another user → LEASED; at a locked note → LOCKED', async () => {
  const bob = await forge(B.page, boardId)
  await a.push([
    { k: 'c', el: { ...rectEl('b6-leased'), type: 'stickynote', baseHeight: 100, created: null } },
  ])
  await bob.send({ type: 'lease.acquire', req: 1, id: 'b6-leased' })
  expect((await bob.socket.next('lease.grant')).id).toBe('b6-leased')
  expect(await r0(a.push([{ k: 'c', el: textEl('b6-l3', { containerId: 'b6-leased' }) }]))).toMatchObject({
    ok: false,
    code: 'LEASED',
  })
  expect(await r0(a.push([{ k: 'c', el: textEl('b6-l4', { containerId: 'b6-locked' }) }]))).toMatchObject({
    ok: false,
    code: 'LOCKED',
  })
})

test('F7 an arrow bound to a missing id → the binding is set to null (fix)', async () => {
  const arrow = {
    ...rectEl('b6-a1'),
    type: 'arrow',
    points: [
      [0, 0],
      [100, 0],
    ],
    startBinding: { elementId: 'nope', fixedPoint: [0.5, 0.5], mode: 'orbit' },
    endBinding: null,
    startArrowhead: null,
    endArrowhead: 'arrow',
    elbowed: false,
  }
  expect(await r0(a.push([{ k: 'c', el: arrow }]))).toMatchObject({ ok: true, fix: { startBinding: null } })
})

test('F8 frameId pointing at a rectangle → INVALID', async () => {
  expect(await r0(a.push([{ k: 'c', el: rectEl('b6-f8', { frameId: 'b6-r1' }) }]))).toMatchObject({
    ok: false,
    code: 'INVALID',
  })
})

test('F9 a fileId of another workspace → INVALID', async () => {
  // no asset of this board's workspace has this version id: the api answers missing or foreign
  const img = {
    ...rectEl('b6-img'),
    type: 'image',
    fileId: 'ver_0000000000forged',
    scale: [1, 1],
    crop: null,
  }
  expect(await r0(a.push([{ k: 'c', el: img }]))).toMatchObject({ ok: false, code: 'INVALID' })
  // "then with the api stopped → UNAVAILABLE" runs in the protocol suite (fake api in error mode)
})

test('F10 javascript:, data: and signed links → INVALID', async () => {
  for (const link of [
    'javascript:alert(1)',
    'data:text/html,x',
    'https://b.r2.cloudflarestorage.com/o?X-Amz-Signature=x',
  ])
    expect(
      await r0(a.push([{ k: 'p', id: 'b6-r1', pv: await pv('b6-r1'), g: { meta: { link } } }])),
    ).toMatchObject({ ok: false, code: 'INVALID' })
})

test('F11 embeddable and iframe → INVALID; a type change → TYPE_CHANGE', async () => {
  for (const type of ['embeddable', 'iframe'])
    expect(await r0(a.push([{ k: 'c', el: { ...rectEl(`b6-${type}`), type } }]))).toMatchObject({
      ok: false,
      code: 'INVALID',
    })
  expect(await r0(a.push([{ k: 'c', el: { ...rectEl('b6-r1'), type: 'ellipse' } }]))).toMatchObject({
    ok: false,
    code: 'TYPE_CHANGE',
  })
})

test('F12 a label whose index sorts before its container → re-keyed (fix)', async () => {
  const ack = await a.push([
    { k: 'c', el: { ...rectEl('b6-c12', { index: 'a5', boundElements: [{ id: 'b6-l12', type: 'text' }] }) } },
    { k: 'c', el: textEl('b6-l12', { containerId: 'b6-c12', index: 'a1' }) },
  ])
  const fix = (ack.r[1] as { fix?: { index?: string } }).fix
  expect(fix?.index && fix.index > 'a5').toBeTruthy()
})

test('F13 a +1 while a dot vote is open → VOTE_OPEN', async () => {
  const res = await fetch(`http://127.0.0.1:${stack.ports.sync}/internal/boards/${boardId}/workshop-state`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-draftroom-internal': stack.internalSecret },
    body: JSON.stringify({ voteOpen: true, anonymous: false }),
  })
  expect(res.status).toBe(204)
  expect(
    await r0(
      a.push([{ k: 'p', id: 'b6-r1', pv: await pv('b6-r1'), c: { [`plusOne:${a.welcome.you.uid}`]: true } }]),
    ),
  ).toMatchObject({ ok: false, code: 'VOTE_OPEN' })
  await fetch(`http://127.0.0.1:${stack.ports.sync}/internal/boards/${boardId}/workshop-state`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-draftroom-internal': stack.internalSecret },
    body: JSON.stringify({ voteOpen: false, anonymous: false }),
  })
})

test('F15 fontFamily 9, 10 and 1 → INVALID; F16 x = 2e6 → INVALID', async () => {
  for (const fontFamily of [9, 10, 1])
    expect(await r0(a.push([{ k: 'c', el: textEl(`b6-ff${fontFamily}`, { fontFamily }) }]))).toMatchObject({
      ok: false,
      code: 'INVALID',
    })
  expect(await r0(a.push([{ k: 'c', el: rectEl('b6-far', { x: 2e6 }) }]))).toMatchObject({
    ok: false,
    code: 'INVALID',
  })
})

test('F17 a drag with 501 ids, and a second active drag, are dropped: no preview reaches the editor', async () => {
  const watcher = await forge(C.page, boardId)
  const presence = (drag: unknown) => ({
    type: 'presence',
    pointer: { x: 1, y: 1 },
    button: 'down',
    sel: [],
    view: null,
    idle: false,
    editing: null,
    drag,
  })
  await a.send(presence({ d: 1, ids: Array.from({ length: 501 }, (_, i) => `x${i}`), dx: 5, dy: 5 }) as never)
  await a.send(presence({ d: 2, ids: ['b6-r1'], dx: 1, dy: 1 }) as never)
  await a.send(presence({ d: 3, ids: ['b6-frame'], dx: 1, dy: 1 }) as never)
  await C.page.waitForTimeout(600)
  const drags = (await watcher.socket.messages()).flatMap((m) =>
    m.type === 'presence' ? (m.drags ?? []) : [],
  )
  expect(drags.some((d) => d.d === 1)).toBe(false)
  expect(drags.some((d) => d.d === 3)).toBe(false)
  await a.send(presence(null) as never)
})

// F14 last: its first half closes A's forged socket for good
test('F14 60 INVALID ops in a minute close with 4099 INVALID_MESSAGE; 60 RATE rejects do not close', async () => {
  const flood = await forge(B.page, boardId)
  const pushes = []
  for (let p = 0; p < 12; p++)
    pushes.push(
      flood.push(Array.from({ length: 500 }, (_, i) => ({ k: 'c', el: rectEl(`b6-rate-${p}-${i}`) }))),
    )
  const acks = await Promise.all(pushes)
  expect(acks.flatMap((k) => codes(k)).filter((c) => c === 'RATE').length).toBeGreaterThanOrEqual(60)
  await flood.send({ type: 'ping', n: 2 })
  await flood.socket.next('pong')
  await a.send({
    type: 'push',
    seq: 999_999,
    base: 0,
    ops: Array.from({ length: 60 }, (_, i) => ({ k: 'c', el: { ...rectEl(`b6-bad${i}`), type: 'iframe' } })),
  } as never)
  expect(await a.socket.closed()).toMatchObject({ code: 4099, reason: 'INVALID_MESSAGE' })
})
