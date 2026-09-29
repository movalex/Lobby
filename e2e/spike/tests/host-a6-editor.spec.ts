import { type BrowserContext, expect, type Page, test } from '@playwright/test'
import { filePickerCalls, instrumentFilePickers, type PageWatch, watchPage } from '../support/watch.ts'
import {
  addNote,
  centerOf,
  editor,
  lab,
  monitorStart,
  openLab,
  resetLab,
  settle,
  waitEditor,
} from './host-kit.ts'

// A6 regression (open item 1, corrected): inside a GRANTED text editor the keys are an allowlist
// (apps/web/src/canvas/input/keymap.ts, classifyTextEditorKey). Every chord with Ctrl, Cmd or Alt that is
// not a kept text-editing chord is stopped in the capture phase, before Excalidraw's textarea handler
// (dist/dev/index.js:25367-25409) can run a zoom, font-size, save (showSaveFilePicker) or submit action.
//
// The sweep: every letter, digit and punctuation key (47) with every combination of Ctrl/Meta/Alt/Shift
// that includes Ctrl, Meta or Alt (14), in one granted editor, on Windows and under macOS emulation
// (navigator.platform = 'MacIntel': Excalidraw's CTRL_OR_CMD is then metaKey). Per press: 0 picker
// calls, 0 downloads, 0 dialogs, 0 popups or new pages, no element change except the label's text (and
// its container's fit), no appState change, the same editor still open and focused. Kept chords must
// reach the textarea; every other chord must not (a target-phase listener counts what reaches it).

const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('').map((c) => `Key${c}`)
const DIGITS = Array.from({ length: 10 }, (_, d) => `Digit${d}`)
const PUNCTUATION = [
  'Backquote',
  'Minus',
  'Equal',
  'BracketLeft',
  'BracketRight',
  'Backslash',
  'Semicolon',
  'Quote',
  'Comma',
  'Period',
  'Slash',
]
const KEYS = [...LETTERS, ...DIGITS, ...PUNCTUATION]
const MODIFIERS = ['Control', 'Meta', 'Alt', 'Shift'] as const
type Mod = (typeof MODIFIERS)[number]
const COMBOS: Mod[][] = []
for (let m = 1; m < 16; m++) {
  const combo = MODIFIERS.filter((_, i) => m & (1 << i))
  if (combo.some((c) => c !== 'Shift')) COMBOS.push(combo)
}

/** The kept text-editing chords among the swept keys (the task's allowlist). */
function kept(mods: readonly Mod[], code: string): boolean {
  const ctrl = mods.includes('Control')
  const meta = mods.includes('Meta')
  const alt = mods.includes('Alt')
  const shift = mods.includes('Shift')
  if (alt || ctrl === meta) return false
  switch (code) {
    case 'KeyZ':
    case 'KeyV':
      return true
    case 'KeyA':
    case 'KeyC':
    case 'KeyX':
      return !shift
    case 'KeyY':
      return ctrl && !shift
    default:
      return false
  }
}

interface PressResult {
  chord: string
  pickers: number
  downloads: number
  dialogs: number
  popups: number
  pages: number
  elementChanges: string[]
  appStateChanges: string[]
  editorOpen: boolean
  sameEditor: boolean
  focused: boolean
  reached: number
  kept: boolean
  value: string | null
}

/** In-page baseline for the next press (window.__a6). */
async function baseline(page: Page): Promise<void> {
  await lab(page, (x) => {
    const api = (
      window as unknown as {
        __lobbySpike: {
          api: { getAppState(): { editingTextElement: { id: string; containerId: string | null } | null } }
        }
      }
    ).__lobbySpike.api
    const editing = api.getAppState().editingTextElement
    const counts =
      (window as unknown as { __spikePickerCalls?: Record<string, number> }).__spikePickerCalls ?? {}
    const ta = document.querySelector<HTMLTextAreaElement>('textarea.excalidraw-wysiwyg')
    ;(window as unknown as { __a6: unknown }).__a6 = {
      labelId: editing?.id ?? null,
      containerId: editing?.containerId ?? null,
      pickers: Object.values(counts).reduce((a, b) => a + b, 0),
      elements: new Map(x.elements().map((e: { id: string }) => [e.id, e])),
      app: x.appSnap(),
      probe: ta?.dataset.probe ?? null,
      reached: x.monitor.reachedCount(),
    }
  })
}

