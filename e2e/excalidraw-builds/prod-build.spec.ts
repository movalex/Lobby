// The PRODUCTION Excalidraw web build (docs/EXCALIDRAW-CUTOVER.md G2 and G3), as the static site is built
// at the cut-over: VITE_LOBBY_ENGINE=excalidraw and NO dev-auth guard. Before wave 4 that build had no
// engine route and no /excalidraw-assets/ (the route and the fonts needed the guard). It must open /b/<id>
// on Lobby's Excalidraw page with real tickets and no debug handle, ship the self-hosted fonts (never
// Liberation), keep the dev-only spike pages out, and have no inline script in index.html (the CSP).
//
//   E2E_PORT_BASE=<base> pnpm --filter @draftroom/e2e excalidraw:prod
//
// No facade here (dev-auth builds only): the page is driven as a person drives it, and read through the
// DOM, the network and the build output on disk.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { Page } from '@playwright/test'
import { signInContext } from '../tests/support/api.ts'
import { expect, test } from '../tests/support/fixtures.ts'
import { PROD_DIST } from './paths.ts'

const TEXT_EDITOR = 'textarea.excalidraw-wysiwyg'
/** Globals a dev-auth build exposes for the suites; none may exist on the production build. */
const DEBUG_HANDLES = [
  '__lobbyBoard',
  'lobbyCanvas',
  '__lobbyHarness',
  'editor',
  '__lobbySpike',
  '__lobbyLod',
]
/** Strings only the dev-only pages and handles carry (route.tsx's spike page, session.ts's handle). */
const DEV_ONLY_MARKERS = ['spike-board', 'spike-missing', '__lobbySpike', '__lobbyBoard']
/**
 * tldraw's marks (wave 4 part 2, docs/EXCALIDRAW-CUTOVER.md G10; SMK-1): its packages, its CSS classes, and
 * the embed allowlist of @tldraw/tlschema that reached the bundle through packages/tldraw-import. On
 * 32859b1 the board chunk carried '@tldraw/tlschema' (through canvas-schema's root) and those hosts.
 */
const TLDRAW_MARKERS = [
  '@tldraw/',
  'tl-container',
  'tlui-',
  'tldraw.css',
  'tldraw-import',
  'codepen.io',
  'youtube.com',
  'vimeo.com',
  'scratch.mit.edu',
  'val.town',
  'codesandbox.io',
]
/**
 * Hosts a literal in the build may name: the auth provider's, and URLs that are never requested (the SVG
 * namespace, JSON-schema ids, the comments React and the bundler leave). Lobby's own placeholders end in
 * `.invalid`. Anything else is a foreign host (plan §2.12: no request leaves Lobby's origins and Clerk's).
 */
const ALLOWED_HOSTS = new Set([
  'clerk.com',
  // The open sign-in's "Continue with Google" (auth/GoogleSignIn.tsx, docs/OPEN-SIGNIN.md): the auth provider's
  // host where GET /api/auth/config offers Google (the theater Lobby, whose CSP allows it), never requested
  // anywhere else; scripts/smoke/live-smoke.mjs checks which a live server is (since 648bd891)
  'accounts.google.com',
  'dashboard.clerk.com',
  'www.w3.org',
  'react.dev',
  'github.com',
  'json-schema.org',
  'rolldown.rs',
])

function* walk(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) yield* walk(p)
    else yield p
  }
}

/** Built text files (js, css, html) whose content has `marker`. */
function builtFilesWith(marker: string): string[] {
  const out: string[] = []
  for (const f of walk(PROD_DIST)) {
    if (!/\.(m?js|css|html)$/.test(f)) continue
    if (readFileSync(f, 'utf8').includes(marker)) out.push(f.slice(PROD_DIST.length + 1))
  }
  return out
}

const canvasHasKeyboard = (page: Page) =>
  page.evaluate(() => !!document.activeElement?.closest('.excalidraw'))

