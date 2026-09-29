import { type CDPSession, expect, type Page, test } from '@playwright/test'
import {
  addNote,
  clipboardCalls,
  element,
  focusCanvas,
  instrumentClipboard,
  lab,
  openLab,
  resetLab,
  select,
  settle,
  waitEditor,
} from '../../spike/tests/host-kit.ts'

// Spike B, B3 L13 / B5 R3 (keys): the keys verifier's K1-K5 on spike A's fix round 2
// (docs/research/excalidraw/spike-b/OPEN-FROM-SPIKE-A.md), as their repros describe them, with CDP
// Input.dispatchKeyEvent on /spike/host-lab (spike A's page; no api or sync). Owner O2.
//
//   K1  keys typed OUTSIDE the board (an <input> on the page, the body) never reach Excalidraw's document
//       keyup listener: selected bound arrows keep their version; Space keeps the selection
//   K2  Ctrl+Insert typed as NumLock-off Numpad0 in the granted editor does not reset the zoom
//   K3  BÉPO/KOY Ctrl+Z (code BracketLeft) in the granted editor undoes natively, never outdents
//   K4  Ctrl + a key reporting 'Enter' on code KeyV does not submit the granted editor
//   K5  key and code that disagree: {Shift on KeyC}+Alt is no copyAsPng, {ArrowUp on KeyH}+Shift no flip,
//       {'<' on KeyV}+Ctrl+Shift in the editor no font size, {Shift on Digit0} no reset zoom for a viewer
//
// Every case failed before the fix (docs/research/excalidraw/spike-b/L13-verifier-k.md). Emulated, as the
// verifier's were: no NumLock-off numpad, BÉPO or Neo layer was physically used.
//
// Run: SPIKE_B_PORT_BASE=7870 pnpm --filter @draftroom/e2e spike-b b3-l13-keys-k   (SPIKE_REPS: default 3)

const N = Number(process.env.SPIKE_REPS ?? 3)

// CDP modifiers: Alt 1, Ctrl 2, Meta 4, Shift 8
interface CdpKey {
  key: string
  code: string
  vk: number
  modifiers?: number
  location?: number
}

async function press(cdp: CDPSession, k: CdpKey): Promise<void> {
  const base = {
    key: k.key,
    code: k.code,
    windowsVirtualKeyCode: k.vk,
    nativeVirtualKeyCode: k.vk,
    modifiers: k.modifiers ?? 0,
    location: k.location ?? 0,
  }
  await cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...base })
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base })
}

async function appZoom(page: Page): Promise<number> {
  return page.evaluate(() => window.__lobbySpike?.api?.getAppState().zoom.value ?? -1)
}

async function setZoom(page: Page, value: number): Promise<void> {
  await page.evaluate((v) => {
    window.__lobbySpike?.api?.updateScene({ appState: { zoom: { value: v as never } } })
  }, value)
  await page.waitForFunction((v) => window.__lobbySpike?.api?.getAppState().zoom.value === v, value)
}

/** Two rectangles and an arrow bound to both (the verifier's fixture). */
async function boundArrow(page: Page): Promise<void> {
  await lab(page, (x) => {
    x.fixture.add([
      { type: 'rectangle', id: 'r1', x: 100, y: 100, width: 100, height: 100, roughness: 0 },
      { type: 'rectangle', id: 'r2', x: 420, y: 100, width: 100, height: 100, roughness: 0 },
      {
        type: 'arrow',
        id: 'a1',
        x: 200,
        y: 150,
        points: [
          [0, 0],
          [220, 0],
        ],
        roughness: 0,
      },
    ])
    x.fixture.bindArrow('a1', 'r1', 'start', [1, 0.5])
    x.fixture.bindArrow('a1', 'r2', 'end', [0, 0.5])
  })
}

async function outsideInput(page: Page): Promise<void> {
  await page.evaluate(() => {
    let input = document.querySelector<HTMLInputElement>('#k1-outside')
    if (!input) {
      input = document.createElement('input')
      input.id = 'k1-outside'
      Object.assign(input.style, { position: 'fixed', right: '8px', bottom: '8px', zIndex: '50' })
      document.body.append(input)
    }
    input.focus()
  })
}

