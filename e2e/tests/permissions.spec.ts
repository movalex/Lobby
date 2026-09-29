// Milestone 1: board permissions, shared and changed through the real UI and enforced by the SERVERS.
// The web app's read-only editor is only a courtesy, so every "cannot" below is also attempted by a
// client that ignores it (window.editor with its read-only flag switched off, raw API requests) and
// then checked where it matters: the other user's tab and a fresh context loading from the server.
import type { Browser, Page } from '@playwright/test'
import { displayName, type Me } from './support/api.ts'
import {
  edit,
  expectConn,
  getShape,
  openSession,
  read,
  type Session,
  signInThroughUi,
  waitForBoard,
} from './support/board.ts'
import { openMoreWaysToShare } from './support/dashboard-share.ts'
import { richText } from './support/editor.ts'
import { expect, test } from './support/fixtures.ts'
import { WEB_URL } from './support/ports.ts'
import { capture } from './support/screenshots.ts'
import type { TestUser } from './support/users.ts'

const NOTE = 'shape:owner-note'
const BOX = 'shape:owner-box'
const FORGED = 'shape:forged-by-reader'
const ORIGIN = { origin: WEB_URL }

const memberRow = (page: Page, userId: string) =>
  page.locator(`[data-testid="member-row"][data-user-id="${userId}"]`)

async function drawOwnerShapes(page: Page) {
  await edit(
    page,
    (ed, ids) =>
      ed.createShapes([
        { id: ids.note, type: 'note', x: 120, y: 120, props: { color: 'yellow', richText: ids.text } },
        { id: ids.box, type: 'geo', x: 420, y: 140, props: { w: 220, h: 140, color: 'blue' } },
      ]),
    { note: NOTE, box: BOX, text: richText('Only editors can change this') },
  )
}

/** The facts a forged write tries to change: the note's color, the box, an extra shape. */
async function ownerFacts(page: Page) {
  const [note, box, forged] = await Promise.all([
    getShape(page, NOTE),
    getShape(page, BOX),
    getShape(page, FORGED),
  ])
  return { note: note?.props.color ?? null, box: box !== null, forged: forged !== null }
}
const UNTOUCHED = { note: 'yellow', box: true, forged: false }

/**
 * What a client that ignores its read-only flag does: switch the editor's UI guard off and write
 * (create, update, delete). Returns the reader's own copy right after, before the server answers.
 */
function forgeWrites(reader: Session) {
  return read(
    reader.page,
    (ed, ids) => {
      ed.updateInstanceState({ isReadonly: false })
      ed.createShape({ id: ids.forged, type: 'geo', x: 700, y: 420, props: { w: 120, h: 120, color: 'red' } })
      ed.updateShape({ id: ids.note, type: 'note', props: { color: 'red' } })
      ed.deleteShapes([ids.box])
      return {
        note: ed.getShape(ids.note)?.props.color ?? null,
        box: ed.getShape(ids.box) !== undefined,
        forged: ed.getShape(ids.forged) !== undefined,
      }
    },
    { forged: FORGED, note: NOTE, box: BOX },
  )
}

/**
 * The forged writes were sent and refused: the reader's copy is rolled back; an edit the owner makes
 * AFTERWARDS reaches the reader (so the room has processed the reader's pushes), and neither the
 * owner's tab nor a fresh context that loads the board from the server ever holds them.
 */
async function expectForgedWritesRefused(
  browser: Browser,
  board: string,
  owner: Session,
  ownerUser: TestUser,
  reader: Session,
  sentinel: string,
) {
  expect(await forgeWrites(reader)).toEqual({ note: 'red', box: false, forged: true })
  await expect.poll(() => ownerFacts(reader.page), { message: 'reader rolled back' }).toEqual(UNTOUCHED)
  await edit(
    owner.page,
    (ed, id) => ed.createShape({ id, type: 'geo', x: 120, y: 420, props: { w: 80, h: 80 } }),
    sentinel,
  )
  await expect.poll(() => getShape(reader.page, sentinel).then((s) => s !== null)).toBe(true)
  expect(await ownerFacts(owner.page)).toEqual(UNTOUCHED)
  expect(await ownerFacts(reader.page)).toEqual(UNTOUCHED)
  const fresh = await openSession(browser, board, ownerUser)
  try {
    await expect.poll(() => getShape(fresh.page, sentinel).then((s) => s !== null)).toBe(true)
    expect(await ownerFacts(fresh.page)).toEqual(UNTOUCHED)
  } finally {
    await fresh.context.close()
  }
  // Put the UI guard back, so it is the server's word (not this test) that changes it later.
  await edit(reader.page, (ed) => ed.updateInstanceState({ isReadonly: true }))
}

