// Wave L, W8 (L8-2): sort by any lens, and "Place with AI" on a 2x2, on the real board page against the real
// api and sync server. The AI's answers (the groups of a lens, the two scores per note) and the person's choice
// in the preview come from the sort feature's dev hook (window.__lobbySort.fakeAi) until W2's runAi and
// showAiPreview are on the page; what is under test is what the board does with them. What must hold: Place
// with AI on the K4-2 2x2 template moves 12 notes into the squares their scores name in one undo step; a note
// another tab is typing in stays put; no arrow is pushed for a connected note that moves; with no 2x2 the
// axes are asked for and a matrix frame is made in the same step; a viewer has no entry.
//
//   E2E_PORT_BASE=7580 pnpm exec playwright test excalidraw/l8-place --project=chromium --workers=1   (from e2e/)
import type { Page } from '@playwright/test'
import {
  type CanvasElement,
  expect,
  expectConverged,
  expectSaved,
  items,
  leaseHolder,
  pushedOps,
  select,
  setViewport,
  startTextEditing,
  stopTextEditing,
  test,
} from '../tests/support/canvas.ts'
import { placeTemplate } from './ai-kit.ts'
import {
  aiPreviews,
  aiRequests,
  arrowOps,
  expectArrowsDerived,
  fakeAi,
  headings,
  makeArrow,
  makeFrame,
  makeNotes,
  opsSince,
  sortMenuState,
  sortRun,
  waitForSort,
  wordsOf,
} from './l8-kit.ts'
import { undoKey } from './navigation-kit.ts'

test.use({ viewport: { width: 1440, height: 900 } })

const frameByName = async (page: Page, name: string) =>
  (await items(page)).find(
    (e) => e.type === 'frame' && (e as { name?: string }).name === name,
  ) as CanvasElement

/** Twelve notes in the template's frame of ideas. */
async function templateWithIdeas(a: { page: Page }, board: string) {
  await placeTemplate(a.page, board, 'prioritisation-2x2')
  await waitForSort(a.page)
  const ideas = await frameByName(a.page, '1 · Ideas to place')
  const specs = Array.from({ length: 12 }, (_, i) => ({
    x: ideas.x + 60 + (i % 6) * 230,
    y: ideas.y + 190 + Math.floor(i / 6) * 215,
    text: `idea ${i + 1}`,
  }))
  const ids = await makeNotes(a.page, specs, ideas.id)
  return { ideas, ids }
}

/** Notes 0-2 low effort and high impact, 3-5 high and high, 6-8 low and low, 9-11 high effort and low impact. */
const SPREAD: Array<[number, number]> = [
  [-4, 4],
  [-3, 5],
  [-5, 3],
  [4, 4],
  [5, 5],
  [3, 3],
  [-4, -4],
  [-2, -5],
  [-5, -2],
  [4, -4],
  [5, -3],
  [3, -5],
]
const scoresFor = (ids: readonly string[]) =>
  Object.fromEntries(ids.map((id, i) => [id, SPREAD[i] as [number, number]]))

const rect = (e: CanvasElement) => ({ x: e.x, y: e.y, w: e.width, h: e.height })
const inside = (n: CanvasElement, f: CanvasElement) =>
  n.x >= f.x && n.y >= f.y && n.x + n.width <= f.x + f.width && n.y + n.height <= f.y + f.height
const overlap = (a: CanvasElement, b: CanvasElement) =>
  a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height

