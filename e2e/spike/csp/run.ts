// Spike check A12, CSP part: the built app (host-rewrite plugin on) served with a strict
// Content-Security-Policy header, against the REAL api + sync + preview worker, in headless Chromium.
//
//   node e2e/spike/csp/run.ts [--run N] [--port-base 7820] [--reuse-build]
//
// Ports: sync = base, api = base + 1, and this CSP static server on base + 2 (the stack's WEB_PORT, so
// the api's Origin check matches). Two policies are tried in turn:
//   plan   plan §2.12's header as written (no Clerk: this stack signs in with the dev provider; sync is
//          same-origin here, so connect-src is 'self')
//   final  plan + what the run shows is needed (recorded in the report and in A12.md)
// Flows per policy, in one browser context:
//   1. dev sign-in: /signin → quick pick "alice" → the dashboard
//   2. the spike board page /spike/render-lab: notes and text in every served font family, Chinese text
//      (Xiaolai), an image uploaded through the real api and loaded by Lobby's loader from its real
//      /files/<ast>/<ver>/d/<drv> route, the text editor (double-click, type, Escape), render overrides,
//      exportToCanvas / exportToSvg (font inlining), wheel zoom and pan
// Collected: securitypolicyviolation events, console messages about CSP, report-uri bodies, requests to
// any non-local host (aborted before they leave), page errors. Writes
// e2e/test-results/spike-csp-<web port>/run-<N>.json. Exit 0 when the final policy has 0 violations and 0
// foreign requests in flows 1 and 2.
import { spawnSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import { type BrowserContext, chromium, type Page } from '@playwright/test'
import { encodePng } from '../fixtures/files-server.ts'
import type { LabExtra, RenderApi } from '../fixtures/render-types.ts'
import { inlineScriptHashes, startCspServer } from './server.ts'

const { values: args } = parseArgs({
  options: {
    run: { type: 'string', default: '1' },
    'port-base': { type: 'string', default: '7820' },
    'reuse-build': { type: 'boolean', default: false },
  },
})
process.env.E2E_PORT_BASE = args['port-base']
const { API_PORT, HOST, SYNC_PORT, WEB_PORT, WEB_URL } = await import('../../tests/support/ports.ts')
const { REPO_ROOT, startStack } = await import('../../tests/support/stack.ts')

const started = Date.now()
const log = (s: string) =>
  console.log(`[csp ${((Date.now() - started) / 1000).toFixed(0).padStart(4)} s] ${s}`)
const OUT = join(REPO_ROOT, 'e2e', 'test-results', `spike-csp-${WEB_PORT}`)
mkdirSync(OUT, { recursive: true })
const DIST = `dist/csp-${WEB_PORT}`
const distDir = join(REPO_ROOT, 'apps/web', DIST)

if (!args['reuse-build']) {
  log(`building apps/web (dev auth) into apps/web/${DIST}`)
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    VITE_DRAFTROOM_DEV_AUTH: '1',
  }
  delete env.VITE_DRAFTROOM_SYNC_ORIGIN
  const b = spawnSync(`pnpm exec vite build --outDir ${DIST} --emptyOutDir`, {
    cwd: join(REPO_ROOT, 'apps/web'),
    env,
    shell: true,
    encoding: 'utf8',
    windowsHide: true,
  })
  if (b.status !== 0) throw new Error(`build failed:\n${b.stdout}\n${b.stderr}`)
}

const hashes = inlineScriptHashes(readFileSync(join(distDir, 'index.html'), 'utf8'))
const PLAN = [
  "default-src 'self'",
  "script-src 'self'",
  "connect-src 'self'",
  "img-src 'self' blob: data:",
  "font-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "worker-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'self'",
  "frame-ancestors 'none'",
].join('; ')
// plan + the one addition the run shows is needed: the hash of index.html's inline theme script
const FINAL = PLAN.replace("script-src 'self'", `script-src 'self' ${hashes.join(' ')}`)
const POLICIES = { plan: PLAN, final: FINAL } as const
/**
 * Runs: the plan's header; the final header; the final header with the app fix the run needs (zod's
 * eval probe off: `z.config({ jitless: true })` in Lobby's bootstrap, emulated here with zod's own
 * global config object before any script runs).
 */
