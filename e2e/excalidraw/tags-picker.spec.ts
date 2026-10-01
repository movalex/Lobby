// tags on the new canvas, the picker and the chips (the port of tests/tags.spec.ts, first half): tags on
// sticky notes and shapes as `customData.lobby['tag:<key>']` with the board's list in lb_doc
// (`tagDef:<key>`). Every test drives the real picker and checks the result in a second browser and in the
// synced elements. Steps that need another wave-3 owner's part (3a's selection bar and context menu) run
// only when that part is on the page; until then the picker opens through the feature's own command,
// which is what the context menu's "Tags…" runs.
//
// Deviations from the tldraw spec (docs/research/excalidraw/wave3/3D.md):
//  - the board's list is lb_doc, which Lobby's undo does not cover: undoing a tag's creation takes it off
//    the notes and leaves it listed (tldraw's undo took the list entry too);
//  - the chips are DOM in the overlay (a `tag-box` per element), not inside the shape;
//  - a file card needs the media owner's upload path: the card placement is covered by the unit tests, a
//    shape (chips above it) is checked here instead.
import type { Page } from '@playwright/test'
import { canvasCall, expect, test } from '../tests/support/canvas.ts'
import { goOffline, goOnline, openRelayedCanvasSession, pressUndo } from '../tests/support/excalidraw.ts'
import { capture } from '../tests/support/screenshots.ts'
import { settled } from './board-kit.ts'
import {
  boardList,
  cameraAt,
  chipKeys,
  chips,
  createShape,
  hostSlot,
  listOnBoard,
  lod,
  N1,
  N2,
  N3,
  openPicker,
  option,
  screenBox,
  seen,
  selectIds,
  storedTagKeys,
  tag,
  tagBox,
  tagElements,
  tagsReady,
  threeNotes,
} from './tags-kit.ts'

test.use({ viewport: { width: 1440, height: 900 } })

const RESEARCH = tag('research', 'Research', 'blue')
const IDEA = tag('idea', 'Idea', 'green')
const BLOCKED = tag('blocked', 'Blocked', 'red')

async function onNotes(pages: Page[]) {
  const [a] = pages
  if (!a) throw new Error('no page')
  await threeNotes(a)
  for (const p of pages) {
    await tagsReady(p)
    await seen(p, [N1, N2, N3])
    await cameraAt(p, { x: 360, y: 100 }, 1)
  }
}

