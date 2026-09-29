// The browser half of the negative security suite (docs/EXCALIDRAW-MIGRATION.md §6.2, §6.3 "Forged
// writes"): forged frames on a raw WebSocket opened INSIDE a signed-in page with the page's own ticket
// (fetched from the real api with the page's session cookie), through the real stack (api-signed tickets,
// the web origin's /connect proxy, the file-refs lookup against the real api). One test per rule class;
// the protocol half, one test per server rule against a bare sync process, is
// apps/sync/test/negative/*.test.ts. Nothing refused may be stored (the test snapshot), and the page's own
// session keeps working.
import type { Page } from '@playwright/test'
import { makePng } from '../spike-b/support/png.ts'
import { createItem, expect, expectSaved, item, test, waitForItem } from '../tests/support/canvas.ts'
import {
  expectServerConverged,
  forgeSession,
  forgeSocket,
  serverSnapshot,
} from '../tests/support/excalidraw.ts'
import { WEB_URL } from '../tests/support/ports.ts'

/** A copy of the page's rectangle `id` as a create under a new id, with `patch` on top. */
async function rectLike(page: Page, id: string, newId: string, patch: Record<string, unknown> = {}) {
  const el = (await item(page, id)) as Record<string, unknown> | null
  if (!el) throw new Error(`${id} is not on the page`)
  const { customData: _drop, ...rest } = el
  return { ...rest, id: newId, index: null, version: 1, versionNonce: 1, ...patch }
}

test('identity comes from the ticket: forged lobbyServer and identity fields are refused or replaced', async ({
  canvasSession,
  stack,
  board,
}) => {
  const a = await canvasSession('alice')
  await createItem(a.page, 'rectangle', { id: 'model', x: 0, y: 0, width: 100, height: 100 })
  await expectSaved(a.page)
  const { socket, welcome } = await forgeSession(a.page, board)
  try {
    expect(welcome.you.uid).toBe(a.id)
    const forged = await rectLike(a.page, 'model', 'forged-author', {
      x: 200,
      customData: {
        lobbyServer: {
          createdBy: { uid: 'usr_mallory', name: 'Mallory', guest: false },
          createdAt: 1,
          lastEditedBy: null,
          lastEditedAt: 1,
          privateNote: { session: 's', author: 'usr_mallory' },
        },
      },
    })
    await socket.send({ type: 'push', seq: 1, base: welcome.clock, ops: [{ k: 'c', el: forged as never }] })
    expect((await socket.next('ack')).r[0]).toMatchObject({ ok: true })
    const stored = (await serverSnapshot(stack, board)).elements.find((e) => e.id === 'forged-author')
    expect(stored?.customData?.lobbyServer?.createdBy).toEqual({ uid: a.id, name: a.name, guest: false })
    expect(stored?.customData?.lobbyServer?.privateNote).toBeUndefined()
    // identity fields in a presence frame close that socket (4099 INVALID_MESSAGE)
    // a raw string: the frozen ClientMessage type has no identity fields (that is the point)
    await socket.send(
      JSON.stringify({
        type: 'presence',
        pointer: { x: 1, y: 1 },
        button: 'up',
        sel: [],
        view: null,
        idle: false,
        editing: null,
        uid: 'usr_mallory',
      }),
    )
    expect(await socket.closed()).toMatchObject({ code: 4099, reason: 'INVALID_MESSAGE' })
  } finally {
    await socket.close()
  }
  // the page's own session is untouched
  await createItem(a.page, 'rectangle', { id: 'after', x: 400, y: 0, width: 50, height: 50 })
  await expectSaved(a.page)
})

test('customData classes: a +1 for someone else, a privateFrame added later, an unknown key: INVALID; nothing stored', async ({
  canvasSession,
  stack,
  board,
}) => {
  const a = await canvasSession('alice')
  const b = await canvasSession('bob')
  await createItem(a.page, 'note', { id: 'voted', x: 0, y: 0 })
  await createItem(a.page, 'frame', { id: 'fr', x: 400, y: 0, width: 300, height: 200 })
  await waitForItem(b.page, 'fr')
  await expectSaved(a.page)
  const { socket, welcome } = await forgeSession(b.page, board)
  try {
    const snap = await serverSnapshot(stack, board)
    const v = (id: string) => snap.elements.find((e) => e.id === id)?.version as number
    await socket.send({
      type: 'push',
      seq: 1,
      base: welcome.clock,
      ops: [
        { k: 'p', id: 'voted', pv: v('voted'), c: { [`plusOne:${a.id}`]: true } },
        { k: 'p', id: 'fr', pv: v('fr'), c: { privateFrame: { session: 's1', by: b.id } } },
        { k: 'p', id: 'voted', pv: v('voted'), c: { secret: 'x' } },
        { k: 'p', id: 'voted', pv: v('voted'), c: { [`plusOne:${b.id}`]: true } },
      ],
    })
    const ack = await socket.next('ack')
    expect(ack.r.map((r) => (r.ok ? 'ok' : r.code))).toEqual(['INVALID', 'INVALID', 'INVALID', 'ok'])
  } finally {
    await socket.close()
  }
  const after = await serverSnapshot(stack, board)
  expect(after.elements.find((e) => e.id === 'voted')?.customData?.lobby).toEqual({
    [`plusOne:${b.id}`]: true,
  })
  expect(after.elements.find((e) => e.id === 'fr')?.customData?.lobby ?? {}).toEqual({})
  await expectServerConverged(stack, board, [a.page, b.page])
})