const RUNS = [
  { name: 'plan', policy: PLAN, zodJitless: false },
  { name: 'final', policy: FINAL, zodJitless: false },
  { name: 'final+zod-jitless', policy: FINAL, zodJitless: true },
] as const

log(`starting api + sync + worker (sync ${SYNC_PORT}, api ${API_PORT}) and the CSP server on ${WEB_PORT}`)
const stack = await startStack()
const server = await startCspServer({
  root: distDir,
  port: WEB_PORT,
  host: HOST,
  api: { host: HOST, port: API_PORT },
  sync: { host: HOST, port: SYNC_PORT },
  policy: PLAN,
})
const browser = await chromium.launch({ headless: true })

interface Violation {
  directive: string
  blocked: string
  source: string
  line: number
  sample: string
  disposition: string
}
interface FlowResult {
  flow: string
  ok: boolean
  error?: string
  violations: Violation[]
  cspConsole: string[]
  consoleErrors: string[]
  pageErrors: string[]
  foreign: string[]
  notes: Record<string, unknown>
}

const isForeign = (url: string) => {
  try {
    const u = new URL(url)
    if (u.protocol === 'data:' || u.protocol === 'blob:' || u.protocol === 'about:') return false
    return !['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname)
  } catch {
    return true
  }
}

async function newContext(zodJitless: boolean) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, baseURL: WEB_URL })
  if (zodJitless) {
    await context.addInitScript(() => {
      ;(globalThis as unknown as { __zod_globalConfig?: Record<string, unknown> }).__zod_globalConfig = {
        jitless: true,
      }
    })
  }
  await context.addInitScript(() => {
    const list: unknown[] = []
    Object.defineProperty(window, '__csp', { value: list })
    document.addEventListener('securitypolicyviolation', (e) => {
      list.push({
        directive: e.effectiveDirective || e.violatedDirective,
        blocked: e.blockedURI,
        source: e.sourceFile,
        line: e.lineNumber,
        sample: e.sample,
        disposition: e.disposition,
      })
    })
  })
  await context.route(
    (url) => isForeign(url.href),
    (route) => route.abort('blockedbyclient'),
  )
  return context
}

function watch(page: Page) {
  const w = {
    cspConsole: [] as string[],
    consoleErrors: [] as string[],
    pageErrors: [] as string[],
    foreign: [] as string[],
  }
  page.on('console', (m) => {
    const t = m.text()
    if (/Content Security Policy|Refused to/i.test(t)) w.cspConsole.push(t.slice(0, 300))
    else if (m.type() === 'error') w.consoleErrors.push(t.slice(0, 200))
  })
  page.on('pageerror', (e) => w.pageErrors.push(String(e).slice(0, 300)))
  page.on('request', (r) => {
    if (isForeign(r.url())) w.foreign.push(r.url())
  })
  page.on('websocket', (ws) => {
    if (isForeign(ws.url())) w.foreign.push(ws.url())
  })
  return w
}

const takeViolations = (page: Page) =>
  page
    .evaluate(() => (window as unknown as { __csp: unknown[] }).__csp.splice(0) as never[])
    .catch(() => [] as never[])

async function flow(
  name: string,
  page: Page,
  body: (notes: Record<string, unknown>) => Promise<void>,
): Promise<FlowResult> {
  const w = watch(page)
  const notes: Record<string, unknown> = {}
  let ok = true
  let error: string | undefined
  try {
    await body(notes)
  } catch (e) {
    ok = false
    error = String(e).slice(0, 500)
  }
  await page.waitForTimeout(500)
  // violations the flow already took per step (notes.steps), plus the rest
  const stepped =
    (notes.steps as { violations: Violation[] }[] | undefined)?.flatMap((s) => s.violations) ?? []
  const violations = [...stepped, ...((await takeViolations(page)) as Violation[])]
  page.removeAllListeners('console')
  page.removeAllListeners('pageerror')
  page.removeAllListeners('request')
  page.removeAllListeners('websocket')
  return { flow: name, ok, ...(error ? { error } : {}), violations, ...w, notes }
}

