import { type CDPSession, expect, type Page, test } from '@playwright/test'
import { layoutPresses } from '../../../apps/web/src/canvas/input/layouts.ts'
import { filePickerCalls, instrumentFilePickers, type PageWatch, watchPage } from '../support/watch.ts'
import { addNote, focusCanvas, lab, openLab, resetLab, select } from './host-kit.ts'

// A6 regression, outside the text editor (fix round 2: the second verifier's defects 3 and 4). Lobby used
// to delegate Ctrl+D / G / Shift+L / = / - / [ ] to Excalidraw by physical `code`, while most of
// Excalidraw's handlers test `key`. A Bone Ctrl+Shift+S (code KeyL, key 'S') passed as the lock chord and
// Excalidraw ran saveFileToDisk; German Ctrl+Shift+ß (code Minus, key '?') and Dvorak Ctrl+Shift+[ (code
// BracketLeft, key '?') opened the help dialog.
//
// The rule now (apps/web/src/canvas/input/keymap.ts, delegatedChord): a chord is delegated only when
// Excalidraw would run exactly one delegated action for that very event, decided by its own key tests.
//
// This spec measures that against Excalidraw itself. Key events are sent through CDP as Chromium on
// Windows reports a layout: `key` is the layout's character, `code` the physical key (emulated, not a
// real layout). For every delegated chord and every (code, key) pair that QWERTY, QWERTZ, AZERTY, Dvorak,
// Colemak, Neo 2 and Bone produce for it (layouts.ts, layoutPresses), plus the chord with the OTHER
// Ctrl/Cmd key:
//   - CONTROL (?allowlist=off): which Excalidraw actions ran (their perform, hooked on the page's
//     ActionManager), and every appState, element, picker, download and dialog change;
//   - Lobby (allowlist on): its verdict, and the same measurements.
// Pass: Lobby delegates exactly when the CONTROL run performed one delegated action and nothing else;
// when it delegates, the same action runs; Lobby's run has 0 pickers, 0 downloads, 0 dialogs, no
// openDialog / openPopup / toast, and no action that is not delegated. On Windows and under macOS
// emulation (navigator.platform = 'MacIntel': Excalidraw's CTRL_OR_CMD is then metaKey).

const DELEGATED = new Set([
  'duplicateSelection',
  'group',
  'ungroup',
  'toggleElementLock',
  'sendBackward',
  'bringForward',
  'sendToBack',
  'bringToFront',
  'zoomIn',
  'zoomOut',
])

/** What a delegated action may change in the snapshot (its own effect). */
const OWN_EFFECT: Record<string, string[]> = {
  duplicateSelection: ['selected'],
  group: ['selected'],
  ungroup: ['selected'],
  toggleElementLock: ['selected'],
  sendBackward: [],
  bringForward: [],
  sendToBack: [],
  bringToFront: [],
  zoomIn: ['zoom', 'scrollX', 'scrollY'],
  zoomOut: ['zoom', 'scrollX', 'scrollY'],
}

const OEM_VK: Record<string, number> = {
  "'": 222,
  ',': 188,
  '.': 190,
  ';': 186,
  '/': 191,
  '-': 189,
  '=': 187,
  '[': 219,
  ']': 221,
  '\\': 220,
  '`': 192,
}
const CODE_VK: Record<string, number> = {
  Minus: 189,
  Equal: 187,
  BracketLeft: 219,
  BracketRight: 221,
  Backslash: 220,
  Semicolon: 186,
  Quote: 222,
  Comma: 188,
  Period: 190,
  Slash: 191,
  Backquote: 192,
  IntlBackslash: 226,
  NumpadAdd: 107,
  NumpadSubtract: 109,
}

/** The Windows virtual key a layout reports for this key (only browser accelerators read it). */
function vkOf(code: string, key: string): number {
  if (/^[a-z]$/i.test(key)) return key.toUpperCase().charCodeAt(0)
  if (/^[0-9]$/.test(key)) return key.charCodeAt(0)
  if (OEM_VK[key]) return OEM_VK[key] ?? 0
  if (/^Key[A-Z]$/.test(code)) return code.charCodeAt(3)
  if (/^Digit[0-9]$/.test(code)) return code.charCodeAt(5)
  return CODE_VK[code] ?? 0
}

interface Press {
  label: string
  code: string
  key: string
  shift: boolean
  alt: boolean
  /** Press the other Ctrl/Cmd key (Meta on Windows, Ctrl on macOS). */
  otherMod: boolean
}

