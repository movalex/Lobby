// The harness's guest sign-in (BrowserOptions.guest, A3) on a real spike B stack with the EXCALIDRAW
// engine (needs M1/M2: O1's room, O2's board page, O5's A3 ticket claim). A guest browser starts with no
// session at all; `openBoard` joins through the product's invite page with just a name (the board owner's
// guest link, made through the api the Share dialog calls), lands on /b/:id and gets its board ticket from
// the guest's own session. Checked: no cookie before the join; the welcome names a guest with the link's
// role (a limited, read-only guest by default; an editor through a workshop link, here a 390 px touch
// phone as B12 uses it); the owner's roster shows the guest flag; a read-only guest pushes 0 ops and an
// editor guest's note converges everywhere; a second board is joined as the same guest user.
import { expect, test } from '@playwright/test'
import { canvasOf, closeAllBrowsers, harness, waitSaved } from '../harness.ts'
import type { O3Stack } from '../stack.ts'

let stack: O3Stack

test.beforeAll(async () => {
  stack = await harness.startStack()
})
test.afterAll(async () => {
  await closeAllBrowsers()
  await stack?.stop()
})

test('guest sign-in: a limited guest by default, an editor guest on a workshop link, both through the invite page', async () => {
  const owner = harness.devUser('owner')
  const { boardId } = await stack.createBoard({ owner, title: 'guest selftest' })
  const O = await harness.launchBrowser(stack, owner, { name: 'owner' })
  await O.openBoard(boardId)

  const V = await harness.launchBrowser(stack, harness.devUser('Vic'), { name: 'guest-viewer', guest: true })
  expect(await V.context.cookies(), 'a guest browser starts with no session').toEqual([])
  await V.openBoard(boardId)
  expect(V.guestUid()).toMatch(/^usr_/)
  const vs = await canvasOf(V.page).session()
  expect(vs).toMatchObject({ welcomed: true, uid: V.guestUid(), guest: true, role: 'viewer', readonly: true })
  const vPushes = await harness.recordPushes(V.page)

  const E = await harness.launchBrowser(stack, harness.devUser('Eve'), {
    name: 'guest-editor',
    guest: true,
    guestRole: 'editor',
    touch: true,
    viewport: { width: 390, height: 844 },
  })
  await E.openBoard(boardId)
  const es = await canvasOf(E.page).session()
  expect(es).toMatchObject({
    welcomed: true,
    uid: E.guestUid(),
    guest: true,
    role: 'editor',
    readonly: false,
  })
  expect(E.guestUid()).not.toBe(V.guestUid())

  for (const g of [V, E])
    await expect
      .poll(() =>
        O.page.evaluate(
          (uid) => window.lobbyCanvas?.collaborators().find((c) => c.uid === uid)?.guest ?? null,
          g.guestUid(),
        ),
      )
      .toBe(true)

  const horizonAtStart = (await harness.readSnapshot(stack, boardId)).horizon
  const id = await canvasOf(E.page).create('note', { x: 40, y: 80, text: 'from a guest' })
  await waitSaved(E.page)
  for (const p of [O, V])
    await p.page.waitForFunction((id) => window.lobbyCanvas?.get(id)?.isDeleted === false, id, {
      timeout: 15_000,
    })
  const report = await harness.converged(stack, boardId, [O, V, E], { horizonAtStart })
  expect(report.horizonMoved).toBe(false)
  expect(report.ok).toBe(true)
  expect(harness.checkInvariants(report.snapshot).violations).toEqual([])
  expect(await vPushes.count(), 'the limited guest pushed nothing').toBe(0)

  // a second board: the same guest user joins it through its own link (the invite page's "Join and open board")
  const second = await stack.createBoard({ owner, title: 'guest selftest 2' })
  const uid = V.guestUid()
  await V.openBoard(second.boardId)
  expect(V.guestUid()).toBe(uid)
  expect(await canvasOf(V.page).session()).toMatchObject({ uid, guest: true, role: 'viewer' })
  console.log(
    'GUEST-SELFTEST',
    JSON.stringify({
      viewer: { role: vs.role, readonly: vs.readonly },
      editor: { role: es.role },
      vPushes: 0,
    }),
  )
})