/** A board and an uploaded PNG with its thumb derivative, through the api as the signed-in user. */
async function prepareBoard(context: BrowserContext) {
  const req = context.request
  const origin = { origin: WEB_URL }
  const me = (await (await req.get('/api/me')).json()) as { workspaces: { id: string; name: string }[] }
  const ws = me.workspaces.find((w) => w.name === 'Dev Studio') ?? me.workspaces[0]
  if (!ws) throw new Error('no workspace')
  const board = (await (
    await req.post(`/api/workspaces/${ws.id}/boards`, { headers: origin, data: { title: 'CSP spike board' } })
  ).json()) as { id: string }
  const png = encodePng(320, 200, (x, y) =>
    Math.abs(x * (200 / 320) - y) < 24 ? [60, 90, 140] : [110, 170, 240],
  )
  const up = await req.post(`/api/boards/${board.id}/assets`, {
    headers: { ...origin, 'content-type': 'image/png', 'x-file-name': 'csp-probe.png' },
    data: png,
  })
  if (!up.ok()) throw new Error(`upload ${up.status()} ${await up.text()}`)
  const asset = (await up.json()) as { assetId: string; versionId: string }
  const deadline = Date.now() + 120_000
  for (;;) {
    const meta = (await (
      await req.get(`/api/boards/${board.id}/assets/${asset.assetId}/${asset.versionId}`)
    ).json()) as {
      status: string
      derivatives: { id: string; role: string }[]
    }
    if (meta.status === 'ready') {
      const thumb = meta.derivatives.find((d) => d.role === 'thumb') ?? meta.derivatives[0]
      if (!thumb) throw new Error('no derivative')
      return {
        boardId: board.id,
        versionId: asset.versionId,
        url: `/files/${asset.assetId}/${asset.versionId}/d/${thumb.id}?board=${board.id}`,
      }
    }
    if (meta.status === 'failed' || Date.now() > deadline) throw new Error(`preview ${meta.status}`)
    await new Promise((r) => setTimeout(r, 300))
  }
}

async function signInFlow(page: Page, notes: Record<string, unknown>) {
  await page.goto('/signin')
  await page.getByTestId('signin-quick-alice').click()
  await page.waitForURL((u) => !u.pathname.startsWith('/signin'), { timeout: 30_000 })
  // the dashboard keeps an event stream open (never network-idle): wait for it to render instead
  await page.getByTestId('dashboard-bell').waitFor({ timeout: 30_000 })
  await page.waitForTimeout(1500)
  notes.landedOn = new URL(page.url()).pathname
}

/** Takes the violations logged so far and files them under a step of the flow. */
async function step(page: Page, notes: Record<string, unknown>, name: string) {
  const violations = (await takeViolations(page)) as Violation[]
  const steps = (notes.steps ?? []) as { step: string; violations: Violation[]; summary: string[] }[]
  notes.steps = steps
  const summary = [
    ...new Set(
      violations.map(
        (v) => `${v.directive} ${v.blocked.startsWith('http') ? new URL(v.blocked).host : v.blocked}`,
      ),
    ),
  ]
  steps.push({ step: name, violations, summary })
}