function presses(platform: 'win' | 'mac'): Press[] {
  const out: Press[] = []
  for (const p of layoutPresses()) {
    if (p.alt && platform !== 'mac') continue
    out.push({
      label: `${p.layout} ${p.chord}: ${p.code}/${p.key}${p.shift ? '+Shift' : ''}${p.alt ? '+Alt' : ''}`,
      code: p.code,
      key: p.key,
      shift: p.shift,
      alt: p.alt,
      otherMod: false,
    })
  }
  // The QWERTY chords with the other Ctrl/Cmd key (macOS Ctrl+G is not group to Excalidraw).
  for (const [code, key, shift] of [
    ['KeyD', 'd', false],
    ['KeyG', 'g', false],
    ['KeyG', 'G', true],
    ['KeyL', 'L', true],
    ['BracketLeft', '[', false],
    ['Equal', '=', false],
  ] as const) {
    out.push({
      label: `QWERTY other-mod ${code}/${key}${shift ? '+Shift' : ''}`,
      code,
      key,
      shift,
      alt: false,
      otherMod: true,
    })
  }
  return out
}

async function cdpPress(cdp: CDPSession, p: Press, platform: 'win' | 'mac'): Promise<void> {
  const primary = platform === 'mac' ? 4 : 2 // Meta : Ctrl
  const other = platform === 'mac' ? 2 : 4
  const modifiers = (p.otherMod ? other : primary) | (p.shift ? 8 : 0) | (p.alt ? 1 : 0)
  const vk = vkOf(p.code, p.key)
  const base = { modifiers, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, code: p.code, key: p.key }
  await cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...base })
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base })
}

/** Hooks every registered Excalidraw action's perform (through the App instance's React fiber). */
async function hookActions(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as unknown as { __performed?: string[] }
    if (w.__performed) return
    const performed: string[] = []
    w.__performed = performed
    const root = document.querySelector('.excalidraw') as (Element & Record<string, unknown>) | null
    if (!root) throw new Error('no .excalidraw')
    const key = Object.keys(root).find((k) => k.startsWith('__reactFiber$'))
    if (!key) throw new Error('no React fiber on .excalidraw')
    type Fiber = { return: Fiber | null; stateNode: unknown }
    let f = root[key] as Fiber | null
    while (f && !(f.stateNode && typeof f.stateNode === 'object' && 'actionManager' in f.stateNode))
      f = f.return
    if (!f) throw new Error('no App instance above .excalidraw')
    const am = (
      f.stateNode as {
        actionManager: { actions: Record<string, { name: string; perform: (...a: unknown[]) => unknown }> }
      }
    ).actionManager
    for (const a of Object.values(am.actions)) {
      const orig = a.perform
      a.perform = function (this: unknown, ...args: unknown[]) {
        performed.push(a.name)
        return orig.apply(this, args)
      }
    }
  })
}

interface Measured {
  label: string
  verdict: string | null
  performed: string[]
  appChanges: string[]
  elementChanges: number
  newElements: number
  pickers: number
  downloads: number
  dialogs: number
  popups: number
  openDialog: string | null
  toast: string | null
}

async function buildScene(page: Page): Promise<void> {
  await resetLab(page)
  await lab(page, (x) =>
    x.fixture.add([
      {
        type: 'rectangle',
        id: 'r1',
        x: 80,
        y: 90,
        width: 160,
        height: 100,
        backgroundColor: '#a5d8ff',
        fillStyle: 'solid',
      },
      {
        type: 'rectangle',
        id: 'r2',
        x: 300,
        y: 120,
        width: 160,
        height: 100,
        backgroundColor: '#b2f2bb',
        fillStyle: 'solid',
      },
    ]),
  )
  await addNote(page, { id: 'n1', x: 540, y: 100, size: 200, text: 'A note' })
  await select(page, ['r1', 'r2'])
}

