// Wave 4 tags (docs/WAVE4-CONTRACTS.md §2 tags; checklist COL-11, MAK-12's tag filter, PRS-13's tags
// column): tags on sticky notes and file cards. Every test drives the real UI (selection bar, picker,
// context menu, Tags panel, board search, export dialog) and checks the result in a second browser and
// in the synced records. Read-only people (viewers, commenters, a commenter guest) get a forged write
// that the sync server must refuse; a name-only guest on a workshop (editor) link can tag.
import type { Page } from '@playwright/test'
import { expectConn, getShape } from './support/board.ts'
import { clickShape, editEd, readEd, waitForCanvasUx, waitForSaved } from './support/canvas-ux.ts'
import { closeMenus, contextMenuAt, docMeta, editBd } from './support/canvas-ux-2.ts'
import { expect, test } from './support/fixtures.ts'
import { downloadFrom, parseCsv } from './support/present-export.ts'
import { capture } from './support/screenshots.ts'
import {
  boardList,
  cameraAt,
  chipKeys,
  chips,
  createGuestLink,
  createShapes,
  forgeTagWrites,
  insideViewport,
  joinAsGuest,
  listOnBoard,
  noteAt,
  openPicker,
  openTagsPanel,
  option,
  row,
  selectIds,
  shapeOpacity,
  storedTagKeys,
  tag,
  tagsMeta,
} from './support/tags.ts'

test.use({ viewport: { width: 1440, height: 900 } })

const N1 = 'shape:tg-1'
const N2 = 'shape:tg-2'
const N3 = 'shape:tg-3'
const CARD = 'shape:tg-card'
const RESEARCH = tag('research', 'Research', 'blue')
const IDEA = tag('idea', 'Idea', 'green')
const BLOCKED = tag('blocked', 'Blocked', 'red')

const undo = (page: Page) => page.keyboard.press('Control+z')
const focusBoard = (page: Page) => editEd(page, (ed) => (ed as unknown as { focus(): void }).focus())
const lod = (page: Page) => page.locator('.tl-container').first().getAttribute('data-dr-tags-lod')

/** Three notes in a row (optionally tagged), bob's camera on them too. */
async function threeNotes(
  pages: Page[],
  tags: { n1?: ReturnType<typeof tag>[]; n2?: ReturnType<typeof tag>[]; n3?: ReturnType<typeof tag>[] } = {},
) {
  const [a] = pages
  if (!a) throw new Error('no page')
  await createShapes(a, [
    noteAt(N1, 0, 0, 'Checkout is slow', tagsMeta(...(tags.n1 ?? []))),
    noteAt(N2, 260, 0, 'Search finds nothing', tagsMeta(...(tags.n2 ?? []))),
    noteAt(N3, 520, 0, 'Love the new dashboard', tagsMeta(...(tags.n3 ?? []))),
  ])
  for (const p of pages) {
    await expect.poll(() => getShape(p, N3)).not.toBeNull()
    await cameraAt(p, { x: 360, y: 100 }, 1)
  }
}