test('COL-11 picker: alice creates and applies tags to two notes; bob sees the chips within 2 s; mixed selection, remove; each change is one undo step', async ({
  canvasSession,
}) => {
  const a = await canvasSession('alice')
  const b = await canvasSession('bob')
  await onNotes([a.page, b.page])

  await test.step('select two notes → Tags → type a new name → Enter: both carry it, the board lists it', async () => {
    await selectIds(a.page, [N1, N2])
    const picker = await openPicker(a.page)
    await expect(picker).toHaveAttribute('role', 'dialog')
    await expect(picker.getByTestId('tag-picker-input')).toBeFocused()
    await expect(picker).toContainText('No tags on this board yet. Type a name to create one.')
    await a.page.keyboard.type('#Research')
    // F15: the typed "#" becomes the field's prefix (the field holds the name), and the offer keeps it.
    await expect(picker.getByTestId('tag-picker-input')).toHaveValue('Research')
    await expect(picker.getByTestId('tag-create')).toHaveText('+ Create “#Research”')
    await a.page.keyboard.press('Enter')
    await expect(picker.getByTestId('tag-picker-status')).toHaveText('Created “#Research”.')
    await expect(picker.getByTestId('tag-picker-input')).toHaveValue('')
    await expect(option(a.page, 'research')).toHaveAttribute('data-state', 'all')
    for (const id of [N1, N2]) expect(await storedTagKeys(a.page, id)).toEqual(['research'])
    expect(await boardList(a.page)).toEqual({ research: { name: 'Research', color: 'blue' } })
    for (const id of [N1, N2]) await expect(chips(b.page, id)).toHaveText(['Research'], { timeout: 2_000 })
    await expect(chips(b.page, N3)).toHaveCount(0)
    await capture('excalidraw-tags-picker.png', a.page, test.info())
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

  await test.step('Ctrl+Z undoes the removal on both notes (bob too); again undoes the tick; then the creation of "Idea" takes it off both notes (the list keeps it: lb_doc is not undone)', async () => {
    await a.page.keyboard.press('Escape')
    await pressUndo(a.page)
    await expect.poll(() => storedTagKeys(a.page, N2)).toEqual(['idea', 'research'])
    expect(await storedTagKeys(a.page, N3)).toEqual(['research'])
    await expect(chips(b.page, N3)).toHaveText(['Research'], { timeout: 2_000 })
    await pressUndo(a.page)
    await expect.poll(() => storedTagKeys(a.page, N3)).toEqual([])
    await pressUndo(a.page) // "Idea" was created and applied in one step: it leaves both notes
    await expect.poll(() => storedTagKeys(a.page, N1)).toEqual(['research'])
    expect(await storedTagKeys(a.page, N2)).toEqual(['research'])
    // deviation: the list entry stays (tldraw's undo removed it with the notes' tags)
    expect(Object.keys(await boardList(a.page)).sort()).toEqual(['idea', 'research'])
    await expect(chips(b.page, N1)).toHaveText(['Research'], { timeout: 2_000 })
  })
})

test('COL-11 context menu and keyboard: Tags… opens the picker with the focus in it; arrows, Space and Escape work; a note takes at most 10 tags', async ({
  canvasSession,
}) => {
  const a = await canvasSession('alice')
  const ten = Array.from({ length: 10 }, (_, i) => tag(`t${i}`, `T${i}`, 'grey'))
  await onNotes([a.page])
  await listOnBoard(a.page, [RESEARCH, IDEA])
  await settled(a.page, tagElements(a.page, { [N1]: [RESEARCH], [N3]: ten }))

  await test.step("right-click the selected note → Tags… (3a's context menu; else the same command)", async () => {
    await selectIds(a.page, [N2])
    if (await hostSlot(a.page, 'contextMenu')) {
      const box = await screenBox(a.page, N2)
      await a.page.mouse.click(box.x + box.width / 2, box.y + box.height / 2, { button: 'right' })
      await a.page.getByTestId('context-menu.dr-tags-open').click()
    } else {
      test.info().annotations.push({ type: 'skipped step', description: "context menu: needs 3a's shell" })
      await openPicker(a.page)
    }
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
    // Keys typed in the picker never reach the board (no type-to-edit, no shortcuts, no nudging).
    const before = await canvasCall(a.page, 'get', N2)
    await a.page.keyboard.press('ArrowUp')
    await a.page.keyboard.press('ArrowUp')
    await expect(a.page.getByTestId('tag-picker-input')).toBeFocused()
    await a.page.keyboard.type('xd')
    expect(await canvasCall(a.page, 'editingId')).toBeNull()
    expect((await canvasCall(a.page, 'get', N2))?.x).toBe(before?.x)
    await a.page.keyboard.press('Escape')
    await expect(a.page.getByTestId('tag-picker')).toHaveCount(0)
    expect(await canvasCall(a.page, 'selection')).toEqual([N2])
    // The board has the keyboard again: Ctrl+Z undoes the last tick right away.
    await expect
      .poll(() => a.page.evaluate(() => !!document.activeElement?.closest('.excalidraw')))
      .toBe(true)
    await a.page.keyboard.press('ControlOrMeta+z')
    await expect.poll(() => storedTagKeys(a.page, N2)).toEqual([])
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

test('chips: inside the note, they scale with zoom, turn into colour dots when small and disappear when tiny; up to three names, then "+N"; above a shape; dark theme', async ({
  canvasSession,
}) => {
  const a = await canvasSession('alice')
  const five = [
    RESEARCH,
    IDEA,
    BLOCKED,
    tag('q3', 'Q3', 'yellow'),
    tag('customer-voice', 'Customer voice', 'violet'),
  ]
  await onNotes([a.page])
  const shape = await settled(a.page, createShape(a.page, 0, 300))
  await listOnBoard(a.page, five)
  await settled(
    a.page,
    tagElements(a.page, { [N1]: [RESEARCH, BLOCKED], [N2]: five, [N3]: [IDEA], [shape]: [IDEA] }),
  )

  await test.step('100 %: names on the notes, sorted; five tags show two names and "+3"', async () => {
    await cameraAt(a.page, { x: 360, y: 200 }, 1)
    expect(await lod(a.page)).toBe('full')
    await expect(chips(a.page, N1)).toHaveText(['Blocked', 'Research'])
    await expect(chips(a.page, N2)).toHaveText(['Blocked', 'Customer voice'])
    await expect(tagBox(a.page, N2).getByTestId('tag-chip-more')).toHaveText('+3')
    const behindMore = tagBox(a.page, N2).getByTestId('tag-chip-overflow')
    await expect(behindMore).toHaveCount(3)
    for (const el of await behindMore.all()) await expect(el).toBeHidden()
    await expect(tagBox(a.page, N2).getByTestId('tag-chips')).toHaveAttribute(
      'aria-label',
      'Tags: Blocked, Customer voice, Idea, Q3, Research',
    )
    // on the shape too, above it (they never cover a topic's centred words)
    await expect(chips(a.page, shape)).toHaveText(['Idea'])
    await expect(tagBox(a.page, shape).getByTestId('tag-chips')).toHaveAttribute('data-kind', 'above')
    const onShape = await chips(a.page, shape).first().boundingBox()
    const shapeBox = await screenBox(a.page, shape)
    if (!onShape) throw new Error('no chip on the shape')
    expect(onShape.y + onShape.height).toBeLessThanOrEqual(shapeBox.y + 0.5)
    // inside the note: the chip row sits in the note's top padding
    const chip = await chips(a.page, N1).first().boundingBox()
    const note = await screenBox(a.page, N1)
    if (!chip) throw new Error('no chip')
    expect(chip.y).toBeGreaterThanOrEqual(note.y)
    expect(chip.y + chip.height).toBeLessThanOrEqual(note.y + 20)
    expect(chip.x).toBeGreaterThanOrEqual(note.x)
    expect(chip.height).toBeCloseTo(16, 0)
    await capture('excalidraw-tags-chips-100.png', a.page, test.info())
  })

  await test.step('200 %: twice the size (scene units, like the note)', async () => {
    await cameraAt(a.page, { x: 100, y: 100 }, 2)
    const chip = await chips(a.page, N1).first().boundingBox()
    expect(chip?.height).toBeCloseTo(32, 0)
  })

  await test.step('40 %: a colour dot per tag (all five on the busy note, no "+3"); 20 %: nothing', async () => {
    await cameraAt(a.page, { x: 360, y: 200 }, 0.4)
    await expect.poll(() => lod(a.page)).toBe('dots')
    const dot = await chips(a.page, N1).first().boundingBox()
    expect(dot?.width).toBeCloseTo(dot?.height ?? -1, 0)
    await expect(tagBox(a.page, N2).getByTestId('tag-chip-more')).toBeHidden()
    const dots = tagBox(a.page, N2).locator(
      ':is([data-testid="tag-chip"], [data-testid="tag-chip-overflow"])',
    )
    await expect(dots).toHaveCount(5)
    for (const el of await dots.all()) await expect(el).toBeVisible()
    await capture('excalidraw-tags-chips-40.png', a.page, test.info())
    await cameraAt(a.page, { x: 360, y: 200 }, 0.2)
    await expect.poll(() => lod(a.page)).toBe('off')
    await expect(chips(a.page, N1).first()).toBeHidden()
  })

  await test.step('a chip follows its note when it moves', async () => {
    await cameraAt(a.page, { x: 360, y: 200 }, 1)
    const before = await chips(a.page, N3).first().boundingBox()
    await settled(a.page, canvasCall(a.page, 'update', N3, { x: 560, y: 40 }))
    await expect
      .poll(async () => {
        const now = await chips(a.page, N3).first().boundingBox()
        return now && before ? [Math.round(now.x - before.x), Math.round(now.y - before.y)] : null
      })
      .toEqual([40, 40])
  })

  await test.step('dark theme: the chips use the dark palette', async () => {
    const fill = () =>
      chips(a.page, N1)
        .first()
        .evaluate((el) => getComputedStyle(el).backgroundColor)
    const light = await fill()
    await a.page.emulateMedia({ colorScheme: 'dark' })
    await expect.poll(fill).not.toBe(light)
    await capture('excalidraw-tags-chips-dark.png', a.page, test.info())
    await a.page.emulateMedia({ colorScheme: 'light' })
  })
})

test('concurrent edits: bob tags a note offline while alice tags the same note; back online, the note carries both tags and the board lists both, in both browsers', async ({
  browser,
  board,
  users,
  canvasSession,
}) => {
  const a = await canvasSession('alice')
  await users.grant(board, 'bob', 'editor')
  const b = await openRelayedCanvasSession(browser, board, await users.get('bob'))
  try {
    await onNotes([a.page, b.page])

    await goOffline(b)
    await expect(b.page.getByTestId('conn-status')).toHaveAttribute('data-state', /offline|connecting/)
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

    await goOnline(b)
    for (const p of [a.page, b.page]) {
      await expect.poll(() => chipKeys(p, N1), { timeout: 15_000 }).toEqual(['blocked', 'idea'])
      await expect.poll(async () => Object.keys(await boardList(p)).sort()).toEqual(['blocked', 'idea'])
    }
  } finally {
    await b.context.close()
  }
})
