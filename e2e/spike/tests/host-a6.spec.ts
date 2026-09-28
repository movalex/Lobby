import { expect, type Page, test } from '@playwright/test'
import { filePickerCalls, instrumentFilePickers, type PageWatch, watchPage } from '../support/watch.ts'
import {
  addNote,
  centerOf,
  clipboardCalls,
  focusCanvas,
  instrumentClipboard,
  lab,
  openLab,
  resetLab,
  select,
  versions,
  waitEditor,
} from './host-kit.ts'

// A6 (docs/EXCALIDRAW-MIGRATION.md §8.2, revision 3.1 open item 1): the key allowlist (§2.3.3) in edit
// mode. Every key of the plan's "Everything else" row does nothing — 0 downloads, 0 dialogs, 0 element
// changes — and, with the text editor focused, Ctrl+S, Cmd+S and Ctrl+Shift+S do nothing.
//
// "Nothing" is measured as: no element version/nonce change and no new element; none of 29 appState
// fields changed (tool, dialogs, popups, menus, toast, modes, selection, viewport, current styles…);
// 0 downloads, 0 browser dialogs, 0 file choosers, 0 popups, 0 File System Access picker calls (the
// scaffold's finding: Chromium's save/open go through showSaveFilePicker/showOpenFilePicker), 0
// clipboard writes. Each key is pressed with ONE shape selected (Tab conversion, flowchart keys) and
// with EVERYTHING selected (align, distribute, flip, styles). A CONTROL run with the allowlist off
// (?allowlist=off) presses the same keys to show which ones Excalidraw would act on.

// The plan's row (Ctrl+Arrow and Alt+Arrow in all four directions; digits 0-9), then every other
// Excalidraw shortcut that is neither delegated nor Lobby-owned (keyTests in dist/dev/index.js and the
// TOOLS letter/numeric keys at :9934+).
const PLAN_ROW = [
  'Control+s',
  'Control+Shift+S',
  'Control+o',
  'Alt+Shift+C',
  'Control+Shift+E',
  'Control+/',
  'Control+p',
  'Control+Backspace',
  'Control+ArrowLeft',
  'Control+ArrowRight',
  'Control+ArrowUp',
  'Control+ArrowDown',
  'Alt+ArrowLeft',
  'Alt+ArrowRight',
  'Alt+ArrowUp',
  'Alt+ArrowDown',
  'g',
  's',
  'i',
  'Shift+F',
  'Shift+S',
  'Shift+G',
  '?',
  '0',
  '1',
  '2',
  '3',
  '4',
  '5',
  '6',
  '7',
  '8',
  '9',
]
const EXTRA = [
  'd',
  'a',
  'x',
  'b',
  'q',
  'w',
  'Shift+X',
  'Control+Shift+P',
  'Alt+Shift+D',
  'Control+Alt+c',
  'Control+Alt+v',
  'Control+Shift+ArrowUp',
  'Control+Shift+ArrowDown',
  'Control+Shift+ArrowLeft',
  'Control+Shift+ArrowRight',
  'Alt+h',
  'Alt+v',
  'Shift+H',
  'Shift+V',
  'Control+x',
  "Control+'",
  'Alt+z',
  'Alt+s',
  'Alt+/',
  'Control+k',
  'Alt+r',
  'Shift+Digit1',
  'Shift+Digit2',
  'Shift+Digit3',
  'Shift+Digit0',
  'Shift+Equal',
  'Shift+Minus',
  'Control+Shift+Comma',
  'Control+Shift+Period',
  'Control+Enter',
  'Tab',
  'Shift+Tab',
]

