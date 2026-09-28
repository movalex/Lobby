import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { expect, type Page, test } from '@playwright/test'
import { watchPage } from '../support/watch.ts'
import {
  addNote,
  centerOf,
  type EditorState,
  editor,
  element,
  focusCanvas,
  lab,
  type NoteIds,
  openLab,
  resetLab,
  toClient,
  versions,
  waitEditor,
} from './host-kit.ts'

// A16 (docs/EXCALIDRAW-MIGRATION.md §8.2 and §2.9.2, revision 3.1 open item 2): every editor-open path
// P1-P8, triggered on a note with NO grant (the fake lease server holds its answer: ?grant=manual).
//  - P1-P4 open only after the grant (no textarea, no editingTextElement, 1 acquire, 0 element changes
//    before it); P5 is caught by the guard (read-only textarea at once, keys buffered, 0 element
//    changes before the grant); P6-P8 are unreachable (setTool refuses text/stickynote/autoshape; T, N,
//    8 and Shift+X never activate them).
//  - Non-text double-clicks still work (forwarded to Excalidraw), and the swallowed second touchstart of
//    a double-tap is preventDefault-ed by Lobby.
// Pass: 8/8 paths plus the 2 forwarded cases; 20/20 per path.

const N = 20
const ROOT = resolve(import.meta.dirname, '../../..')

const settle = (page: Page, ms = 120) =>
  page.evaluate(
    (t) =>
      new Promise<void>((r) =>
        requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(() => r(), t))),
      ),
    ms,
  )

interface Before {
  state: EditorState
  acquires: string[]
  elementChanges: number
}

async function acquires(page: Page): Promise<string[]> {
  return lab(page, (x) =>
    x.lease
      .log()
      .filter(
        (l: { dir: string; message: { type: string } }) =>
          l.dir === 'up' && l.message.type === 'lease.acquire',
      )
      .map((l: { message: { id: string } }) => l.message.id),
  )
}

async function changedSince(page: Page, v0: Record<string, [number, number]>): Promise<number> {
  const v1 = await versions(page)
  return (
    Object.keys(v1).filter((id) => JSON.stringify(v0[id]) !== JSON.stringify(v1[id])).length +
    Object.keys(v0).filter((id) => !(id in v1)).length
  )
}

/** A point on the note's body, away from its centered label. */
async function bodyPoint(page: Page, id: string): Promise<{ x: number; y: number }> {
  const el = await element(page, id)
  if (!el) throw new Error('no note')
  return toClient(page, el.x + 24, el.y + 24)
}

/** A point on the note's label text. */
async function labelPoint(page: Page, ids: NoteIds): Promise<{ x: number; y: number }> {
  if (!ids.label) throw new Error('no label')
  return centerOf(page, ids.label)
}

async function selectByClick(page: Page, ids: NoteIds): Promise<void> {
  const p = await bodyPoint(page, ids.note)
  await page.mouse.click(p.x, p.y)
  await expect
    .poll(() => page.evaluate(() => window.__lobbySpike?.api?.getAppState().selectedElementIds))
    .toEqual({ [ids.note]: true })
  await page.waitForTimeout(600) // the next click must not pair with this one (dblclick / Excalidraw's own)
}

type PathKind = 'lease-first' | 'guard'

interface PathCase {
  name: string
  kind: PathKind
  /** Selects first with a real click (P1, P2, P5, P6). */
  preselect: boolean
  trigger: (page: Page, ids: NoteIds) => Promise<void>
  /** Extra text the trigger itself types (P2's first key). */
  typedByTrigger?: string
  /**
   * Guard cases: Excalidraw selected the whole text when it opened (a double-click's pointer-up opens
   * with autoSelect: `initialCaretSceneCoords: this.lastPointerUpIsDoubleClick ? undefined : …`,
   * index.js:51685), so the replayed keys replace it, exactly as if the lease had been instant.
   */
  replacesAll?: boolean
}