test('the board opens on Excalidraw with real tickets and no debug handle; a note made by hand is Saved and is there after a reload', async ({
  browser,
  board,
  users,
}) => {
  const alice = await users.get('alice')
  const context = await browser.newContext()
  try {
    const page = await context.newPage()
    const fontRequests: { url: string; status: number | null }[] = []
    page.on('response', (r) => {
      if (r.url().includes('/excalidraw-assets/')) fontRequests.push({ url: r.url(), status: r.status() })
    })
    await signInContext(context, alice.handle, alice.name)
    await page.goto(`/b/${board}`)
    const lobbyBoard = page.getByTestId('lobby-board')
    // before wave 4 this build opened the tldraw board page here (no lobby-board at all)
    await expect(lobbyBoard).toHaveAttribute('data-engine', 'excalidraw', { timeout: 60_000 })
    await expect(lobbyBoard).toHaveAttribute('data-phase', 'ready', { timeout: 60_000 })
    await expect(page.getByTestId('conn-status')).toHaveAttribute('data-state', 'online')
    await expect(page.getByTestId('save-status')).toHaveAttribute('data-state', 'saved')
    await expect(page.getByTestId('board-title')).toContainText('The board opens on Excalidraw')
    // no facade, no debug handle, no spike channel: those keep the dev-auth guard
    expect(await page.evaluate((keys) => keys.filter((k) => k in window), DEBUG_HANDLES)).toEqual([])

    // a note by hand: the canvas takes the keyboard, N, a click; the editor opens, text, Escape, Saved
    const box = await page.locator('[data-lobby-board-canvas]').boundingBox()
    if (!box) throw new Error('no board canvas')
    const at = { x: box.x + box.width * 0.5, y: box.y + box.height * 0.5 }
    await page.mouse.click(box.x + box.width * 0.8, box.y + box.height * 0.75)
    await expect.poll(() => canvasHasKeyboard(page)).toBe(true)
    await page.keyboard.press('n')
    await page.mouse.click(at.x, at.y)
    const editor = page.locator(TEXT_EDITOR)
    await expect(editor).toBeFocused({ timeout: 15_000 })
    await expect(editor).toHaveJSProperty('readOnly', false, { timeout: 15_000 })
    await page.keyboard.type('Made on the production build', { delay: 15 })
    await page.keyboard.press('Escape')
    await expect(editor).toHaveCount(0)
    const save = page.getByTestId('save-status')
    await expect(save).toHaveAttribute('data-state', 'saved', { timeout: 30_000 })
    await page.waitForTimeout(700)
    await expect(save).toHaveAttribute('data-state', 'saved')
    // the engine's fonts came from this origin's /excalidraw-assets/, every one of them served
    expect(fontRequests.length).toBeGreaterThan(0)
    expect(fontRequests.filter((r) => r.status !== 200)).toEqual([])
    expect(fontRequests.every((r) => new URL(r.url).origin === new URL(page.url()).origin)).toBe(true)

    // a reload: the note is on the server, and (the camera kept) opens for editing where it was
    await page.reload()
    await expect(lobbyBoard).toHaveAttribute('data-phase', 'ready', { timeout: 60_000 })
    await expect(save).toHaveAttribute('data-state', 'saved', { timeout: 30_000 })
    await page.mouse.dblclick(at.x, at.y)
    await expect(editor).toBeFocused({ timeout: 15_000 })
    await expect(editor).toHaveValue('Made on the production build')
    await page.keyboard.press('Escape')
  } finally {
    await context.close()
  }
})

test("the dev-only spike pages are not in this build: ?page=spike opens Lobby's page, /spike/* is no page, and the output has no spike or debug-handle marker", async ({
  browser,
  board,
  users,
}) => {
  const alice = await users.get('alice')
  const context = await browser.newContext()
  try {
    const page = await context.newPage()
    await signInContext(context, alice.handle, alice.name)
    await page.goto(`/b/${board}?page=spike`)
    await expect(page.getByTestId('lobby-board')).toHaveAttribute('data-phase', 'ready', { timeout: 60_000 })
    await expect(page.getByTestId('spike-board')).toHaveCount(0)
    await page.goto('/spike/render-lab')
    await expect(page.getByText('Page not found')).toBeVisible()
    await expect(page.getByTestId('spike-missing')).toHaveCount(0)
    expect(await page.evaluate(() => '__lobbySpike' in window)).toBe(false)
  } finally {
    await context.close()
  }
  // the inlined guards fold the spike chunks and the debug handle out of the build
  for (const marker of DEV_ONLY_MARKERS) expect(builtFilesWith(marker), marker).toEqual([])
  // positive control: the engine page is in
  expect(builtFilesWith('data-engine').length).toBeGreaterThan(0)
})

test('the build carries no tldraw (packages, classes, the embed allowlist) and names no host but Clerk’s and the no-request URLs', () => {
  for (const marker of TLDRAW_MARKERS) expect(builtFilesWith(marker), marker).toEqual([])
  const hosts = new Set<string>()
  for (const f of walk(PROD_DIST)) {
    if (!/\.(m?js|css|html)$/.test(f)) continue
    for (const m of readFileSync(f, 'utf8').matchAll(/https?:\/\/([a-z0-9.-]+\.[a-z]{2,})/g))
      hosts.add(m[1] as string)
  }
  expect([...hosts].filter((h) => !h.endsWith('.invalid') && !ALLOWED_HOSTS.has(h)).sort()).toEqual([])
  expect(hosts.has('clerk.com')).toBe(true) // positive control: the scan read the chunks
})

