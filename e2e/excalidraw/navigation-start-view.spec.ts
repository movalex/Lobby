// 3b navigation on the Excalidraw board page: the first view (PRE-06: the last camera per board and user,
// a camera showing nothing falls back to fit, a first visit fits at ≤ 100%) and the board's start view
// (PRE-08, lb_doc.startView), ported from canvas-ux.spec.ts "start view" and canvas-ux-2.spec.ts "PRE-08".
// The board menu and the context menu are 3a's shells: their entries run here through the page's registry
// (window.__lobbyNavigation). On the new canvas only owners may set the start view (canvas-schema doc.ts:
// `startView` is an owner key); the tldraw board let editors set it too.
//
//   E2E_PORT_BASE=<base> pnpm --filter @draftroom/e2e excalidraw -- navigation-start-view
import { createItem, createNote, expect, expectSaved, select, test } from '../tests/support/canvas.ts'
import { forgeSession } from '../tests/support/excalidraw.ts'
import {
  boundsOf,
  contains,
  docValue,
  inView,
  navEntries,
  navMenu,
  nearView,
  openPath,
  seed,
  setView,
  startView,
  storedView,
  viewport,
  waitForNavigation,
  zoom,
} from './navigation-kit.ts'

test.use({ viewport: { width: 1440, height: 900 } })

/**
 * The room caches its reset snapshot for 5 s (apps/sync room/element-room.ts `snapshotFor`), lb_doc
 * included, and a fresh session takes its board document from that snapshot (canvas/sync/core/engine.ts
 * `onSnapshot`), so a start view set less than 5 s before a first visit is not seen by it. The PRE-08 test
 * waits that out; the last test pins the defect (expected to fail until it is fixed).
 */
const SNAPSHOT_CACHE_WAIT_MS = 5_500

test('start view: a reload returns to the last camera (±1 px); a camera far from content falls back to fit; a first visit fits the content at ≤ 100%; one small note far away opens at exactly 100%', async ({
  canvasSession,
  board,
  browser,
  users,
}) => {
  const a = await canvasSession('alice')
  await waitForNavigation(a.page)
  const all = (await seed(a.page, [
    () => createNote(a.page, { x: 0, y: 0, text: 'North west' }),
    () => createNote(a.page, { x: 2600, y: 0, text: 'North east' }),
    () => createNote(a.page, { x: 0, y: 1900, text: 'South west' }),
    () => createNote(a.page, { x: 2600, y: 1900, text: 'South east' }),
  ])) as string[]

  await test.step('alice’s camera comes back after a reload (±1 px)', async () => {
    const cam = { x: 133.4, y: 46.7, zoom: 0.8 }
    await setView(a.page, cam)
    await expect.poll(() => storedView(a.page, board, a.id)).toMatchObject(cam)
    await a.page.reload()
    await waitForNavigation(a.page)
    expect(await startView(a.page)).toBe('restore')
    expect(nearView(await viewport(a.page), cam)).toBe(true)
    expect(await inView(a.page, all)).toBe(false) // her own zoomed-in view, not a fit
  })

  await test.step('a saved camera that shows nothing falls back to fitting all content', async () => {
    await setView(a.page, { x: 60_000, y: 60_000, zoom: 1 })
    await expect.poll(() => storedView(a.page, board, a.id).then((c) => c?.x)).toBe(60_000)
    await a.page.reload()
    await waitForNavigation(a.page)
    expect(await startView(a.page)).toBe('restore+fit')
    expect(await inView(a.page, all)).toBe(true)
    expect(await zoom(a.page)).toBeLessThanOrEqual(1)
  })

  await test.step('bob’s first visit fits the content, at no more than 100%', async () => {
    await users.grant(board, 'bob', 'editor')
    const b = await openPath(browser, await users.get('bob'), `/b/${board}`)
    try {
      expect(await startView(b.page)).toBe('fit')
      await expect.poll(() => inView(b.page, all)).toBe(true)
      expect(await zoom(b.page)).toBeLessThanOrEqual(1)
      // fitted, not merely zoomed far out: the content spans most of the view
      const [v, content] = [await viewport(b.page), await boundsOf(b.page, all)]
      expect(content && content.width / v.width).toBeGreaterThan(0.6)
      // cameras are per user: alice's saved views never reach bob's browser
      expect(await storedView(b.page, board, a.id)).toBeNull()
    } finally {
      await b.context.close()
    }
  })

  await test.step('one small note far from the origin: a first visit shows it at exactly 100% (fit never zooms in)', async () => {
    const small = await users.createBoard('One small note')
    await a.page.goto(`/b/${small}`)
    await waitForNavigation(a.page)
    const lonely = await createNote(a.page, { x: 8000, y: 6000, text: 'Just me' })
    await expectSaved(a.page)
    const first = await openPath(browser, await users.get('alice'), `/b/${small}`) // a new browser profile
    try {
      expect(await startView(first.page)).toBe('fit')
      await expect.poll(() => inView(first.page, [lonely])).toBe(true)
      expect(await zoom(first.page)).toBeCloseTo(1, 5)
    } finally {
      await first.context.close()
    }
  })
})