test('L8-2: Place with AI on the 2x2 template moves 12 notes into the squares their scores name, in one undo step, with no arrow pushed for a connected note', async ({
  canvasSession,
  board,
}) => {
  const a = await canvasSession('alice')
  const b = await canvasSession('bob')
  const { ideas, ids } = await templateWithIdeas(a, board)
  await waitForSort(b.page)
  const arrow = await makeArrow(a.page, ids[0] as string, ids[1] as string)
  await expectArrowsDerived(a.page, [arrow])
  await expectConverged(a.page, [b.page])
  await fakeAi(a.page, { preview: 'apply', scores: scoresFor(ids) })
  const quick = await frameByName(a.page, '2 · Quick wins')
  const bets = await frameByName(a.page, '3 · Big bets')
  const fill = await frameByName(a.page, '4 · Fill-ins')
  const park = await frameByName(a.page, '5 · Park it')
  const startOf = Object.fromEntries(
    (await items(a.page)).filter((e) => ids.includes(e.id)).map((e) => [e.id, `${e.x},${e.y},${e.frameId}`]),
  )
  const pushes = (await pushedOps(a.page)).length
  const bobPushes = (await pushedOps(b.page)).length

  await test.step('select the twelve ideas and run Place on a 2x2: the template names its own axes', async () => {
    await select(a.page, ids)
    expect(await sortRun(a.page, 'sort.place')).toBe(true)
    await expect(a.page.getByTestId('sort-notice')).toContainText('12 notes placed')
    const asked = await aiRequests(a.page)
    expect(asked).toHaveLength(1)
    expect(asked[0]).toMatchObject({ action: 'score' })
    expect((asked[0] as { axes: { name: string }[] }).axes.map((x) => x.name)).toEqual(['Effort', 'Impact'])
    expect((asked[0] as { shapeIds: string[] }).shapeIds).toHaveLength(12)
    // twelve is more than ten: the preview was shown first
    expect(await aiPreviews(a.page)).toHaveLength(1)
  })

  await test.step('every note is in the square its two scores name, inside it, and nothing overlaps', async () => {
    const all = new Map((await items(a.page)).map((e) => [e.id, e]))
    const squares = [quick, bets, fill, park].map((f) => all.get(f.id) as CanvasElement)
    const want = [quick, quick, quick, bets, bets, bets, fill, fill, fill, park, park, park]
    ids.forEach((id, i) => {
      const n = all.get(id) as CanvasElement
      const sq = all.get((want[i] as CanvasElement).id) as CanvasElement
      expect(n.frameId, `idea ${i + 1}`).toBe(sq.id)
      expect(inside(n, sq), `idea ${i + 1} inside its square`).toBe(true)
    })
    const notes = [...all.values()].filter((e) => e.type === 'stickynote')
    for (let i = 0; i < notes.length; i++)
      for (let j = i + 1; j < notes.length; j++)
        expect(
          overlap(notes[i] as CanvasElement, notes[j] as CanvasElement),
          `${notes[i]?.id} and ${notes[j]?.id}`,
        ).toBe(false)
    // the ideas frame no longer holds them, and no square grew
    for (const f of squares)
      expect(rect(f)).toEqual(rect(await frameByName(a.page, (f as { name?: string }).name as string)))
    // the same on bob's screen
    await expectConverged(a.page, [b.page])
  })

  await test.step('this tab pushed notes and their labels, not an arrow; bob pushed nothing', async () => {
    await expectSaved(a.page)
    await expectArrowsDerived(a.page, [arrow])
    const ops = await opsSince(a.page, pushes)
    expect(ops.length).toBeGreaterThan(0)
    expect(arrowOps(ops, [arrow])).toEqual([])
    expect((await pushedOps(b.page)).length).toBe(bobPushes)
  })

  await test.step('Show scores draws a chip on each placed note, local to this tab; Hide takes them away', async () => {
    await setViewport(a.page, { x: -100, y: 400, zoom: 0.6 })
    await a.page.getByTestId('sort-show-scores').click()
    await expect(a.page.getByTestId('sort-score')).toHaveCount(12)
    await expect(b.page.getByTestId('sort-score')).toHaveCount(0)
    await expect(a.page.getByTestId('sort-scores-legend')).toContainText('Effort across, Impact up')
    await a.page.getByTestId('sort-scores-hide').click()
    await expect(a.page.getByTestId('sort-score')).toHaveCount(0)
  })

  await test.step('one Ctrl+Z puts every idea back in the frame of ideas', async () => {
    await undoKey(a.page)
    await expect
      .poll(async () =>
        JSON.stringify(
          Object.fromEntries(
            (await items(a.page))
              .filter((e) => ids.includes(e.id))
              .map((e) => [e.id, `${e.x},${e.y},${e.frameId}`]),
          ),
        ),
      )
      .toBe(JSON.stringify(startOf))
    expect((await items(a.page)).filter((e) => ids.includes(e.id) && e.frameId === ideas.id)).toHaveLength(12)
    await expectSaved(a.page)
    await expectConverged(a.page, [b.page])
  })
})

