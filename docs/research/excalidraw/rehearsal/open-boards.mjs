#!/usr/bin/env node
// Rehearsal check: opens boards in headless Chromium (Playwright from the main checkout's e2e/) with the
// rehearsal-local session cookie, and reports ids, states, counts and timings only. No screenshot, no
// trace, no video, no board text.
//
//   node open-boards.mjs --base https://192.168.10.1:8443 --token-file session.token
//        --boards b-1,b-2 --expect r0|excalidraw|maintenance|new-canvas [--dashboard] [--hold-ms 7000] [--json out]
import { readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'

const REPO = process.env.LOBBY_REPO_ROOT ?? 'C:/Users/Chase/Documents/GitHub/Draftroom'
const { values: a } = parseArgs({
  options: {
    base: { type: 'string' },
    'token-file': { type: 'string' },
    boards: { type: 'string', default: '' },
    expect: { type: 'string', default: 'excalidraw' },
    dashboard: { type: 'boolean', default: false },
    'hold-ms': { type: 'string', default: '4000' },
    json: { type: 'string' },
    timeout: { type: 'string', default: '45000' },
  },
})
if (!a.base || !a['token-file']) {
  console.error('usage: --base <url> --token-file <file> [--boards a,b] [--expect ...] [--dashboard]')
  process.exit(2)
}
const BASE = new URL(a.base)
const token = readFileSync(a['token-file'], 'utf8').trim()
const HOLD = Number(a['hold-ms'])
const TIMEOUT = Number(a.timeout)
const req = createRequire(new URL('e2e/package.json', pathToFileURL(REPO + '/')))
const pwMod = await import(pathToFileURL(req.resolve('@playwright/test')))
const { chromium } = pwMod.default ?? pwMod
const browser = await chromium.launch({ headless: true })
const out = { at: new Date().toISOString(), base: BASE.origin, expect: a.expect, dashboard: null, boards: [] }
const short = (s, n = 100) => (s.length > n ? s.slice(0, n) + '…' : s)

async function newPage() {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, ignoreHTTPSErrors: true })
  await context.addCookies([
    { name: 'dr_session', value: token, domain: BASE.hostname, path: '/', secure: true, httpOnly: true, sameSite: 'Lax' },
  ])
  await context.addInitScript(() => {
    const list = []
    Object.defineProperty(window, '__csp', { value: list })
    document.addEventListener('securitypolicyviolation', (e) =>
      list.push(`${e.effectiveDirective} ${e.blockedURI} ${(e.sourceFile ?? '').slice(-40)}:${e.lineNumber ?? 0}`),
    )
  })
  const page = await context.newPage()
  const rec = { consoleErrors: [], pageErrors: [], hosts: new Map(), failed: [], fonts: { ok: 0, bad: 0 }, assets404: 0 }
  page.on('console', (m) => {
    if (m.type() === 'error') rec.consoleErrors.push(short(m.text(), 140))
  })
  page.on('pageerror', (e) => rec.pageErrors.push(short(String(e), 140)))
  page.on('request', (r) => {
    try {
      const u = new URL(r.url())
      if (['data:', 'blob:', 'about:'].includes(u.protocol)) return
      rec.hosts.set(u.hostname, (rec.hosts.get(u.hostname) ?? 0) + 1)
    } catch {}
  })
  page.on('response', (r) => {
    const u = r.url()
    if (u.includes('/excalidraw-assets/')) {
      if (r.status() === 200) rec.fonts.ok++
      else {
        rec.fonts.bad++
        if (r.status() === 404) rec.assets404++
      }
    }
  })
  page.on('requestfailed', (r) => rec.failed.push(short(r.url().replace(/\?.*$/, '?…'), 100) + ' ' + (r.failure()?.errorText ?? '')))
  return { context, page, rec }
}

const finish = async ({ context, page, rec }) => {
  const csp = await page.evaluate(() => window.__csp ?? []).catch(() => [])
  await context.close()
  return {
    cspViolations: csp.length,
    cspSample: csp.slice(0, 3),
    consoleErrors: rec.consoleErrors.length,
    consoleSample: rec.consoleErrors.slice(0, 2),
    pageErrors: rec.pageErrors.length,
    pageErrorSample: rec.pageErrors.slice(0, 2),
    failedRequests: rec.failed.length,
    failedSample: rec.failed.slice(0, 3),
    hosts: Object.fromEntries([...rec.hosts].sort((x, y) => y[1] - x[1])),
    fonts: rec.fonts,
  }
}