test('PRE-08 start view: alice (owner) saves her view; first visits land exactly there, a returning person keeps their own view, Go to start view returns to it; a frame can be the start view; clear falls back to fit; a viewer and an editor can go to it but not set or forge it', async ({
  canvasSession,
  browser,
  board,
  users,
}) => {
  const a = await canvasSession('alice')
  await waitForNavigation(a.page)
  await seed(a.page, [
    () => createNote(a.page, { x: 0, y: 0, text: 'North west' }),
    () => createNote(a.page, { x: 2600, y: 0, text: 'North east' }),
    () => createNote(a.page, { x: 0, y: 1900, text: 'South west' }),
    () => createNote(a.page, { x: 2600, y: 1900, text: 'South east' }),
  ])
  const INTRO = await createItem(a.page, 'frame', {
    x: 1100,
    y: 700,
    width: 500,
    height: 400,
    name: 'Start here',
  })
  await expectSaved(a.page)
  const cam = { x: 2300, y: -80, zoom: 0.9 }
  await setView(a.page, cam)

  await test.step('alice: Board menu → Set current view as start view (stored in the board document)', async () => {
    expect(await navMenu(a.page, 'mainMenu', 'navigation.set-start-view')).toBe(true)
    await expect(a.page.getByTestId('board-setting-notice')).toContainText('Start view set.')
    const view = (await docValue(a.page, 'startView')) as Record<string, number>
    const v = await viewport(a.page)
    expect(view.x).toBeCloseTo(v.x, 3)
    expect(view.y).toBeCloseTo(v.y, 3)
    expect(view.w).toBeCloseTo(v.width, 3)
    expect(view.h).toBeCloseTo(v.height, 3)
    await expectSaved(a.page)
  })

  const firstVisit = async (handle: string, role: 'editor' | 'viewer') => {
    await users.grant(board, handle, role)
    await a.page.waitForTimeout(SNAPSHOT_CACHE_WAIT_MS)
    return openPath(browser, await users.get(handle), `/b/${board}`)
  }

  await test.step('bob’s first visit lands on alice’s view (same screen: same camera); a reload keeps his own; Go to start view', async () => {
    const b = await firstVisit('bob', 'editor')
    try {
      expect(await startView(b.page)).toBe('start-view')
      await expect.poll(async () => nearView(await viewport(b.page), cam)).toBe(true)
      const away = { x: 900, y: 1500, zoom: 0.6 }
      await setView(b.page, away)
      const bob = await users.get('bob')
      await expect.poll(() => storedView(b.page, board, bob.id)).toMatchObject(away)
      await b.page.reload()
      await waitForNavigation(b.page)
      expect(await startView(b.page)).toBe('restore')
      expect(nearView(await viewport(b.page), away)).toBe(true)
      expect(await navMenu(b.page, 'mainMenu', 'navigation.go-to-start-view')).toBe(true)
      await expect.poll(async () => nearView(await viewport(b.page), cam)).toBe(true)
      // an editor cannot set the start view on the new canvas (an owner key), and a forged write is refused
      const entries = (await navEntries(b.page, 'mainMenu')).map((e) => e.id)
      expect(entries).toContain('navigation.go-to-start-view')
      expect(entries).not.toContain('navigation.set-start-view')
      const { socket, welcome } = await forgeSession(b.page, board)
      try {
        await socket.send({
          type: 'push',
          seq: 1,
          base: welcome.clock,
          ops: [],
          doc: { set: { startView: { x: 99_999, y: 99_999, w: 10, h: 10 } } },
        })
        const ack = await socket.next('ack')
        expect(ack.docDenied?.keys).toEqual(['startView'])
      } finally {
        await socket.close()
      }
    } finally {
      await b.context.close()
    }
  })

  await test.step('a viewer’s first visit lands there too; she can go to it, not set it, and a forged write never lands', async () => {
    const c = await firstVisit('carol', 'viewer')
    try {
      expect(await startView(c.page)).toBe('start-view')
      await expect.poll(async () => nearView(await viewport(c.page), cam)).toBe(true)
      const entries = (await navEntries(c.page, 'mainMenu')).map((e) => e.id)
      expect(entries).toContain('navigation.go-to-start-view')
      expect(entries).not.toContain('navigation.set-start-view')
      expect(entries).not.toContain('navigation.clear-start-view')
      const original = await docValue(a.page, 'startView')
      const { socket, welcome } = await forgeSession(c.page, board)
      try {
        await socket.send({
          type: 'push',
          seq: 1,
          base: welcome.clock,
          ops: [],
          doc: { set: { startView: { x: 99_999, y: 99_999, w: 10, h: 10 } } },
        })
        await socket.next('ack').catch(() => null)
      } finally {
        await socket.close()
      }
      await a.page.waitForTimeout(1_000)
      expect(await docValue(a.page, 'startView')).toEqual(original)
      expect(await docValue(c.page, 'startView')).toEqual(original)
    } finally {
      await c.context.close()
    }
  })

  await test.step('Set this frame as start view (context menu): a first visit shows the whole frame, at ≤ 100%', async () => {
    await select(a.page, [INTRO])
    expect(await navMenu(a.page, 'contextMenu', 'navigation.set-frame-start-view')).toBe(true)
    await expect(a.page.getByTestId('board-setting-notice')).toContainText(
      'This frame is now the start view.',
    )
    expect(await docValue(a.page, 'startView')).toMatchObject({ frameId: INTRO })
    await expectSaved(a.page)
    const d = await firstVisit('dave', 'editor')
    try {
      expect(await startView(d.page)).toBe('start-view')
      const [v, f] = [await viewport(d.page), await boundsOf(d.page, [INTRO])]
      expect(f && contains(v, f)).toBe(true)
      expect(await zoom(d.page)).toBeLessThanOrEqual(1)
    } finally {
      await d.context.close()
    }
  })

  await test.step('Board menu → Clear start view: the next first visit fits all content again', async () => {
    expect(await navMenu(a.page, 'mainMenu', 'navigation.clear-start-view')).toBe(true)
    await expect(a.page.getByTestId('board-setting-notice')).toContainText('Start view cleared.')
    await expect.poll(() => docValue(a.page, 'startView')).toBeNull()
    expect((await navEntries(a.page, 'mainMenu')).map((e) => e.id)).not.toContain(
      'navigation.clear-start-view',
    )
    await expectSaved(a.page)
    const e = await firstVisit('erin', 'editor')
    try {
      // the default first view again: all content, or (DANA-06) the first frame where all of it only fits
      // unreadably small
      expect(['fit', 'first-frame']).toContain(await startView(e.page))
    } finally {
      await e.context.close()
    }
  })
})