/** Labels made before Nunito loads are measured with a fallback font; see the cold-open test. */
async function warmFonts(page: Page): Promise<void> {
  await page.evaluate(async () => {
    await document.fonts.load('20px Nunito', 'Label Tap 0123456789 zq')
  })
}

const TYPED = 'zq'

async function runPath(page: Page, c: PathCase, i: number): Promise<Record<string, unknown>> {
  await resetLab(page)
  const original = `Label ${i}`
  const ids = await addNote(page, { x: 220, y: 160, size: 200, text: original })
  if (c.preselect) await selectByClick(page, ids)
  await lab(page, (x) => x.lease.setDelay('manual'))
  const v0 = await versions(page)
  await c.trigger(page, ids)
  await settle(page)
  const first = await editor(page)
  // Keys typed before the grant.
  await page.keyboard.type(TYPED)
  await settle(page, 60)
  const before: Before = {
    state: await editor(page),
    acquires: await acquires(page),
    elementChanges: await changedSince(page, v0),
  }
  const pendingAnswers = await lab(page, (x) => x.lease.pending())
  await lab(page, (x) => x.lease.flush())
  const after = await waitEditor(
    page,
    (e) => e.phase === 'open' && !!e.textarea?.focused && !e.textarea.readOnly,
  ).catch(() => editor(page))
  await expect
    .poll(() => editor(page).then((e) => e.textarea?.value ?? ''), { timeout: 3000 })
    .toContain(TYPED)
    .catch(() => {})
  const opened = await editor(page)
  const value = opened.textarea?.value ?? null
  await page.keyboard.press('Escape')
  await waitEditor(page, (e) => e.phase === 'idle' && e.textarea === null).catch(() => {})
  const label = ids.label ? await element(page, ids.label) : undefined
  const released = await lab(page, (x, id) => !x.lease.isHeld(id), ids.note)
  const expectText = original + (c.typedByTrigger ?? '') + TYPED

  let ok: boolean
  let why = ''
  if (c.kind === 'lease-first') {
    const noEditorBefore =
      first.textarea === null &&
      first.editingId === null &&
      before.state.textarea === null &&
      before.state.editingId === null
    ok =
      noEditorBefore &&
      before.state.phase === 'pending' &&
      before.acquires.length === 1 &&
      before.acquires[0] === ids.note &&
      before.elementChanges === 0 &&
      pendingAnswers >= 1 &&
      value === expectText &&
      label?.originalText === expectText &&
      released
    if (!noEditorBefore) why = 'editor before grant'
  } else {
    ok =
      first.textarea !== null &&
      first.textarea.readOnly === true &&
      before.state.origin === 'guard' &&
      before.state.textarea?.readOnly === true &&
      before.state.textarea.value === original &&
      before.acquires.length === 1 &&
      before.acquires[0] === ids.note &&
      before.elementChanges === 0 &&
      value !== null &&
      (c.replacesAll ? value === TYPED : value.replace(TYPED, '') === original) &&
      label?.originalText === value &&
      released
  }
  if (!ok && !why) why = 'see fields'
  return {
    i,
    ok,
    why,
    firstTextarea: first.textarea ? { readOnly: first.textarea.readOnly } : null,
    phaseBefore: before.state.phase,
    originBefore: before.state.origin,
    valueBefore: before.state.textarea?.value ?? null,
    acquires: before.acquires.length,
    elementChangesBeforeGrant: before.elementChanges,
    afterPhase: after.phase,
    value,
    stored: label?.originalText ?? null,
    released,
  }
}

async function runCases(
  page: Page,
  c: PathCase,
): Promise<{ pass: number; results: Record<string, unknown>[] }> {
  await warmFonts(page)
  const results: Record<string, unknown>[] = []
  for (let i = 0; i < N; i++) results.push(await runPath(page, c, i))
  const pass = results.filter((r) => r.ok).length
  console.log(
    `A16-${c.name}`,
    JSON.stringify({ pass, of: N, sample: results.slice(0, 2), failed: results.filter((r) => !r.ok) }),
  )
  return { pass, results }
}