async function boardFlow(
  page: Page,
  notes: Record<string, unknown>,
  image: { versionId: string; url: string },
) {
  await page.goto('/spike/render-lab')
  await page.waitForFunction(() => window.__lobbySpike !== undefined, null, { timeout: 30_000 })
  await page.evaluate(async () => {
    await window.__lobbySpike?.ready
  })
  await page.waitForTimeout(500)
  await step(page, notes, 'page load (engine mounted, no scene)')
  const setup = await page.evaluate(async (image) => {
    const spike = window.__lobbySpike
    const extra = (spike as { extra: unknown }).extra as LabExtra
    const api = spike?.api as RenderApi
    const skeletons: Record<string, unknown>[] = [
      {
        type: 'stickynote',
        id: 'n1',
        x: 40,
        y: 40,
        width: 200,
        height: 200,
        backgroundColor: '#ffdf6b',
        label: { text: 'CSP note', fontFamily: 6 },
      },
      {
        type: 'stickynote',
        id: 'n2',
        x: 280,
        y: 40,
        width: 200,
        height: 200,
        backgroundColor: '#9fd4ff',
        label: { text: 'Second note', fontFamily: 8 },
      },
      { type: 'image', id: 'img', x: 520, y: 40, width: 320, height: 200, fileId: image.versionId },
      {
        type: 'frame',
        id: 'fr',
        x: 20,
        y: 20,
        width: 840,
        height: 240,
        name: 'CSP frame',
        children: ['n1', 'n2', 'img'],
      },
    ]
    let y = 300
    for (const [name, id] of Object.entries(extra.engine.FONT_FAMILY)) {
      if (id === 9 || id === 10) continue // Liberation (not self-hosted) and Assistant (UI font): refused by Lobby
      skeletons.push({
        type: 'text',
        id: `t${id}`,
        x: 40,
        y,
        text: `${name} Lobby 0123`,
        fontFamily: id,
        fontSize: 24,
      })
      y += 44
    }
    skeletons.push({ type: 'text', id: 'cjk', x: 40, y, text: '白板 协作 你好', fontFamily: 5, fontSize: 24 })
    const els = extra.engine
      .convertToExcalidrawElements(skeletons, { regenerateIds: false })
      .map((e) =>
        e.type === 'stickynote'
          ? { ...e, created: null }
          : e.type === 'image'
            ? { ...e, status: 'saved' }
            : e,
      )
    extra.probe.applyServer(els)
    const loader = extra.loader({ urls: { [image.versionId]: image.url } })
    loader.syncScene(api.getSceneElements())
    const t0 = performance.now()
    while (loader.states().loaded < 1 && performance.now() - t0 < 15_000)
      await new Promise((r) => setTimeout(r, 100))
    await document.fonts.ready
    return { elements: api.getSceneElements().length, loader: loader.states(), stats: { ...loader.stats } }
  }, image)
  notes.setup = setup
  await page.waitForTimeout(800)
  await step(page, notes, 'scene, fonts, image through the loader')
  // the text editor: double-click the note, type, close
  const c = await page.evaluate(() => {
    const spike = window.__lobbySpike
    if (!spike?.api) throw new Error('no api')
    return spike.lib.sceneCoordsToViewportCoords({ sceneX: 140, sceneY: 140 }, spike.api.getAppState())
  })
  await page.mouse.dblclick(c.x, c.y)
  await page.waitForSelector('textarea.excalidraw-wysiwyg', { timeout: 5000 })
  await page.keyboard.type(' typed under CSP')
  await page.keyboard.press('Escape')
  await page.waitForTimeout(300)
  await step(page, notes, 'text editor')
  const after = await page.evaluate(() => {
    const spike = window.__lobbySpike
    const extra = (spike as { extra: unknown }).extra as LabExtra
    extra.overrides.setDrag('peer', new Map([['n2', { x: 0, y: 40 }]]))
    extra.overrides.setHidden('collapse', ['t1'])
    extra.overrides.flush()
    const labels = (spike?.api?.getSceneElements() ?? [])
      .filter((e) => e.type === 'text' && e.containerId === 'n1')
      .map((e) => e.text)
    return { labels }
  })
  notes.edited = after.labels
  await page.waitForTimeout(300)
  await step(page, notes, 'render overrides')
  const exportCanvas = await page.evaluate(async () => {
    const spike = window.__lobbySpike
    const extra = (spike as { extra: unknown }).extra as LabExtra
    const api = spike?.api as RenderApi
    const canvas = await extra.engine.exportToCanvas({
      elements: api.getSceneElements(),
      files: api.getFiles(),
      appState: { exportBackground: true },
    })
    const png = await new Promise<number>((resolve) =>
      canvas.toBlob((b) => resolve(b?.size ?? 0), 'image/png'),
    )
    return { canvas: [canvas.width, canvas.height], pngBytes: png }
  })
  await step(page, notes, 'exportToCanvas + PNG blob')
  const exportSvgPlain = await page.evaluate(async () => {
    const spike = window.__lobbySpike
    const extra = (spike as { extra: unknown }).extra as LabExtra
    const api = spike?.api as RenderApi
    const svg = await extra.engine.exportToSvg({
      elements: api.getSceneElements(),
      files: api.getFiles(),
      skipInliningFonts: true,
    })
    return {
      bytes: svg.outerHTML.length,
      fontFaces: (svg.querySelector('style')?.textContent?.match(/@font-face/g) ?? []).length,
    }
  })
  await step(page, notes, 'exportToSvg, skipInliningFonts')
  notes.exports = { exportCanvas, exportSvgPlain }
  // wheel zoom and pan
  await page.mouse.move(640, 400)
  await page.keyboard.down('Control')
  await page.mouse.wheel(0, -300)
  await page.keyboard.up('Control')
  await page.mouse.wheel(0, 200)
  await page.waitForTimeout(500)
  await step(page, notes, 'wheel zoom and pan')
  notes.images = await page.evaluate(() =>
    Object.values(((window.__lobbySpike as { api: unknown }).api as RenderApi).getFiles()).map((f) =>
      f.dataURL.slice(0, 5),
    ),
  )
}