test('shared as viewer: read-only and forged writes never land; upgraded to editor: can edit; removed: no access within 15 s', async ({
  browser,
  board,
  users,
  session,
}, testInfo) => {
  const aliceUser = await users.get('alice')
  const bob = await users.get('bob') // a Dev Studio member, with no access to this private board yet
  const a = await session('alice')
  await drawOwnerShapes(a.page)

  await test.step('alice shares the board with bob as a viewer, from the Share dialog', async () => {
    await a.page.getByTestId('share-button').click()
    const dialog = a.page.getByTestId('share-dialog')
    await expect(dialog.getByTestId('share-workspace-name')).toHaveText('Dev Studio')
    await expect(memberRow(a.page, aliceUser.id)).toHaveAttribute('data-role', 'owner')
    await dialog.getByTestId('share-add-member').selectOption(bob.id)
    await dialog.getByTestId('share-add-role').selectOption('viewer')
    await dialog.getByTestId('share-add-submit').click()
    await expect(memberRow(a.page, bob.id)).toHaveAttribute('data-role', 'viewer')
    await capture('share-dialog.png', a.page, testInfo)
    await a.page.keyboard.press('Escape')
    await expect(dialog).toHaveCount(0)
  })

  const b = await session('bob', { role: null })

  await test.step('bob gets a read-only board', async () => {
    const pill = b.page.getByTestId('readonly-pill')
    await expect(pill).toHaveAttribute('data-role', 'viewer')
    await expect(pill).toHaveText('View only')
    expect(await read(b.page, (ed) => ed.getIsReadonly())).toBe(true)
    // No rename control, just the title.
    await expect(b.page.getByTestId('board-title')).toHaveJSProperty('tagName', 'H1')
    await expect.poll(() => ownerFacts(b.page)).toEqual(UNTOUCHED)
    await expect(b.page.locator(`[data-testid="presence-user"][data-user-id="${a.id}"]`)).toBeVisible()
    await edit(b.page, (ed) => ed.zoomToFit())
    await capture('readonly-board.png', b.page, testInfo)
  })

  await test.step('the API refuses bob’s writes (rename, upload); his ticket says viewer', async () => {
    const rename = await b.page.request.patch(`/api/boards/${board}`, {
      headers: ORIGIN,
      data: { title: 'Taken over by bob' },
    })
    expect(rename.status()).toBe(403)
    const upload = await b.page.request.post(`/api/boards/${board}/assets`, {
      headers: { ...ORIGIN, 'content-type': 'image/png', 'x-file-name': 'forged.png' },
      data: Buffer.from('not really an image'),
    })
    expect(upload.status()).toBe(403)
    const ticket = await b.page.request.post(`/api/boards/${board}/ticket`, { headers: ORIGIN })
    expect(ticket.status()).toBe(200)
    expect(await ticket.json()).toMatchObject({ role: 'viewer', user: { id: bob.id } })
    expect((await (await a.page.request.get(`/api/boards/${board}`)).json()).board.title).not.toBe(
      'Taken over by bob',
    )
  })

  await test.step('a forged canvas write from bob’s window.editor never reaches alice or the server', async () => {
    await expectForgedWritesRefused(browser, board, a, aliceUser, b, 'shape:after-viewer-forgery')
  })

  await test.step('alice upgrades bob to editor: he reconnects with an editor ticket and can edit', async () => {
    await a.page.getByTestId('share-button').click()
    await memberRow(a.page, bob.id).getByTestId('member-role').selectOption('editor')
    await expect(memberRow(a.page, bob.id)).toHaveAttribute('data-role', 'editor')
    await expect(b.page.getByTestId('readonly-pill')).toHaveCount(0, { timeout: 20_000 })
    await expect.poll(() => read(b.page, (ed) => ed.getIsReadonly()), { timeout: 20_000 }).toBe(false)
    await expectConn(b.page, 'online')
    await edit(
      b.page,
      (ed, id) => ed.createShape({ id, type: 'note', x: 700, y: 120, props: { color: 'green' } }),
      'shape:by-bob-the-editor',
    )
    await expect
      .poll(() => getShape(a.page, 'shape:by-bob-the-editor').then((s) => s?.type ?? null))
      .toBe('note')
    await edit(b.page, (ed, id) => ed.updateShape({ id, type: 'note', props: { color: 'violet' } }), NOTE)
    await expect.poll(() => ownerFacts(a.page)).toEqual({ ...UNTOUCHED, note: 'violet' })
  })

  await test.step('alice removes bob: his open board shows "no access" within 15 s', async () => {
    // PRI-21: removing asks first ("Remove Bob? Bob loses access now.").
    await memberRow(a.page, bob.id).getByTestId('member-remove').click()
    await expect(memberRow(a.page, bob.id).getByTestId('member-remove-question')).toHaveText(
      `Remove ${bob.name}? ${bob.name} loses access now.`,
    )
    const started = Date.now()
    await memberRow(a.page, bob.id).getByTestId('member-remove-confirm').click()
    await expect(b.page.getByTestId('no-access')).toBeVisible({ timeout: 15_000 })
    const ms = Date.now() - started
    testInfo.annotations.push({ type: 'revocation latency', description: `${ms} ms (target < 15000 ms)` })
    console.log(`[permissions] bob saw the no-access screen ${ms} ms after alice clicked remove`)
    expect(ms).toBeLessThan(15_000)
    await expect(b.page.getByTestId('no-access')).toContainText('You no longer have access to this board')
    await expect(memberRow(a.page, bob.id)).toHaveCount(0)
    await capture('no-access.png', b.page, testInfo)
  })

  await test.step('bob has no way back in; alice keeps working', async () => {
    expect((await b.page.request.get(`/api/boards/${board}`)).status()).toBe(404)
    expect((await b.page.request.post(`/api/boards/${board}/ticket`, { headers: ORIGIN })).status()).toBe(404)
    await b.page.reload()
    await expect(b.page.getByTestId('no-access')).toContainText("You don't have access to this board")
    await expectConn(a.page, 'online')
    expect(await ownerFacts(a.page)).toEqual({ ...UNTOUCHED, note: 'violet' })
  })
})

