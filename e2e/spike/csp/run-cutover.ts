// The cut-over's CSP check (docs/EXCALIDRAW-CUTOVER.md G3; spike A12's harness, run.ts, on the production
// build): the PRODUCTION web build (NO dev auth, the host-rewrite
// plugin on) served by ./server.ts with the Content-Security-Policy of
// docs/research/excalidraw/render.cutover.yaml.patch, against the REAL api + sync + preview worker (sync on
// the Excalidraw engine), in headless Chromium.
//
//   node e2e/spike/csp/run-cutover.ts [--run N] [--port-base 6430] [--reuse-build] [--dry-run] [--seed 1200]
//   (or: E2E_PORT_BASE=6430 pnpm --filter @draftroom/e2e csp:cutover)
//
// The port base is --port-base, else E2E_PORT_BASE, else 6430. A literal `--` leading the arguments is
// dropped (pnpm forwards the one in `pnpm csp:cutover -- --port-base N`). --dry-run prints the ports the
// run would use and exits, after the same unsafe-port check as every e2e run (tests/support/ports.ts).
//
// Ports: sync = base, api = base + 1, the CSP static server on base + 2 (the stack's WEB_PORT, so the api's
// Origin check matches). The header is the patch's, verbatim: the staging sync origin and Clerk's origins
// are unused here (the socket is same-origin through the server's tunnel, covered by 'self'; this stack
// signs in with the dev provider), and nothing else is added. When the patch file is not on this branch
// the copy below (as prepared 2026-09-30) is used.
//
// Flows, in one browser context, as a person (the production build has no facade and no debug handle):
//   1. sign-in: /signin → the dev quick pick "alice" → the dashboard
//   2. dashboard: the workspace page with its boards and the event stream
//   3. board: Lobby's Excalidraw board page /b/<id>, a board first seeded with --seed small shapes (1,200 by
//      default; 0 seeds none) through the real protocol (a forge socket in the page, before it opens the board),
//      so the reset welcome's snapshot frame is over the snapshot worker's 16 KiB floor (wave N, N1-1) and is
//      decoded in that module worker under the policy; the shapes sit in two small clusters at the far left and
//      right of the first visit's fit, clear of the points the flow clicks. Then a note by hand (N, a click,
//      typing, Escape, Saved), a free text by double-click, a PDF export (wave N, WS6: the PDF module worker, its
//      vector pages' font engine fetching Lobby's fonts), a wheel zoom and a pan, a reload and the note opened
//      again. The flow fails unless both workers started.
// Collected per flow: securitypolicyviolation events, console messages about CSP, report-uri bodies,
// requests to any non-local host (aborted before they leave), page errors. Exit 0 when every flow ran with
// 0 violations, 0 CSP console messages and 0 foreign requests. Report:
// e2e/test-results/spike-csp-cutover-<web port>/run-<N>.json (no board content: ids and counts only).
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import { type BrowserContext, chromium, type Page } from '@playwright/test'
import { checkElement, type WireElement } from '../../../packages/canvas-schema/src/elements.ts'
import { indexKeysBetween } from '../../../packages/canvas-schema/src/engine/index.ts'
import { GEN_UPDATED } from '../../load/boards.ts'
import { seedElements } from '../../load/seed.ts'
import { forgeSession } from '../../spike-b/support/forge.ts'
import { startCspServer } from './server.ts'

const argv = process.argv.slice(2)
if (argv[0] === '--') argv.shift()
const { values: args } = parseArgs({
  args: argv,
  options: {
    run: { type: 'string', default: '1' },
    'port-base': { type: 'string' },
    'reuse-build': { type: 'boolean', default: false },
    'dry-run': { type: 'boolean', default: false },
    seed: { type: 'string', default: '1200' },
  },
})
const SEED = Number(args.seed)
if (!Number.isInteger(SEED) || SEED < 0 || SEED > 5000)
  throw new Error(`--seed: 0 to 5000 shapes, not ${args.seed}`)
