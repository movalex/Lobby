// Port of the CANVAS parts of e2e/tests/permissions.spec.ts to the Excalidraw engine (the tldraw version,
// with the Share dialog, the invitation page and the api refusals, stays in e2e/tests on the default
// build). Board permissions are enforced by the SERVER: the page's read-only mode is only a courtesy, so
// every "cannot" is also attempted with forged frames on a raw socket that carries the reader's own ticket
// (§6.3), and checked where it matters: the owner's tab, the stored board, and a fresh session.
// Roles are changed through the api here (the Share dialog is ported by its own owner in wave 3).
import type { Browser, Page } from '@playwright/test'
import { type Api, signInContext } from '../tests/support/api.ts'
import {
  type CanvasSession,
  canvasCall,
  createItem,
  createNote,
  expect,
  expectSaved,
  item,
  openCanvasSession,
  readOnly,
  test,
  updateItem,
  waitForItem,
} from '../tests/support/canvas.ts'
import {
  expectServerConverged,
  factsOf,
  forgeSession,
  noAccessScreen,
  pushCount,
  serverSnapshot,
} from '../tests/support/excalidraw.ts'
import type { Stack } from '../tests/support/stack.ts'
import type { TestUser } from '../tests/support/users.ts'

const BOX = 'owner-box'
const FORGED = 'forged-by-reader'

/** The facts a forged write tries to change: the note's colour, the box, an extra element. */
async function ownerFacts(page: Page, note: string) {
  const [n, box, forged] = await Promise.all([
    factsOf(page, note, ['backgroundColor']),
    item(page, BOX),
    item(page, FORGED),
  ])
  return {
    note: (n?.backgroundColor as string | undefined) ?? null,
    box: box !== null && !box.isDeleted,
    forged: forged !== null,
  }
}
const UNTOUCHED = { note: '#ffec99', box: true, forged: false }

async function drawOwnerElements(page: Page): Promise<string> {
  const note = await createNote(page, {
    x: 120,
    y: 120,
    text: 'Only editors can change this',
    color: '#ffec99',
  })
  await createItem(page, 'rectangle', {
    id: BOX,
    x: 420,
    y: 140,
    width: 220,
    height: 140,
    strokeColor: '#1971c2',
  })
  await expectSaved(page)
  return note
}

/**
 * What a client that ignores its read-only mode does: forged frames on a raw socket with the reader's own
 * ticket (create, update, delete). Every op must be refused READ_ONLY; nothing reaches the owner's tab,
 * the stored board or a fresh session; and an owner edit made afterwards still reaches the reader (the
 * room processed the forged pushes and kept the reader's session).
 */
async function expectForgedWritesRefused(
  browser: Browser,
  stack: Stack,
  board: string,
  owner: CanvasSession,
  ownerUser: TestUser,
  reader: CanvasSession,
  note: string,
  sentinel: string,
) {
  const { socket, welcome } = await forgeSession(reader.page, board)
  try {
    expect(welcome.readonly).toBe(true)
    const stored = await serverSnapshot(stack, board)
    const v = (id: string) => (stored.elements.find((e) => e.id === id)?.version ?? 1) as number
    const forgedEl = {
      ...((await item(owner.page, BOX)) as Record<string, unknown>),
      id: FORGED,
      x: 700,
      y: 420,
    }
    await socket.send({
      type: 'push',
      seq: 1,
      base: welcome.clock,
      ops: [
        { k: 'c', el: forgedEl as never },
        { k: 'p', id: note, pv: v(note), g: { style: { backgroundColor: '#ff0000' } } },
        { k: 'p', id: BOX, pv: v(BOX), g: { life: { isDeleted: true } } },
      ],
    })
    const ack = await socket.next('ack')
    expect(ack.r.map((r) => (r.ok ? 'ok' : r.code))).toEqual(['READ_ONLY', 'READ_ONLY', 'READ_ONLY'])
  } finally {
    await socket.close()
  }
  await createItem(owner.page, 'rectangle', { id: sentinel, x: 120, y: 420, width: 80, height: 80 })
  await waitForItem(reader.page, sentinel)
  expect(await ownerFacts(owner.page, note)).toEqual(UNTOUCHED)
  expect(await ownerFacts(reader.page, note)).toEqual(UNTOUCHED)
  const after = await serverSnapshot(stack, board)
  expect(after.elements.some((e) => e.id === FORGED)).toBe(false)
  const fresh = await openCanvasSession(browser, board, ownerUser)
  try {
    await waitForItem(fresh.page, sentinel)
    expect(await ownerFacts(fresh.page, note)).toEqual(UNTOUCHED)
  } finally {
    await fresh.context.close()
  }
}