test('a first visit right after the owner sets the start view lands on it (the room’s cached reset snapshot carries the old board document)', async ({
  canvasSession,
  browser,
  board,
  users,
}) => {
  test.fail(
    true,
    'defect (O1/O2): a fresh session within 5 s of a doc write gets lb_doc from the cached reset snapshot (room/element-room.ts snapshotFor; sync/core/engine.ts onSnapshot overwrites welcome.doc) and no catch-up of it',
  )
  const a = await canvasSession('alice')
  await waitForNavigation(a.page)
  await seed(a.page, [
    () => createNote(a.page, { x: 0, y: 0, text: 'North west' }),
    () => createNote(a.page, { x: 2600, y: 1900, text: 'South east' }),
  ])
  await users.grant(board, 'bob', 'editor')
  // a fresh session right now makes the room cache its reset snapshot (without a start view)
  const c = await canvasSession('carol', { role: 'viewer' })
  await waitForNavigation(c.page)
  const cam = { x: 2300, y: -80, zoom: 0.9 }
  await setView(a.page, cam)
  expect(await navMenu(a.page, 'mainMenu', 'navigation.set-start-view')).toBe(true)
  await expectSaved(a.page)
  // bob's first visit within the cache's 5 s
  const b = await openPath(browser, await users.get('bob'), `/b/${board}`)
  try {
    expect(await docValue(b.page, 'startView')).not.toBeNull()
    expect(await startView(b.page)).toBe('start-view')
  } finally {
    await b.context.close()
  }
})