async function measure(
  page: Page,
  cdp: CDPSession,
  watch: PageWatch,
  p: Press,
  platform: 'win' | 'mac',
): Promise<Measured> {
  await select(page, ['r1', 'r2'])
  await focusCanvas(page)
  const before = await lab(page, (x) => {
    const w = window as unknown as { __performed: string[]; __spikePickerCalls?: Record<string, number> }
    return {
      performed: w.__performed.length,
      app: x.appSnap(),
      versions: x.versions(),
      keyTraces: x.traces.filter((t: { type: string }) => t.type === 'key').length,
      pickers: Object.values(w.__spikePickerCalls ?? {}).reduce((a, b) => a + b, 0),
    }
  })
  const d0 = { downloads: watch.downloads, dialogs: watch.dialogs, popups: watch.popups }
  await cdpPress(cdp, p, platform)
  const after = await lab(
    page,
    async (x, b) => {
      await new Promise<void>((r) =>
        requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(r, 120))),
      )
      const w = window as unknown as { __performed: string[]; __spikePickerCalls?: Record<string, number> }
      const app = x.appSnap()
      const versions = x.versions()
      const keyTraces = x.traces.filter((t: { type: string }) => t.type === 'key').slice(b.keyTraces)
      return {
        performed: w.__performed.slice(b.performed),
        appChanges: Object.keys(app).filter((f) => JSON.stringify(app[f]) !== JSON.stringify(b.app[f])),
        elementChanges: Object.keys(b.versions).filter(
          (id) => JSON.stringify(b.versions[id]) !== JSON.stringify(versions[id]),
        ).length,
        newElements: Object.keys(versions).filter((id) => !(id in b.versions)).length,
        verdict: (keyTraces[0] as { verdict?: string } | undefined)?.verdict ?? null,
        pickers: Object.values(w.__spikePickerCalls ?? {}).reduce((a, c) => a + c, 0) - b.pickers,
        openDialog: app.openDialog,
        toast: app.toast,
      }
    },
    before,
  )
  const m: Measured = {
    label: p.label,
    ...after,
    downloads: watch.downloads - d0.downloads,
    dialogs: watch.dialogs - d0.dialogs,
    popups: watch.popups - d0.popups,
  }
  // Undo whatever the press did before the next one (CONTROL runs act).
  if (m.performed.length || m.appChanges.length || m.elementChanges || m.newElements) {
    await lab(page, () => {
      const api = (window as unknown as { __lobbySpike: { api: { updateScene(d: unknown): void } } })
        .__lobbySpike.api
      api.updateScene({ appState: { openDialog: null, openPopup: null, toast: null } })
    })
    await buildScene(page)
  }
  return m
}

/** CONTROL's outcome: 'delegated:<action>' when exactly one delegated action ran and nothing else did. */
function controlOutcome(m: Measured): string {
  const others = m.performed.filter((a) => !DELEGATED.has(a))
  const own = m.performed.filter((a) => DELEGATED.has(a))
  const sideEffects = m.pickers + m.downloads + m.dialogs + m.popups > 0 || !!m.openDialog || !!m.toast
  if (own.length === 1 && others.length === 0 && !sideEffects) {
    const allowed = new Set(OWN_EFFECT[own[0] ?? ''] ?? [])
    if (m.appChanges.every((f) => allowed.has(f))) return `delegated:${own[0]}`
  }
  if (
    m.performed.length === 0 &&
    m.appChanges.length === 0 &&
    !sideEffects &&
    !m.elementChanges &&
    !m.newElements
  ) {
    return 'nothing'
  }
  return `other:${[
    ...m.performed,
    ...m.appChanges.map((f) => `app.${f}`),
    m.openDialog ? `dialog:${m.openDialog}` : '',
    m.pickers ? `pickers:${m.pickers}` : '',
  ]
    .filter(Boolean)
    .join(',')}`
}

