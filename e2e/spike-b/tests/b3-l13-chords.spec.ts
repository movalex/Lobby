// B3 L13 (docs/EXCALIDRAW-MIGRATION.md §8.3; the verifier's A6 probe) on the real board: in a GRANTED
// editor, A presses Ctrl+S, Ctrl+Alt+S, Ctrl+Shift+S, Ctrl+O and Ctrl+P, Cmd+S and Cmd+Alt+S (macOS
// emulation), then types '@' with AltGr (a German layout: Ctrl+Alt on KeyQ) and 'ß' with Option (macOS
// emulation: Alt on KeyS). Two Chromium processes signed in as A: one as Windows, one with
// navigator.platform = 'MacIntel' (Excalidraw's CTRL_OR_CMD is then metaKey). Owner O2; evidence
// docs/research/excalidraw/spike-b/B3.md.
//
// Pass (20/20): 0 downloads, 0 file pickers (showSaveFilePicker/showOpenFilePicker/showDirectoryPicker,
// counted and rejected as a Cancel), 0 dialogs, 0 window.print calls, the editor stays open on the same
// note, writable; the AltGr and Option characters land in the text (the stored label ends with them).
// Emulated, as the verifier's were: the chords and Option+S are CDP key events (Option+S carrying the
// produced 'ß'); CDP has no AltGraph modifier, so the AltGr keydown is an in-page KeyboardEvent with
// modifierAltGraph (checked: not prevented, never reaching the textarea's handlers) followed by the
// browser's default action as Input.insertText. No German keyboard or Mac was physically used.
//
// Run: SPIKE_B_PORT_BASE=<base> pnpm --filter @draftroom/e2e spike-b b3-l13-chords   (SPIKE_B3_CHORD_REPS, default 20)
import { type CDPSession, expect, test } from '@playwright/test'
import {
  filePickerCalls,
  instrumentFilePickers,
  type PageWatch,
  watchPage,
} from '../../spike/support/watch.ts'
import type { BrowserProcess } from '../support/types.ts'
import {
  allSaved,
  closeEditor,
  converge,
  editorState,
  labelText,
  note,
  openEditor,
  REPS,
  type Room,
  room,
  show,
} from './b3-kit.ts'

const N = REPS('B3_CHORD', 20)
test.describe.configure({ mode: 'serial' })
test.setTimeout(60 * 60_000)

let r: Room
const watches = new Map<string, PageWatch>()

/** Re-opens the board in `b` with the pickers counted, window.print counted and (mac) the platform set. */
async function instrument(b: BrowserProcess, mac: boolean): Promise<void> {
  await instrumentFilePickers(b.page)
  await b.context.addInitScript((isMac: boolean) => {
    const w = window as unknown as { __prints: number }
    w.__prints = 0
    window.print = () => {
      w.__prints++
    }
    if (isMac)
      Object.defineProperty(Navigator.prototype, 'platform', { get: () => 'MacIntel', configurable: true })
  }, mac)
  watches.set(b.name, watchPage(b.page))
  await b.openBoard(r.boardId)
}

test.beforeAll(async () => {
  r = await room(['A', 'M'])
  await instrument(r.by.A as BrowserProcess, false)
  await instrument(r.by.M as BrowserProcess, true)
})
test.afterAll(async () => {
  await r?.close()
})

/** A key press as CDP raw events; `text` makes it produce that character (AltGr, Option). */
async function cdpKey(
  cdp: CDPSession,
  k: { key: string; code: string; vk: number; modifiers: number; text?: string },
): Promise<void> {
  const base = {
    key: k.key,
    code: k.code,
    windowsVirtualKeyCode: k.vk,
    nativeVirtualKeyCode: k.vk,
    modifiers: k.modifiers,
  }
  await cdp.send('Input.dispatchKeyEvent', {
    type: k.text ? 'keyDown' : 'rawKeyDown',
    ...base,
    ...(k.text ? { text: k.text, unmodifiedText: k.text } : {}),
  })
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base })
}

// CDP modifiers: Alt 1, Ctrl 2, Meta 4, Shift 8
const CHORDS = {
  win: ['Control+s', 'Control+Alt+s', 'Control+Shift+s', 'Control+o', 'Control+p'],
  mac: ['Meta+s', 'Meta+Alt+s', 'Control+s', 'Meta+o', 'Meta+p', 'Control+o', 'Control+p'],
}
const CHARACTER = {
  // AltGr+Q on a German layout: Chromium on Windows reports Ctrl+Alt with the produced '@'
  win: { key: '@', code: 'KeyQ', vk: 81, modifiers: 3, text: '@' },
  // Option+S on macOS: Alt with the produced 'ß'
  mac: { key: 'ß', code: 'KeyS', vk: 83, modifiers: 1, text: 'ß' },
}