/** Compares with the baseline, then re-baselines. */
async function afterPress(
  page: Page,
  code: string,
): Promise<Omit<PressResult, 'chord' | 'downloads' | 'dialogs' | 'popups' | 'pages' | 'kept'>> {
  return lab(
    page,
    async (x, keyCode) => {
      await new Promise<void>((r) =>
        requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(r, 40))),
      )
      const w = window as unknown as {
        __a6: {
          labelId: string | null
          containerId: string | null
          pickers: number
          elements: Map<string, Record<string, unknown>>
          app: Record<string, unknown>
          probe: string | null
          reached: number
        }
        __spikePickerCalls?: Record<string, number>
      }
      const b = w.__a6
      const counts = w.__spikePickerCalls ?? {}
      const pickers = Object.values(counts).reduce((a, n) => a + n, 0) - b.pickers
      const LABEL_OK = new Set([
        'text',
        'originalText',
        'x',
        'y',
        'width',
        'height',
        'version',
        'versionNonce',
        'updated',
      ])
      const FIT_OK = new Set(['x', 'y', 'width', 'height', 'version', 'versionNonce', 'updated'])
      const elementChanges: string[] = []
      const now = x.elements() as Record<string, unknown>[]
      for (const e of now) {
        const id = e.id as string
        const prev = b.elements.get(id)
        if (!prev) {
          elementChanges.push(`${id}:(new)`)
          continue
        }
        for (const k of new Set([...Object.keys(prev), ...Object.keys(e)])) {
          if (JSON.stringify(prev[k]) === JSON.stringify(e[k])) continue
          const ok = id === b.labelId ? LABEL_OK.has(k) : id === b.containerId ? FIT_OK.has(k) : false
          if (!ok) elementChanges.push(`${id}:${k}`)
        }
      }
      const app = x.appSnap() as Record<string, unknown>
      const appStateChanges = Object.keys(b.app).filter(
        (k) => JSON.stringify(b.app[k]) !== JSON.stringify(app[k]),
      )
      const ta = document.querySelector<HTMLTextAreaElement>('textarea.excalidraw-wysiwyg')
      const reached = (x.monitor.reachedSince(b.reached) as { code: string }[]).filter(
        (r) => r.code === keyCode,
      ).length
      const result = {
        pickers,
        elementChanges,
        appStateChanges,
        editorOpen: !!ta && x.editor().phase === 'open',
        sameEditor: !!ta && ta.dataset.probe === b.probe,
        focused: !!ta && document.activeElement === ta,
        reached,
        value: ta?.value ?? null,
      }
      w.__a6 = {
        ...b,
        pickers: b.pickers + pickers,
        elements: new Map(now.map((e) => [e.id as string, e])),
        app,
        reached: x.monitor.reachedCount(),
      }
      return result
    },
    code,
  )
}

async function openGrantedEditor(page: Page): Promise<void> {
  await resetLab(page)
  const ids = await addNote(page, { x: 200, y: 150, size: 200, text: 'Editing' })
  const c = await centerOf(page, ids.note)
  await page.mouse.click(c.x + 60, c.y + 70)
  await page.keyboard.press('Enter')
  await waitEditor(page, (e) => e.phase === 'open' && !!e.textarea?.focused && !e.textarea.readOnly)
  await page.keyboard.type('abc')
  await settle(page, 40)
  await monitorStart(page)
  await baseline(page)
}

function countPages(context: BrowserContext): { n: number } {
  const c = { n: 0 }
  context.on('page', () => {
    c.n++
  })
  return c
}

async function sweep(page: Page, watch: PageWatch, pages: { n: number }): Promise<PressResult[]> {
  const out: PressResult[] = []
  await openGrantedEditor(page)
  for (const combo of COMBOS) {
    for (const code of KEYS) {
      const chord = [...combo, code].join('+')
      const d0 = { downloads: watch.downloads, dialogs: watch.dialogs, popups: watch.popups, pages: pages.n }
      await page.keyboard.press(chord)
      const r = await afterPress(page, code)
      const row: PressResult = {
        chord,
        ...r,
        downloads: watch.downloads - d0.downloads,
        dialogs: watch.dialogs - d0.dialogs,
        popups: watch.popups - d0.popups,
        pages: pages.n - d0.pages,
        kept: kept(combo, code),
      }
      out.push(row)
      if (!row.editorOpen || !row.sameEditor || !row.focused) await openGrantedEditor(page) // keep sweeping
    }
  }
  return out
}

const failed = (r: PressResult) =>
  r.pickers !== 0 ||
  r.downloads !== 0 ||
  r.dialogs !== 0 ||
  r.popups !== 0 ||
  r.pages !== 0 ||
  r.elementChanges.length > 0 ||
  r.appStateChanges.length > 0 ||
  !r.editorOpen ||
  !r.sameEditor ||
  !r.focused ||
  (r.kept ? r.reached === 0 : r.reached !== 0)