for (const platform of ['win', 'mac'] as const) {
  test.describe(`A6 layouts outside the text editor (${platform === 'mac' ? 'macOS emulation' : 'Windows'})`, () => {
    test.beforeEach(async ({ page }) => {
      await instrumentFilePickers(page)
      if (platform === 'mac') {
        await page.addInitScript(() => {
          Object.defineProperty(Navigator.prototype, 'platform', {
            get: () => 'MacIntel',
            configurable: true,
          })
        })
      }
    })

    test("the verifier's five layout cases: blocked and prevented; 0 pickers, downloads, dialogs; 3/3", async ({
      page,
    }) => {
      const watch = watchPage(page)
      await openLab(page, { grant: 30 })
      await hookActions(page)
      const cdp = await page.context().newCDPSession(page)
      const cases: Press[] = [
        {
          label: 'Bone Ctrl+Shift+S on KeyL',
          code: 'KeyL',
          key: 'S',
          shift: true,
          alt: false,
          otherMod: false,
        },
        {
          label: 'Colemak Ctrl+S on KeyD',
          code: 'KeyD',
          key: 's',
          shift: false,
          alt: false,
          otherMod: false,
        },
        { label: 'Neo 2 Ctrl+O on KeyG', code: 'KeyG', key: 'o', shift: false, alt: false, otherMod: false },
        {
          label: 'QWERTZ Ctrl+Shift+ß on Minus (key ?)',
          code: 'Minus',
          key: '?',
          shift: true,
          alt: false,
          otherMod: false,
        },
        {
          label: 'Dvorak Ctrl+Shift+[ on BracketLeft (key ?)',
          code: 'BracketLeft',
          key: '?',
          shift: true,
          alt: false,
          otherMod: false,
        },
      ]
      const out: Measured[] = []
      await buildScene(page)
      for (const c of cases)
        for (let i = 0; i < 3; i++) out.push(await measure(page, cdp, watch, c, platform))
      console.log(`A6-LAYOUTS-VERIFIER-${platform}`, JSON.stringify(out))
      for (const m of out) {
        expect(m, m.label).toMatchObject({
          verdict: 'block+prevent',
          performed: [],
          appChanges: [],
          elementChanges: 0,
          newElements: 0,
          pickers: 0,
          downloads: 0,
          dialogs: 0,
          popups: 0,
          openDialog: null,
        })
      }
      expect(await filePickerCalls(page)).toEqual({
        showSaveFilePicker: 0,
        showOpenFilePicker: 0,
        showDirectoryPicker: 0,
      })
      expect(watch.pageErrors).toEqual([])
    })

    test('sweep: every delegated chord on 7 layouts; Lobby delegates exactly what Excalidraw would run as that delegated action; 0 pickers, downloads, dialogs', async ({
      page,
    }) => {
      test.setTimeout(600_000)
      const list = presses(platform)
      const cdp0 = { control: [] as Measured[], lobby: [] as Measured[] }
      for (const mode of ['off', 'on'] as const) {
        const watch = watchPage(page)
        await openLab(page, { grant: 30, allowlist: mode })
        await hookActions(page)
        const cdp = await page.context().newCDPSession(page)
        await buildScene(page)
        for (const p of list)
          (mode === 'off' ? cdp0.control : cdp0.lobby).push(await measure(page, cdp, watch, p, platform))
        await cdp.detach()
        if (mode === 'on') expect(watch.pageErrors).toEqual([])
      }
      const rows = list.map((p, i) => {
        const c = cdp0.control[i] as Measured
        const l = cdp0.lobby[i] as Measured
        const outcome = controlOutcome(c)
        const expectDelegate = outcome.startsWith('delegated:')
        const delegated = l.verdict === 'delegate'
        const ok =
          delegated === expectDelegate &&
          (!delegated ||
            JSON.stringify(l.performed) === JSON.stringify([outcome.slice('delegated:'.length)])) &&
          l.performed.every((a) => DELEGATED.has(a)) &&
          l.pickers + l.downloads + l.dialogs + l.popups === 0 &&
          !l.openDialog &&
          !l.toast &&
          l.appChanges.every((f) => ['zoom', 'scrollX', 'scrollY', 'selected'].includes(f))
        return {
          label: p.label,
          ok,
          control: outcome,
          lobby: l.verdict,
          lobbyPerformed: l.performed,
          lobbyApp: l.appChanges,
        }
      })
      const fails = rows.filter((r) => !r.ok)
      const summary = {
        presses: rows.length,
        delegated: rows.filter((r) => r.lobby === 'delegate').length,
        controlDelegated: rows.filter((r) => r.control.startsWith('delegated:')).length,
        controlOther: rows
          .filter((r) => r.control.startsWith('other:'))
          .map((r) => `${r.label} -> ${r.control}`),
        controlNothing: rows.filter((r) => r.control === 'nothing').length,
        lobbyPickers: cdp0.lobby.reduce((a, m) => a + m.pickers, 0),
        lobbyDialogs: cdp0.lobby.filter((m) => !!m.openDialog).length,
        fails,
      }
      console.log(`A6-LAYOUTS-SWEEP-${platform}`, JSON.stringify(summary))
      expect(fails).toEqual([])
      expect(summary.delegated).toBeGreaterThan(15)
      // The probe is live: the CONTROL run reached Excalidraw's save picker and help dialog.
      expect(summary.controlOther.some((s) => s.includes('saveFileToDisk'))).toBe(true)
      expect(summary.controlOther.some((s) => s.includes('dialog:help'))).toBe(true)
    })
  })
}