test('links and file ids: javascript: links, base64 and URL file ids, and another workspace’s upload are INVALID', async ({
  canvasSession,
  users,
  stack,
  board,
}) => {
  const a = await canvasSession('alice')
  await createItem(a.page, 'rectangle', { id: 'model', x: 0, y: 0, width: 100, height: 100 })
  await expectSaved(a.page)
  // real uploads: one to this board (its workspace's version: the positive control), one to a board of
  // alice's PERSONAL workspace (another workspace's version)
  const aliceUser = await users.get('alice')
  const alice = await users.api('alice')
  const upload = async (bid: string, name: string, n: number) => {
    const up = await alice.request.post(`${WEB_URL}/api/boards/${bid}/assets`, {
      headers: { origin: WEB_URL, 'content-type': 'image/png', 'x-file-name': name },
      data: makePng(64, 48, n),
    })
    expect(up.status(), await up.text()).toBeLessThan(300)
    return ((await up.json()) as { versionId: string }).versionId
  }
  const elsewhere = (await alice.createBoard(aliceUser.personalWorkspaceId, 'Elsewhere')).id
  const ownVersion = await upload(board, 'here.png', 6)
  const foreignVersion = await upload(elsewhere, 'elsewhere.png', 7)

  const { socket, welcome } = await forgeSession(a.page, board)
  try {
    const img = (id: string, fileId: string) => ({
      ...{ type: 'image', status: 'saved', scale: [1, 1], crop: null },
      ...{ id, fileId },
    })
    const base = await rectLike(a.page, 'model', 'x')
    const imageOf = (id: string, fileId: string) =>
      ({ ...base, ...img(id, fileId), roundness: null }) as never
    const v = (await serverSnapshot(stack, board)).elements.find((e) => e.id === 'model')?.version as number
    await socket.send({
      type: 'push',
      seq: 1,
      base: welcome.clock,
      ops: [
        { k: 'p', id: 'model', pv: v, g: { meta: { link: 'javascript:alert(document.cookie)' } } },
        { k: 'c', el: imageOf('img-base64', 'data:image/png;base64,iVBORw0KGgo=') },
        { k: 'c', el: imageOf('img-url', `/files/x/${foreignVersion}/original`) },
        { k: 'c', el: imageOf('img-foreign', foreignVersion) },
        // the positive controls: the same element shapes with a valid value are accepted
        { k: 'c', el: imageOf('ok-image', ownVersion) },
      ],
    })
    const ack = await socket.next('ack', 15_000)
    expect(ack.r.map((r) => (r.ok ? 'ok' : r.code))).toEqual([
      'INVALID',
      'INVALID',
      'INVALID',
      'INVALID',
      'ok',
    ])
    await socket.send({
      type: 'push',
      seq: 2,
      base: ack.clock,
      ops: [{ k: 'p', id: 'model', pv: v, g: { meta: { link: 'https://example.com/brief' } } }],
    })
    expect((await socket.next('ack')).r[0]).toMatchObject({ ok: true })
  } finally {
    await socket.close()
  }
  const snap = await serverSnapshot(stack, board)
  expect(snap.elements.map((e) => e.id).filter((id) => id.startsWith('img-'))).toEqual([])
  expect((snap.elements.find((e) => e.id === 'ok-image') as { fileId?: string } | undefined)?.fileId).toBe(
    ownVersion,
  )
  expect(snap.elements.find((e) => e.id === 'model')?.link).toBe('https://example.com/brief')
  // no durable element holds bytes or a URL of a file
  expect(JSON.stringify(snap.elements)).not.toMatch(/data:|blob:|X-Amz-Signature/)
})

test('an old tldraw tab is told CLIENT_TOO_OLD; a ticket for another board is FORBIDDEN', async ({
  canvasSession,
  users,
  board,
}) => {
  const a = await canvasSession('alice')
  const s1 = await forgeSocket(a.page, board)
  // what a tldraw 5.4.2 tab sends first (a raw string: not a message of this protocol)
  await s1.send(
    JSON.stringify({
      type: 'connect',
      protocolVersion: 7,
      connectRequestId: 'x',
      schema: {},
      lastServerClock: 0,
    }),
  )
  expect(await s1.closed()).toMatchObject({ code: 4099, reason: 'CLIENT_TOO_OLD' })

  // a correctly signed ticket, for another board, presented on this one
  const other = await users.createBoard('Other board')
  const ticket = await a.page.evaluate(async (bid) => {
    const res = await fetch(`/api/boards/${encodeURIComponent(bid)}/ticket`, {
      method: 'POST',
      credentials: 'same-origin',
    })
    return ((await res.json()) as { ticket: string }).ticket
  }, other)
  const closed = await a.page.evaluate(
    async ({ board, ticket }) => {
      const url = `${location.origin.replace(/^http/, 'ws')}/connect/${encodeURIComponent(board)}?${new URLSearchParams({ sessionId: 'forge-wrong-board', ticket })}`
      const ws = new WebSocket(url)
      return new Promise<{ code: number; reason: string }>((resolve) => {
        ws.onclose = (e) => resolve({ code: e.code, reason: e.reason })
      })
    },
    { board, ticket },
  )
  expect(closed).toEqual({ code: 4099, reason: 'FORBIDDEN' })
})