test.describe('A6 regression: chords inside a granted text editor', () => {
  for (const platform of ['win', 'mac'] as const) {
    test(`${platform}: 47 keys x 14 Ctrl/Meta/Alt(+Shift) combinations: nothing acts, the editor stays open`, async ({
      page,
      context,
    }) => {
      test.setTimeout(420_000)
      await instrumentFilePickers(page)
      if (platform === 'mac') {
        await page.addInitScript(() => {
          Object.defineProperty(Navigator.prototype, 'platform', {
            get: () => 'MacIntel',
            configurable: true,
          })
        })
      }
      const watch = watchPage(page)
      const pages = countPages(context)
      await openLab(page, { grant: 30 })
      const results = await sweep(page, watch, pages)
      await settle(page, 500)
      const pickersTotal = Object.values(await filePickerCalls(page)).reduce((a, b) => a + b, 0)
      const bad = results.filter(failed)
      const keptRows = results.filter((r) => r.kept)
      // What acted (beyond reaching the textarea): pickers, element or appState changes, a closed editor.
      const acted = results
        .filter(
          (r) =>
            r.pickers ||
            r.downloads ||
            r.dialogs ||
            r.popups ||
            r.pages ||
            r.elementChanges.length ||
            r.appStateChanges.length ||
            !r.editorOpen ||
            !r.sameEditor ||
            !r.focused,
        )
        .map((r) => {
          const what = [
            r.pickers ? `picker x${r.pickers}` : '',
            r.elementChanges.length ? `elements ${r.elementChanges.join(' ')}` : '',
            r.appStateChanges.length ? `appState ${r.appStateChanges.join(' ')}` : '',
            !r.editorOpen || !r.sameEditor ? 'editor closed' : !r.focused ? 'focus lost' : '',
            r.downloads || r.dialogs || r.popups || r.pages ? 'download/dialog/popup/page' : '',
          ]
          return `${r.chord}: ${what.filter(Boolean).join('; ')}`
        })
      console.log(
        `A6-EDITOR-SWEEP-${platform}`,
        JSON.stringify({
          presses: results.length,
          keys: KEYS.length,
          combos: COMBOS.length,
          kept: keptRows.length,
          keptReached: keptRows.filter((r) => r.reached > 0).length,
          blockedReached: results.filter((r) => !r.kept && r.reached > 0).length,
          failed: bad.length,
          pickersTotal,
          downloads: watch.downloads,
          dialogs: watch.dialogs,
          popups: watch.popups,
          pages: pages.n,
          acted,
          sampleFailures: bad.slice(0, 5),
          failedCount: bad.length,
        }),
      )
      expect(results.length).toBe(KEYS.length * COMBOS.length)
      expect(bad.map((r) => r.chord)).toEqual([])
      expect(pickersTotal).toBe(0)
      expect(watch.pageErrors).toEqual([])
    })
  }

  test('win: the kept keys still work (native undo/redo, word delete, select all, caret moves, clipboard, indent)', async ({
    page,
    context,
  }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write'])
    await instrumentFilePickers(page)
    const watch = watchPage(page)
    await openLab(page, { grant: 30 })
    await resetLab(page)
    const ids = await addNote(page, { x: 200, y: 150, size: 260, text: 'Editing' })
    const c = await centerOf(page, ids.note)
    await page.mouse.click(c.x + 60, c.y + 90)
    await page.keyboard.press('Enter')
    await waitEditor(page, (e) => e.phase === 'open' && !!e.textarea?.focused && !e.textarea.readOnly)
    const value = async () => (await editor(page)).textarea?.value ?? null
    const sel = async () => {
      const t = (await editor(page)).textarea
      return t ? [t.selectionStart, t.selectionEnd] : null
    }
    const steps: Record<string, unknown>[] = []
    const step = async (name: string, keys: string[], check: () => Promise<unknown>, want: unknown) => {
      for (const k of keys) await page.keyboard.press(k)
      await settle(page, 30)
      const got = await check()
      steps.push({ name, keys, got, want, ok: JSON.stringify(got) === JSON.stringify(want) })
    }
    await page.keyboard.type(' hello world')
    await settle(page, 30)
    const typed = 'Editing hello world'
    await step('Ctrl+Backspace deletes a word', ['Control+Backspace'], value, 'Editing hello ')
    await step('Ctrl+Z undoes it (native)', ['Control+z'], value, typed)
    await step('Ctrl+Y redoes', ['Control+y'], value, 'Editing hello ')
    await step('Ctrl+Z again', ['Control+z'], value, typed)
    await step('Ctrl+Shift+Z redoes', ['Control+Shift+Z'], value, 'Editing hello ')
    await step('Ctrl+Z again', ['Control+z'], value, typed)
    await step('Ctrl+A selects the text', ['Control+a'], sel, [0, typed.length])
    await step('End, Ctrl+Left moves a word', ['End', 'Control+ArrowLeft'], sel, [14, 14])
    await step('Shift+Home selects to the line start', ['Shift+Home'], sel, [0, 14])
    // Windows: Ctrl+Delete deletes the word and the space after it.
    await step('Ctrl+Delete deletes a word forward', ['ArrowLeft', 'Control+Delete'], value, 'hello world')
    await step('Ctrl+Z restores it', ['Control+z'], value, typed)
    await step(
      'Ctrl+C, End, Ctrl+V pastes the copy',
      ['Control+a', 'Control+c', 'End', 'Control+v'],
      value,
      typed + typed,
    )
    await step('Ctrl+Z undoes the paste', ['Control+z'], value, typed)
    await step('Tab indents (Excalidraw, 4 spaces)', ['Home', 'Tab'], value, `    ${typed}`)
    await step('Shift+Tab outdents', ['Shift+Tab'], value, typed)
    await step(
      'Shift+Enter and Enter add lines',
      ['End', 'Shift+Enter', 'x', 'Enter', 'y'],
      value,
      `${typed}\nx\ny`,
    )
    const verdicts = await lab(page, (x) =>
      x.traces
        .filter((t: { type: string; inTextEditor: boolean }) => t.type === 'key' && t.inTextEditor)
        .map((t: { key: string; verdict: string }) => `${t.key}:${t.verdict}`),
    )
    await page.keyboard.press('Escape')
    await waitEditor(page, (e) => e.phase === 'idle' && e.textarea === null)
    const stored = await lab(
      page,
      (x, id) => x.elements().find((e: { id: string }) => e.id === id)?.originalText,
      ids.label,
    )
    console.log('A6-EDITOR-KEPT-win', JSON.stringify({ steps, stored, verdicts }))
    expect(steps.filter((s) => !s.ok)).toEqual([])
    expect(stored).toBe(`${typed}\nx\ny`)
    expect(verdicts.filter((v: string) => !v.endsWith(':delegate'))).toEqual([])
    expect(watch.downloads + watch.dialogs + watch.popups).toBe(0)
    expect(Object.values(await filePickerCalls(page)).reduce((a, b) => a + b, 0)).toBe(0)
  })

  test('mac: the kept Cmd chords reach the textarea; Option characters are left to the browser; Ctrl/Cmd+Alt+S are stopped', async ({
    page,
  }) => {
    await instrumentFilePickers(page)
    await page.addInitScript(() => {
      Object.defineProperty(Navigator.prototype, 'platform', { get: () => 'MacIntel', configurable: true })
    })
    await openLab(page, { grant: 30 })
    await openGrantedEditor(page)
    const verdictOf = async (key: string) => {
      const n0 = await lab(page, (x) => x.traces.length)
      await page.keyboard.press(key)
      await settle(page, 30)
      return lab(
        page,
        (x, n) =>
          x.traces
            .slice(n)
            .filter(
              (t: { type: string; key: string }) =>
                t.type === 'key' && !['Meta', 'Control', 'Alt', 'Shift'].includes(t.key),
            )
            .map((t: { verdict: string }) => t.verdict)
            .join(','),
        n0,
      )
    }
    const out: Record<string, string> = {}
    for (const k of [
      'Meta+z',
      'Meta+Shift+Z',
      'Meta+a',
      'Meta+c',
      'Meta+x',
      'Meta+v',
      'Meta+Backspace',
      'Alt+Backspace',
      'Alt+ArrowLeft',
      'Meta+ArrowRight',
      'Alt+e',
      'Alt+s',
      'Meta+s',
      'Meta+Alt+s',
      'Control+Alt+s',
      'Meta+Equal',
      'Meta+Shift+Period',
      'Meta+Enter',
      'Meta+BracketRight',
      'Meta+y',
    ]) {
      out[k] = await verdictOf(k)
    }
    const st = await editor(page)
    console.log(
      'A6-EDITOR-KEPT-mac',
      JSON.stringify({ verdicts: out, open: st.phase, pickers: await filePickerCalls(page) }),
    )
    expect(out).toEqual({
      'Meta+z': 'delegate',
      'Meta+Shift+Z': 'delegate',
      'Meta+a': 'delegate',
      'Meta+c': 'delegate',
      'Meta+x': 'delegate',
      'Meta+v': 'delegate',
      'Meta+Backspace': 'delegate',
      'Alt+Backspace': 'delegate',
      'Alt+ArrowLeft': 'delegate',
      'Meta+ArrowRight': 'delegate',
      'Alt+e': 'browser',
      'Alt+s': 'browser',
      'Meta+s': 'block+prevent',
      'Meta+Alt+s': 'block+prevent',
      'Control+Alt+s': 'block+prevent',
      'Meta+Equal': 'block+prevent',
      'Meta+Shift+Period': 'block+prevent',
      'Meta+Enter': 'block+prevent',
      'Meta+BracketRight': 'block+prevent',
      'Meta+y': 'block+prevent',
    })
    expect(st.phase).toBe('open')
    expect(Object.values(await filePickerCalls(page)).reduce((a, b) => a + b, 0)).toBe(0)
  })
})