/**
 * Marks of Mermaid and the libraries it brings (PLAN-wave4, the mermaid stub: apps/web/vite.config.ts aliases
 * @excalidraw/mermaid-to-excalidraw to apps/web/build/mermaid-to-excalidraw-stub.ts). Before the stub the build
 * carried them in about 90 chunks, three of them in the board route's eager closure.
 */
const MERMAID_MARKERS = [
  'securityLevel',
  'flowchart-v2',
  'mermaidAPI',
  'dagre',
  'cytoscape',
  'chevrotain',
  'langium',
]

test('the build carries no Mermaid: the engine’s converter is Lobby’s stub (a pasted chart definition stays text)', () => {
  for (const marker of MERMAID_MARKERS) expect(builtFilesWith(marker), marker).toEqual([])
  // positive control: the stub is what the engine's import resolves to
  expect(builtFilesWith('Mermaid diagrams are not available on Lobby boards').length).toBeGreaterThan(0)
})

test('the static files: self-hosted fonts under /excalidraw-assets/ (200 woff2; 404 for a miss and for Liberation), index.html with no inline script, /theme-boot.js', async ({
  request,
}) => {
  // on disk: the font tree without Liberation (plan §2.12)
  const fontsDir = join(PROD_DIST, 'excalidraw-assets', 'fonts')
  expect(existsSync(fontsDir), 'dist/excalidraw-assets/fonts').toBe(true)
  const families = readdirSync(fontsDir).sort()
  expect(families).toContain('Nunito')
  expect(families).toContain('Excalifont')
  expect(families).not.toContain('Liberation')
  const nunito = readdirSync(join(fontsDir, 'Nunito')).find((f) => f.endsWith('.woff2'))
  if (!nunito) throw new Error('no Nunito woff2 in the build')

  // served: a real font is 200 font/woff2
  const font = await request.get(`/excalidraw-assets/fonts/Nunito/${nunito}`)
  expect(font.status()).toBe(200)
  expect(font.headers()['content-type']).toContain('font/woff2')
  // a miss under the prefix is a 404, never the SPA's index.html (the browser would take the font as
  // broken and try its next source)
  for (const miss of [
    '/excalidraw-assets/fonts/Nunito/not-there.woff2',
    '/excalidraw-assets/fonts/Liberation/LiberationSans-Regular.woff2',
  ]) {
    const r = await request.get(miss)
    expect(r.status(), miss).toBe(404)
    expect(r.headers()['content-type'] ?? '', miss).not.toContain('text/html')
  }

  // index.html: no inline script (the CSP has no hash); the theme boot is a same-origin classic script
  // in <head>, before the app's module script. K1-6 (wave K): both head scripts are emitted hashed under
  // /assets/ (cached for a year); the plain root copies stay for a page cached before that.
  const html = await (await request.get('/')).text()
  expect(html.match(/<script(?![^>]*\bsrc=)[^>]*>/g)).toBeNull()
  const bootSrc = /<script src="(\/assets\/theme-boot-[\w-]+\.js)"><\/script>/.exec(html)?.[1] ?? ''
  const boot = bootSrc ? html.indexOf(`<script src="${bootSrc}">`) : -1
  expect(boot).toBeGreaterThan(-1)
  expect(boot).toBeLessThan(html.indexOf('</head>'))
  expect(boot).toBeLessThan(html.indexOf('type="module"'))
  const script = await request.get(bootSrc)
  expect(script.status()).toBe(200)
  expect(script.headers()['content-type'] ?? '').toMatch(/javascript/)
  expect(await script.text()).toContain('draftroom:theme')
  expect((await request.get('/theme-boot.js')).status()).toBe(200)
  // zod's jitless setting (no 'unsafe-eval'): a classic head script too, before every module script
  const zodSrc = /<script src="(\/assets\/zod-jitless-[\w-]+\.js)"><\/script>/.exec(html)?.[1] ?? ''
  const zod = zodSrc ? html.indexOf(`<script src="${zodSrc}">`) : -1
  expect(zod).toBeGreaterThan(-1)
  expect(zod).toBeLessThan(html.indexOf('type="module"'))
  const jitless = await request.get(zodSrc)
  expect(jitless.status()).toBe(200)
  expect(await jitless.text()).toContain('jitless: true')
})