test.describe('A16: editor-open paths (mouse / keyboard)', () => {
  test('probe: 7 startTextEditing and 2 handleTextWysiwyg call sites in the pinned bundle', () => {
    const count = (file: string, re: RegExp) => (readFileSync(file, 'utf8').match(re) ?? []).length
    const out: Record<string, number> = {}
    for (const flavour of ['dev', 'prod']) {
      const file = resolve(ROOT, `apps/web/node_modules/@excalidraw/excalidraw/dist/${flavour}/index.js`)
      out[`${flavour}.startTextEditing`] = count(file, /[\w$]+\.startTextEditing\(/g)
      out[`${flavour}.handleTextWysiwyg`] = count(file, /[\w$]+\.handleTextWysiwyg\(/g)
    }
    console.log('A16-PROBE', JSON.stringify(out))
    expect(out).toEqual({
      'dev.startTextEditing': 7,
      'dev.handleTextWysiwyg': 2,
      'prod.startTextEditing': 7,
      'prod.handleTextWysiwyg': 2,
    })
  })

  const cases: PathCase[] = [
    {
      name: 'P1-enter',
      kind: 'lease-first',
      preselect: true,
      trigger: async (page) => {
        await page.keyboard.press('Enter')
      },
    },
    {
      name: 'P2-type-to-edit',
      kind: 'lease-first',
      preselect: true,
      typedByTrigger: 'k',
      trigger: async (page) => {
        await page.keyboard.type('k')
      },
    },
    {
      name: 'P3a-dblclick-body',
      kind: 'lease-first',
      preselect: false,
      trigger: async (page, ids) => {
        const p = await bodyPoint(page, ids.note)
        await page.mouse.dblclick(p.x, p.y)
      },
    },
    {
      // Finding: on the label, the SECOND POINTER-UP of the double-click is P5 (index.js:51679-51686):
      // the editor opens before `dblclick` fires, and handleCanvasDoubleClick then returns because
      // editingTextElement is set (:44727). So this is a guard case, not a lease-first one.
      name: 'P3b-dblclick-label',
      kind: 'guard',
      preselect: false,
      replacesAll: true,
      trigger: async (page, ids) => {
        const p = await labelPoint(page, ids)
        await page.mouse.dblclick(p.x, p.y)
      },
    },
    {
      name: 'P5-second-click-on-label',
      kind: 'guard',
      preselect: true,
      trigger: async (page, ids) => {
        const p = await labelPoint(page, ids)
        await page.mouse.click(p.x, p.y)
      },
    },
    {
      name: 'P6-lobby-T-tool-click',
      kind: 'lease-first',
      preselect: false,
      trigger: async (page, ids) => {
        await focusCanvas(page)
        await page.keyboard.press('t') // Lobby's custom text tool, never Excalidraw's
        const p = await bodyPoint(page, ids.note)
        await page.mouse.click(p.x, p.y)
      },
    },
  ]

  for (const c of cases) {
    test(`${c.name}: ${c.kind === 'lease-first' ? 'opens only after the grant' : 'caught by the guard'}, 20/20`, async ({
      page,
    }) => {
      test.setTimeout(240_000)
      const watch = watchPage(page)
      await openLab(page, { grant: 'manual' })
      const { pass } = await runCases(page, c)
      expect(pass).toBe(N)
      expect(watch.pageErrors).toEqual([])
    })
  }

  test('cold open (finding): opening re-lays out a label measured before Nunito loaded; the guard holds it back', async ({
    page,
  }) => {
    await openLab(page, { grant: 'manual' })
    await resetLab(page)
    const fontBefore = await page.evaluate(() => document.fonts.check('20px Nunito', 'Label'))
    const original = 'Label cold'
    const ids = await addNote(page, { x: 220, y: 160, size: 200, text: original })
    await selectByClick(page, ids)
    const prev = await lab(page, (x) => x.elements())
    const p = await labelPoint(page, ids)
    await page.mouse.click(p.x, p.y)
    await settle(page)
    await page.keyboard.type(TYPED)
    await settle(page, 60)
    const writes = await lab(page, (x, before) => x.classifySince(before), prev)
    const st = await editor(page)
    console.log('A16-COLD-OPEN', JSON.stringify({ fontLoadedAtCreate: fontBefore, writes, editor: st }))
    expect(st).toMatchObject({
      phase: 'pending',
      origin: 'guard',
      textarea: { readOnly: true, value: original },
    })
    // Whatever Excalidraw re-measured on open is the leased label's layout (or the container's fit):
    // held back until the grant; nothing would be pushed.
    expect(writes.filter((w: { heldBack?: boolean }) => !w.heldBack)).toEqual([])
    await lab(page, (x) => x.lease.flush())
  })

  test('deny (the note is held by another user): P1 opens nothing, P5 closes unchanged, toast; 20/20 each', async ({
    page,
  }) => {
    test.setTimeout(240_000)
    await openLab(page, { grant: 'manual' })
    await warmFonts(page)
    const out: Record<string, unknown>[] = []
    for (const kind of ['P1', 'P5'] as const) {
      for (let i = 0; i < N; i++) {
        await resetLab(page)
        const original = `Held ${i}`
        const ids = await addNote(page, { x: 220, y: 160, size: 200, text: original })
        await lab(page, (x, id) => x.lease.holdByOther(id), ids.note)
        await selectByClick(page, ids)
        const v0 = await versions(page)
        if (kind === 'P1') await page.keyboard.press('Enter')
        else {
          const p = await labelPoint(page, ids)
          await page.mouse.click(p.x, p.y)
        }
        await settle(page)
        const before = await editor(page)
        await page.keyboard.type(TYPED)
        await settle(page, 40)
        await lab(page, (x) => x.lease.flush())
        await waitEditor(page, (e) => e.phase === 'idle' && e.textarea === null).catch(() => {})
        const after = await editor(page)
        const label = ids.label ? await element(page, ids.label) : undefined
        const deny = await lab(page, (x) =>
          x.lease.log().find((l: { message: { type: string } }) => l.message.type === 'lease.deny'),
        )
        const toasts = await lab(page, (x) => [...x.toasts])
        const ok =
          (kind === 'P1' ? before.textarea === null : before.textarea?.readOnly === true) &&
          after.phase === 'idle' &&
          after.textarea === null &&
          label?.originalText === original &&
          (await changedSince(page, v0)) === 0 &&
          deny?.message?.holder?.name === 'Alice' &&
          toasts.includes('Alice is typing in this note')
        out.push({
          kind,
          i,
          ok,
          before: before.phase,
          after: after.phase,
          stored: label?.originalText,
          toasts,
        })
      }
    }
    const fails = out.filter((r) => !r.ok)
    console.log(
      'A16-DENY',
      JSON.stringify({ pass: out.length - fails.length, of: out.length, sample: [out[0], out[N]], fails }),
    )
    expect(fails).toEqual([])
  })

  test('P6-P8 unreachable: setTool refuses text, stickynote, autoshape; T, N, 8, Shift+X never activate them', async ({
    page,
  }) => {
    await openLab(page, { grant: 'manual' })
    const out: Record<string, unknown>[] = []
    for (let i = 0; i < N; i++) {
      await resetLab(page)
      const refused = await lab(page, (x) => ({
        text: x.tools.setEngineTool('text'),
        stickynote: x.tools.setEngineTool('stickynote'),
        autoshape: x.tools.setEngineTool('autoshape'),
      }))
      await focusCanvas(page)
      const tools: Record<string, string> = {}
      for (const key of ['t', 'n', '8', 'Shift+X']) {
        await lab(page, (x) => x.tools.setTool('select'))
        await focusCanvas(page)
        await page.keyboard.press(key)
        await settle(page, 20)
        tools[key] = await lab(page, (x) => x.appSnap().activeTool)
      }
      const toolbar = await page.locator('.App-toolbar, [data-testid^="toolbar-"], .ToolIcon').count()
      out.push({ i, refused, tools, excalidrawToolbarNodes: toolbar })
    }
    console.log('A16-P6-P8', JSON.stringify({ sample: out[0], n: out.length }))
    for (const r of out) {
      expect(r).toMatchObject({
        refused: { text: false, stickynote: false, autoshape: false },
        tools: { t: 'custom:lobby-text', n: 'custom:lobby-note', '8': 'selection:', 'Shift+X': 'selection:' },
        excalidrawToolbarNodes: 0,
      })
    }
  })

  test("P7 replacement: Lobby's N tool click makes a created-null note and opens it at once (New element)", async ({
    page,
  }) => {
    await openLab(page, { grant: 'manual' })
    const out: Record<string, unknown>[] = []
    for (let i = 0; i < N; i++) {
      await resetLab(page)
      await focusCanvas(page)
      await page.keyboard.press('n')
      const p = await toClient(page, 300 + i, 260)
      await page.mouse.click(p.x, p.y)
      const st = await waitEditor(page, (e) => e.phase === 'open' && !!e.textarea?.focused)
      await page.keyboard.type('new')
      await settle(page, 40)
      const typed = await editor(page)
      // The acquire went out in parallel and is still unanswered while the editor is already open.
      const log = await lab(page, (x) => x.lease.log())
      const acquired = log.filter(
        (l: { dir: string; message: { type: string } }) =>
          l.dir === 'up' && l.message.type === 'lease.acquire',
      ).length
      const answered = log.filter((l: { dir: string }) => l.dir === 'down').length
      const pendingAcquire = acquired === 1 && answered === 0 ? 1 : 0
      await lab(page, (x) => x.lease.flush())
      await page.keyboard.press('Escape')
      await waitEditor(page, (e) => e.phase === 'idle')
      const notes = (await lab(page, (x) => x.elements())).filter(
        (e: { type: string }) => e.type === 'stickynote',
      )
      out.push({
        i,
        openedBeforeGrant: st.phase === 'open' && pendingAcquire === 1,
        value: typed.textarea?.value,
        created: notes[0]?.created,
        notes: notes.length,
      })
    }
    console.log('A16-P7-N-tool', JSON.stringify({ sample: out[0], n: out.length }))
    for (const r of out)
      expect(r).toMatchObject({ openedBeforeGrant: true, value: 'new', created: null, notes: 1 })
  })
})

test.describe('A16: forwarded double-clicks (open item 2)', () => {
  test('a line double-click opens the linear editor; Ctrl+double-click on an arrow too; 20/20 each', async ({
    page,
  }) => {
    test.setTimeout(180_000)
    await openLab(page, { grant: 'manual' })
    const out: Record<string, unknown>[] = []
    for (const kind of ['line', 'arrow-ctrl', 'arrow-plain'] as const) {
      for (let i = 0; i < N; i++) {
        await resetLab(page)
        const type = kind === 'line' ? 'line' : 'arrow'
        await lab(
          page,
          (x, t) =>
            x.fixture.add([
              {
                type: t,
                id: 'lin',
                x: 200,
                y: 200,
                points: [
                  [0, 0],
                  [240, 0],
                ],
              },
            ]),
          type,
        )
        const p = await toClient(page, 320, 200)
        if (kind === 'arrow-ctrl') await page.keyboard.down('Control')
        await page.mouse.dblclick(p.x, p.y)
        if (kind === 'arrow-ctrl') await page.keyboard.up('Control')
        await settle(page)
        const st = await page.evaluate(() => {
          const s = window.__lobbySpike?.api?.getAppState() as unknown as
            | {
                selectedLinearElement?: { isEditing?: boolean } | null
                editingTextElement?: { id: string } | null
                editingGroupId?: string | null
              }
            | undefined
          return {
            linearEditing: s?.selectedLinearElement?.isEditing ?? false,
            editingText: s?.editingTextElement?.id ?? null,
          }
        })
        const acq = await acquires(page)
        const traces = await lab(page, (x) =>
          x.traces
            .filter((t: { type: string }) => t.type === 'dblclick')
            .map((t: { verdict: string }) => t.verdict),
        )
        out.push({ kind, i, ...st, acquires: acq, dblclick: traces })
        await lab(page, (x) => x.lease.flush())
        await page.keyboard.press('Escape')
        await page.keyboard.press('Escape')
      }
    }
    const by = (k: string) => out.filter((r) => r.kind === k)
    console.log(
      'A16-FORWARD-LINEAR',
      JSON.stringify({
        line: by('line')[0],
        arrowCtrl: by('arrow-ctrl')[0],
        arrowPlain: by('arrow-plain')[0],
      }),
    )
    for (const r of by('line')) {
      expect(r).toMatchObject({
        linearEditing: true,
        editingText: null,
        acquires: [],
        dblclick: ['forward:linear-editor'],
      })
    }
    for (const r of by('arrow-ctrl')) {
      expect(r).toMatchObject({
        linearEditing: true,
        editingText: null,
        acquires: [],
        dblclick: ['forward:linear-editor'],
      })
    }
    // Finding: a plain double-click on a simple arrow is a TEXT path (its label), stopped for the lease.
    for (const r of by('arrow-plain')) {
      expect(r).toMatchObject({
        linearEditing: false,
        editingText: null,
        acquires: ['lin'],
        dblclick: ['text'],
      })
    }
  })

  test('a double-click on a group enters it; 20/20', async ({ page }) => {
    await openLab(page, { grant: 'manual' })
    const out: Record<string, unknown>[] = []
    for (let i = 0; i < N; i++) {
      await resetLab(page)
      await lab(page, (x) =>
        x.fixture.add([
          {
            type: 'rectangle',
            id: 'ga',
            x: 150,
            y: 150,
            width: 120,
            height: 90,
            backgroundColor: '#a5d8ff',
            groupIds: ['grp'],
          },
          {
            type: 'rectangle',
            id: 'gb',
            x: 320,
            y: 150,
            width: 120,
            height: 90,
            backgroundColor: '#b2f2bb',
            groupIds: ['grp'],
          },
        ]),
      )
      const p = await toClient(page, 210, 195)
      await page.mouse.dblclick(p.x, p.y)
      await settle(page)
      const st = await page.evaluate(() => {
        const s = window.__lobbySpike?.api?.getAppState() as unknown as
          | {
              selectedLinearElement?: { isEditing?: boolean } | null
              editingTextElement?: { id: string } | null
              editingGroupId?: string | null
            }
          | undefined
        return { editingGroupId: s?.editingGroupId ?? null, editingText: s?.editingTextElement?.id ?? null }
      })
      out.push({ i, ...st, acquires: await acquires(page) })
      await page.keyboard.press('Escape')
    }
    console.log('A16-FORWARD-GROUP', JSON.stringify({ sample: out[0], n: out.length }))
    for (const r of out) expect(r).toMatchObject({ editingGroupId: 'grp', editingText: null, acquires: [] })
  })
})

test.describe('A16: touch (hasTouch)', () => {
  test.use({ hasTouch: true })

  async function doubleTap(page: Page, p: { x: number; y: number }) {
    await page.touchscreen.tap(p.x, p.y)
    await page.waitForTimeout(90)
    await page.touchscreen.tap(p.x + 3, p.y + 2)
  }

  test('P4 double-tap: opens only after the grant; the swallowed touchstart is preventDefault-ed; 20/20', async ({
    page,
  }) => {
    test.setTimeout(240_000)
    const watch = watchPage(page)
    await openLab(page, { grant: 'manual' })
    const results: Record<string, unknown>[] = []
    for (let i = 0; i < N; i++) {
      await resetLab(page)
      const original = `Tap ${i}`
      const ids = await addNote(page, { x: 220, y: 160, size: 200, text: original })
      const v0 = await versions(page)
      const p = await bodyPoint(page, ids.note)
      await doubleTap(page, p)
      await settle(page)
      const before = await editor(page)
      const acq = await acquires(page)
      const changes = await changedSince(page, v0)
      const taps = await lab(page, (x) =>
        x.traces
          .filter((t: { type: string }) => t.type === 'doubletap')
          .map((t: { prevented: boolean }) => t.prevented),
      )
      await lab(page, (x) => x.lease.flush())
      const after = await waitEditor(page, (e) => e.phase === 'open' && !!e.textarea).catch(() =>
        editor(page),
      )
      await page.keyboard.type(TYPED)
      await settle(page, 60)
      const typed = await editor(page)
      await page.keyboard.press('Escape')
      await waitEditor(page, (e) => e.phase === 'idle').catch(() => {})
      const ok =
        before.textarea === null &&
        before.editingId === null &&
        before.phase === 'pending' &&
        acq.length === 1 &&
        acq[0] === ids.note &&
        changes === 0 &&
        taps.length === 1 &&
        taps[0] === true &&
        after.phase === 'open' &&
        typed.textarea?.value === original + TYPED
      results.push({
        i,
        ok,
        before: before.phase,
        acq,
        changes,
        taps,
        after: after.phase,
        value: typed.textarea?.value,
      })
    }
    const pass = results.filter((r) => r.ok).length
    console.log(
      'A16-P4-doubletap',
      JSON.stringify({ pass, of: N, sample: results[0], failed: results.filter((r) => !r.ok) }),
    )
    expect(pass).toBe(N)
    expect(watch.pageErrors).toEqual([])
  })

  test('CONTROL (dbl=off): without the detector a double-tap reaches Excalidraw; the guard catches it', async ({
    page,
  }) => {
    await openLab(page, { grant: 'manual', dbl: 'off' })
    const out: Record<string, unknown>[] = []
    for (let i = 0; i < 5; i++) {
      await resetLab(page)
      const ids = await addNote(page, { x: 220, y: 160, size: 200, text: `Tap ${i}` })
      const p = await bodyPoint(page, ids.note)
      await doubleTap(page, p)
      await settle(page)
      const st = await editor(page)
      const guardTraces = await lab(page, (x) =>
        x.traces
          .filter((t: { type: string }) => ['guard', 'closed-while-pending'].includes(t.type))
          .map((t: { type: string }) => t.type),
      )
      out.push({
        i,
        phase: st.phase,
        origin: st.origin,
        textarea: st.textarea ? { readOnly: st.textarea.readOnly } : null,
        guardTraces,
      })
      await lab(page, (x) => x.lease.flush())
      await page.keyboard.press('Escape')
      await waitEditor(page, (e) => e.phase === 'idle').catch(() => {})
    }
    console.log('A16-P4-CONTROL', JSON.stringify(out))
    // Excalidraw opened its editor from the double-tap every time (the guard saw it); some editors were
    // closed again right away by the tap's compatibility mousedown (see A16.md), so they are not open.
    for (const r of out) expect(r.guardTraces).toContain('guard')
    for (const r of out.filter((o) => o.textarea)) {
      expect(r).toMatchObject({ phase: 'pending', origin: 'guard', textarea: { readOnly: true } })
    }
  })
})

test.describe('A16: mouse double-click CONTROL', () => {
  test('CONTROL (dbl=off): a body double-click reaches Excalidraw; the guard catches it', async ({
    page,
  }) => {
    await openLab(page, { grant: 'manual', dbl: 'off' })
    const out: Record<string, unknown>[] = []
    for (let i = 0; i < 5; i++) {
      await resetLab(page)
      const ids = await addNote(page, { x: 220, y: 160, size: 200, text: `Label ${i}` })
      const p = await bodyPoint(page, ids.note)
      await page.mouse.dblclick(p.x, p.y)
      await settle(page)
      const st = await editor(page)
      out.push({
        i,
        phase: st.phase,
        origin: st.origin,
        textarea: st.textarea ? { readOnly: st.textarea.readOnly } : null,
      })
      await lab(page, (x) => x.lease.flush())
      await page.keyboard.press('Escape')
      await waitEditor(page, (e) => e.phase === 'idle').catch(() => {})
    }
    console.log('A16-P3-CONTROL', JSON.stringify(out))
    for (const r of out)
      expect(r).toMatchObject({ phase: 'pending', origin: 'guard', textarea: { readOnly: true } })
  })
})