for (const os of ['win', 'mac'] as const) {
  test(`L13 ${os}: save, open and print chords do nothing in a granted editor; the ${os === 'win' ? 'AltGr' : 'Option'} character lands`, async () => {
    const b = (os === 'win' ? r.by.A : r.by.M) as BrowserProcess
    const page = b.page
    const w = watches.get(b.name) as PageWatch
    const cdp = await page.context().newCDPSession(page)
    const rows: Record<string, unknown>[] = []
    for (let i = 0; i < N; i++) {
      const n = await note(page, [b], { x: i * 300, y: os === 'win' ? 0 : 400 }, `L13 ${os} ${i}`)
      await show(page, [n.id])
      await openEditor(page, n.id)
      await page.keyboard.press('End')
      w.reset()
      const pickers0 = Object.values(await filePickerCalls(page)).reduce((a, c) => a + c, 0)
      const prints0 = await page.evaluate(() => (window as unknown as { __prints: number }).__prints)
      const stillOpen: string[] = []
      for (const chord of CHORDS[os]) {
        await page.keyboard.press(chord)
        await page.waitForTimeout(40)
        const e = await editorState(page)
        if (!(e.phase === 'open' && e.leaseId === n.id && e.textareas === 1 && e.readOnly === false))
          stillOpen.push(`${chord}: ${e.phase} ${e.leaseId} ${e.textareas}`)
      }
      let altGr: { prevented: boolean; altGraph: boolean; reached: number } | null = null
      if (os === 'mac') await cdpKey(cdp, CHARACTER.mac)
      else {
        // CDP has no AltGraph modifier bit, so the AltGr keydown is an in-page event with
        // modifierAltGraph (what Chromium on Windows reports for AltGr+Q on a German layout); Lobby must
        // leave it to the browser (not prevented, stopped before Excalidraw), and the browser's default
        // action, typing '@', is then Input.insertText
        altGr = await page.evaluate(() => {
          const ta = document.querySelector<HTMLTextAreaElement>('textarea.excalidraw-wysiwyg')
          if (!ta) return null
          let reached = 0
          const count = () => reached++
          ta.addEventListener('keydown', count)
          const ev = new KeyboardEvent('keydown', {
            key: '@',
            code: 'KeyQ',
            keyCode: 81,
            ctrlKey: true,
            altKey: true,
            modifierAltGraph: true,
            bubbles: true,
            cancelable: true,
          } as KeyboardEventInit)
          ta.dispatchEvent(ev)
          ta.removeEventListener('keydown', count)
          return { prevented: ev.defaultPrevented, altGraph: ev.getModifierState('AltGraph'), reached }
        })
        if (altGr && !altGr.prevented) await cdp.send('Input.insertText', { text: '@' })
      }
      await page.waitForTimeout(40)
      const value = (await editorState(page)).value
      const pickers = Object.values(await filePickerCalls(page)).reduce((a, c) => a + c, 0) - pickers0
      const prints =
        (await page.evaluate(() => (window as unknown as { __prints: number }).__prints)) - prints0
      await closeEditor(page)
      await allSaved([b])
      const stored = await labelText(page, n.label)
      const ch = CHARACTER[os].text
      const ok =
        w.downloads === 0 &&
        w.dialogs === 0 &&
        w.fileChoosers === 0 &&
        w.popups === 0 &&
        pickers === 0 &&
        prints === 0 &&
        stillOpen.length === 0 &&
        (os === 'mac' || (altGr?.altGraph === true && altGr.prevented === false && altGr.reached === 0)) &&
        value === `L13 ${os} ${i}${ch}` &&
        stored === `L13 ${os} ${i}${ch}`
      rows.push({
        i,
        ok,
        downloads: w.downloads,
        dialogs: w.dialogs,
        fileChoosers: w.fileChoosers,
        popups: w.popups,
        pickers,
        prints,
        stillOpen,
        altGr,
        value,
        stored,
      })
      if (!ok) console.log('row', JSON.stringify(rows.at(-1)))
    }
    console.log(
      `B3-L13-${os}`,
      JSON.stringify({ n: rows.length, sample: rows[0], failed: rows.filter((x) => !x.ok).slice(0, 6) }),
    )
    expect(rows.filter((x) => !x.ok)).toEqual([])
    await converge(r)
  })
}