// the explicit option wins, then the variable every other e2e runner reads, then this runner's own range
process.env.E2E_PORT_BASE = args['port-base'] ?? (process.env.E2E_PORT_BASE || '6430')
const { API_PORT, HOST, SYNC_PORT, WEB_PORT, WEB_URL } = await import('../../tests/support/ports.ts')
if (args['dry-run']) {
  console.log(`csp-cutover ports: sync ${SYNC_PORT} api ${API_PORT} web ${WEB_PORT} (run ${args.run})`)
  process.exit(0)
}
const { REPO_ROOT, startStack } = await import('../../tests/support/stack.ts')

const started = Date.now()
const log = (s: string) =>
  console.log(`[csp-cutover ${((Date.now() - started) / 1000).toFixed(0).padStart(4)} s] ${s}`)
const OUT = join(REPO_ROOT, 'e2e', 'test-results', `spike-csp-cutover-${WEB_PORT}`)
mkdirSync(OUT, { recursive: true })
const DIST = `dist/csp-cutover-${WEB_PORT}`
const distDir = join(REPO_ROOT, 'apps/web', DIST)
const PATCH = join(REPO_ROOT, 'docs/research/excalidraw/render.cutover.yaml.patch')

/** The patch's CSP value as prepared 2026-09-30 on engine/w4-prep (used when the file is not here). */
const POLICY_2026_09_30 = [
  "default-src 'self'",
  "script-src 'self' https://splendid-flamingo-3744.clerk.accounts.dev https://challenges.cloudflare.com",
  "connect-src 'self' https://draftroom-staging-sync.onrender.com wss://draftroom-staging-sync.onrender.com https://splendid-flamingo-3744.clerk.accounts.dev https://clerk-telemetry.com",
  "img-src 'self' blob: data: https://img.clerk.com",
  "font-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "worker-src 'self' blob:",
  'frame-src https://challenges.cloudflare.com',
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ')

/**
 * The `Content-Security-Policy` header value in render.cutover.yaml.patch: the `value: >-` folded scalar
 * under `name: Content-Security-Policy` (each line a `+` patch line), folded with spaces as YAML does.
 */
export function policyFromPatch(patch: string): string | null {
  const lines = patch.split(/\r?\n/).map((l) => l.replace(/^[+ ]/, ''))
  const at = lines.findIndex((l) => /^\s*name:\s*Content-Security-Policy\s*$/.test(l))
  if (at < 0) return null
  const value = lines[at + 1]
  if (!value || !/^\s*value:\s*>-\s*$/.test(value)) return null
  const indent = /^\s*/.exec(value)?.[0].length ?? 0
  const body: string[] = []
  for (let i = at + 2; i < lines.length; i++) {
    const l = lines[i] ?? ''
    if (!l.trim()) break
    const lead = /^\s*/.exec(l)?.[0].length ?? 0
    if (lead <= indent) break
    body.push(l.trim())
  }
  return body.length ? body.join(' ').replace(/\s+/g, ' ') : null
}

const fromFile = existsSync(PATCH) ? policyFromPatch(readFileSync(PATCH, 'utf8')) : null
const POLICY = fromFile ?? POLICY_2026_09_30
const policySource = fromFile
  ? 'docs/research/excalidraw/render.cutover.yaml.patch'
  : 'embedded copy (2026-09-30)'

if (!args['reuse-build']) {
  log(`building apps/web (NO dev auth: the production build) into apps/web/${DIST}`)
  const env: NodeJS.ProcessEnv = { ...process.env }
  delete env.VITE_DRAFTROOM_SYNC_ORIGIN
  delete env.VITE_DRAFTROOM_DEV_AUTH
  delete env.VITE_LOBBY_BOARD_PAGE
  const b = spawnSync(`pnpm exec vite build --outDir ${DIST} --emptyOutDir`, {
    cwd: join(REPO_ROOT, 'apps/web'),
    env,
    shell: true,
    encoding: 'utf8',
    windowsHide: true,
  })
  if (b.status !== 0) throw new Error(`build failed:\n${b.stdout}\n${b.stderr}`)
}
const indexHtml = readFileSync(join(distDir, 'index.html'), 'utf8')
const inlineScripts = indexHtml.match(/<script(?![^>]*\bsrc=)[^>]*>/g) ?? []

log(`policy from ${policySource}`)
log(`starting api + sync + worker (sync ${SYNC_PORT}, api ${API_PORT}) and the CSP server on ${WEB_PORT}`)
const stack = await startStack({ engine: 'excalidraw' })
const server = await startCspServer({
  root: distDir,
  port: WEB_PORT,
  host: HOST,
  api: { host: HOST, port: API_PORT },
  sync: { host: HOST, port: SYNC_PORT },
  policy: POLICY,
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

async function newContext() {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, baseURL: WEB_URL })
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
  const stepped =
    (notes.steps as { violations: Violation[] }[] | undefined)?.flatMap((s) => s.violations) ?? []
  const violations = [...stepped, ...((await takeViolations(page)) as Violation[])]
  page.removeAllListeners('console')
  page.removeAllListeners('pageerror')
  page.removeAllListeners('request')
  page.removeAllListeners('websocket')
  return { flow: name, ok, ...(error ? { error } : {}), violations, ...w, notes }
}

const attr = (page: Page, testId: string, name: string) =>
  page.evaluate(
    ([t, n]) => document.querySelector(`[data-testid="${t}"]`)?.getAttribute(n as string) ?? null,
    [testId, name],
  )

async function waitForAttr(page: Page, testId: string, name: string, value: string, timeout: number) {
  await page.waitForFunction(
    ([t, n, v]) => document.querySelector(`[data-testid="${t}"]`)?.getAttribute(n as string) === v,
    [testId, name, value],
    { timeout },
  )
}

async function signInFlow(page: Page, notes: Record<string, unknown>) {
  await page.goto('/signin')
  await step(page, notes, 'sign-in page')
  await page.getByTestId('signin-quick-alice').click()
  await page.waitForURL((u) => !u.pathname.startsWith('/signin'), { timeout: 30_000 })
  // the dashboard keeps an event stream open (never network-idle): wait for it to render instead
  await page.getByTestId('dashboard-bell').waitFor({ timeout: 30_000 })
  await page.waitForTimeout(1500)
  notes.landedOn = new URL(page.url()).pathname
}

/** A board in the signed-in user's first workspace, through the api as the browser would. */
async function createBoard(context: BrowserContext): Promise<string> {
  const req = context.request
  const me = (await (await req.get('/api/me')).json()) as { workspaces: { id: string; name: string }[] }
  const ws = me.workspaces.find((w) => w.name === 'Dev Studio') ?? me.workspaces[0]
  if (!ws) throw new Error('no workspace')
  const board = (await (
    await req.post(`/api/workspaces/${ws.id}/boards`, {
      headers: { origin: WEB_URL },
      data: { title: 'CSP cut-over board' },
    })
  ).json()) as { id: string }
  return board.id
}

async function dashboardFlow(page: Page, notes: Record<string, unknown>) {
  await page.goto('/')
  await page.getByTestId('dashboard').waitFor({ timeout: 30_000 })
  await page.getByTestId('dashboard-bell').waitFor({ timeout: 30_000 })
  await page.waitForTimeout(1500)
  await step(page, notes, 'dashboard (boards, the event stream)')
  notes.boards = await page.evaluate(() => document.querySelectorAll('[data-testid="board-card"]').length)
}

const TEXT_EDITOR = 'textarea.excalidraw-wysiwyg'

/** The snapshot worker's floor, gzip bytes (apps/web canvas/sync/transport/snapshot-decoder.ts WORKER_MIN_BYTES). */
const SNAPSHOT_WORKER_MIN_BYTES = 16 * 1024

/**
 * `count` small filled squares in two clusters 6,000 px apart (half each, a 10 px grid), every one passing
 * canvas-schema's checkElement: a first visit fits them at about 20 %, at the canvas's far left and right, so the
 * points the flow clicks (40 % to 80 % across) stay empty canvas. Distinct ids, seeds and nonces keep the snapshot
 * frame's gzip size well over the snapshot worker's floor (about 60 bytes a shape).
 */
function seedShapes(boardId: string, count: number): WireElement[] {
  const p = boardId.replace(/[^A-Za-z0-9]/g, '').slice(0, 12) || 'b'
  const keys = indexKeysBetween(null, null, count)
  const fills = ['#a5d8ff', '#b2f2bb', '#ffec99', '#ffc9c9']
  return Array.from({ length: count }, (_, s) => {
    const cluster = s % 2
    const k = Math.floor(s / 2)
    const el = {
      id: `${p}-csp${s}`,
      type: 'rectangle',
      x: cluster * 6000 + (k % 30) * 10,
      y: Math.floor(k / 30) * 10,
      width: 6,
      height: 6,
      angle: 0,
      strokeColor: '#1e1e1e',
      backgroundColor: fills[s % fills.length],
      fillStyle: 'solid',
      strokeWidth: 1,
      strokeStyle: 'solid',
      roundness: null,
      roughness: 0,
      opacity: 100,
      seed: 50_000 + s,
      version: 1,
      versionNonce: 70_000 + s * 7,
      isDeleted: false,
      groupIds: [],
      frameId: null,
      boundElements: null,
      updated: GEN_UPDATED,
      created: GEN_UPDATED,
      link: null,
      locked: false,
      index: keys[s] as string,
    } as unknown as WireElement
    const check = checkElement(el)
    if (!check.ok) throw new Error(`seed shape ${el.id} fails the element schema: ${check.detail}`)
    return el
  })
}

/** Seeds the board through the real protocol from `page` (signed in, on Lobby's origin), before it is opened. */
async function seedBoard(page: Page, notes: Record<string, unknown>, boardId: string) {
  const t0 = Date.now()
  const shapes = seedShapes(boardId, SEED)
  const { socket, welcome } = await forgeSession(page, boardId)
  try {
    const pushed = await seedElements(socket, shapes, welcome.clock)
    if (pushed.ok !== pushed.ops)
      throw new Error(`seeding: ${pushed.ops - pushed.ok} of ${pushed.ops} creates refused`)
  } finally {
    await socket.close()
  }
  notes.seeded = { shapes: shapes.length, ms: Date.now() - t0 }
  await step(page, notes, `seed ${shapes.length} shapes (a forge socket in the page, the real protocol)`)
}

/** The module workers a page starts, by their bundle path without the hash (`/assets/pdf.worker.js`). */
function watchWorkers(page: Page): string[] {
  const started: string[] = []
  page.on('worker', (w) => started.push(new URL(w.url()).pathname.replace(/-[\w-]+\.js$/, '.js')))
  return started
}

/** The largest binary frame (the reset welcome's snapshot) each board socket of `page` receives, bytes. */
function watchSnapshotFrames(page: Page): { largest: number } {
  const seen = { largest: 0 }
  page.on('websocket', (ws) => {
    if (!new URL(ws.url()).pathname.startsWith('/connect/')) return
    ws.on('framereceived', (f) => {
      if (typeof f.payload !== 'string') seen.largest = Math.max(seen.largest, f.payload.length)
    })
  })
  return seen
}

async function boardFlow(page: Page, notes: Record<string, unknown>, boardId: string) {
  if (SEED > 0) await seedBoard(page, notes, boardId)
  const startedWorkers = watchWorkers(page)
  const snapshot = watchSnapshotFrames(page)
  await page.goto(`/b/${boardId}`)
  await waitForAttr(page, 'lobby-board', 'data-phase', 'ready', 60_000)
  notes.engine = await attr(page, 'lobby-board', 'data-engine')
  await waitForAttr(page, 'conn-status', 'data-state', 'online', 30_000)
  await page.waitForTimeout(800)
  notes.snapshotFrameBytes = snapshot.largest
  notes.workersAfterOpen = [...startedWorkers]
  // wave N (WS1, N1-1): the reset welcome's snapshot over the floor is decoded in the snapshot module worker
  // (zod jitless, so under the policy without 'unsafe-eval'; a violation inside the worker reaches report-uri)
  if (SEED > 0) {
    if (snapshot.largest < SNAPSHOT_WORKER_MIN_BYTES)
      throw new Error(`the snapshot frame (${snapshot.largest} B) is under the worker's floor`)
    if (!startedWorkers.includes('/assets/snapshot.worker.js'))
      throw new Error('the snapshot worker did not start')
  }
  await step(page, notes, 'board open (engine mounted, fonts, the socket welcome, the snapshot worker)')
  const box = await page.locator('[data-lobby-board-canvas]').boundingBox()
  if (!box) throw new Error('no board canvas')
  // a note by hand: focus the canvas, N, a click; the editor opens, text, Escape, Saved
  await page.mouse.click(box.x + box.width * 0.8, box.y + box.height * 0.75)
  await page.waitForFunction(() => !!document.activeElement?.closest('.excalidraw'), null, { timeout: 5000 })
  await page.keyboard.press('n')
  const at = { x: box.x + box.width * 0.4, y: box.y + box.height * 0.45 }
  await page.mouse.click(at.x, at.y)
  await page.waitForSelector(TEXT_EDITOR, { timeout: 10_000 })
  await page.waitForFunction(
    (sel) => {
      const ta = document.querySelector<HTMLTextAreaElement>(sel)
      return !!ta && document.activeElement === ta && !ta.readOnly
    },
    TEXT_EDITOR,
    { timeout: 10_000 },
  )
  await page.keyboard.type('CSP note', { delay: 15 })
  await page.keyboard.press('Escape')
  await waitForAttr(page, 'save-status', 'data-state', 'saved', 30_000)
  await page.waitForTimeout(700)
  notes.saveAfterNote = await attr(page, 'save-status', 'data-state')
  await step(page, notes, 'a note by hand (N, click, the text editor, Saved)')
  // a free text by double-click on empty canvas
  await page.mouse.dblclick(box.x + box.width * 0.7, box.y + box.height * 0.3)
  await page.waitForSelector(TEXT_EDITOR, { timeout: 10_000 })
  await page.waitForFunction(
    (sel) => {
      const ta = document.querySelector<HTMLTextAreaElement>(sel)
      return !!ta && document.activeElement === ta && !ta.readOnly
    },
    TEXT_EDITOR,
    { timeout: 10_000 },
  )
  await page.keyboard.type('Free text under CSP', { delay: 15 })
  await page.keyboard.press('Escape')
  await waitForAttr(page, 'save-status', 'data-state', 'saved', 30_000)
  await step(page, notes, 'a free text by double-click')
  // wave N (WS6, N6-1): a PDF export: the PDF module worker (@cantoo/pdf-lib, and for its vector pages the font
  // engine fetching Lobby's fonts) runs under the policy (a violation inside the worker reaches report-uri). A click
  // on empty canvas first: with nothing selected the page is the whole board (the seeded shapes and both notes)
  await page.mouse.click(box.x + box.width * 0.55, box.y + box.height * 0.8)
  await page.getByTestId('main-menu.button').click()
  await page.getByTestId('main-menu-sub.export-button').click()
  await page.getByTestId('main-menu.export-dialog').click()
  const exportDialog = page.getByTestId('export-dialog')
  await exportDialog.waitFor({ timeout: 10_000 })
  notes.pdfSummary = await exportDialog.getByTestId('export-pdf-summary').textContent()
  const vectorChoice = exportDialog.getByTestId('export-pdf-pages-vector')
  notes.pdfPages = (await vectorChoice.count()) && (await vectorChoice.isChecked()) ? 'vector' : 'image'
  const [pdf] = await Promise.all([
    page.waitForEvent('download', { timeout: 60_000 }),
    exportDialog.getByTestId('export-pdf').click(),
  ])
  await page.waitForFunction(
    () => /^Downloaded/.test(document.querySelector('[data-testid="export-status"]')?.textContent ?? ''),
    null,
    { timeout: 60_000 },
  )
  const pdfBytes = readFileSync(await pdf.path())
  const header = pdfBytes.subarray(0, 5).toString('latin1')
  const fallbackNote = exportDialog.getByTestId('export-pdf-fallback')
  // sizes and the dialog's words only (no board content in the report)
  notes.pdf = {
    name: pdf.suggestedFilename(),
    status: await exportDialog.getByTestId('export-status').textContent(),
    bytes: pdfBytes.length,
    header,
    fallback: (await fallbackNote.count()) ? await fallbackNote.textContent() : null,
  }
  // the worker started (it is terminated once the file is made, so it is counted as it starts)
  notes.pdfWorkers = [...startedWorkers]
  if (!startedWorkers.includes('/assets/pdf.worker.js')) throw new Error('the PDF worker did not start')
  if (header !== '%PDF-') throw new Error('the download is not a PDF')
  await page.keyboard.press('Escape')
  await step(page, notes, 'a PDF export (the PDF worker, its font engine)')
  // wheel zoom and pan
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await page.keyboard.down('Control')
  await page.mouse.wheel(0, -300)
  await page.keyboard.up('Control')
  await page.mouse.wheel(0, 200)
  await page.waitForTimeout(500)
  await step(page, notes, 'wheel zoom and pan')
  // a reload: the camera is kept, the note is on the server
  await page.reload()
  await waitForAttr(page, 'lobby-board', 'data-phase', 'ready', 60_000)
  await waitForAttr(page, 'save-status', 'data-state', 'saved', 30_000)
  await page.waitForTimeout(800)
  await step(page, notes, 'reload')
  notes.save = await attr(page, 'save-status', 'data-state')
  notes.conn = await attr(page, 'conn-status', 'data-state')
  notes.debugHandles = await page.evaluate(() =>
    ['__lobbyBoard', 'lobbyCanvas', '__lobbyHarness', 'editor'].filter((k) => k in window),
  )
  notes.workers = [...new Set(startedWorkers)]
}

let flows: FlowResult[] = []
try {
  const context = await newContext()
  const page = await context.newPage()
  flows.push(await flow('sign-in', page, (n) => signInFlow(page, n)))
  flows.push(await flow('dashboard', page, (n) => dashboardFlow(page, n)))
  const boardId = await createBoard(context)
  flows.push(await flow('board', page, (n) => boardFlow(page, n, boardId)))
  await context.close()
  for (const f of flows) {
    log(
      `${f.flow}: ${f.ok ? 'ran' : `FAILED (${f.error})`}; ${f.violations.length} violation event(s) ` +
        `[${[...new Set(f.violations.map((v) => `${v.directive} ${v.blocked}`))].join(' | ')}]; ${f.cspConsole.length} CSP console; ` +
        `${f.foreign.length} foreign; ${f.pageErrors.length} page errors`,
    )
  }
  log(`${server.reports.length} report-uri bodies`)
} catch (e) {
  flows = [
    ...flows,
    {
      flow: 'harness',
      ok: false,
      error: String(e).slice(0, 500),
      violations: [],
      cspConsole: [],
      consoleErrors: [],
      pageErrors: [],
      foreign: [],
      notes: {},
    },
  ]
} finally {
  await browser.close()
  await server.close()
  await stack.stop()
}

const pass =
  flows.length === 3 &&
  inlineScripts.length === 0 &&
  flows.every(
    (f) => f.ok && f.violations.length === 0 && f.cspConsole.length === 0 && f.foreign.length === 0,
  ) &&
  server.reports.length === 0
const report = {
  at: new Date().toISOString(),
  run: args.run,
  build: 'no dev auth (production), host rewrite on',
  policySource,
  policy: POLICY,
  inlineScriptsInIndexHtml: inlineScripts,
  flows,
  reportUriBodies: server.reports,
  serverLog: server.log.filter(
    (l) =>
      l.status >= 400 ||
      l.path.startsWith('/excalidraw-assets/') ||
      l.path === '/theme-boot.js' ||
      l.path === '/zod-jitless.js',
  ),
  pass,
}
const file = join(OUT, `run-${args.run}.json`)
writeFileSync(file, JSON.stringify(report, null, 2))
log(
  `${pass ? 'PASS' : 'FAIL'}: the patch's CSP on the production engine build, sign-in + dashboard + board: ` +
    `0 violations, 0 CSP console messages, 0 foreign requests, 0 report-uri bodies, no inline script required. report: ${file}`,
)
process.exit(pass ? 0 : 1)
