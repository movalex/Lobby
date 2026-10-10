// Wave M (W7, M7-2's stale pair; the wave M gate's pair (a)): a tab of the web deployed today (a build of
// 4e4a549, CONTRACTS_REV 12, dev auth) against THIS sync, beside a tab of this tree's web. permessage-deflate
// changes no frame, so what is checked is that the deployed web works over it exactly as before:
//  - bob's page is served from that build's dist (l-compat-kit.ts serveOldWeb), and his board socket is NOT
//    relayed: it goes from his browser through the preview proxy to this sync, so the browser negotiates
//    permessage-deflate itself (read from the handshake answer with CDP);
//  - edits both ways, cursors, the laser, follow, a vote, a spotlight and a restore from "Recently deleted";
//  - every tab ends on the server's board (convergence hashes), bob's socket never got a CLOSING notice (so no
//    INVALID_MESSAGE close) nor reconnected, and his page threw nothing.
// Run (the old build is made outside the repo, as l-compat-kit.ts describes, for 4e4a549):
//   cd e2e && E2E_OLD_WEB_DIST=<dist> E2E_OLD_WEB_COMMIT=4e4a549 E2E_PORT_BASE=<base> \
//     pnpm exec playwright test --config load/stale-web.config.ts --project=chromium --workers=1
// Without E2E_OLD_WEB_DIST it is skipped.
import type { Page } from '@playwright/test'
import { OLD_WEB_DIST, OLD_WEB_LAUNCH, OLD_WEB_SKIP_REASON, serveOldWeb } from '../excalidraw/l-compat-kit.ts'
import { follow, laserStroke, openTab, pickLaser, sidOf, watchLaser } from '../excalidraw/l6-kit.ts'
import { clickElement } from '../excalidraw/workshops-kit.ts'
import {
  createNote,
  deleteItem,
  expect,
  hash,
  item,
  setViewport,
  test,
  viewport,
  zoomToFit,
} from '../tests/support/canvas.ts'
import { serverSnapshot } from '../tests/support/excalidraw.ts'

test.use({ viewport: { width: 1440, height: 900 }, launchOptions: OLD_WEB_LAUNCH })

interface SocketWatch {
  /** Sec-WebSocket-Extensions of every board socket handshake the page made */
  readonly extensions: string[]
  /** board socket handshakes (a reconnect is a second one) */
  readonly opened: number[]
  /** CLOSING notices the page received (the room sends one before every terminal close) */
  readonly closing: string[]
}