test('COL-11 picker: alice creates and applies tags to two notes from the selection bar; bob sees the chips within 2 s; mixed selection, remove; each change is one undo step', async ({
  session,
}) => {
  const a = await session('alice')
  const b = await session('bob')
  await waitForCanvasUx(a.page)
  await threeNotes([a.page, b.page])

  await test.step('select two notes → Tags → type a new name → Enter: both carry it, the board lists it', async () => {
    await selectIds(a.page, [N1, N2])
    const picker = await openPicker(a.page)
    await expect(picker).toHaveAttribute('role', 'dialog')
    await expect(picker.getByTestId('tag-picker-input')).toBeFocused()
    await expect(picker).toContainText('No tags on this board yet. Type a name to create one.')
    await a.page.keyboard.type('#Research')
    await expect(picker.getByTestId('tag-create')).toHaveText('+ Create “Research”')
    await a.page.keyboard.press('Enter')
    await expect(picker.getByTestId('tag-picker-status')).toHaveText('Created “Research”.')
    await expect(picker.getByTestId('tag-picker-input')).toHaveValue('')
    await expect(option(a.page, 'research')).toHaveAttribute('data-state', 'all')
    for (const id of [N1, N2]) expect(await storedTagKeys(a.page, id)).toEqual(['research'])
    expect(await boardList(a.page)).toEqual({ research: { name: 'Research', color: 'blue' } })
    for (const id of [N1, N2]) await expect(chips(b.page, id)).toHaveText(['Research'], { timeout: 2_000 })
    await expect(chips(b.page, N3)).toHaveCount(0)
    await capture('tags-picker.png', a.page, test.info())
  })

  await test.step('a second tag with the Create button; the list narrows as you type; case and # do not make a new tag', async () => {
    const picker = await openPicker(a.page)
    const input = picker.getByTestId('tag-picker-input')
    await input.fill('Idea')
    await expect(picker.getByTestId('tag-option')).toHaveCount(0)
    await picker.getByTestId('tag-create').click()
    await expect(option(a.page, 'idea')).toHaveAttribute('data-state', 'all')
    await input.fill('res')
    await expect(picker.getByTestId('tag-option')).toHaveCount(1)
    await input.fill('#RESEARCH')
    await expect(picker.getByTestId('tag-create')).toHaveCount(0)
    await expect(option(a.page, 'research')).toHaveAttribute('data-exact', 'true')
    await a.page.keyboard.press('Enter')
    await expect(picker.getByTestId('tag-picker-status')).toHaveText(
      'Every selected note already has “Research”.',
    )
    await input.fill('')
    await expect(picker.getByTestId('tag-option')).toHaveCount(2)
    await expect(chips(b.page, N1)).toHaveText(['Idea', 'Research'], { timeout: 2_000 })
    expect(Object.keys(await boardList(b.page)).sort()).toEqual(['idea', 'research'])
  })

  await test.step('a mixed selection shows "mixed"; ticking adds it to the rest, unticking removes it from all', async () => {
    await a.page.keyboard.press('Escape')
    await expect(a.page.getByTestId('tag-picker')).toHaveCount(0)
    await selectIds(a.page, [N2, N3])
    await openPicker(a.page)
    const box = option(a.page, 'research').getByTestId('tag-option-box')
    await expect(option(a.page, 'research')).toHaveAttribute('data-state', 'some')
    await expect(box).toHaveAttribute('aria-checked', 'mixed')
    await box.click()
    await expect(option(a.page, 'research')).toHaveAttribute('data-state', 'all')
    expect(await storedTagKeys(a.page, N3)).toEqual(['research'])
    await box.click()
    await expect(option(a.page, 'research')).toHaveAttribute('data-state', 'none')
    expect(await storedTagKeys(a.page, N2)).toEqual(['idea'])
    expect(await storedTagKeys(a.page, N3)).toEqual([])
    await expect(chips(b.page, N3)).toHaveCount(0, { timeout: 2_000 })
  })

  await test.step('Ctrl+Z undoes the removal on both notes (bob too); again undoes the tick; the creation undoes the list entry', async () => {
    await a.page.keyboard.press('Escape')
    await focusBoard(a.page)
    await undo(a.page)
    expect(await storedTagKeys(a.page, N2)).toEqual(['idea', 'research'])
    expect(await storedTagKeys(a.page, N3)).toEqual(['research'])
    await expect(chips(b.page, N3)).toHaveText(['Research'], { timeout: 2_000 })
    await undo(a.page)
    expect(await storedTagKeys(a.page, N3)).toEqual([])
    await undo(a.page) // "Idea" was created and applied in one step: both go
    expect(await storedTagKeys(a.page, N1)).toEqual(['research'])
    expect(Object.keys(await boardList(a.page))).toEqual(['research'])
    await expect(chips(b.page, N1)).toHaveText(['Research'], { timeout: 2_000 })
  })
})