test('L8-2: a note another tab is typing in stays where it is, and the notice counts it', async ({
  canvasSession,
  board,
}) => {
  const a = await canvasSession('alice')
  const b = await canvasSession('bob')
  const { ids } = await templateWithIdeas(a, board)
  await waitForSort(b.page)
  await expectConverged(a.page, [b.page])
  await fakeAi(a.page, { preview: 'apply', scores: scoresFor(ids) })
  const typed = ids[4] as string
  const before = (await items(a.page)).find((e) => e.id === typed) as CanvasElement
  await startTextEditing(b.page, typed)
  await expect.poll(async () => (await leaseHolder(a.page, typed))?.name).toBeTruthy()
  const bobPushes = (await pushedOps(b.page)).length

  await select(a.page, ids)
  expect(await sortRun(a.page, 'sort.place')).toBe(true)
  await expect(a.page.getByTestId('sort-notice')).toContainText('1 note was skipped')
  const after = (await items(a.page)).find((e) => e.id === typed) as CanvasElement
  expect([after.x, after.y, after.frameId]).toEqual([before.x, before.y, before.frameId])
  // the other eleven did move into squares
  expect(
    (await items(a.page)).filter((e) => ids.includes(e.id) && e.frameId !== before.frameId),
  ).toHaveLength(11)
  await expectSaved(a.page)
  expect((await pushedOps(b.page)).length).toBe(bobPushes)
  await stopTextEditing(b.page)
})

test('L8-2: with no 2x2 on the board the axes are asked for, and a matrix frame is made in the same undo step', async ({
  canvasSession,
}) => {
  const a = await canvasSession('alice')
  const b = await canvasSession('bob')
  for (const s of [a, b]) await waitForSort(s.page)
  const ideas = await makeFrame(a.page, 0, 0, 1600, 800, 'Ideas')
  const ids = await makeNotes(
    a.page,
    Array.from({ length: 8 }, (_, i) => ({
      x: 60 + (i % 4) * 230,
      y: 120 + Math.floor(i / 4) * 230,
      text: `idea ${i + 1}`,
    })),
    ideas,
  )
  await fakeAi(a.page, { preview: 'apply' })
  const startOf = JSON.stringify(
    Object.fromEntries(
      (await items(a.page))
        .filter((e) => ids.includes(e.id))
        .map((e) => [e.id, `${e.x},${e.y},${e.frameId}`]),
    ),
  )
  const count = (await items(a.page)).length

  await test.step('the command opens the axes view (nothing is sent yet)', async () => {
    await select(a.page, ids)
    expect(await sortRun(a.page, 'sort.place')).toBe(true)
    await expect(a.page.getByTestId('sort-menu')).toHaveAttribute('data-view', 'axes')
    expect(await sortMenuState(a.page)).toMatchObject({ view: 'axes' })
    expect(await aiRequests(a.page)).toHaveLength(0)
  })

  await test.step('name the axes and place the notes', async () => {
    await a.page.getByTestId('sort-axis-across-name').fill('Cost')
    await a.page.getByTestId('sort-axis-across-low').fill('Cheap')
    await a.page.getByTestId('sort-axis-across-high').fill('Dear')
    await a.page.getByTestId('sort-axis-up-name').fill('Delight')
    await a.page.getByTestId('sort-axes-go').click()
    await expect(a.page.getByTestId('sort-notice')).toContainText('8 notes placed')
    const asked = await aiRequests(a.page)
    expect(asked[0]).toMatchObject({
      action: 'score',
      axes: [
        { name: 'Cost', low: 'Cheap', high: 'Dear' },
        { name: 'Delight', low: 'Low', high: 'High' },
      ],
    })
  })

  await test.step('a frame with a cross and six axis words appears beside the ideas, and the notes are in it', async () => {
    const all = await items(a.page)
    const frame = all.find(
      (e) => e.type === 'frame' && (e as { name?: string }).name === 'Delight by Cost',
    ) as CanvasElement
    expect(frame).toBeTruthy()
    expect(frame.x).toBeGreaterThanOrEqual(1600)
    const kids = all.filter((e) => e.frameId === frame.id)
    expect(kids.filter((e) => e.type === 'line')).toHaveLength(2)
    expect(
      kids
        .filter((e) => e.type === 'text' && !e.containerId)
        .map(wordsOf)
        .sort(),
    ).toEqual(['Cheap', 'Cost', 'Delight', 'Dear', 'High', 'Low'].sort())
    for (const id of ids) {
      const n = all.find((e) => e.id === id) as CanvasElement
      expect(n.frameId).toBe(frame.id)
      expect(inside(n, frame)).toBe(true)
    }
    await expectSaved(a.page)
    await expectConverged(a.page, [b.page])
  })

  await test.step('one Ctrl+Z takes the frame away and puts the notes back', async () => {
    await undoKey(a.page)
    await expect.poll(async () => (await items(a.page)).length).toBe(count)
    expect(
      JSON.stringify(
        Object.fromEntries(
          (await items(a.page))
            .filter((e) => ids.includes(e.id))
            .map((e) => [e.id, `${e.x},${e.y},${e.frameId}`]),
        ),
      ),
    ).toBe(startOf)
    await expectConverged(a.page, [b.page])
  })
})