test('shared as viewer: read-only and forged writes never land; upgraded to editor: can edit; removed: no access within 15 s', async ({
  browser,
  board,
  users,
  canvasSession,
  stack,
}, testInfo) => {
  const aliceUser = await users.get('alice')
  const bob = await users.get('bob') // a Dev Studio member, with no access to this private board yet
  const alice: Api = await users.api('alice')
  const a = await canvasSession('alice')
  const note = await drawOwnerElements(a.page)

  await alice.putMember(board, bob.id, 'viewer')
  const b = await canvasSession('bob', { role: null })

  await test.step('bob gets a read-only board', async () => {
    expect(await canvasCall(b.page, 'me')).toMatchObject({ uid: bob.id, role: 'viewer' })
    expect(await readOnly(b.page)).toBe(true)
    await expect.poll(() => ownerFacts(b.page, note)).toEqual(UNTOUCHED)
    // the page's own guard: the facade refuses to write for a read-only tab (the server would anyway)
    await expect(createItem(b.page, 'rectangle', { id: 'viewer-facade-write' })).rejects.toThrow(/read-only/)
    expect(await pushCount(b.page)).toBe(0)
  })

  await test.step('a forged canvas write from bob’s own ticket never reaches alice or the server', async () => {
    await expectForgedWritesRefused(browser, stack, board, a, aliceUser, b, note, 'after-viewer-forgery')
  })

  await test.step('alice upgrades bob to editor: he reconnects with an editor ticket and can edit', async () => {
    await alice.putMember(board, bob.id, 'editor')
    await expect.poll(() => readOnly(b.page), { timeout: 20_000 }).toBe(false)
    await expect.poll(async () => (await canvasCall(b.page, 'me'))?.role, { timeout: 20_000 }).toBe('editor')
    await createItem(b.page, 'note', { id: 'by-bob-the-editor', x: 700, y: 120 })
    await waitForItem(a.page, 'by-bob-the-editor')
    await updateItem(b.page, note, { backgroundColor: '#d0bfff' })
    await expect.poll(() => ownerFacts(a.page, note)).toEqual({ ...UNTOUCHED, note: '#d0bfff' })
    await expectSaved(b.page)
  })

  await test.step('alice removes bob: his open board shows "no access" within 15 s', async () => {
    const started = Date.now()
    const res = await alice.fetch('DELETE', `/api/boards/${board}/members/${bob.id}`)
    expect(res.status()).toBeLessThan(300)
    await expect(noAccessScreen(b.page)).toBeVisible({ timeout: 15_000 })
    const ms = Date.now() - started
    testInfo.annotations.push({ type: 'revocation latency', description: `${ms} ms (target < 15000 ms)` })
    expect(ms).toBeLessThan(15_000)
    await expect(noAccessScreen(b.page)).toContainText('no longer have access')
  })

  await test.step('bob has no way back in; alice keeps working', async () => {
    await b.page.reload()
    await expect(b.page.getByText(/^You don't have access to this board\.?$/)).toBeVisible()
    expect(await b.page.evaluate(() => window.lobbyCanvas === undefined)).toBe(true)
    expect(await ownerFacts(a.page, note)).toEqual({ ...UNTOUCHED, note: '#d0bfff' })
    await expectServerConverged(stack, board, [a.page])
  })
})

test('a user from another workspace opening the board link gets "no access", and no canvas', async ({
  browser,
  users,
}) => {
  const aliceUser = await users.get('alice')
  const alice = await users.api('alice')
  const privateBoard = (await alice.createBoard(aliceUser.personalWorkspaceId, 'Alice’s private plans')).id
  const erin = await users.get('erin')
  const context = await browser.newContext()
  try {
    await signInContext(context, erin.handle, erin.name)
    const page = await context.newPage()
    await page.goto(`/b/${privateBoard}`)
    await expect(page.getByText(/^You don't have access to this board\.?$/)).toBeVisible()
    expect(await page.evaluate(() => window.lobbyCanvas === undefined)).toBe(true)
  } finally {
    await context.close()
  }
})

test('a commenter: read-only on the canvas, no lease, and forged writes never land', async ({
  browser,
  board,
  users,
  canvasSession,
  stack,
}) => {
  const aliceUser = await users.get('alice')
  const a = await canvasSession('alice')
  const note = await drawOwnerElements(a.page)
  const c = await canvasSession('carol', { role: 'commenter' })
  expect(await canvasCall(c.page, 'me')).toMatchObject({ role: 'commenter' })
  expect(await readOnly(c.page)).toBe(true)
  await expect.poll(() => ownerFacts(c.page, note)).toEqual(UNTOUCHED)
  // no text lease for a commenter: the forge socket's acquire is denied
  const { socket } = await forgeSession(c.page, board)
  try {
    await socket.send({ type: 'lease.acquire', req: 1, id: note })
    expect((await socket.next('lease.deny')).id).toBe(note)
  } finally {
    await socket.close()
  }
  await expectForgedWritesRefused(browser, stack, board, a, aliceUser, c, note, 'after-commenter-forgery')
  expect(await pushCount(c.page)).toBe(0)
})