test('COL-11 context menu and keyboard: right-click → Tags… opens the picker with the focus in it; arrows, Space and Escape work; a note takes at most 10 tags', async ({
  session,
}) => {
  const a = await session('alice')
  await waitForCanvasUx(a.page)
  const ten = Array.from({ length: 10 }, (_, i) => tag(`t${i}`, `T${i}`, 'grey'))
  await threeNotes([a.page], { n1: [RESEARCH], n3: ten })
  await listOnBoard(a.page, [RESEARCH, IDEA])

  await test.step('right-click the selected note → Tags…', async () => {
    await clickShape(a.page, N2)
    const center = await readEd(
      a.page,
      (ed, id) => {
        const bb = ed.getShapePageBounds(id)
        return bb ? { x: bb.x + bb.w / 2, y: bb.y + bb.h / 2 } : { x: 0, y: 0 }
      },
      N2,
    )
    const menu = await contextMenuAt(a.page, center)
    await menu.getByTestId('context-menu.dr-tags-open').click()
    const picker = a.page.getByTestId('tag-picker')
    await expect(picker).toBeVisible()
    await expect(picker.getByTestId('tag-picker-input')).toBeFocused()
  })

  await test.step('↓ moves to the tags, Space and Enter tick, Escape closes and gives the board the keyboard back', async () => {
    await a.page.keyboard.press('ArrowDown')
    const first = option(a.page, 'idea').getByTestId('tag-option-box')
    await expect(first).toBeFocused()
    await a.page.keyboard.press('ArrowDown')
    await expect(option(a.page, 'research').getByTestId('tag-option-box')).toBeFocused()
    await a.page.keyboard.press('Space')
    await expect(option(a.page, 'research')).toHaveAttribute('data-state', 'all')
    await a.page.keyboard.press('Enter') // Enter on a tag toggles it too
    await expect(option(a.page, 'research')).toHaveAttribute('data-state', 'none')
    await a.page.keyboard.press('Space')
    expect(await storedTagKeys(a.page, N2)).toEqual(['research'])
    // Keys typed in the picker never reach the board (no type-to-edit, no shortcuts).
    await a.page.keyboard.press('ArrowUp')
    await a.page.keyboard.press('ArrowUp')
    await expect(a.page.getByTestId('tag-picker-input')).toBeFocused()
    await a.page.keyboard.type('xd')
    expect(
      await readEd(a.page, (ed) =>
        (ed as unknown as { getEditingShapeId(): string | null }).getEditingShapeId(),
      ),
    ).toBeNull()
    await a.page.keyboard.press('Escape')
    await expect(a.page.getByTestId('tag-picker')).toHaveCount(0)
    expect(await readEd(a.page, (ed) => [...ed.getSelectedShapeIds()])).toEqual([N2])
    // The board has the keyboard again: Ctrl+Z undoes the last tick right away.
    await expect.poll(() => readEd(a.page, (ed) => ed.getInstanceState().isFocused)).toBe(true)
    await undo(a.page)
    expect(await storedTagKeys(a.page, N2)).toEqual([])
  })

  await test.step('10 tags is the limit: the 11th is refused for that note and said so; others still get it', async () => {
    await selectIds(a.page, [N1, N3])
    const picker = await openPicker(a.page)
    await picker.getByTestId('tag-picker-input').fill('Idea')
    await a.page.keyboard.press('Enter')
    await expect(picker.getByTestId('tag-picker-status')).toHaveText(
      '1 note already has 10 tags, so it was left out.',
    )
    expect(await storedTagKeys(a.page, N1)).toEqual(['idea', 'research'])
    expect(await storedTagKeys(a.page, N3)).toHaveLength(10)
    await a.page.keyboard.press('Escape')
    await selectIds(a.page, [N3])
    await openPicker(a.page)
    await expect(option(a.page, 'idea').getByTestId('tag-option-box')).toBeDisabled()
    await expect(option(a.page, 'idea')).toHaveAttribute('title', 'Each selected note already has 10 tags')
  })
})

