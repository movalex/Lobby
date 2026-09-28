import { expect, type Page, test } from '@playwright/test'
import { watchPage } from '../support/watch.ts'
import { editor, element, lab, openLab, resetLab, toClient, waitEditor } from './host-kit.ts'

// A17 (docs/EXCALIDRAW-MIGRATION.md §8.2, §2.5.4, §2.9.4; open item 3): while the text editor is open,
// a remote container MOVE and RESIZE arrive through updateScene with CaptureUpdateAction.NEVER. The
// textarea stays open, caret and text are kept, the editor follows the container, and the holder's
// re-fit is classified as `fit` (not pos/shape). The spec also records exactly which fields Excalidraw
// writes on the container, the label and a bound arrow while the holder types (open item 3). Ctrl+Z
// inside the textarea undoes the typing natively and never reaches Lobby's undo (Lobby's own key action
// and the `undo` action registered with api.registerAction, both counted). Pass: 20/20.

const N = 20
const NOTE = 'n17'
const DX = 120
const DY = 40
const LONG =
  ' and then a much longer paragraph that keeps going until the sticky note has to shrink its font and finally grow taller than its base height'

const settle = (page: Page, ms = 80) =>
  page.evaluate(
    (t) =>
      new Promise<void>((r) =>
        requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(() => r(), t))),
      ),
    ms,
  )

async function buildScene(page: Page): Promise<void> {
  await resetLab(page)
  await lab(
    page,
    (x, id) =>
      x.fixture.add([
        {
          type: 'stickynote',
          id,
          x: 200,
          y: 150,
          width: 200,
          height: 200,
          baseHeight: 200,
          backgroundColor: '#ffd966',
          roughness: 0,
          created: null,
          label: { text: 'Hello', fontFamily: 6 },
        },
        {
          type: 'arrow',
          id: 'arr',
          x: 300,
          y: 560,
          points: [
            [0, 0],
            [0, -200],
          ],
        },
      ]),
    NOTE,
  )
  // The arrow's end is bound to the note's bottom centre (a FixedPointBinding, as Excalidraw makes).
  await lab(page, (x, id) => x.fixture.bindArrow('arr', id, 'end', [0.5, 1]), NOTE)
}

interface Aggregate {
  [roleAndKind: string]: string[]
}

function aggregate(
  steps: { kind: string; writes: { role: string; fields: string[]; fit?: object; groups: object }[] }[],
) {
  const fields: Aggregate = {}
  const groups: Aggregate = {}
  const fitKeys: Aggregate = {}
  for (const s of steps) {
    const kind = s.kind === 'onChange' ? 'typing' : s.kind
    for (const w of s.writes) {
      const k = `${w.role}@${kind}`
      fields[k] = [...new Set([...(fields[k] ?? []), ...w.fields])].sort()
      groups[k] = [...new Set([...(groups[k] ?? []), ...Object.keys(w.groups)])].sort()
      if (w.fit) fitKeys[k] = [...new Set([...(fitKeys[k] ?? []), ...Object.keys(w.fit)])].sort()
    }
  }
  return { fields, groups, fitKeys }
}