test('a user from another workspace opening the board link gets "no access", and the API reveals nothing', async ({
  browser,
  board,
  users,
}) => {
  const aliceUser = await users.get('alice')
  const alice = await users.api('alice')
  // A board in alice's personal workspace: erin has never been a member of it.
  const privateBoard = (await alice.createBoard(aliceUser.personalWorkspaceId, 'Alice’s private plans')).id
  const context = await browser.newContext()
  try {
    const page = await context.newPage()
    await page.goto(`/b/${privateBoard}`)
    await expect(page).toHaveURL(/\/signin\?returnTo=/)
    await signInThroughUi(page, { handle: 'erin', name: displayName('erin') })
    await expect(page).toHaveURL(new RegExp(`/b/${privateBoard}$`))
    await expect(page.getByTestId('no-access')).toContainText("You don't have access to this board")
    expect(await page.evaluate(() => window.editor === undefined)).toBe(true)

    const me = (await (await page.request.get('/api/me')).json()) as Me
    expect(me.user.name).toBe(displayName('erin'))
    expect(me.workspaces.map((w) => w.id)).not.toContain(aliceUser.personalWorkspaceId)

    // Byte-for-byte the answers for a board id that does not exist: nothing leaks that it does.
    const missing = 'b-0000000000'
    for (const [method, path] of [
      ['GET', '/api/boards/:bid'],
      ['GET', '/api/boards/:bid/members'],
      ['POST', '/api/boards/:bid/ticket'],
    ] as const) {
      const call = (bid: string) =>
        page.request.fetch(path.replace(':bid', bid), { method, headers: method === 'POST' ? ORIGIN : {} })
      const [real, fake] = await Promise.all([call(privateBoard), call(missing)])
      expect(real.status(), `${method} ${path}`).toBe(404)
      expect(fake.status()).toBe(404)
      expect(await real.text()).toBe(await fake.text())
    }
    expect((await page.request.get(`/api/workspaces/${aliceUser.personalWorkspaceId}/boards`)).status()).toBe(
      404,
    )

    // In a workspace erin DOES belong to (Dev Studio), a board is still private until it is shared.
    await page.goto(`/b/${board}`)
    await expect(page.getByTestId('no-access')).toContainText("You don't have access to this board")
    expect((await page.request.post(`/api/boards/${board}/ticket`, { headers: ORIGIN })).status()).toBe(404)
  } finally {
    await context.close()
  }
})

