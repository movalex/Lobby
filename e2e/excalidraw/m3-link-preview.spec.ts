// Wave M (W3, M3-6, S1.2): a pasted board link unfurls generically. A crawler (a chat tool, a meeting invite) fetches the
// board's address without a session; every /b/<id> serves the same index.html, so what it reads is the same static page
// whatever the board is called: "Lobby board", never its title. (The built page's tags are asserted against the real
// index.html in apps/web/src/lib/link-preview.test.ts; this is the served page.)
//
//   E2E_PORT_BASE=<base> pnpm exec playwright test excalidraw/m3-link-preview.spec.ts --project=chromium --workers=1
import { request } from '@playwright/test'
import { Api } from '../tests/support/api.ts'
import { expect, test } from '../tests/support/canvas.ts'
import {
  freshHandle,
  openDashboard,
  personalWorkspace,
  signedInContext,
} from '../tests/support/dashboard-share.ts'
import { WEB_URL } from '../tests/support/ports.ts'

test('the page a crawler gets for a board address is the same static page, with the generic tags and no word of the board', async ({
  browser,
}) => {
  test.setTimeout(120_000)
  const p = await signedInContext(browser, freshHandle('m3l'), {
    name: 'Lia Link',
    email: 'lobby-test-m3l@darkburn.com',
  })
  const secret = `Secret launch plan ${Date.now().toString(36)}`
  try {
    await openDashboard(p.page, personalWorkspace(p.me))
    const board = await new Api(p.context.request).createBoard(personalWorkspace(p.me), secret)

    // no cookie, no session: a crawler's request
    const anonymous = await request.newContext({ baseURL: WEB_URL })
    try {
      const get = async (path: string) => {
        const res = await anonymous.get(path)
        expect(res.status(), path).toBe(200)
        expect(res.headers()['content-type'], path).toMatch(/text\/html/)
        return res.text()
      }
      const page = await get(`/b/${board.id}`)
      const other = await get('/b/b-otherboard1')
      const dashboard = await get(`/w/${personalWorkspace(p.me)}`)

      // the same file for every address: no title, no thumbnail, no id of a board in it
      expect(page).toBe(other)
      expect(page).toBe(dashboard)
      expect(page).not.toContain(secret)
      expect(page).not.toContain(board.id)

      const tag = (name: string) =>
        new RegExp(`<meta[^>]*(?:property|name)="${name}"[^>]*content="([^"]*)"`).exec(page)?.[1]
      expect(tag('og:title')).toBe('Lobby board')
      expect(tag('og:description')).toBe('Open to view in Lobby')
      expect(tag('og:type')).toBe('website')
      expect(tag('twitter:card')).toBe('summary')
      expect(tag('robots')).toMatch(/noindex/)
      // the image is a brand PNG of this site at an absolute URL when the build has VITE_PUBLIC_ORIGIN (Render's does); this
      // run's build has none, so the image tags are dropped (N1: they used to keep the literal %VITE_PUBLIC_ORIGIN% in the
      // address), and no placeholder is left anywhere in the page
      expect(page).not.toMatch(/%[A-Za-z_][A-Za-z0-9_]*%/)
      const image = tag('og:image')
      if (image === undefined) expect(page).not.toMatch(/<meta[^>]*og:image/)
      else expect(image).toMatch(/^https?:\/\/.+\/icon-512\.png$/)
      const png = await anonymous.get('/icon-512.png')
      expect(png.status()).toBe(200)
      expect(png.headers()['content-type']).toMatch(/image\/png/)
    } finally {
      await anonymous.dispose()
    }

    // opening the board in a browser changes nothing about the tags (the app never writes them)
    await p.page.goto(`/b/${board.id}`)
    await expect(p.page.getByTestId('board-title')).toContainText(secret.slice(0, 20))
    const live = await p.page.evaluate(() =>
      [...document.querySelectorAll('meta[property^="og:"], meta[name^="twitter:"]')].map(
        (m) => `${m.getAttribute('property') ?? m.getAttribute('name')}=${m.getAttribute('content')}`,
      ),
    )
    expect(live.join('\n')).not.toContain(secret)
    expect(live).toContain('og:title=Lobby board')
  } finally {
    await p.context.close()
  }
})