async function openGrantedEditor(page: Page, text: string): Promise<{ note: string; label: string }> {
  const ids = await addNote(page, { id: `n${Date.now().toString(36)}`, x: 120, y: 140, size: 200, text })
  await lab(
    page,
    (x, id) => x.input.editorLease.requestEdit(id, { reason: 'spec', caretEnd: true }),
    ids.note,
  )
  await waitEditor(page, (e) => e.phase === 'open' && !!e.textarea?.focused && !e.textarea.readOnly)
  return { note: ids.note, label: ids.label ?? '' }
}

const textareaValue = (page: Page) =>
  page.evaluate(
    () => document.querySelector<HTMLTextAreaElement>('textarea.excalidraw-wysiwyg')?.value ?? null,
  )

test.describe('B3 L13: the keys verifier K1-K5 (host-lab, CDP key events)', () => {
  let cdp: CDPSession

  test.beforeEach(async ({ page, context }) => {
    test.setTimeout(300_000)
    await instrumentClipboard(page)
    cdp = await context.newCDPSession(page)
  })

  test('K1: arrow and Space keyups from outside the board never reach Excalidraw', async ({ page }) => {
    await openLab(page, { grant: 0 })
    const rows: Record<string, unknown>[] = []
    for (let i = 0; i < N; i++) {
      await resetLab(page)
      await boundArrow(page)
      for (const where of ['input', 'body'] as const) {
        await select(page, ['a1'])
        if (where === 'input') await outsideInput(page)
        else
          await page.evaluate(() => {
            ;(document.activeElement as HTMLElement | null)?.blur()
            document.body.focus()
          })
        const v0 = (await element(page, 'a1'))?.version
        await press(cdp, { key: 'ArrowLeft', code: 'ArrowLeft', vk: 37 })
        await press(cdp, { key: 'ArrowRight', code: 'ArrowRight', vk: 39 })
        await press(cdp, { key: 'ArrowUp', code: 'ArrowUp', vk: 38, modifiers: 8 })
        await settle(page, 40)
        const v1 = (await element(page, 'a1'))?.version
        rows.push({ i, where, case: 'arrow keyups', v0, v1, ok: v0 === v1 })
      }
      // Space in an outside input while a Lobby custom tool is active keeps the selection
      await lab(page, (x) => x.tools.setTool('note'))
      await select(page, ['r1'])
      await outsideInput(page)
      await press(cdp, { key: ' ', code: 'Space', vk: 32 })
      await settle(page, 40)
      const sel = await page.evaluate(() =>
        Object.entries(window.__lobbySpike?.api?.getAppState().selectedElementIds ?? {})
          .filter(([, v]) => v)
          .map(([k]) => k),
      )
      rows.push({ i, case: 'space keyup, note tool', sel, ok: JSON.stringify(sel) === '["r1"]' })
      await lab(page, (x) => x.tools.setTool('select'))
    }
    console.log('B3-L13-K1', JSON.stringify(rows))
    expect(rows.filter((r) => !r.ok)).toEqual([])
  })

  test('K2: Ctrl+Insert as NumLock-off Numpad0 in the granted editor keeps the zoom', async ({ page }) => {
    await openLab(page, { grant: 0 })
    const rows: Record<string, unknown>[] = []
    for (let i = 0; i < N; i++) {
      await resetLab(page)
      await setZoom(page, 1.7)
      await openGrantedEditor(page, 'Note one')
      await press(cdp, { key: 'Insert', code: 'Numpad0', vk: 45, location: 3, modifiers: 2 })
      await settle(page, 60)
      const zoom = await appZoom(page)
      const open = (await lab(page, (x) => x.editor().phase)) === 'open'
      rows.push({ i, zoom, open, ok: zoom === 1.7 && open })
      await page.keyboard.press('Escape')
    }
    console.log('B3-L13-K2', JSON.stringify(rows))
    expect(rows.filter((r) => !r.ok)).toEqual([])
  })

  test('K3: BÉPO Ctrl+Z (code BracketLeft) in the granted editor never outdents', async ({ page }) => {
    await openLab(page, { grant: 0 })
    const rows: Record<string, unknown>[] = []
    for (let i = 0; i < N; i++) {
      await resetLab(page)
      await openGrantedEditor(page, '    Note one')
      await page.evaluate(() => document.execCommand('insertText', false, 'X'))
      await settle(page, 40)
      const before = await textareaValue(page)
      await press(cdp, { key: 'z', code: 'BracketLeft', vk: 90, modifiers: 2 })
      await settle(page, 60)
      const after = await textareaValue(page)
      // the outdent removed the leading spaces; native undo takes the X back
      rows.push({
        i,
        before,
        after,
        ok: before === '    Note oneX' && after !== 'Note oneX' && after === '    Note one',
      })
      await page.keyboard.press('Escape')
    }
    console.log('B3-L13-K3', JSON.stringify(rows))
    expect(rows.filter((r) => !r.ok)).toEqual([])
  })

  test("K4: Ctrl + a key reporting 'Enter' on code KeyV does not submit the granted editor", async ({
    page,
  }) => {
    await openLab(page, { grant: 0 })
    const rows: Record<string, unknown>[] = []
    for (let i = 0; i < N; i++) {
      await resetLab(page)
      await openGrantedEditor(page, 'Note one')
      await press(cdp, { key: 'Enter', code: 'KeyV', vk: 13, modifiers: 2 })
      await settle(page, 60)
      const st = await lab(page, (x) => x.editor())
      rows.push({ i, phase: st.phase, editing: st.editingId, ok: st.phase === 'open' && !!st.editingId })
      await page.keyboard.press('Escape')
    }
    console.log('B3-L13-K4', JSON.stringify(rows))
    expect(rows.filter((r) => !r.ok)).toEqual([])
  })

  test('K5: key and code that disagree run no Excalidraw action (editor, text editor, viewer)', async ({
    page,
  }) => {
    await openLab(page, { grant: 0 })
    const rows: Record<string, unknown>[] = []
    for (let i = 0; i < N; i++) {
      // outside the editor: {Shift on KeyC} with Alt+Shift (copyAsPng), {ArrowUp on KeyH} with Shift (flip)
      await resetLab(page)
      await boundArrow(page)
      await select(page, ['r1', 'r2'])
      await focusCanvas(page)
      const clip0 = await clipboardCalls(page)
      const pos0 = [(await element(page, 'r1'))?.x, (await element(page, 'r2'))?.x]
      await press(cdp, { key: 'Shift', code: 'KeyC', vk: 16, modifiers: 9 })
      await press(cdp, { key: 'ArrowUp', code: 'KeyH', vk: 38, modifiers: 8 })
      await settle(page, 80)
      const clip1 = await clipboardCalls(page)
      const pos1 = [(await element(page, 'r1'))?.x, (await element(page, 'r2'))?.x]
      rows.push({
        i,
        case: 'outside',
        clip: (clip1.write ?? 0) - (clip0.write ?? 0),
        pos0,
        pos1,
        ok: clip1.write === clip0.write && JSON.stringify(pos0) === JSON.stringify(pos1),
      })
      // in the granted editor: {'<' on KeyV} with Ctrl+Shift (decreaseFontSize)
      const ids = await openGrantedEditor(page, 'Note one')
      const f0 = await page.evaluate(() => window.__lobbySpike?.api?.getAppState().currentItemFontSize)
      const lf0 = (await element(page, ids.label))?.fontSize
      await press(cdp, { key: '<', code: 'KeyV', vk: 86, modifiers: 10 })
      await settle(page, 60)
      const f1 = await page.evaluate(() => window.__lobbySpike?.api?.getAppState().currentItemFontSize)
      const lf1 = (await element(page, ids.label))?.fontSize
      rows.push({ i, case: 'editor', f0, f1, lf0, lf1, ok: f0 === f1 && lf0 === lf1 })
      await page.keyboard.press('Escape')
    }
    // read-only: {Shift on Digit0} (resetZoom)
    await openLab(page, { grant: 0 }, { role: 'viewer' })
    for (let i = 0; i < N; i++) {
      await setZoom(page, 1.7)
      await focusCanvas(page)
      await press(cdp, { key: 'Shift', code: 'Digit0', vk: 16, modifiers: 8 })
      await settle(page, 60)
      const zoom = await appZoom(page)
      rows.push({ i, case: 'viewer', zoom, ok: zoom === 1.7 })
    }
    console.log('B3-L13-K5', JSON.stringify(rows))
    expect(rows.filter((r) => !r.ok)).toEqual([])
  })
})