test('invitation link: alice invites as commenter; carol signs in, accepts, and can view but not edit', async ({
  browser,
  users,
  stack,
}) => {
  const aliceUser = await users.get('alice')
  const alice = await users.api('alice')
  const board = (await alice.createBoard(aliceUser.personalWorkspaceId, 'Design review')).id
  const a = await openSession(browser, board, aliceUser)
  const contexts = [a.context]
  try {
    await drawOwnerShapes(a.page)

    await a.page.getByTestId('share-button').click()
    const dialog = a.page.getByTestId('share-dialog')
    await expect(dialog.getByTestId('share-workspace-name')).toHaveText(`${aliceUser.name}'s workspace`)
    await openMoreWaysToShare(a.page) // DANA-03: one-time invite links are under "More ways to share"
    // Domain access: a one-time link is for one address; carol signs in without an email, so her
    // verified address is carol@dev.invalid.
    await dialog.getByTestId('one-person-link-email').fill('carol@dev.invalid')
    await dialog.getByTestId('invite-role').selectOption('commenter')
    await dialog.getByTestId('invite-create').click()
    await expect(dialog.getByTestId('invite-link')).toHaveValue(/\/invite\//)
    const link = await dialog.getByTestId('invite-link').inputValue()
    expect(link).toMatch(new RegExp(`^${WEB_URL}/invite/[A-Za-z0-9_-]{43}$`))
    const token = link.slice(link.lastIndexOf('/') + 1)

    // carol has never signed in on this browser; the link works for her after signing in.
    const context = await browser.newContext()
    contexts.push(context)
    const page = await context.newPage()
    await page.goto(link)
    await expect(page.getByTestId('invite-page')).toBeVisible()
    await expect(page.getByTestId('invite-title')).toContainText('Design review')
    await expect(page.getByTestId('invite-inviter')).toHaveText(aliceUser.name)
    await expect(page.getByTestId('invite-role-label')).toHaveText('Can comment')
    await page.getByTestId('invite-signin').click()
    // PRI-16: back from signing in, the invitation is accepted without a second click.
    await expect(page.getByTestId('signin-heading')).toHaveText(
      `Sign in with c•••@dev.invalid to join “Design review” (invited by ${aliceUser.name})`,
    )
    await signInThroughUi(page, { handle: 'carol', name: displayName('carol') })
    await expect(page).toHaveURL(new RegExp(`/b/${board}$`))
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/)
    await waitForBoard(page)
    const carol = await users.get('carol')
    const c: Session = { user: 'carol', name: carol.name, id: carol.id, context, page }
    await expect(page.getByTestId('dev-identity-badge')).toHaveAttribute('data-user-id', carol.id)

    await expect(page.getByTestId('readonly-pill')).toHaveAttribute('data-role', 'commenter')
    await expect(page.getByTestId('readonly-pill')).toHaveText('Can comment')
    expect(await read(page, (ed) => ed.getIsReadonly())).toBe(true)
    await expect.poll(() => ownerFacts(page)).toEqual(UNTOUCHED) // she can view
    await expectForgedWritesRefused(browser, board, a, aliceUser, c, 'shape:after-commenter-forgery')
    const rename = await page.request.patch(`/api/boards/${board}`, { headers: ORIGIN, data: { title: 'x' } })
    expect(rename.status()).toBe(403)

    // The invitation made carol a guest of alice's workspace with a commenter grant on this board.
    const me = (await (await page.request.get('/api/me')).json()) as Me
    expect(me.workspaces).toContainEqual(
      expect.objectContaining({ id: aliceUser.personalWorkspaceId, role: 'guest' }),
    )
    await a.page.keyboard.press('Escape')
    await a.page.getByTestId('share-button').click()
    await expect(memberRow(a.page, carol.id)).toHaveAttribute('data-role', 'commenter')

    // A link is single-use: someone else cannot redeem it after carol.
    const bob = await users.api('bob')
    expect((await bob.fetch('POST', `/api/invitations/${token}/accept`)).status()).toBe(410)

    // Neither the invitation token nor any board ticket ever reaches a server log.
    expect(stack.api.logs()).not.toContain(token)
    const ticketLike = /v1\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}/
    expect(stack.api.logs()).not.toMatch(ticketLike)
    expect(stack.sync.logs()).not.toMatch(ticketLike)
  } finally {
    await Promise.all(contexts.map((x) => x.close()))
  }
})