if (a.dashboard) {
  const s = await newPage()
  const t0 = Date.now()
  let r = { ok: false }
  try {
    const resp = await s.page.goto(`${BASE.origin}/`, { waitUntil: 'load', timeout: TIMEOUT })
    await s.page.waitForSelector('[data-testid="dashboard"], [data-testid="signin-page"]', { timeout: TIMEOUT })
    const signin = await s.page.locator('[data-testid="signin-page"]').count()
    if (!signin) {
      await s.page.waitForSelector('[data-testid="board-card"], [data-testid="dashboard-empty"]', { timeout: TIMEOUT })
      await s.page.waitForTimeout(1000)
    }
    r = {
      ok: !signin,
      status: resp?.status() ?? 0,
      ms: Date.now() - t0,
      url: new URL(s.page.url()).pathname,
      signedIn: !signin,
      boardCards: await s.page.locator('[data-testid="board-card"]').count(),
      newCanvasBadges: await s.page.locator('[data-testid="board-card-new-canvas"]').count(),
    }
  } catch (e) {
    r = { ok: false, error: short(e.message, 160), ms: Date.now() - t0 }
  }
  out.dashboard = { ...r, ...(await finish(s)) }
  console.log('dashboard', JSON.stringify(out.dashboard))
}

for (const id of a.boards.split(',').map((x) => x.trim()).filter(Boolean)) {
  const s = await newPage()
  const t0 = Date.now()
  const row = { id, expect: a.expect }
  try {
    const resp = await s.page.goto(`${BASE.origin}/b/${id}`, { waitUntil: 'load', timeout: TIMEOUT })
    row.status = resp?.status() ?? 0
    // R0 shows a board the api marks as made on the new canvas as its own page (data-testid new-canvas-board,
    // before any socket); the Excalidraw build shows every terminal sync error as sync-error with a reason.
    const sel = '[data-testid="conn-status"][data-state="online"], [data-testid="sync-error"], [data-testid="new-canvas-board"], [data-testid="signin-page"]'
    await s.page.waitForSelector(sel, { timeout: TIMEOUT })
    row.msToState = Date.now() - t0
    if (await s.page.locator('[data-testid="signin-page"]').count()) row.outcome = 'signed-out'
    else if (await s.page.locator('[data-testid="new-canvas-board"]').count()) row.outcome = 'sync-error:NEW_CANVAS_BOARD'
    else if (await s.page.locator('[data-testid="sync-error"]').count()) {
      const reason = await s.page.locator('[data-testid="sync-error-reason"]').first().innerText().catch(() => '?')
      row.outcome = `sync-error:${reason.trim()}`
    } else {
      row.outcome = 'online'
      // "Saved": the save pill (both builds) settles after the welcome
      try {
        await s.page.waitForFunction(
          () => document.querySelector('[data-testid="save-status"]')?.getAttribute('data-state') === 'saved',
          undefined,
          { timeout: 20_000 },
        )
        row.saved = true
      } catch {
        row.saved = false
        row.saveState = await s.page.locator('[data-testid="save-status"]').first().getAttribute('data-state').catch(() => null)
      }
      row.msToSaved = Date.now() - t0
    }
    await s.page.waitForTimeout(HOLD)
    row.markers = {
      excalidraw: await s.page.locator('.excalidraw').count(),
      lobbyCanvas: await s.page.locator('[data-lobby-board-canvas]').count(),
      excalidrawCanvas: await s.page.locator('canvas.excalidraw__canvas').count(),
      tlContainer: await s.page.locator('.tl-container').count(),
      tlCanvas: await s.page.locator('.tl-canvas').count(),
      tlShapes: await s.page.locator('.tl-shape').count(),
      tlFrameHeadings: await s.page.locator('.tl-frame-heading').count(),
      connState: await s.page.locator('[data-testid="conn-status"]').first().getAttribute('data-state').catch(() => null),
      saveState: await s.page.locator('[data-testid="save-status"]').first().getAttribute('data-state').catch(() => null),
    }
    row.msTotal = Date.now() - t0
    const want = a.expect
    row.pass =
      want === 'maintenance'
        ? row.outcome === 'sync-error:MAINTENANCE'
        : want === 'new-canvas'
          ? row.outcome === 'sync-error:NEW_CANVAS_BOARD'
          : want === 'r0'
            ? row.outcome === 'online' && row.saved === true && row.markers.tlContainer > 0 && row.markers.tlCanvas > 0 && row.markers.excalidraw === 0
            : row.outcome === 'online' && row.saved === true && row.markers.lobbyCanvas > 0 && row.markers.excalidraw > 0 && row.markers.tlContainer === 0
  } catch (e) {
    row.outcome = 'error'
    row.error = short(e.message, 200)
    row.pass = false
    row.msTotal = Date.now() - t0
  }
  Object.assign(row, await finish(s))
  if (a.expect === 'excalidraw') row.pass = row.pass && row.cspViolations === 0
  out.boards.push(row)
  console.log(row.pass ? 'PASS' : 'FAIL', JSON.stringify(row))
}
await browser.close()
if (a.json) writeFileSync(a.json, JSON.stringify(out, null, 2) + '\n')
const failed = out.boards.filter((b) => !b.pass).length + (a.dashboard && !out.dashboard?.ok ? 1 : 0)
console.log(`${failed ? 'FAILED' : 'OK'}: ${out.boards.length} board(s), ${failed} failed; ${new Date().toISOString()}`)
process.exit(failed ? 1 : 0)