test('chips: inside the note, they scale with zoom, turn into colour dots when small and disappear when tiny; up to three names, then "+N"; on file cards too', async ({
  session,
}) => {
  const a = await session('alice')
  await waitForCanvasUx(a.page)
  const five = [
    RESEARCH,
    IDEA,
    BLOCKED,
    tag('q3', 'Q3', 'yellow'),
    tag('customer-voice', 'Customer voice', 'violet'),
  ]
  await threeNotes([a.page], { n1: [RESEARCH, BLOCKED], n2: five, n3: [IDEA] })
  await listOnBoard(a.page, five)
  await createShapes(a.page, [
    {
      id: CARD,
      type: 'dr-file-card',
      x: 0,
      y: 300,
      props: {
        w: 280,
        h: 92,
        name: 'survey.pdf',
        kind: 'other',
        mimeType: 'application/pdf',
        status: 'ready',
      },
      meta: tagsMeta(IDEA),
    },
  ])

  await test.step('100 %: names on the notes, sorted; five tags show two names and "+3"', async () => {
    await cameraAt(a.page, { x: 360, y: 200 }, 1)
    expect(await lod(a.page)).toBe('full')
    await expect(chips(a.page, N1)).toHaveText(['Blocked', 'Research'])
    await expect(chips(a.page, N2)).toHaveText(['Blocked', 'Customer voice'])
    const more = a.page.locator(`.tl-shape[data-shape-id="${N2}"] [data-testid="tag-chip-more"]`)
    await expect(more).toHaveText('+3')
    const behindMore = a.page.locator(`.tl-shape[data-shape-id="${N2}"] [data-testid="tag-chip-overflow"]`)
    await expect(behindMore).toHaveCount(3)
    for (const el of await behindMore.all()) await expect(el).toBeHidden()
    await expect(
      a.page.locator(`.tl-shape[data-shape-id="${N2}"] [data-testid="tag-chips"]`),
    ).toHaveAttribute('aria-label', 'Tags: Blocked, Customer voice, Idea, Q3, Research')
    // on the card too, in its own corner style
    await expect(chips(a.page, CARD)).toHaveText(['Idea'])
    await expect(
      a.page.locator(`.tl-shape[data-shape-id="${CARD}"] [data-testid="tag-chips"]`),
    ).toHaveAttribute('data-kind', 'card')
    // inside the note: the chip row sits in the note's top padding
    const chip = await chips(a.page, N1).first().boundingBox()
    const note = await a.page.locator(`.tl-shape[data-shape-id="${N1}"]`).boundingBox()
    if (!chip || !note) throw new Error('no boxes')
    expect(chip.y).toBeGreaterThanOrEqual(note.y)
    expect(chip.y + chip.height).toBeLessThanOrEqual(note.y + 20)
    expect(chip.height).toBeCloseTo(16, 0)
    await capture('tags-chips-100.png', a.page, test.info())
  })

  await test.step('200 %: twice the size (they are part of the note, not an overlay)', async () => {
    await cameraAt(a.page, { x: 100, y: 100 }, 2)
    const chip = await chips(a.page, N1).first().boundingBox()
    expect(chip?.height).toBeCloseTo(32, 0)
  })

  await test.step('40 %: a colour dot per tag (all five on the busy note, no "+3"); 20 %: nothing', async () => {
    await cameraAt(a.page, { x: 360, y: 200 }, 0.4)
    await expect.poll(() => lod(a.page)).toBe('dots')
    const dot = await chips(a.page, N1).first().boundingBox()
    expect(dot?.width).toBeCloseTo(dot?.height ?? -1, 0)
    await expect(
      a.page.locator(`.tl-shape[data-shape-id="${N2}"] [data-testid="tag-chip-more"]`),
    ).toBeHidden()
    const dots = a.page.locator(
      `.tl-shape[data-shape-id="${N2}"] :is([data-testid="tag-chip"], [data-testid="tag-chip-overflow"])`,
    )
    await expect(dots).toHaveCount(5)
    for (const el of await dots.all()) await expect(el).toBeVisible()
    await capture('tags-chips-40.png', a.page, test.info())
    await cameraAt(a.page, { x: 360, y: 200 }, 0.2)
    await expect.poll(() => lod(a.page)).toBe('off')
    await expect(chips(a.page, N1).first()).toBeHidden()
  })

  await test.step('dark theme: the chips use the dark palette', async () => {
    await cameraAt(a.page, { x: 360, y: 200 }, 1)
    const fill = () =>
      chips(a.page, N1)
        .first()
        .evaluate((el) => getComputedStyle(el).backgroundColor)
    const light = await fill()
    await a.page.emulateMedia({ colorScheme: 'dark' })
    await expect.poll(fill).not.toBe(light)
    await capture('tags-chips-dark.png', a.page, test.info())
    await a.page.emulateMedia({ colorScheme: 'light' })
  })
})