async function watchSocket(page: Page): Promise<SocketWatch> {
  const w: SocketWatch = { extensions: [], opened: [], closing: [] }
  const cdp = await page.context().newCDPSession(page)
  await cdp.send('Network.enable')
  const boardSockets = new Set<string>()
  cdp.on('Network.webSocketCreated', (e) => {
    if (/\/connect\//.test(e.url)) boardSockets.add(e.requestId)
  })
  cdp.on('Network.webSocketHandshakeResponseReceived', (e) => {
    if (!boardSockets.has(e.requestId)) return
    const h = e.response.headers as Record<string, string>
    const ext = Object.entries(h).find(([k]) => k.toLowerCase() === 'sec-websocket-extensions')?.[1] ?? ''
    w.extensions.push(ext)
    w.opened.push(Date.now())
  })
  cdp.on('Network.webSocketFrameReceived', (e) => {
    if (!boardSockets.has(e.requestId)) return
    const d = e.response.payloadData
    if (d.startsWith('{"type":"notice"') && d.includes('"CLOSING"')) w.closing.push(d.slice(0, 200))
  })
  return w
}

test('stale pair (a): the 4e4a549 web over permessage-deflate: edits both ways, cursors, laser, follow, vote, spotlight, restore', async ({
  browser,
  board,
  users,
  canvasSession,
  stack,
}) => {
  test.skip(!OLD_WEB_DIST, OLD_WEB_SKIP_REASON)
  test.setTimeout(240_000)
  const a = await canvasSession('alice')
  const served: string[] = []
  const pageErrors: string[] = []
  let sock: SocketWatch | null = null
  const b = await openTab(browser, board, users, 'bob', {
    role: 'editor',
    beforeOpen: async (page) => {
      await serveOldWeb(page.context(), OLD_WEB_DIST as string, served)
      page.on('pageerror', (e) => pageErrors.push(String(e).slice(0, 300)))
      sock = await watchSocket(page)
    },
  })
  const s = sock as unknown as SocketWatch
  const alice = await users.api('alice')
  try {
    await test.step('bob is the deployed build, and his browser negotiated permessage-deflate with this sync', async () => {
      expect(served.some((p) => p.startsWith('/assets/'))).toBe(true)
      await expect.poll(() => s.extensions.length).toBeGreaterThan(0)
      expect(s.extensions[0]).toMatch(/permessage-deflate/)
    })
    const bsid = (await sidOf(b.page)) as string
    const asid = (await sidOf(a.page)) as string

    await test.step('edits both ways', async () => {
      const fromAlice = await createNote(a.page, { x: 100, y: 100, text: 'from alice' })
      await expect.poll(() => item(b.page, fromAlice).then((e) => e?.id ?? null)).toBe(fromAlice)
      const fromBob = await createNote(b.page, { x: 420, y: 100, text: 'from bob' })
      await expect.poll(() => item(a.page, fromBob).then((e) => e?.id ?? null)).toBe(fromBob)
    })

    await test.step('cursors: alice’s pointer reaches bob, bob’s reaches alice', async () => {
      for (const [from, to, uid] of [
        [a, b, a.id],
        [b, a, b.id],
      ] as const) {
        const box = await from.page.locator('.excalidraw canvas').last().boundingBox()
        if (!box) throw new Error('no canvas')
        for (let i = 0; i < 6; i++) await from.page.mouse.move(box.x + 300 + i * 20, box.y + 300 + i * 10)
        await expect(to.page.locator(`[data-testid="cursor"][data-uid="${uid}"]`)).toBeVisible()
      }
    })

    await test.step('laser: alice’s sweep reaches bob’s page as a path', async () => {
      await pickLaser(a.page)
      const watch = await watchLaser(b.page, a.id, 2)
      await laserStroke(a.page)
      await expect.poll(async () => (await watch.read()).maxPoints).toBeGreaterThanOrEqual(2)
      await watch.stop()
      await a.page.keyboard.press('Escape')
    })

    await test.step('follow: bob follows alice’s view', async () => {
      await setViewport(a.page, { x: 1500, y: 700, zoom: 1 })
      await follow(b.page, asid)
      const off = async () => {
        const [av, bv] = await Promise.all([viewport(a.page), viewport(b.page)])
        return Math.round(
          Math.max(
            Math.abs(av.x + av.width / 2 - (bv.x + bv.width / 2)),
            Math.abs(av.y + av.height / 2 - (bv.y + bv.height / 2)),
          ),
        )
      }
      await expect.poll(off, { message: 'bob follows alice' }).toBeLessThanOrEqual(3)
      await b.page.keyboard.press('Escape')
    })

    let voteNote = ''
    await test.step('vote: alice starts one, bob joins and casts a dot', async () => {
      voteNote = await createNote(a.page, { x: 100, y: 400, text: 'vote for me' })
      await expect.poll(() => item(b.page, voteNote).then((e) => e?.id ?? null)).toBe(voteNote)
      await zoomToFit(b.page)
      const res = await alice.fetch('POST', `/api/boards/${board}/votes`, {
        title: 'Pick one',
        votesPerPerson: 3,
        onePerObject: false,
        scope: 'board',
      })
      expect(res.status()).toBeLessThan(300)
      const prompt = b.page.getByTestId('vote-join-prompt')
      await expect(prompt).toBeVisible()
      await prompt.getByTestId('vote-join').click()
      await expect(b.page.getByTestId('vote-remaining')).toHaveText('3 of 3 left')
      await clickElement(b.page, voteNote) // in a vote, a click on an object casts a dot
      await expect(b.page.getByTestId('vote-remaining')).toHaveText('2 of 3 left')
    })

    await test.step('spotlight: alice spotlights a note, bob sees the bar; it ends for him when she ends it', async () => {
      const res = await alice.fetch('POST', `/api/boards/${board}/spotlight`, { refs: [`shape:${voteNote}`] })
      expect(res.status()).toBeLessThan(300)
      await expect(b.page.getByTestId('spotlight-bar')).toBeVisible()
      await a.page.getByTestId('spotlight-end').click()
      await expect(b.page.getByTestId('spotlight-bar')).toHaveCount(0)
    })

    await test.step('restore: a note alice deleted comes back from Recently deleted, for bob too', async () => {
      const gone = await createNote(a.page, { x: 700, y: 400, text: 'deleted then restored' })
      await expect.poll(() => item(b.page, gone).then((e) => e?.id ?? null)).toBe(gone)
      await deleteItem(a.page, gone)
      // the facade keeps the tombstone: deleted for bob
      await expect.poll(() => item(b.page, gone).then((e) => e?.isDeleted ?? true)).toBe(true)
      const res = await alice.fetch('POST', `/api/boards/${board}/deleted/restore`, {
        ids: [`shape:${gone}`],
      })
      expect(res.status(), await res.text()).toBeLessThan(300)
      await expect.poll(() => item(b.page, gone).then((e) => (e && !e.isDeleted ? e.id : null))).toBe(gone)
    })

    await test.step('every tab holds the server’s board; bob’s socket was never closed by the room, his page threw nothing', async () => {
      const server = await serverSnapshot(stack, board)
      await expect.poll(() => hash(a.page)).toBe(server.hash)
      await expect.poll(() => hash(b.page)).toBe(server.hash)
      expect(s.closing).toEqual([])
      expect(s.opened).toHaveLength(1) // no reconnect
      expect(await sidOf(b.page)).toBe(bsid)
      expect(pageErrors).toEqual([])
      await expect(b.page.getByTestId('conn-status')).not.toHaveAttribute('data-state', /offline|error/)
    })
  } finally {
    await b.context.close()
  }
})
