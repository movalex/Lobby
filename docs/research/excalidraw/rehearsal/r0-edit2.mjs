#!/usr/bin/env node
// R0-side edits, second pass (the frame drag landed in r0-edit.mjs): drag a note without a preceding click
// (a click then a drag 300 ms later read as a double-click into text editing), then add a note by
// duplicating a selected one (Ctrl+D, tldraw's duplicate) and, as a second attempt, with the N tool.
// Verified afterwards by the R0 sync's internal snapshot (record counts and positions; ids only here).
//
//   node r0-edit2.mjs --base https://192.168.10.1:8443 --token-file session.token --board b-… --note <N3 id>
//        [--dx 60 --dy 40] [--json out.json]
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
const result = { boardId: a.board, note: a.note, delta: { x: DX, y: DY }, steps: [] }
const step = (name, extra = {}) => {
  const row = { name, at: Date.now() - t0, ...extra }
  result.steps.push(row)
  console.log('step', JSON.stringify(row))
}
const saved = () =>
  page.waitForFunction(
    () => document.querySelector('[data-testid="save-status"]')?.getAttribute('data-state') === 'saved',
    undefined,
    { timeout: 20_000 },
  )
const shapeBox = async (id) => {
  const loc = page.locator(`.tl-shape[data-shape-id="shape:${id}"]`)
  if ((await loc.count()) === 0) throw new Error(`shape ${id} not in the DOM`)
  const box = await loc.first().boundingBox()
  if (!box) throw new Error(`shape ${id} has no box`)
  return box
}
const shapes = () => page.locator('.tl-shape').count()
const editing = () => page.locator('.tl-text-input, textarea.tl-text-input, [contenteditable="true"]').count()
try {
  await page.goto(`${BASE.origin}/b/${a.board}`, { waitUntil: 'load', timeout: 45_000 })
  await page.waitForSelector('[data-testid="conn-status"][data-state="online"]', { timeout: 45_000 })
  await saved()
  await page.waitForSelector('.tl-shape', { timeout: 30_000 })
  await page.waitForTimeout(1500)
  const canvas = page.locator('.tl-canvas').first()
  const cbox = await canvas.boundingBox()
  // an empty spot: the bottom-right corner of the viewport before zoom-to-fit spreads the content
  const empty = { x: cbox.x + cbox.width - 60, y: cbox.y + cbox.height - 60 }
  await page.mouse.click(empty.x, empty.y)
  await page.keyboard.press('Shift+1')
  await page.waitForTimeout(800)
  step('board open, zoomed to fit', { shapes: await shapes() })

  // 1. the note: one pointer gesture, no click first
  await page.keyboard.press('Escape')
  const nbox = await shapeBox(a.note)
  const c = { x: nbox.x + nbox.width / 2, y: nbox.y + nbox.height / 2 }
  await page.mouse.move(c.x, c.y)
  await page.mouse.down()
  await page.waitForTimeout(120)
  await page.mouse.move(c.x + DX / 3, c.y + DY / 3, { steps: 5 })
  await page.mouse.move(c.x + DX, c.y + DY, { steps: 10 })
  await page.waitForTimeout(120)
  await page.mouse.up()
  await saved()
  await page.waitForTimeout(400)
  const nbox2 = await shapeBox(a.note)
  const d = { x: Math.round(nbox2.x - nbox.x), y: Math.round(nbox2.y - nbox.y) }
  step('note dragged', { screenDelta: d, editing: await editing() })
  result.noteMoved = Math.abs(d.x - DX) <= 3 && Math.abs(d.y - DY) <= 3

  // 2. a new note: the dragged note is selected; Ctrl+D duplicates it
  const before = await shapes()
  await page.keyboard.press('Control+d')
  await saved()
  await page.waitForTimeout(600)
  const afterDup = await shapes()
  step('duplicate with Ctrl+D', { shapesBefore: before, shapesAfter: afterDup })
  result.duplicated = afterDup === before + 1

  // 3. a second attempt with the N tool on an empty spot (Escape clears the selection first)
  await page.keyboard.press('Escape')
  await page.keyboard.press('Escape')
  const before2 = await shapes()
  await page.keyboard.press('n')
  await page.waitForTimeout(250)
  const toolBtn = await page.locator('[data-testid="tools.note"][aria-pressed="true"], [data-testid="tools.note"][data-state="selected"]').count()
  await page.mouse.click(empty.x - 160, empty.y - 120)
  await page.waitForTimeout(600)
  const typed = (await editing()) > 0
  if (typed) {
    await page.keyboard.type('Rehearsal note R (tldraw side)')
    await page.keyboard.press('Escape')
  }
  await page.keyboard.press('Escape')
  await saved()
  await page.waitForTimeout(500)
  const after2 = await shapes()
  step('note with the N tool', { toolPressed: toolBtn, editorOpened: typed, shapesBefore: before2, shapesAfter: after2 })
  result.nToolAdded = after2 === before2 + 1
  result.ok = result.noteMoved && (result.duplicated || result.nToolAdded) && errors.length === 0
} catch (e) {
  result.ok = false
  result.error = String(e.message).slice(0, 200)
  console.log('ERROR', result.error)
}
result.pageErrors = errors.length
result.ms = Date.now() - t0
result.saveState = await page.locator('[data-testid="save-status"]').first().getAttribute('data-state').catch(() => null)
await page.waitForTimeout(800)
await context.close()
await browser.close()
if (a.json) writeFileSync(a.json, JSON.stringify(result, null, 2) + '\n')
console.log(result.ok ? 'OK' : 'FAILED', JSON.stringify({ ms: result.ms, saveState: result.saveState, pageErrors: result.pageErrors, noteMoved: result.noteMoved, duplicated: result.duplicated, nToolAdded: result.nToolAdded }))
process.exit(result.ok ? 0 : 1)
