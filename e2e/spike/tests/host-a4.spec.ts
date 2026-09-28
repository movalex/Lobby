import { expect, type Page, test } from '@playwright/test'
import type { SpikeRole } from '../support/spike-global.ts'
import { filePickerCalls, instrumentFilePickers, watchPage } from '../support/watch.ts'
import {
  addNote,
  clipboardCalls,
  elements,
  focusCanvas,
  instrumentClipboard,
  lab,
  openLab,
  resetLab,
  select,
  toClient,
  versions,
} from './host-kit.ts'

// A4 (docs/EXCALIDRAW-MIGRATION.md §8.2, §2.3.3, §2.7): the `interaction` config for read-only roles
// (commenter, viewer, limited guest). Pan, zoom, links and custom tools work; keys, clipboard and drop
// do nothing; Lobby's own pointer listener reports the cursor with no tool selected while Excalidraw's
// onPointerUpdate stays silent. Scripted per role. Guests run with the export policy "deny" (Lobby's
// capture copy listener blocks); commenters and viewers with "allow" (Lobby lets copy through and
// Excalidraw still writes nothing: its copy/cut/paste listeners are not even registered for a
// non-interactive editor, dist/dev/index.js:49243-49337).

const settle = (page: Page, ms = 120) =>
  page.evaluate(
    (t) =>
      new Promise<void>((r) =>
        requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(() => r(), t))),
      ),
    ms,
  )

const view = (page: Page) =>
  page.evaluate(() => {
    const s = window.__lobbySpike?.api?.getAppState()
    return { scrollX: s?.scrollX ?? 0, scrollY: s?.scrollY ?? 0, zoom: s?.zoom.value ?? 0 }
  })

const LINK = 'https://example.com/lobby-doc'

async function buildScene(page: Page): Promise<void> {
  await resetLab(page)
  await addNote(page, { id: 'n1', x: 120, y: 120, size: 200, text: 'Read only' })
  await lab(
    page,
    (x, link) =>
      x.fixture.add([
        {
          type: 'rectangle',
          id: 'lnk',
          x: 420,
          y: 140,
          width: 160,
          height: 100,
          backgroundColor: '#a5d8ff',
          link,
        },
      ]),
    LINK,
  )
}

/** Dispatches a synthetic clipboard event on the focused element; returns what Excalidraw left in it. */
async function clipboardEvent(page: Page, type: 'copy' | 'cut' | 'paste') {
  return page.evaluate((t) => {
    const dt = new DataTransfer()
    if (t === 'paste') {
      dt.setData('text/plain', 'pasted from outside')
    }
    const ev = new ClipboardEvent(t, { clipboardData: dt, bubbles: true, cancelable: true })
    const target = document.activeElement ?? document.body
    target.dispatchEvent(ev)
    return { types: [...dt.types], prevented: ev.defaultPrevented, target: target.className }
  }, type)
}

async function dropFile(page: Page, at: { x: number; y: number }) {
  return page.evaluate((p) => {
    const dt = new DataTransfer()
    const png = Uint8Array.from(
      atob(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
      ),
      (c) => c.charCodeAt(0),
    )
    dt.items.add(new File([png], 'dropped.png', { type: 'image/png' }))
    dt.setData('text/plain', 'dropped text')
    const target = document.elementFromPoint(p.x, p.y) ?? document.body
    const opts = { dataTransfer: dt, bubbles: true, cancelable: true, clientX: p.x, clientY: p.y }
    const over = new DragEvent('dragover', opts)
    target.dispatchEvent(new DragEvent('dragenter', opts))
    target.dispatchEvent(over)
    const drop = new DragEvent('drop', opts)
    target.dispatchEvent(drop)
    return {
      overPrevented: over.defaultPrevented,
      dropPrevented: drop.defaultPrevented,
      target: target.tagName,
    }
  }, at)
}