async function buildScene(page: Page): Promise<string[]> {
  await resetLab(page)
  await lab(page, (x) =>
    x.fixture.add([
      { type: 'rectangle', id: 'r1', x: 80, y: 90, width: 120, height: 80, backgroundColor: '#a5d8ff' },
      { type: 'rectangle', id: 'r2', x: 300, y: 120, width: 120, height: 80, backgroundColor: '#b2f2bb' },
      { type: 'rectangle', id: 'r3', x: 520, y: 80, width: 120, height: 80, backgroundColor: '#ffc9c9' },
      { type: 'ellipse', id: 'e1', x: 80, y: 420, width: 120, height: 80 },
      {
        type: 'arrow',
        id: 'a1',
        x: 150,
        y: 260,
        points: [
          [0, 0],
          [220, 40],
        ],
      },
      {
        type: 'line',
        id: 'l1',
        x: 300,
        y: 380,
        points: [
          [0, 0],
          [160, 30],
        ],
      },
      { type: 'text', id: 't1', x: 520, y: 300, text: 'Free text', fontFamily: 6 },
    ]),
  )
  await addNote(page, { id: 'n1', x: 700, y: 220, size: 200, text: 'A note' })
  return ['r1', 'r2', 'r3', 'e1', 'a1', 'l1', 't1', 'n1']
}

interface Counters {
  downloads: number
  dialogs: number
  fileChoosers: number
  popups: number
  pickers: number
  clipboard: number
}

async function counters(page: Page, watch: PageWatch): Promise<Counters> {
  const p = await filePickerCalls(page)
  const c = await clipboardCalls(page)
  return {
    downloads: watch.downloads,
    dialogs: watch.dialogs,
    fileChoosers: watch.fileChoosers,
    popups: watch.popups,
    pickers: (p.showSaveFilePicker ?? 0) + (p.showOpenFilePicker ?? 0) + (p.showDirectoryPicker ?? 0),
    clipboard: (c.write ?? 0) + (c.writeText ?? 0),
  }
}

const settle = (page: Page) =>
  page.evaluate(
    () =>
      new Promise<void>((r) =>
        requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(() => r(), 150))),
      ),
  )

interface KeyResult {
  key: string
  selection: 'one' | 'all'
  elementChanges: string[]
  newElements: number
  appStateChanges: string[]
  counterDeltas: Partial<Counters>
  navigated: boolean
}

async function pressAndDiff(
  page: Page,
  watch: PageWatch,
  key: string,
  selection: 'one' | 'all',
  ids: string[],
): Promise<KeyResult> {
  await select(page, selection === 'one' ? ['r1'] : ids)
  await focusCanvas(page)
  const url = page.url()
  const v0 = await versions(page)
  const a0 = await lab(page, (x) => x.appSnap())
  const c0 = await counters(page, watch)
  await page.keyboard.press(key)
  await settle(page)
  const navigated = page.url() !== url
  const v1 = await versions(page)
  const a1 = await lab(page, (x) => x.appSnap())
  const c1 = await counters(page, watch)
  const elementChanges = Object.keys(v0).filter((id) => JSON.stringify(v0[id]) !== JSON.stringify(v1[id]))
  const newElements = Object.keys(v1).filter((id) => !(id in v0)).length
  const appStateChanges = Object.keys(a0).filter(
    (k) =>
      JSON.stringify((a0 as Record<string, unknown>)[k]) !==
      JSON.stringify((a1 as Record<string, unknown>)[k]),
  )
  const counterDeltas: Partial<Counters> = {}
  for (const k of Object.keys(c0) as (keyof Counters)[]) if (c1[k] !== c0[k]) counterDeltas[k] = c1[k] - c0[k]
  return { key, selection, elementChanges, newElements, appStateChanges, counterDeltas, navigated }
}

const didSomething = (r: KeyResult) =>
  r.elementChanges.length > 0 ||
  r.newElements > 0 ||
  r.appStateChanges.length > 0 ||
  Object.keys(r.counterDeltas).length > 0 ||
  r.navigated

async function runKeys(page: Page, watch: PageWatch, allowlist: 'on' | 'off'): Promise<KeyResult[]> {
  const out: KeyResult[] = []
  const open = async () => {
    await openLab(page, { allowlist, grant: 30 })
    return buildScene(page)
  }
  let ids = await open()
  for (const selection of ['one', 'all'] as const) {
    for (const key of [...PLAN_ROW, ...EXTRA]) {
      const r = await pressAndDiff(page, watch, key, selection, ids)
      out.push(r)
      if (didSomething(r)) ids = await open() // a fresh page for the next key (control runs)
    }
  }
  return out
}

