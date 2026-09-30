// 3b navigation on the Excalidraw board page: paste as sticky notes (COL-05, RETRO-01), ported from
// canvas-ux.spec.ts "bulk paste" (three tests) and "heavy board", and canvas-ux.fix.spec.ts "RETRO-01".
// The paste reaches the features' content handlers through the board page (2C); a single line is left to
// the engine's own paste (a text element). On the new canvas each note is `tx.create('note')` (the
// pasted-note face of the tldraw board, a hand-drawn label, waits for CR-2D-2's `LobbyTx.insert`).
//
//   E2E_PORT_BASE=<base> pnpm --filter @draftroom/e2e excalidraw -- navigation-paste
import type { Page } from '@playwright/test'
import { createItem, createNote, expect, expectSaved, itemText, test } from '../tests/support/canvas.ts'
import { forgeSession } from '../tests/support/excalidraw.ts'
import { focusBoard } from './board-kit.ts'
import {
  boundsOf,
  clickCanvasAt,
  contains,
  contentOf,
  countOf,
  grantClipboard,
  inView,
  notes,
  openPath,
  overlaps,
  seed,
  setFrame,
  setView,
  sortedSelection,
  undoKey,
  waitForNavigation,
  writeClipboard,
} from './navigation-kit.ts'

test.use({ viewport: { width: 1440, height: 900 } })

