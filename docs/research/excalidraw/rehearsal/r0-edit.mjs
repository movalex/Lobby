#!/usr/bin/env node
// R0-side edits for the drill (runbook R10 "edits on tldraw"; the task's step 6): in headless Chromium on
// the tldraw board page, through the real UI: a note added with the N tool, a frame dragged by its heading
// (R0 moves the frame whose child the Excalidraw side moved), and a note dragged (the same note the
// Excalidraw side moved: the same-group conflict). Verified by the records the R0 sync's internal snapshot
// shows (run from the NAS afterwards). Prints ids, deltas, counts and timings only.
//
//   node r0-edit.mjs --base https://192.168.10.1:8443 --token-file session.token --board b-… --frame <F2 id>
//        --note <N3 id> [--dx 60 --dy 40] [--json out.json]
import { readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'

const REPO = process.env.LOBBY_REPO_ROOT ?? 'C:/Users/Chase/Documents/GitHub/Draftroom'
const { values: a } = parseArgs({
  options: {
    base: { type: 'string' },
    'token-file': { type: 'string' },
    board: { type: 'string' },
    frame: { type: 'string' },
    note: { type: 'string' },
    dx: { type: 'string', default: '60' },
    dy: { type: 'string', default: '40' },
    json: { type: 'string' },
  },
})
const BASE = new URL(a.base)
const token = readFileSync(a['token-file'], 'utf8').trim()
const DX = Number(a.dx)
const DY = Number(a.dy)
const req = createRequire(new URL('e2e/package.json', pathToFileURL(REPO + '/')))
const pwMod = await import(pathToFileURL(req.resolve('@playwright/test')))
const { chromium } = pwMod.default ?? pwMod
const browser = await chromium.launch({ headless: true })
const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, ignoreHTTPSErrors: true })
await context.addCookies([
  { name: 'dr_session', value: token, domain: BASE.hostname, path: '/', secure: true, httpOnly: true, sameSite: 'Lax' },
])
const page = await context.newPage()
const errors = []
page.on('pageerror', (e) => errors.push(String(e).slice(0, 120)))
const t0 = Date.now()
const result = { boardId: a.board, frame: a.frame, note: a.note, delta: { x: DX, y: DY }, steps: [] }
const step = (name, extra = {}) => {
  const row = { name, at: Date.now() - t0, ...extra }
  result.steps.push(row)
  console.log('step', JSON.stringify(row))
}
const saved = async () => {
  await page.waitForFunction(
    () => document.querySelector('[data-testid="save-status"]')?.getAttribute('data-state') === 'saved',
    undefined,
    { timeout: 20_000 },
  )
}
const shapeBox = async (id) => {
  const loc = page.locator(`.tl-shape[data-shape-id="shape:${id}"]`)
  if ((await loc.count()) === 0) throw new Error(`shape ${id} not in the DOM`)
  const box = await loc.first().boundingBox()
  if (!box) throw new Error(`shape ${id} has no box`)
  return box
}
const drag = async (from, delta, steps = 12) => {
  await page.mouse.move(from.x, from.y)
  await page.mouse.down()
  await page.mouse.move(from.x + delta.x / 2, from.y + delta.y / 2, { steps: Math.ceil(steps / 2) })
  await page.mouse.move(from.x + delta.x, from.y + delta.y, { steps: Math.ceil(steps / 2) })
  await page.mouse.up()
}
try {
  await page.goto(`${BASE.origin}/b/${a.board}`, { waitUntil: 'load', timeout: 45_000 })
  await page.waitForSelector('[data-testid="conn-status"][data-state="online"]', { timeout: 45_000 })
  await saved()
  await page.waitForSelector('.tl-shape', { timeout: 30_000 })
  await page.waitForTimeout(1500)
  step('board open', { shapes: await page.locator('.tl-shape').count() })

  // zoom to fit so every shape is on screen (tldraw: shift+1)
  const canvas = page.locator('.tl-canvas').first()
  const cbox = await canvas.boundingBox()
  await page.mouse.click(cbox.x + cbox.width / 2, cbox.y + cbox.height / 2)
  await page.keyboard.press('Shift+1')
  await page.waitForTimeout(800)
  step('zoom to fit')

  // 1. the frame: drag by its heading (the heading is the frame's handle in tldraw's UI)
  const fbox = await shapeBox(a.frame)
  const heading = page.locator(`.tl-shape[data-shape-id="shape:${a.frame}"] .tl-frame-heading`).first()
  let from
  if (await heading.count()) {
    const hb = await heading.boundingBox()
    from = { x: hb.x + Math.min(hb.width / 2, 40), y: hb.y + hb.height / 2 }
  } else from = { x: fbox.x + fbox.width / 2, y: fbox.y + 2 }
  await page.keyboard.press('Escape')
  await drag(from, { x: DX, y: DY })
  await saved()
  const fbox2 = await shapeBox(a.frame)
  step('frame dragged by its heading', { screenDelta: { x: Math.round(fbox2.x - fbox.x), y: Math.round(fbox2.y - fbox.y) } })

  // 2. the note: drag from its centre (the note the Excalidraw side moved too)
  await page.keyboard.press('Escape')
  const nbox = await shapeBox(a.note)
  await page.mouse.click(nbox.x + nbox.width / 2, nbox.y + nbox.height / 2)
  await page.waitForTimeout(300)
  await drag({ x: nbox.x + nbox.width / 2, y: nbox.y + nbox.height / 2 }, { x: DX, y: DY })
  await saved()
  const nbox2 = await shapeBox(a.note)
  step('note dragged', { screenDelta: { x: Math.round(nbox2.x - nbox.x), y: Math.round(nbox2.y - nbox.y) } })

  // 3. a new note with the N tool on an empty spot (bottom-right of the viewport, away from the content)
  await page.keyboard.press('Escape')
  const before = await page.locator('.tl-shape').count()
  const spot = { x: cbox.x + cbox.width - 180, y: cbox.y + cbox.height - 160 }
  await page.keyboard.press('n')
  await page.waitForTimeout(200)
  await page.mouse.click(spot.x, spot.y)
  await page.waitForTimeout(500)
  await page.keyboard.type('Rehearsal note R (tldraw side)')
  await page.keyboard.press('Escape')
  await page.keyboard.press('Escape')
  await saved()
  await page.waitForTimeout(500)
  const after = await page.locator('.tl-shape').count()
  step('note added with N', { shapesBefore: before, shapesAfter: after })
  result.ok = after === before + 1 && errors.length === 0
} catch (e) {
  result.ok = false
  result.error = String(e.message).slice(0, 200)
  console.log('ERROR', result.error)
}
result.pageErrors = errors.length
result.ms = Date.now() - t0
result.saveState = await page.locator('[data-testid="save-status"]').first().getAttribute('data-state').catch(() => null)
await page.waitForTimeout(1000)
await context.close()
await browser.close()
if (a.json) writeFileSync(a.json, JSON.stringify(result, null, 2) + '\n')
console.log(result.ok ? 'OK' : 'FAILED', JSON.stringify({ ms: result.ms, saveState: result.saveState, pageErrors: result.pageErrors }))
process.exit(result.ok ? 0 : 1)