test.describe('A6: the key allowlist in edit mode', () => {
  test.beforeEach(async ({ page }) => {
    await instrumentFilePickers(page)
    await instrumentClipboard(page)
  })

  test('every "Everything else" key (and every other non-delegated Excalidraw shortcut) does nothing', async ({
    page,
  }) => {
    test.setTimeout(240_000)
    const watch = watchPage(page)
    const results = await runKeys(page, watch, 'on')
    const acted = results.filter(didSomething)
    console.log(
      'A6-ALLOWLIST',
      JSON.stringify({
        presses: results.length,
        keys: PLAN_ROW.length + EXTRA.length,
        planRow: PLAN_ROW.length,
        acted,
        totals: {
          downloads: watch.downloads,
          dialogs: watch.dialogs,
          fileChoosers: watch.fileChoosers,
          popups: watch.popups,
        },
      }),
    )
    expect(acted).toEqual([])
    expect(watch.downloads).toBe(0)
    expect(watch.dialogs).toBe(0)
    expect(await filePickerCalls(page)).toEqual({
      showSaveFilePicker: 0,
      showOpenFilePicker: 0,
      showDirectoryPicker: 0,
    })
    expect(watch.pageErrors).toEqual([])
  })

  test('CONTROL (allowlist off): the same keys reach Excalidraw and many act', async ({ page }) => {
    test.setTimeout(300_000)
    const watch = watchPage(page)
    const results = await runKeys(page, watch, 'off')
    const acted = results.filter(didSomething)
    console.log('A6-CONTROL', JSON.stringify({ presses: results.length, acted }))
    // The probe is sensitive: these are Excalidraw's own actions, reached without the allowlist.
    const actedKey = (k: string, sel: 'one' | 'all' = 'one') =>
      acted.find((r) => r.key === k && r.selection === sel)
    expect(actedKey('Control+Shift+S')?.counterDeltas.pickers, 'saveFileToDisk -> showSaveFilePicker').toBe(1)
    expect(actedKey('?')?.appStateChanges, 'help dialog').toContain('openDialog')
    expect(actedKey('2')?.appStateChanges, 'digit switches tool').toContain('activeTool')
    expect(acted.length).toBeGreaterThan(20)
  })

  for (const platform of ['win', 'mac'] as const) {
    for (const allowlist of ['on', 'off'] as const) {
      test(`text editor focused (${platform}${allowlist === 'off' ? ', CONTROL allowlist off' : ''}): Ctrl+S, Cmd+S, Ctrl+Shift+S`, async ({
        page,
      }) => {
        const watch = watchPage(page)
        if (platform === 'mac') {
          // Excalidraw reads navigator.platform once at module load (common dist/dev/index.js:2242):
          // on macOS CTRL_OR_CMD is metaKey, so Cmd+S is its save chord.
          await page.addInitScript(() => {
            Object.defineProperty(Navigator.prototype, 'platform', {
              get: () => 'MacIntel',
              configurable: true,
            })
          })
        }
        await openLab(page, { allowlist, grant: 30 })
        const out: Record<string, unknown>[] = []
        for (const key of ['Control+s', 'Meta+s', 'Control+Shift+S', 'Meta+Shift+S']) {
          await resetLab(page)
          const ids = await addNote(page, { x: 200, y: 150, size: 200, text: 'Editing' })
          const c = await centerOf(page, ids.note)
          await page.mouse.click(c.x + 60, c.y + 70)
          await page.keyboard.press('Enter')
          if (allowlist === 'off') {
            // No key allowlist: Enter reaches Excalidraw directly and opens the editor; Lobby's guard
            // still asks for the lease and clears read-only on the grant (30 ms).
            await expect
              .poll(() =>
                lab(page, (x) => x.editor().textarea?.readOnly === false && x.editor().phase === 'open'),
              )
              .toBe(true)
          } else {
            await waitEditor(page, (e) => e.phase === 'open' && !!e.textarea?.focused)
          }
          await expect.poll(() => page.evaluate(() => document.activeElement?.tagName)).toBe('TEXTAREA')
          await page.keyboard.type('abc')
          const before = await lab(page, (x) => x.editor())
          const c0 = await counters(page, watch)
          const v0 = await versions(page)
          await page.keyboard.press(key)
          await settle(page)
          const after = await lab(page, (x) => x.editor())
          const c1 = await counters(page, watch)
          const v1 = await versions(page)
          out.push({
            key,
            editorStillOpen: after.textarea !== null,
            valueKept: after.textarea?.value === before.textarea?.value,
            pickers: c1.pickers - c0.pickers,
            downloads: c1.downloads - c0.downloads,
            dialogs: c1.dialogs - c0.dialogs,
            elementChanges: Object.keys(v0).filter((id) => JSON.stringify(v0[id]) !== JSON.stringify(v1[id])),
          })
          await page.keyboard.press('Escape').catch(() => {})
        }
        console.log(`A6-EDITOR-${platform}-${allowlist}`, JSON.stringify(out))
        if (allowlist === 'on') {
          for (const r of out) {
            expect(r, String(r.key)).toMatchObject({
              editorStillOpen: true,
              valueKept: true,
              pickers: 0,
              downloads: 0,
              dialogs: 0,
              elementChanges: [],
            })
          }
        } else {
          // CONTROL: the textarea's own onkeydown runs actionSaveToActiveFile on the platform's save
          // chord (index.js:25388-25391): it submits (closes) the editor and calls the save picker.
          const chord = platform === 'mac' ? 'Meta+s' : 'Control+s'
          expect(out.find((r) => r.key === chord)).toMatchObject({ editorStillOpen: false, pickers: 1 })
        }
      })
    }
  }

  test("Lobby's Ctrl+A: Excalidraw's set minus hidden (collapsed) elements; control shows Excalidraw's", async ({
    page,
  }) => {
    const res: Record<string, unknown> = {}
    for (const allowlist of ['on', 'off'] as const) {
      await openLab(page, { allowlist })
      await resetLab(page)
      await lab(page, (x) =>
        x.fixture.add([
          { type: 'rectangle', id: 'g1a', x: 80, y: 80, width: 80, height: 60, groupIds: ['grp'] },
          { type: 'rectangle', id: 'g1b', x: 200, y: 80, width: 80, height: 60, groupIds: ['grp'] },
          { type: 'rectangle', id: 'locked', x: 80, y: 220, width: 80, height: 60, locked: true },
          { type: 'rectangle', id: 'hidden', x: 200, y: 220, width: 80, height: 60 },
        ]),
      )
      await addNote(page, { id: 'nn', x: 340, y: 80, size: 200, text: 'label' })
      await lab(page, (x) => x.setHidden(['hidden']))
      await select(page, [])
      await focusCanvas(page)
      const v0 = await versions(page)
      await page.keyboard.press('Control+a')
      await settle(page)
      const st = await page.evaluate(() => {
        const s = window.__lobbySpike?.api?.getAppState() as unknown as {
          selectedElementIds: Record<string, boolean>
          selectedGroupIds: Record<string, boolean>
        }
        const on = (m: Record<string, boolean>) =>
          Object.keys(m)
            .filter((k) => m[k])
            .sort()
        return { ids: on(s.selectedElementIds), groups: on(s.selectedGroupIds) }
      })
      const v1 = await versions(page)
      res[allowlist] = {
        ...st,
        elementChanges: Object.keys(v0).filter((id) => JSON.stringify(v0[id]) !== JSON.stringify(v1[id])),
      }
    }
    console.log('A6-CTRL-A', JSON.stringify(res))
    expect(res.on).toEqual({ ids: ['g1a', 'g1b', 'nn'], groups: ['grp'], elementChanges: [] })
    // Excalidraw's own select-all (control) also takes the element Lobby hides.
    expect((res.off as { ids: string[] }).ids).toContain('hidden')
  })
})