const KEYS = [
  'Delete',
  'Backspace',
  'ArrowLeft',
  'ArrowDown',
  'Control+d',
  'Control+a',
  'Control+z',
  'Control+Shift+Z',
  'Control+y',
  'Control+g',
  'Enter',
  'n',
  't',
  'r',
  'x',
  '2',
  'Control+s',
  'Control+Shift+S',
  'Control+o',
  'Alt+Shift+C',
  'Control+Shift+E',
  'Control+x',
  'Control+c',
  'Control+v',
  'Control+Alt+c',
  'Shift+H',
  'Tab',
  '?',
  'Escape',
]

for (const role of ['commenter', 'viewer', 'guest'] as SpikeRole[]) {
  test(`A4 ${role}: pan, zoom, links, custom tools work; keys, clipboard, drop do nothing; presence from Lobby's listener`, async ({
    page,
  }) => {
    test.setTimeout(120_000)
    await instrumentFilePickers(page)
    await instrumentClipboard(page)
    const watch = watchPage(page)
    await openLab(page, { toolbar: true, copy: role === 'guest' ? 'deny' : 'allow' }, { role })
    await buildScene(page)
    const report: Record<string, unknown> = { role }
    const interaction = await page.evaluate(() => {
      const c = document.querySelector('.excalidraw')?.className ?? ''
      return {
        nonInteractive: c.includes('excalidraw--non-interactive'),
        navigation: c.includes('excalidraw--navigation'),
      }
    })
    report.interaction = interaction

    // --- presence: Lobby's listener with NO tool selected; Excalidraw's onPointerUpdate stays silent.
    await lab(page, (x) => {
      x.presence.length = 0
      x.pointerUpdates.length = 0
    })
    const a = await toClient(page, 700, 420)
    const b = await toClient(page, 900, 520)
    await page.mouse.move(a.x, a.y)
    const t0 = Date.now()
    await page.mouse.move(b.x, b.y, { steps: 30 })
    await page.waitForTimeout(120)
    const moveMs = Date.now() - t0
    const pres = await lab(page, (x) => ({
      samples: x.presence.length,
      last: x.presence.at(-1),
      updates: x.pointerUpdates.length,
      tool: x.appSnap().activeTool,
    }))
    const hz = pres.samples / ((moveMs + 120) / 1000)
    report.presenceNoTool = { ...pres, moveMs, hz: Math.round(hz) }
    expect(pres.tool).toBe('selection:')
    expect(pres.samples).toBeGreaterThan(0)
    expect(pres.updates, 'onPointerUpdate silent for a read-only role with no tool').toBe(0)
    expect(Math.abs(pres.last.pointer.x - 900)).toBeLessThanOrEqual(1)
    expect(Math.abs(pres.last.pointer.y - 520)).toBeLessThanOrEqual(1)
    expect(hz, 'throttled to about 20 Hz').toBeLessThanOrEqual(26)
    // Leaving the board (onto Lobby's toolbar, outside the wrapper) sends pointer: null.
    const bar = await page.getByTestId('lobby-toolbar').boundingBox()
    if (!bar) throw new Error('no toolbar')
    await page.mouse.move(bar.x + 8, bar.y + bar.height / 2, { steps: 4 })
    await page.waitForTimeout(80)
    const leave = await lab(page, (x) => x.presence.at(-1))
    report.presenceLeave = leave
    expect(leave).toMatchObject({ pointer: null, source: 'pointerleave' })
    // Contrast (engine behaviour): with a custom tool active, Excalidraw does call onPointerUpdate.
    await lab(page, (x) => x.tools.setTool('comment'))
    await page.mouse.move(a.x, a.y)
    await page.mouse.move(b.x, b.y, { steps: 10 })
    report.pointerUpdatesWithCustomTool = await lab(page, (x) => x.pointerUpdates.length)
    // Engine behaviour: Excalidraw's own setActiveTool refuses the SELECTION tool for a read-only role
    // (index.js:44343-44350), so the custom tool would stick; Lobby's setTool('select') goes through
    // appState instead (canvas/tools/tools.ts).
    const warnings: string[] = []
    const onConsole = (m: { type(): string; text(): string }) => {
      if (m.type() === 'warning') warnings.push(m.text())
    }
    page.on('console', onConsole)
    const direct = await page.evaluate(() => {
      const api = window.__lobbySpike?.api as unknown as {
        setActiveTool(t: { type: string }): void
        getAppState(): { activeTool: { type: string } }
      }
      api.setActiveTool({ type: 'selection' })
      return new Promise<string>((r) => setTimeout(() => r(api.getAppState().activeTool.type), 50))
    })
    page.off('console', onConsole)
    const viaLobby = await lab(page, (x) => x.tools.setTool('select'))
    await settle(page, 20)
    const afterLobby = await lab(page, (x) => x.appSnap().activeTool)
    const hand = await lab(page, (x) => x.tools.setTool('hand'))
    report.leaveCustomTool = {
      directSetActiveTool: direct,
      warnings,
      viaLobby,
      afterLobby,
      handRefused: !hand,
    }
    expect(direct, "Excalidraw's setActiveTool({type:'selection'}) is refused read-only").toBe('custom')
    expect(afterLobby).toBe('selection:')
    expect(hand).toBe(false)

    // --- pan: wheel and pointer drag on empty canvas; zoom: Ctrl+wheel and Ctrl+= / Ctrl+-.
    const empty = await toClient(page, 800, 500)
    await page.mouse.move(empty.x, empty.y)
    const v0 = await view(page)
    await page.mouse.wheel(0, 240)
    await settle(page)
    const v1 = await view(page)
    await page.mouse.move(empty.x, empty.y)
    await page.mouse.down()
    await page.mouse.move(empty.x - 150, empty.y - 90, { steps: 8 })
    await page.mouse.up()
    await settle(page)
    const v2 = await view(page)
    await page.keyboard.down('Control')
    await page.mouse.wheel(0, -200)
    await page.keyboard.up('Control')
    await settle(page)
    const v3 = await view(page)
    await focusCanvas(page)
    await page.keyboard.press('Control+Equal')
    await settle(page)
    const v4 = await view(page)
    await page.keyboard.press('Control+Minus')
    await settle(page)
    const v5 = await view(page)
    report.navigation = { v0, wheel: v1, drag: v2, ctrlWheel: v3, ctrlPlus: v4, ctrlMinus: v5 }
    expect(v1.scrollY, 'wheel pans').not.toBe(v0.scrollY)
    expect(v2.scrollX, 'drag pans').not.toBe(v1.scrollX)
    expect(v3.zoom, 'Ctrl+wheel zooms').not.toBe(v2.zoom)
    expect(v4.zoom, 'Ctrl+= zooms in').toBeGreaterThan(v3.zoom)
    expect(v5.zoom, 'Ctrl+- zooms out').toBeLessThan(v4.zoom)
    // Back to a known view for the rest.
    await page.evaluate(() => {
      window.__lobbySpike?.api?.updateScene({ appState: { scrollX: 0, scrollY: 0, zoom: { value: 1 } } })
    })
    await settle(page)

    // --- links: a click on a linked element reaches Lobby's onLinkOpen (which prevents the default).
    const url = page.url()
    const lp = await toClient(page, 500, 190)
    await page.mouse.click(lp.x, lp.y)
    await settle(page, 200)
    const links = await lab(page, (x) => [...x.linkOpens])
    report.links = { links, popups: watch.popups, navigated: page.url() !== url }
    expect(links).toEqual([LINK])
    expect(watch.popups).toBe(0)
    expect(page.url()).toBe(url)

    // --- custom tools: Lobby's comment tool gets the click; Excalidraw creates nothing.
    const before = await versions(page)
    await lab(page, (x) => x.tools.setTool('comment'))
    const cp = await toClient(page, 760, 180)
    await page.mouse.click(cp.x, cp.y)
    await settle(page)
    const clicks = await lab(page, (x) => x.customClicks.map((c: { tool: string }) => c.tool))
    await lab(page, (x) => x.tools.setTool('select'))
    report.customTool = { clicks }
    expect(clicks).toEqual(['comment'])
    expect(await versions(page)).toEqual(before)

    // --- keys: nothing changes, nothing downloads, no picker, no dialog.
    await select(page, ['n1'])
    const keyResults: Record<string, unknown>[] = []
    for (const key of KEYS) {
      await focusCanvas(page)
      const v = await versions(page)
      const s0 = await lab(page, (x) => x.appSnap())
      await page.keyboard.press(key)
      await settle(page, 60)
      const s1 = await lab(page, (x) => x.appSnap())
      const changedApp = Object.keys(s0).filter(
        (k) =>
          JSON.stringify((s0 as Record<string, unknown>)[k]) !==
          JSON.stringify((s1 as Record<string, unknown>)[k]),
      )
      const changedEls = JSON.stringify(v) !== JSON.stringify(await versions(page))
      if (changedApp.length || changedEls) keyResults.push({ key, changedApp, changedEls })
    }
    const pickers = await filePickerCalls(page)
    const clip = await clipboardCalls(page)
    report.keys = { pressed: KEYS.length, acted: keyResults, pickers, clipboard: clip }
    expect(keyResults).toEqual([])
    expect(pickers).toEqual({ showSaveFilePicker: 0, showOpenFilePicker: 0, showDirectoryPicker: 0 })
    expect((clip.write ?? 0) + (clip.writeText ?? 0)).toBe(0)

    // --- clipboard events: Excalidraw writes nothing, pastes nothing, cuts nothing.
    await focusCanvas(page)
    const n0 = (await elements(page)).length
    const v6 = await versions(page)
    const copy = await clipboardEvent(page, 'copy')
    const cut = await clipboardEvent(page, 'cut')
    const paste = await clipboardEvent(page, 'paste')
    await settle(page, 200)
    report.clipboard = { copy, cut, paste }
    expect(copy.types, 'nothing copied').toEqual([])
    expect(cut.types, 'nothing cut').toEqual([])
    expect((await elements(page)).length, 'nothing pasted').toBe(n0)
    expect(await versions(page)).toEqual(v6)
    if (role === 'guest') expect(copy.prevented, "Lobby's export policy blocks the guest's copy").toBe(true)

    // --- drop: nothing added; the browser does not navigate to the file (Lobby prevents the default).
    const dp = await toClient(page, 700, 400)
    const drop = await dropFile(page, dp)
    await settle(page, 200)
    const dropCount = await lab(page, (x) => x.counters.drop)
    report.drop = { ...drop, lobbyDropHandler: dropCount }
    expect(drop).toMatchObject({ overPrevented: true, dropPrevented: true })
    expect(dropCount, "read-only roles do not reach Lobby's upload path").toBe(0)
    expect((await elements(page)).length).toBe(n0)

    expect(watch.downloads).toBe(0)
    expect(watch.dialogs).toBe(0)
    expect(watch.fileChoosers).toBe(0)
    expect(watch.pageErrors).toEqual([])
    console.log(`A4-${role.toUpperCase()}`, JSON.stringify(report))
  })
}

test('A4 CONTROL (editor): the same synthetic paste creates an element and the drop reaches Lobby only', async ({
  page,
}) => {
  await openLab(page, { toolbar: true })
  await buildScene(page)
  const p = await toClient(page, 800, 450)
  await page.mouse.move(p.x, p.y) // Excalidraw pastes only when the pointer is over its canvas
  await focusCanvas(page)
  const n0 = (await elements(page)).length
  const paste = await clipboardEvent(page, 'paste')
  await expect.poll(async () => (await elements(page)).length).toBe(n0 + 1)
  const drop = await dropFile(page, p)
  await settle(page, 200)
  const dropCount = await lab(page, (x) => x.counters.drop)
  console.log('A4-CONTROL-EDITOR', JSON.stringify({ paste, elementsAfterPaste: n0 + 1, drop, dropCount }))
  expect(dropCount).toBe(1)
  expect((await elements(page)).length).toBe(n0 + 1)
})