test('Tags panel: "Show only" dims everything else for alice alone; rename, recolour and delete everywhere reach bob; each is one undo step; a name clash is refused', async ({
  session,
}) => {
  const a = await session('alice')
  const b = await session('bob')
  await waitForCanvasUx(a.page)
  await threeNotes([a.page, b.page], { n1: [RESEARCH], n2: [RESEARCH, IDEA], n3: [IDEA] })
  await listOnBoard(a.page, [RESEARCH, IDEA, BLOCKED])
  await expect(chips(b.page, N2)).toHaveCount(2)

  await test.step('the panel lists every tag with its count', async () => {
    await openTagsPanel(a.page)
    await expect(a.page.getByTestId('tag-row-name')).toHaveText(['Blocked', 'Idea', 'Research'])
    await expect(a.page.getByTestId('tag-row-count')).toHaveText(['Not used yet', 'On 2 items', 'On 2 items'])
  })

  await test.step('Show only “Research”: the other note fades, the bar says so; bob’s board is untouched; Show all clears', async () => {
    await row(a.page, 'research').getByTestId('tag-filter').click()
    await expect(row(a.page, 'research').getByTestId('tag-filter')).toHaveAttribute('aria-pressed', 'true')
    const bar = a.page.getByTestId('tag-filter-bar')
    await expect(bar).toContainText('Showing only Research')
    await expect(bar).toContainText('2 items')
    await expect.poll(() => shapeOpacity(a.page, N3)).toBeLessThan(0.2)
    expect(await shapeOpacity(a.page, N1)).toBe(1)
    expect(await shapeOpacity(a.page, N2)).toBe(1)
    expect(await shapeOpacity(b.page, N3)).toBe(1)
    await expect(b.page.getByTestId('tag-filter-bar')).toHaveCount(0)
    await capture('tags-show-only.png', a.page, test.info())
    await bar.getByTestId('tag-filter-clear').click()
    await expect(bar).toHaveCount(0)
    await expect.poll(() => shapeOpacity(a.page, N3)).toBe(1)
  })

  await test.step('presenting suspends "Show only": no bar on the slide, nothing faded; it is back afterwards', async () => {
    await createShapes(a.page, [
      // behind the notes (lowest index), so the slide shows them
      {
        id: 'shape:tg-frame',
        type: 'frame',
        index: 'a0',
        x: -40,
        y: -40,
        props: { w: 800, h: 300, name: 'Findings' },
      },
    ])
    await row(a.page, 'research').getByTestId('tag-filter').click()
    await expect.poll(() => shapeOpacity(a.page, N3)).toBeLessThan(0.2)
    await a.page.getByTestId('present-button').click()
    await expect(a.page.getByTestId('present-overlay')).toBeVisible()
    await expect(a.page.getByTestId('tag-filter-bar')).toBeHidden()
    await expect.poll(() => shapeOpacity(a.page, N3)).toBe(1)
    await a.page.keyboard.press('Escape')
    await expect(a.page.getByTestId('present-overlay')).toHaveCount(0)
    await expect(a.page.getByTestId('tag-filter-bar')).toBeVisible()
    await expect.poll(() => shapeOpacity(a.page, N3)).toBeLessThan(0.2)
    await a.page.getByTestId('tag-filter-clear').click()
    await openTagsPanel(a.page)
  })

  await test.step('rename “Research” → “User research”: bob’s chips follow; the key moves on every note and on the list', async () => {
    await row(a.page, 'research').getByTestId('tag-edit').click()
    const input = a.page.getByTestId('tag-rename-input')
    await input.fill('Idea')
    await a.page.getByTestId('tag-rename-save').click()
    await expect(a.page.getByTestId('tag-editor-error')).toHaveText('There is already a tag called “Idea”.')
    await input.fill('User research')
    await a.page.getByTestId('tag-rename-save').click()
    await expect(a.page.getByTestId('tags-notice')).toHaveText('Renamed to “User research”.')
    await expect(chips(b.page, N1)).toHaveText(['User research'], { timeout: 2_000 })
    expect(await storedTagKeys(a.page, N2)).toEqual(['idea', 'user-research'])
    expect(Object.keys(await boardList(b.page)).sort()).toEqual(['blocked', 'idea', 'user-research'])
  })

  await test.step('recolour “Idea” to Coral: bob’s chips change colour', async () => {
    await row(a.page, 'idea').getByTestId('tag-edit').click()
    await a.page.locator('[data-testid="tag-color"][data-color="red"]').click()
    await expect(a.page.locator('[data-testid="tag-color"][data-color="red"]')).toHaveAttribute(
      'aria-pressed',
      'true',
    )
    await expect(chips(b.page, N3)).toHaveAttribute('data-dr-tag-color', 'red', { timeout: 2_000 })
    expect((await boardList(a.page)).idea).toEqual({ name: 'Idea', color: 'red' })
  })

  await test.step('delete “Idea” everywhere (after a confirmation): gone from both notes and the list, for bob too; Ctrl+Z brings it all back', async () => {
    await a.page.getByTestId('tag-delete').click()
    await expect(a.page.getByTestId('tag-editor')).toContainText(
      'Delete “Idea” from 2 items? The notes and cards stay.',
    )
    await a.page.getByTestId('tag-delete-confirm').click()
    await expect(a.page.getByTestId('tags-notice')).toHaveText(
      'Deleted “Idea” from 2 items. Ctrl+Z brings it back.',
    )
    await expect(chips(b.page, N3)).toHaveCount(0, { timeout: 2_000 })
    await expect(chips(b.page, N2)).toHaveText(['User research'])
    expect(await boardList(a.page)).not.toHaveProperty('idea')
    await expect(row(a.page, 'idea')).toHaveCount(0)
    await focusBoard(a.page)
    await undo(a.page)
    await expect(chips(b.page, N3)).toHaveText(['Idea'], { timeout: 2_000 })
    await expect(chips(b.page, N2)).toHaveText(['Idea', 'User research'])
    expect((await boardList(b.page)).idea).toEqual({ name: 'Idea', color: 'red' })
  })

  await test.step('bob deletes the tag alice is showing only: her filter ends by itself', async () => {
    await row(a.page, 'idea').getByTestId('tag-filter').click()
    await expect(a.page.getByTestId('tag-filter-bar')).toBeVisible()
    await openTagsPanel(b.page)
    await row(b.page, 'idea').getByTestId('tag-edit').click()
    await b.page.getByTestId('tag-delete').click()
    await b.page.getByTestId('tag-delete-confirm').click()
    await expect(a.page.getByTestId('tag-filter-bar')).toHaveCount(0, { timeout: 3_000 })
    await expect.poll(() => shapeOpacity(a.page, N1)).toBe(1)
  })
})