test('A17: remote move/resize while typing; holder re-fit is fit; native Ctrl+Z inside the editor; 20/20', async ({
  page,
}) => {
  test.setTimeout(300_000)
  const watch = watchPage(page)
  await openLab(page, { grant: 30 })
  await page.evaluate(() => document.fonts.load('20px Nunito', 'Hello World'))
  const results: Record<string, unknown>[] = []
  let lastAgg: ReturnType<typeof aggregate> | null = null

  for (let i = 0; i < N; i++) {
    await buildScene(page)
    const arrow0 = await element(page, 'arr')
    const bound = arrow0?.endBinding as { elementId?: string } | undefined
    // Select the note (away from the label) and open the editor with Enter (lease granted in 30 ms).
    const note0 = await element(page, NOTE)
    if (!note0) throw new Error('no note')
    const body = await toClient(page, note0.x + 20, note0.y + 20)
    await page.mouse.click(body.x, body.y)
    await page.keyboard.press('Enter')
    await waitEditor(page, (e) => e.phase === 'open' && !!e.textarea?.focused)
    await page.keyboard.type(' World from the holder')
    // The caret goes to offset 3 (a real user click would put it anywhere; the check is that it stays).
    await page.evaluate(() =>
      document.querySelector<HTMLTextAreaElement>('textarea.excalidraw-wysiwyg')?.setSelectionRange(3, 3),
    )
    await settle(page)
    await page.evaluate(() => {
      const ta = document.querySelector<HTMLTextAreaElement>('textarea.excalidraw-wysiwyg')
      if (ta) ta.dataset.probe = 'same-node'
    })
    const e0 = await editor(page)
    const labelId = e0.editingId ?? ''
    const label0 = await element(page, labelId)
    const zoom = await page.evaluate(() => window.__lobbySpike?.api?.getAppState().zoom.value ?? 1)
    await lab(page, (x) => x.recorder.start())

    // Remote MOVE.
    await lab(
      page,
      (x, a) => x.recorder.applyRemote([{ id: a.id, patch: { x: 200 + a.dx, y: 150 + a.dy } }]),
      {
        id: NOTE,
        dx: DX,
        dy: DY,
      },
    )
    await settle(page)
    const e1 = await editor(page)
    const label1 = await element(page, labelId)
    const same1 = await page.evaluate(
      () =>
        document.querySelector<HTMLTextAreaElement>('textarea.excalidraw-wysiwyg')?.dataset.probe ===
        'same-node',
    )

    // Remote RESIZE (wider and taller base).
    await lab(
      page,
      (x, id) => x.recorder.applyRemote([{ id, patch: { width: 300, height: 260, baseHeight: 260 } }]),
      NOTE,
    )
    await settle(page)
    const e2 = await editor(page)
    const same2 = await page.evaluate(
      () =>
        document.querySelector<HTMLTextAreaElement>('textarea.excalidraw-wysiwyg')?.dataset.probe ===
        'same-node',
    )
    const label2 = await element(page, labelId)

    // The holder's re-fit on the new geometry (Excalidraw's own path: one input event).
    await lab(page, (x) => x.recorder.refit())
    await settle(page)
    const label3 = await element(page, labelId)

    // Type enough to shrink the font and grow the note (auto-fit writes the container and the arrow).
    await page.keyboard.press('Control+End')
    // One large insert (a paste-sized input event) plus a typed tail: the note must outgrow its base.
    await page.keyboard.insertText(LONG.repeat(4))
    await page.keyboard.type(' the end')
    await settle(page)
    const note4 = await element(page, NOTE)
    const typed4 = await editor(page)

    // Remote SHRINK back to 200 x 200 (another user's resize, with that user's own height). updateScene
    // runs no sticky-note re-layout (E7), so the note stays 200 high although the text overflows; the
    // holder's re-fit then grows it again, and that write must be a fit.
    await lab(
      page,
      (x, id) => x.recorder.applyRemote([{ id, patch: { width: 200, height: 200, baseHeight: 200 } }]),
      NOTE,
    )
    await settle(page)
    const note5 = await element(page, NOTE)
    const e5 = await editor(page)
    const same5 = await page.evaluate(
      () =>
        document.querySelector<HTMLTextAreaElement>('textarea.excalidraw-wysiwyg')?.dataset.probe ===
        'same-node',
    )
    await lab(page, (x) => x.recorder.refit())
    await settle(page)
    const note6 = await element(page, NOTE)
    const beforeUndo = await editor(page)

    // Native undo / redo inside the textarea.
    const c0 = await lab(page, (x) => ({ ...x.counters }))
    await page.keyboard.press('Control+z')
    await settle(page)
    const afterUndo = await editor(page)
    await page.keyboard.press('Control+y')
    await settle(page)
    const afterRedo = await editor(page)
    const c1 = await lab(page, (x) => ({ ...x.counters }))

    const steps = await lab(page, (x) => x.recorder.stop())
    const agg = aggregate(steps)
    lastAgg = agg
    await page.keyboard.press('Escape')
    await waitEditor(page, (e) => e.phase === 'idle')
    const stored = (await element(page, labelId))?.originalText
    const released = await lab(page, (x, id) => !x.lease.isHeld(id), NOTE)

    // Every container write in the holder's editor window is fit (no pos/shape group); report the
    // arrow separately.
    const containerWrites = steps.flatMap(
      (s: { kind: string; writes: { role: string; fit?: object; groups: object }[] }) =>
        s.writes
          .filter((w) => w.role === 'container')
          .map((w) => ({ kind: s.kind, fit: w.fit, groups: w.groups })),
    )
    const containerAllFit = containerWrites.every(
      (w: { groups: object; fit?: object }) => Object.keys(w.groups).length === 0 && !!w.fit,
    )
    const t0 = e0.textarea
    const t1 = e1.textarea
    const t2 = e2.textarea
    const followsMove =
      !!t0 &&
      !!t1 &&
      Math.abs(t1.left - t0.left - DX * zoom) <= 1.5 &&
      Math.abs(t1.top - t0.top - DY * zoom) <= 1.5
    const labelFollows =
      !!label0 &&
      !!label1 &&
      Math.abs(label1.x - label0.x - DX) <= 1 &&
      Math.abs(label1.y - label0.y - DY) <= 1
    const keptAfterMove =
      !!t1 &&
      same1 &&
      t1.focused &&
      t1.value === t0?.value &&
      t1.selectionStart === 3 &&
      t1.selectionEnd === 3 &&
      t0?.selectionStart === 3
    const keptAfterResize =
      !!t2 &&
      same2 &&
      t2.focused &&
      t2.value === t0?.value &&
      t2.selectionStart === 3 &&
      t2.selectionEnd === 3
    // After the resize the editor re-centres on the wider note (x) and the taller base (y).
    const followsResize = !!t1 && !!t2 && t2.left > t1.left && t2.top > t1.top
    const rewrapped = (label2?.text ?? '').includes('\n') && !(label3?.text ?? '').includes('\n')
    const grew = !!note4 && note4.height > 260
    const noRelayoutOnApply = !!note5 && note5.height === 200 && note5.width === 200
    const keptAfterShrink = same5 && !!e5.textarea?.focused && e5.textarea.value === typed4.textarea?.value
    const refitGrew = !!note6 && note6.width === 200 && note6.baseHeight === 200 && note6.height > 200
    const refitIsFit = steps.some(
      (s: { kind: string; writes: { role: string; fit?: { height?: number }; groups: object }[] }) =>
        s.kind === 'refit' &&
        s.writes.some((w) => w.role === 'container' && !!w.fit?.height && Object.keys(w.groups).length === 0),
    )
    const undoNative =
      !!beforeUndo.textarea &&
      !!afterUndo.textarea &&
      afterUndo.textarea.value !== beforeUndo.textarea.value &&
      beforeUndo.textarea.value.startsWith(afterUndo.textarea.value) &&
      afterRedo.textarea?.value === beforeUndo.textarea.value
    const lobbyUndoUntouched =
      c1.lobbyUndo === c0.lobbyUndo &&
      c1.registeredUndo === c0.registeredUndo &&
      c1.lobbyRedo === c0.lobbyRedo &&
      c1.registeredRedo === c0.registeredRedo
    const ok =
      bound?.elementId === NOTE &&
      keptAfterMove &&
      keptAfterResize &&
      followsMove &&
      labelFollows &&
      followsResize &&
      rewrapped &&
      containerAllFit &&
      containerWrites.length > 0 &&
      grew &&
      noRelayoutOnApply &&
      keptAfterShrink &&
      refitGrew &&
      refitIsFit &&
      undoNative &&
      lobbyUndoUntouched &&
      stored === afterRedo.textarea?.value &&
      released
    results.push({
      i,
      ok,
      bound: bound?.elementId === NOTE,
      keptAfterMove,
      keptAfterResize,
      followsMove,
      moveDelta: t0 && t1 ? [t1.left - t0.left, t1.top - t0.top] : null,
      labelFollows,
      followsResize,
      rewrapped,
      containerAllFit,
      containerWrites: containerWrites.length,
      grew,
      noteHeight: note4?.height,
      noRelayoutOnApply,
      keptAfterShrink,
      heightAfterShrink: note5?.height,
      refitGrew,
      heightAfterRefit: note6?.height,
      refitIsFit,
      undoNative,
      undoValue: afterUndo.textarea?.value.length,
      beforeUndoValue: beforeUndo.textarea?.value.length,
      lobbyUndoUntouched,
      released,
    })
  }
  console.log('A17-RESULTS', JSON.stringify(results))
  console.log('A17-WRITES', JSON.stringify(lastAgg))
  const pass = results.filter((r) => r.ok).length
  console.log('A17-SUMMARY', JSON.stringify({ pass, of: N }))
  expect(results.filter((r) => !r.ok)).toEqual([])
  expect(watch.pageErrors).toEqual([])
})