test('L8-2: sort by a lens names groups with the AI and lays them out as columns; the headings carry the run; one undo step', async ({
  canvasSession,
}) => {
  const a = await canvasSession('alice')
  await waitForSort(a.page)
  const frame = await makeFrame(a.page, 0, 0, 2000, 1000, 'Journey')
  const ids = await makeNotes(
    a.page,
    Array.from({ length: 6 }, (_, i) => ({
      x: 60 + (i % 3) * 230,
      y: 120 + Math.floor(i / 3) * 230,
      text: `step ${i + 1}`,
    })),
    frame,
  )
  await fakeAi(a.page, {
    preview: 'apply',
    themes: [
      { name: 'Awareness', ids: [ids[0], ids[1], ids[4]] as string[] },
      { name: 'Decision', ids: [ids[2], ids[3], ids[5]] as string[] },
    ],
  })
  const startOf = JSON.stringify(
    Object.fromEntries(
      (await items(a.page)).filter((e) => ids.includes(e.id)).map((e) => [e.id, `${e.x},${e.y}`]),
    ),
  )
  await select(a.page, ids)

  await test.step('the selection bar’s Sort > By a lens… asks for the words, then sorts', async () => {
    await a.page.getByTestId('selection-sort').click()
    await a.page.getByTestId('sort-by-lens').click()
    await expect(a.page.getByTestId('sort-menu')).toHaveAttribute('data-view', 'lens')
    await expect(a.page.getByTestId('sort-lens-go')).toBeDisabled()
    await a.page.getByTestId('sort-lens-input').fill('journey stage')
    await a.page.getByTestId('sort-lens-go').click()
    await expect(a.page.getByTestId('sort-notice')).toContainText('6 notes in 2 columns')
    expect(await aiRequests(a.page)).toMatchObject([{ action: 'sort', lens: 'journey stage' }])
  })

  await test.step('two columns under the names the AI chose, made by this run', async () => {
    const heads = (await headings(a.page)).sort((p, q) => p.x - q.x)
    expect(heads.map(wordsOf)).toEqual(['Awareness', 'Decision'])
    for (const h of heads) {
      const lobby = (h.customData as { lobby: { ai?: { by: string; run?: string }; kind: string } }).lobby
      expect(lobby.kind).toBe('ai-sort-label')
      expect(lobby.ai?.by).toBe(a.id)
      expect(lobby.ai?.run).toMatch(/^air_/)
    }
    const all = new Map((await items(a.page)).map((e) => [e.id, e]))
    expect(new Set([0, 1, 4].map((i) => all.get(ids[i] as string)?.x))).toEqual(new Set([heads[0]?.x]))
    expect(new Set([2, 3, 5].map((i) => all.get(ids[i] as string)?.x))).toEqual(new Set([heads[1]?.x]))
    await expectSaved(a.page)
  })

  await test.step('sorting by another lens replaces the headings; one Ctrl+Z undoes the last sort only', async () => {
    await fakeAi(a.page, {
      preview: 'apply',
      themes: [{ name: 'Everything', ids: ids }],
    })
    await select(a.page, ids)
    expect(await sortRun(a.page, 'sort.lens', { lens: 'one pile' })).toBe(true)
    await expect.poll(async () => (await headings(a.page)).map(wordsOf)).toEqual(['Everything'])
    await undoKey(a.page)
    await expect
      .poll(async () => (await headings(a.page)).map(wordsOf).sort())
      .toEqual(['Awareness', 'Decision'])
    await undoKey(a.page)
    await expect.poll(async () => (await headings(a.page)).length).toBe(0)
    expect(
      JSON.stringify(
        Object.fromEntries(
          (await items(a.page)).filter((e) => ids.includes(e.id)).map((e) => [e.id, `${e.x},${e.y}`]),
        ),
      ),
    ).toBe(startOf)
  })
})

test('L8-2: a viewer has no Place entry and the AI is never asked', async ({ canvasSession, board }) => {
  const a = await canvasSession('alice')
  const v = await canvasSession('bob', { role: 'viewer' })
  const { ids } = await templateWithIdeas(a, board)
  await waitForSort(v.page)
  await expectConverged(a.page, [v.page])
  await fakeAi(v.page, { preview: 'apply' })
  await select(v.page, ids)
  await expect(v.page.getByTestId('selection-sort')).toHaveCount(0)
  expect(await sortRun(v.page, 'sort.place')).toBe(false)
  expect(await sortRun(v.page, 'sort.lens', { lens: 'x' })).toBe(false)
  expect(await aiRequests(v.page)).toHaveLength(0)
  expect((await pushedOps(v.page)).length).toBe(0)
})