test('search by tag and the CSV tags column: the panel’s tag filter lists the carriers, #terms match tags only, a word finds a tag name; the export has a tags column', async ({
  session,
}) => {
  const a = await session('alice')
  await waitForCanvasUx(a.page)
  await threeNotes([a.page], { n1: [RESEARCH], n2: [RESEARCH, IDEA], n3: [] })
  await listOnBoard(a.page, [RESEARCH, IDEA])
  await createShapes(a.page, [noteAt('shape:tg-plain', 0, 300, 'Research budget for Q4')])
  const results = () =>
    a.page.getByTestId('search-result').evaluateAll((els) => els.map((e) => e.getAttribute('data-shape-id')))

  await test.step('Ctrl+F → Tag: Idea lists the one note carrying it, highlighted on the canvas', async () => {
    await focusBoard(a.page)
    await a.page.keyboard.press('Control+f')
    await expect(a.page.getByTestId('search-input')).toBeFocused()
    const select = a.page.getByTestId('search-tag-filter')
    await expect(select.locator('option')).toHaveText(['Any tag', 'Idea (1)', 'Research (2)'])
    await select.selectOption('idea')
    await expect.poll(results).toEqual([N2])
    await expect(a.page.getByTestId('search-highlights')).toHaveAttribute('data-match-count', '1')
    await select.selectOption('')
    await expect.poll(results).toEqual([])
  })

  await test.step('#res matches the tag, not the word; a plain word finds text first, then tag names', async () => {
    const input = a.page.getByTestId('search-input')
    await input.fill('#res')
    // tag-only results come in reading order (both notes are on one row: left to right)
    await expect.poll(results).toEqual([N1, N2])
    await input.fill('research')
    await expect.poll(async () => (await results())[0]).toBe('shape:tg-plain')
    expect((await results()).sort()).toEqual([N1, N2, 'shape:tg-plain'].sort())
    await input.fill('#idea search')
    await expect.poll(results).toEqual([N2])
    await expect(a.page.getByTestId('search-result').locator('mark')).toHaveText(['Search'])
    await a.page.keyboard.press('Escape')
  })

  await test.step('Export → CSV: a tags column with the names as the board shows them', async () => {
    await editBd(a.page, (ed) => (ed as unknown as { selectNone(): void }).selectNone())
    await a.page.getByTestId('export-button').click()
    const dialog = a.page.getByTestId('export-dialog')
    await expect(dialog).toBeVisible()
    await expect(dialog).toContainText('one row per object with its type, frame, colour, position and tags.')
    const file = await downloadFrom(a.page, () => dialog.getByTestId('export-csv').click())
    const rows = parseCsv(file.bytes.subarray(3).toString('utf8'))
    expect(rows[0]).toEqual(['id', 'type', 'text', 'frame', 'color', 'x', 'y', 'tags'])
    const byId = new Map(rows.slice(1).map((r) => [r[0], r]))
    expect(byId.get(N1)?.[7]).toBe('Research')
    expect(byId.get(N2)?.[7]).toBe('Idea; Research')
    expect(byId.get(N3)?.[7]).toBe('')
    await a.page.keyboard.press('Escape')
  })
})