/** Excalidraw's own SVG font inlining (subsetting with its woff2/harfbuzz WebAssembly): not a Lobby path. */
async function svgInliningFlow(page: Page, notes: Record<string, unknown>) {
  notes.exportSvg = await page.evaluate(async () => {
    const spike = window.__lobbySpike
    const extra = (spike as { extra: unknown }).extra as LabExtra
    const api = spike?.api as RenderApi
    const svg = await extra.engine.exportToSvg({ elements: api.getSceneElements(), files: api.getFiles() })
    const css = svg.querySelector('style')?.textContent ?? ''
    return {
      bytes: svg.outerHTML.length,
      fontFaces: (css.match(/@font-face/g) ?? []).length,
      dataSources: (css.match(/src: url\(data:/g) ?? []).length,
      urlSources: [...css.matchAll(/src: url\((https?:[^)]+)\)/g)].map((m) => m[1]).slice(0, 5),
    }
  })
  await page.waitForTimeout(500)
}

const results: Record<string, FlowResult[]> = {}
let image: { boardId: string; versionId: string; url: string } | null = null
try {
  for (const { name, policy, zodJitless } of RUNS) {
    server.setPolicy(policy)
    const reportsBefore = server.reports.length
    const context = await newContext(zodJitless)
    const page = await context.newPage()
    const flows: FlowResult[] = []
    flows.push(await flow('sign-in', page, (n) => signInFlow(page, n)))
    image ??= await prepareBoard(context)
    const img = image
    flows.push(await flow('spike-board', page, (n) => boardFlow(page, n, img)))
    flows.push(await flow('svg font inlining (informational)', page, (n) => svgInliningFlow(page, n)))
    await context.close()
    results[name] = flows.map((f) => f)
    const reports = server.reports.slice(reportsBefore)
    ;(results[name] as unknown as { reports?: unknown[] }).reports = reports
    for (const f of flows) {
      log(
        `${name} / ${f.flow}: ${f.ok ? 'ran' : `FAILED (${f.error})`}; ${f.violations.length} violation event(s) ` +
          `[${[...new Set(f.violations.map((v) => `${v.directive} ${v.blocked}`))].join(' | ')}]; ${f.cspConsole.length} CSP console; ` +
          `${f.foreign.length} foreign; ${f.pageErrors.length} page errors`,
      )
    }
    log(`${name}: ${reports.length} report-uri bodies`)
  }
} finally {
  await browser.close()
  await server.close()
  await stack.stop()
}

const finalFlows = (results['final+zod-jitless'] ?? []).filter((f) => !f.flow.includes('informational'))
const pass =
  finalFlows.length === 2 &&
  finalFlows.every(
    (f) => f.ok && f.violations.length === 0 && f.cspConsole.length === 0 && f.foreign.length === 0,
  )
const report = {
  at: new Date().toISOString(),
  run: args.run,
  policies: POLICIES,
  runs: RUNS,
  inlineScriptHashes: hashes,
  results,
  reportUriBodies: server.reports,
  serverLog: server.log.filter(
    (l) => l.status >= 400 || l.path.startsWith('/files/') || l.path.startsWith('/excalidraw-assets/'),
  ),
  pass,
}
const file = join(OUT, `run-${args.run}.json`)
writeFileSync(file, JSON.stringify(report, null, 2))
log(
  `${pass ? 'PASS' : 'FAIL'}: final policy with the zod fix, sign-in + spike board: 0 violations and 0 foreign requests required. report: ${file}`,
)
process.exit(pass ? 0 : 1)