// A 3×3 spreadsheet selection with one empty cell (a gap in the source layout).
const GRID = [
  ['Setup', 'Conflict', 'Payoff'],
  ['Hero', '', 'Villain'],
  ['City', 'Storm', 'Home'],
]
const TSV = GRID.map((r) => r.join('\t')).join('\n')
const TABLE_HTML = `<table>${GRID.map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join('')}</tr>`).join('')}</table>`

/** A real Ctrl/Cmd+V on the board with the pointer at a screen point over the canvas. */
async function pasteAt(page: Page, at?: { x: number; y: number }) {
  if (at) await page.mouse.move(at.x, at.y)
  await page.keyboard.press('ControlOrMeta+v')
}

test('bulk paste: a 3×3 spreadsheet selection asks notes-or-text, becomes 8 selected notes in the source layout, one undo, seen by bob', async ({
  canvasSession,
}) => {
  const a = await canvasSession('alice')
  const b = await canvasSession('bob')
  await grantClipboard(a.context)
  await waitForNavigation(a.page)
  await focusBoard(a.page)
  await writeClipboard(a.page, { 'text/html': TABLE_HTML, 'text/plain': TSV })
  await pasteAt(a.page)
  const prompt = a.page.getByTestId('bulk-paste-prompt')
  await expect(prompt).toBeVisible()
  await expect(prompt).toContainText('Paste 8 items as sticky notes or as text?')
  await expect(a.page.getByTestId('bulk-paste-notes')).toBeFocused()
  await a.page.getByTestId('bulk-paste-notes').click()
  await expect(prompt).toHaveCount(0)

  await expect.poll(async () => (await notes(a.page)).length).toBe(8)
  const pasted = await notes(a.page)
  expect(pasted.map((n) => n.text).sort()).toEqual(GRID.flat().filter(Boolean).sort())
  expect(await sortedSelection(a.page)).toEqual(pasted.map((n) => n.id).sort())
  // source rows and columns: one x per column, one y per row, in order; the empty cell stays a gap
  const xs = [...new Set(pasted.map((n) => Math.round(n.x)))].sort((p, q) => p - q)
  const ys = [...new Set(pasted.map((n) => Math.round(n.y)))].sort((p, q) => p - q)
  expect([xs.length, ys.length]).toEqual([3, 3])
  for (const [r, row] of GRID.entries()) {
    for (const [c, text] of row.entries()) {
      if (!text) {
        expect(pasted.some((p) => Math.round(p.x) === xs[c] && Math.round(p.y) === ys[r])).toBe(false)
        continue
      }
      const n = pasted.find((p) => p.text === text)
      expect({
        text,
        col: xs.indexOf(Math.round(n?.x ?? Number.NaN)),
        row: ys.indexOf(Math.round(n?.y ?? Number.NaN)),
      }).toEqual({
        text,
        col: c,
        row: r,
      })
    }
  }
  await expect
    .poll(async () => (await notes(b.page)).map((n) => n.id).sort())
    .toEqual(pasted.map((n) => n.id).sort())
  expect(
    await inView(
      a.page,
      pasted.map((n) => n.id),
    ),
  ).toBe(true)

  await undoKey(a.page)
  await expect.poll(() => countOf(a.page)).toBe(0)
  await expect.poll(() => countOf(b.page)).toBe(0)
})

test('bulk paste: "Text" makes one text element; a single line pastes as usual, with no prompt; Esc and a click on the board dismiss the prompt', async ({
  canvasSession,
}) => {
  const a = await canvasSession('alice')
  await grantClipboard(a.context)
  await waitForNavigation(a.page)
  await focusBoard(a.page)
  const prompt = a.page.getByTestId('bulk-paste-prompt')

  await test.step('the same cells as text: exactly one text element', async () => {
    await writeClipboard(a.page, { 'text/html': TABLE_HTML, 'text/plain': TSV })
    await pasteAt(a.page)
    await expect(prompt).toBeVisible()
    await a.page.getByTestId('bulk-paste-text').click()
    await expect.poll(() => countOf(a.page)).toBe(1)
    const [only] = await contentOf(a.page)
    expect(only?.type).toBe('text')
    expect(await itemText(a.page, only?.id as string)).toContain('Payoff')
  })

  await test.step('a single line: a text element straight away', async () => {
    await focusBoard(a.page)
    await writeClipboard(a.page, { 'text/plain': 'One idea, stated once' })
    await pasteAt(a.page)
    await expect.poll(() => countOf(a.page)).toBe(2)
    const texts = await Promise.all((await contentOf(a.page)).map((e) => itemText(a.page, e.id)))
    expect(texts).toContain('One idea, stated once')
    await expect(prompt).toHaveCount(0)
  })

  await test.step('Esc cancels the prompt; so does working on the board; nothing is pasted', async () => {
    // away from the pasted text (a click on it would open its editor)
    await clickCanvasAt(a.page, 0.3, 0.3)
    await writeClipboard(a.page, { 'text/plain': 'a\nb\nc' })
    await pasteAt(a.page)
    await expect(prompt).toBeVisible()
    await a.page.keyboard.press('Escape')
    await expect(prompt).toHaveCount(0)
    await pasteAt(a.page)
    await expect(prompt).toBeVisible()
    await clickCanvasAt(a.page, 0.3, 0.3)
    await expect(prompt).toHaveCount(0)
    expect(await countOf(a.page)).toBe(2)
  })
})

test('bulk paste cap: 620 lines become the first 500 notes and a notice says 120 cells were left out', async ({
  canvasSession,
}) => {
  test.setTimeout(240_000)
  const a = await canvasSession('alice')
  const b = await canvasSession('bob')
  await grantClipboard(a.context)
  await waitForNavigation(a.page)
  await focusBoard(a.page)
  const lines = Array.from({ length: 620 }, (_, i) => `Idea ${i + 1}`)
  await writeClipboard(a.page, { 'text/plain': lines.join('\n') })
  await pasteAt(a.page)
  await expect(a.page.getByTestId('bulk-paste-prompt')).toContainText('Only the first 500 become notes.')
  await expect(a.page.getByTestId('bulk-paste-notes')).toHaveText('500 sticky notes')
  await a.page.getByTestId('bulk-paste-notes').click()
  await expect(a.page.getByTestId('bulk-paste-notice')).toContainText('120 more cells were left out')
  await expect.poll(() => countOf(a.page, 'stickynote')).toBe(500)
  expect((await sortedSelection(a.page)).length).toBe(500)
  const texts = new Set((await notes(a.page)).map((n) => n.text))
  expect(texts.has('Idea 1') && texts.has('Idea 500') && !texts.has('Idea 501')).toBe(true)
  await expect.poll(() => countOf(b.page, 'stickynote'), { timeout: 60_000 }).toBe(500)
  await expectSaved(a.page, 60_000)
})

test('RETRO-01: a 5×1 spreadsheet column pasted over the empty lower half of a frame becomes 5 notes inside that frame, clear of its notes, as a compact grid', async ({
  canvasSession,
}) => {
  const a = await canvasSession('alice')
  await grantClipboard(a.context)
  await waitForNavigation(a.page)
  const frame = await createItem(a.page, 'frame', {
    x: 0,
    y: 0,
    width: 900,
    height: 1400,
    name: '3 · What to improve',
  })
  await expectSaved(a.page)
  const existing = await seed(a.page, [
    () => createNote(a.page, { x: 40, y: 60, text: 'Late handover' }),
    () => createNote(a.page, { x: 300, y: 60, text: 'Flaky build' }),
    () => createNote(a.page, { x: 560, y: 60, text: 'No owner' }),
  ])
  await setFrame(a.page, existing, frame)
  const fb = await boundsOf(a.page, [frame])
  if (!fb) throw new Error('no frame bounds')
  await setView(a.page, { x: -80, y: -80, zoom: 0.5 })
  const before = await Promise.all(existing.map((id) => boundsOf(a.page, [id])))

  const cells = [
    'Scope creep',
    'Handoffs were late',
    'Too many meetings',
    'Feedback came late',
    'Unclear owner',
  ]
  await focusBoard(a.page)
  await writeClipboard(a.page, { 'text/plain': cells.join('\n') })
  const target = await a.page.evaluate(
    (p) =>
      (
        window as unknown as { lobbyCanvas: { sceneToScreen(p: unknown): { x: number; y: number } } }
      ).lobbyCanvas.sceneToScreen(p),
    { x: fb.x + fb.width / 2, y: fb.y + fb.height * 0.72 },
  )
  await pasteAt(a.page, target)
  const prompt = a.page.getByTestId('bulk-paste-prompt')
  await expect(prompt).toBeVisible()
  // the prompt shows at the pointer
  const pb = await prompt.boundingBox()
  expect(pb && Math.hypot(pb.x + pb.width / 2 - target.x, pb.y + pb.height / 2 - target.y)).toBeLessThan(80)
  await a.page.getByTestId('bulk-paste-notes').click()
  await expect(prompt).toHaveCount(0)

  await expect.poll(async () => (await notes(a.page)).filter((n) => cells.includes(n.text)).length).toBe(5)
  const pasted = (await notes(a.page)).filter((n) => cells.includes(n.text))
  for (const n of pasted) {
    expect(n.frameId).toBe(frame)
    const nb = await boundsOf(a.page, [n.id])
    if (!nb) throw new Error('note has no bounds')
    expect(contains(fb, nb)).toBe(true)
    for (const e of before) expect(e && overlaps(nb, e)).toBe(false)
  }
  // a compact grid (3 + 2), not one tall column
  expect(new Set(pasted.map((n) => Math.round(n.x))).size).toBe(3)
})

test('heavy board: 500 pasted notes land on a board that already holds 4,500 items (5,000 in total, on a fresh tab too)', async ({
  canvasSession,
  browser,
  board,
  users,
}) => {
  test.setTimeout(300_000)
  const [{ seedElements }, { indexKeysBetween }] = await Promise.all([
    import('../load/seed.ts'),
    import('../../packages/canvas-schema/src/engine/index.ts'),
  ])
  const a = await canvasSession('alice')
  await grantClipboard(a.context)
  await waitForNavigation(a.page)
  // 4,500 small boxes to the right of the view: one made through the page, the rest its copies pushed as
  // creates on a raw socket with the page's own ticket (the room checks them like a user's pushes)
  const first = await createItem(a.page, 'rectangle', { x: 3000, y: 0, width: 40, height: 40 })
  await expectSaved(a.page)
  const proto = (await contentOf(a.page)).find((e) => e.id === first) as unknown as Record<string, unknown>
  const keys = indexKeysBetween((proto.index as string | null) ?? null, null, 4_499)
  const copies = keys.map((index, i) => {
    const n = i + 1
    return {
      ...proto,
      id: `heavy-${n}`,
      x: 3000 + (n % 75) * 60,
      y: Math.floor(n / 75) * 60,
      index,
      version: 1,
      versionNonce: 1_000 + n,
      seed: 5_000 + n,
      boundElements: null,
    }
  })
  const { socket, welcome } = await forgeSession(a.page, board)
  try {
    const r = await seedElements(socket, copies as never, welcome.clock)
    expect(r.ok).toBe(r.ops)
  } finally {
    await socket.close()
  }
  await expect.poll(() => countOf(a.page), { timeout: 60_000 }).toBe(4_500)

  await clickCanvasAt(a.page, 0.3, 0.5)
  await writeClipboard(a.page, {
    'text/plain': Array.from({ length: 500 }, (_, i) => `Heavy ${i + 1}`).join('\n'),
  })
  await pasteAt(a.page)
  await a.page.getByTestId('bulk-paste-notes').click()
  await expect.poll(() => countOf(a.page, 'stickynote'), { timeout: 60_000 }).toBe(500)
  expect(await countOf(a.page)).toBe(5_000)
  await expect(a.page.getByTestId('bulk-paste-notice')).toHaveCount(0)
  await expectSaved(a.page, 120_000)

  await users.grant(board, 'bob', 'editor')
  const b = await openPath(browser, await users.get('bob'), `/b/${board}`)
  try {
    await expect.poll(() => countOf(b.page), { timeout: 60_000 }).toBe(5_000)
    expect(await countOf(b.page, 'stickynote')).toBe(500)
  } finally {
    await b.context.close()
  }
})