test('read-only people: a viewer and a commenter see chips, the panel and a note’s tags and can filter, with no way to change them; their forged writes never land', async ({
  session,
}) => {
  const a = await session('alice')
  await waitForCanvasUx(a.page)
  await threeNotes([a.page], { n1: [RESEARCH], n2: [RESEARCH, IDEA, BLOCKED, tag('q3', 'Q3', 'yellow')] })
  await listOnBoard(a.page, [RESEARCH, IDEA, BLOCKED])
  await waitForSaved(a.page)

  for (const [handle, role] of [
    ['carol', 'viewer'],
    ['dave', 'commenter'],
  ] as const) {
    await test.step(`${handle} (${role})`, async () => {
      const c = await session(handle, { role })
      await waitForCanvasUx(c.page)
      await cameraAt(c.page, { x: 360, y: 100 }, 1)
      await expect(chips(c.page, N1)).toHaveText(['Research'])
      // A note without tags: no Tags button at all.
      await selectIds(c.page, [N3])
      await expect(c.page.getByTestId('selection-tags')).toHaveCount(0)
      // The note with four tags (two names and "+2" on it): "Show tags" lists all four, read-only.
      await selectIds(c.page, [N2])
      await expect(c.page.getByTestId('selection-tags')).toHaveAttribute('aria-label', 'Show tags')
      const picker = await openPicker(c.page)
      await expect(picker.getByTestId('tag-picker-readonly').locator('li')).toHaveText([
        'Blocked',
        'Idea',
        'Q3',
        'Research',
      ])
      await expect(picker.getByTestId('tag-picker-input')).toHaveCount(0)
      await expect(picker).toContainText('Only people who can edit this board can change them.')
      await c.page.keyboard.press('Escape')
      // The panel: filter yes, edit no.
      await openTagsPanel(c.page)
      await expect(c.page.getByTestId('tags-readonly-hint')).toBeVisible()
      await expect(c.page.getByTestId('tags-new')).toHaveCount(0)
      await expect(c.page.getByTestId('tag-edit')).toHaveCount(0)
      await row(c.page, 'idea').getByTestId('tag-filter').click()
      await expect(c.page.getByTestId('tag-filter-bar')).toBeVisible()
      await expect.poll(() => shapeOpacity(c.page, N1)).toBeLessThan(0.2)
      await c.page.getByTestId('tag-filter-clear').click()
      // The context menu offers "Show tags", nothing to change.
      const menu = await contextMenuAt(c.page, { x: 360, y: 100 })
      await expect(menu.getByTestId('context-menu.dr-tags-open')).toHaveText('Show tags')
      await closeMenus(c.page)
      // Forged: the sync server refuses the read-only session's pushes; the tab rolls back.
      await forgeTagWrites(c.page, N1)
      await expect.poll(() => storedTagKeys(c.page, N1)).toEqual(['research'])
      await expect
        .poll(async () => Object.keys(await boardList(c.page)).sort())
        .toEqual(['blocked', 'idea', 'research'])
      await a.page.waitForTimeout(1_000)
      expect(await storedTagKeys(a.page, N1)).toEqual(['research'])
      expect(Object.keys(await docMeta(a.page))).not.toContain('drTagList:forged')
      await c.context.close()
    })
  }
})

test('name-only guests follow their link’s role: a workshop (editor) guest tags a note alice sees; a review (commenter) guest can only look, and a forged write never lands', async ({
  browser,
  session,
}) => {
  const a = await session('alice')
  await waitForCanvasUx(a.page)
  await threeNotes([a.page], { n1: [RESEARCH] })
  await listOnBoard(a.page, [RESEARCH])
  await waitForSaved(a.page)

  const workshop = await createGuestLink(a.page, 'workshop')
  const editorGuest = await joinAsGuest(browser, workshop, 'Wes Guest')
  const review = await createGuestLink(a.page, 'review')
  const commenterGuest = await joinAsGuest(browser, review, 'Ria Guest')
  try {
    await test.step('the workshop guest tags a note through the picker', async () => {
      const g = editorGuest.page
      await waitForCanvasUx(g)
      await cameraAt(g, { x: 360, y: 100 }, 1)
      await selectIds(g, [N3])
      const picker = await openPicker(g)
      await picker.getByTestId('tag-picker-input').fill('From the workshop')
      await g.keyboard.press('Enter')
      await expect(chips(a.page, N3)).toHaveText(['From the workshop'], { timeout: 3_000 })
    })
    await test.step('the review guest sees the chips but cannot change them; a forged write is refused', async () => {
      const g = commenterGuest.page
      await waitForCanvasUx(g)
      await cameraAt(g, { x: 360, y: 100 }, 1)
      await expect(chips(g, N3)).toHaveText(['From the workshop'])
      await selectIds(g, [N1])
      await expect(g.getByTestId('selection-tags')).toHaveAttribute('aria-label', 'Show tags')
      await forgeTagWrites(g, N1)
      await expect.poll(() => storedTagKeys(g, N1)).toEqual(['research'])
      await a.page.waitForTimeout(1_000)
      expect(await storedTagKeys(a.page, N1)).toEqual(['research'])
      expect(Object.keys(await docMeta(a.page))).not.toContain('drTagList:forged')
    })
  } finally {
    await editorGuest.context.close()
    await commenterGuest.context.close()
  }
})

test('concurrent edits: bob tags a note offline while alice tags the same note; back online, the note carries both tags and the board lists both, in both browsers', async ({
  session,
}) => {
  const a = await session('alice')
  const b = await session('bob')
  await waitForCanvasUx(a.page)
  await threeNotes([a.page, b.page])

  await b.context.setOffline(true)
  await expectConn(b.page, 'offline')
  await selectIds(b.page, [N1])
  await openPicker(b.page)
  await b.page.getByTestId('tag-picker-input').fill('Blocked')
  await b.page.keyboard.press('Enter')
  await expect(chips(b.page, N1)).toHaveText(['Blocked'])

  await selectIds(a.page, [N1])
  await openPicker(a.page)
  await a.page.getByTestId('tag-picker-input').fill('Idea')
  await a.page.keyboard.press('Enter')
  await expect(chips(a.page, N1)).toHaveText(['Idea'])
  await waitForSaved(a.page)

  await b.context.setOffline(false)
  await expectConn(b.page, 'online')
  for (const p of [a.page, b.page]) {
    await expect.poll(() => chipKeys(p, N1), { timeout: 15_000 }).toEqual(['blocked', 'idea'])
    await expect.poll(async () => Object.keys(await boardList(p)).sort()).toEqual(['blocked', 'idea'])
  }
})

test('the look at 390 px, light and dark: the picker stays on screen clear of the toolbar, the panel and the filter bar fit', async ({
  session,
}) => {
  const a = await session('alice')
  await waitForCanvasUx(a.page)
  const five = [
    RESEARCH,
    IDEA,
    BLOCKED,
    tag('q3', 'Q3', 'yellow'),
    tag('customer-voice', 'Customer voice', 'violet'),
  ]
  await threeNotes([a.page], { n1: [RESEARCH, BLOCKED], n2: five, n3: [IDEA] })
  await listOnBoard(a.page, five)
  await a.page.setViewportSize({ width: 390, height: 844 })
  await expect
    .poll(() =>
      readEd(
        a.page,
        (ed) => (ed as unknown as { getViewportScreenBounds(): { w: number } }).getViewportScreenBounds().w,
      ),
    )
    .toBeLessThan(390)
  for (const scheme of ['light', 'dark'] as const) {
    await test.step(scheme, async () => {
      await a.page.emulateMedia({ colorScheme: scheme })
      await cameraAt(a.page, { x: 360, y: 200 }, 1)
      await selectIds(a.page, [N2])
      await openPicker(a.page)
      await expect.poll(() => insideViewport(a.page, '[data-testid="tag-picker"]', 4)).toBe(true)
      const picker = await a.page.getByTestId('tag-picker').boundingBox()
      const toolbar = await a.page.locator('.tlui-layout__bottom__main').first().boundingBox()
      if (!picker || !toolbar) throw new Error('no boxes')
      expect(picker.y + picker.height).toBeLessThanOrEqual(toolbar.y)
      await capture(`tags-picker-390-${scheme}.png`, a.page, test.info())
      await a.page.keyboard.press('Escape')
      await openTagsPanel(a.page)
      await row(a.page, 'research').getByTestId('tag-filter').click()
      await row(a.page, 'research').getByTestId('tag-edit').click()
      expect(await a.page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
        true,
      )
      await capture(`tags-panel-390-${scheme}.png`, a.page, test.info())
      await a.page.getByTestId('dock-tab-tags').click() // close the dock
      await expect.poll(() => insideViewport(a.page, '[data-testid="tag-filter-bar"]', 4)).toBe(true)
      await capture(`tags-filter-390-${scheme}.png`, a.page, test.info())
      await a.page.getByTestId('tag-filter-clear').click()
    })
  }
})
