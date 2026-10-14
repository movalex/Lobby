// tags on the new canvas, the Tags panel, "Show only", search, CSV and who may change tags (the port of
// tests/tags.spec.ts, second half). "Show only" fades everything else under a veil over the canvas (the
// elements are painted on a canvas, so there is no per-shape opacity to read): the checks read the veil's
// holes and the colour on screen. Read-only people (viewers, commenters, a commenter guest) get a forged
// push on a raw socket with their own ticket, which the sync server must refuse; a name-only guest on a
// workshop (editor) link tags with the board's tags and creates new ones (CR-3D-5: the room takes an editor
// guest's `tagDef:` writes, up to GUEST_TAG_DEF_CAP keys; never `workshop` or `startView`).
//
// Deviations from the tldraw spec (docs/research/excalidraw/wave3/3D.md):
//  - presenting is the board's focus mode here (3e's present sets it; its button is used when present);
//  - search by tag needs 3b's search panel to render ./SearchTagFilter.tsx and the tags column needs 3e's
//    export dialog: those steps run only when those parts are on the page.
import type { Page } from '@playwright/test'
import { canvasCall, createItem, expect, expectSaved, item, items, test } from '../tests/support/canvas.ts'
import { forgeSession, pressUndo } from '../tests/support/excalidraw.ts'
import { downloadFrom, parseCsv } from '../tests/support/present-export.ts'
import { capture } from '../tests/support/screenshots.ts'
import { createGuestLink } from '../tests/support/tags.ts'
import { settled } from './board-kit.ts'
import { openBoardExport, startPresenting } from './present-kit.ts'
import {
  boardList,
  cameraAt,
  chips,
  fromWhite,
  hostSlot,
  insideViewport,
  joinAsGuest,
  listOnBoard,
  N1,
  N2,
  N3,
  openPicker,
  openTagsPanel,
  pixelAt,
  quietSpot,
  row,
  seen,
  selectIds,
  storedTagKeys,
  type Tag,
  tag,
  tagElements,
  tagsReady,
  threeNotes,
  veilHoles,
} from './tags-kit.ts'

test.use({ viewport: { width: 1440, height: 900 } })

const RESEARCH = tag('research', 'Research', 'blue')
const IDEA = tag('idea', 'Idea', 'green')
const BLOCKED = tag('blocked', 'Blocked', 'red')

/** Three notes (tagged), everyone's camera on them. */
async function taggedNotes(pages: Page[], tags: Record<string, Tag[]>, listed: Tag[] = []) {
  const [a] = pages
  if (!a) throw new Error('no page')
  await tagsReady(a)
  await threeNotes(a)
  if (listed.length) await listOnBoard(a, listed)
  await settled(a, tagElements(a, tags))
  for (const p of pages) {
    await tagsReady(p)
    await seen(p, [N1, N2, N3])
    await cameraAt(p, { x: 360, y: 100 }, 1)
  }
}

/** Focus mode on or off (present mode; 3e's button when it is on the page). */
async function presenting(page: Page, on: boolean) {
  if (on && (await page.getByTestId('present-button').count()) > 0) {
    // present mode shows frames: a frame "Findings" around the notes first, as the tldraw spec makes one
    // (the wave-3 integration: 3e's Present button is on this page now)
    if (!(await items(page)).some((e) => e.type === 'frame')) {
      const all = await items(page)
      const xs = all.flatMap((e) => [e.x, e.x + e.width])
      const ys = all.flatMap((e) => [e.y, e.y + e.height])
      const x = Math.min(...xs) - 40
      const y = Math.min(...ys) - 40
      await createItem(page, 'frame', {
        id: 'tg-frame',
        x,
        y,
        width: Math.max(...xs) + 40 - x,
        height: Math.max(...ys) + 40 - y,
        name: 'Findings',
      })
      await expectSaved(page)
    }
    await startPresenting(page.getByTestId('present-button'))
    await expect(page.getByTestId('present-overlay')).toBeVisible()
    return
  }
  if (!on && (await page.getByTestId('present-overlay').count()) > 0) {
    await page.keyboard.press('Escape')
    return
  }
  await page.evaluate(
    (v) =>
      (
        window as unknown as {
          __lobbyBoard: { canvas: { settings: { set(p: { focusMode: boolean }): void } } }
        }
      ).__lobbyBoard.canvas.settings.set({ focusMode: v }),
    on,
  )
}

test('Tags panel: "Show only" fades everything else for alice alone; rename, recolour and delete everywhere reach bob; each is one undo step; a name clash is refused', async ({
  canvasSession,
}) => {
  const a = await canvasSession('alice')
  const b = await canvasSession('bob')
  await taggedNotes([a.page, b.page], { [N1]: [RESEARCH], [N2]: [RESEARCH, IDEA], [N3]: [IDEA] }, [
    RESEARCH,
    IDEA,
    BLOCKED,
  ])
  await expect(chips(b.page, N2)).toHaveCount(2)

  await test.step('the panel lists every tag with its count', async () => {
    await openTagsPanel(a.page)
    await expect(a.page.getByTestId('tag-row-name')).toHaveText(['Blocked', 'Idea', 'Research'])
    await expect(a.page.getByTestId('tag-row-count')).toHaveText(['Not used yet', 'On 2 items', 'On 2 items'])
  })

  await test.step('Show only “Research”: the other note fades, the bar says so; bob’s board is untouched; Show all clears', async () => {
    const n3 = await quietSpot(a.page, N3)
    const n1 = await quietSpot(a.page, N1)
    const n3Before = await pixelAt(a.page, n3)
    expect(fromWhite(n3Before)).toBeGreaterThan(60) // a coloured note
    await row(a.page, 'research').getByTestId('tag-filter').click()
    await expect(row(a.page, 'research').getByTestId('tag-filter')).toHaveAttribute('aria-pressed', 'true')
    const bar = a.page.getByTestId('tag-filter-bar')
    await expect(bar).toContainText('Showing only Research')
    await expect(bar).toContainText('2 items')
    await expect.poll(() => veilHoles(a.page)).toEqual([N1, N2].sort())
    // on screen: the note without the tag is almost the canvas colour, the carriers are as they were
    await expect
      .poll(async () => fromWhite(await pixelAt(a.page, n3)))
      .toBeLessThan(0.2 * fromWhite(n3Before))
    expect(await pixelAt(a.page, n1)).toEqual(n3Before)
    expect(await veilHoles(b.page)).toBeNull()
    await expect(b.page.getByTestId('tag-filter-bar')).toHaveCount(0)
    await capture('excalidraw-tags-show-only.png', a.page, test.info())
    await bar.getByTestId('tag-filter-clear').click()
    await expect(bar).toHaveCount(0)
    await expect.poll(() => veilHoles(a.page)).toBeNull()
    await expect.poll(() => pixelAt(a.page, n3)).toEqual(n3Before)
  })

  await test.step('presenting suspends "Show only": no bar and no veil; it is back afterwards', async () => {
    await row(a.page, 'research').getByTestId('tag-filter').click()
    await expect.poll(() => veilHoles(a.page)).toEqual([N1, N2].sort())
    await presenting(a.page, true)
    await expect(a.page.getByTestId('tag-filter-bar')).toHaveCount(0)
    await expect.poll(() => veilHoles(a.page)).toBeNull()
    // the chips stay on the slides (they were part of the notes)
    await expect(chips(a.page, N1)).toHaveText(['Research'])
    await presenting(a.page, false)
    await expect(a.page.getByTestId('tag-filter-bar')).toBeVisible()
    await expect.poll(() => veilHoles(a.page)).toEqual([N1, N2].sort())
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
    await expect
      .poll(async () => Object.keys(await boardList(b.page)).sort())
      .toEqual(['blocked', 'idea', 'user-research'])
  })

  await test.step('recolour “Idea” to red: bob’s chips change colour', async () => {
    await row(a.page, 'idea').getByTestId('tag-edit').click()
    await a.page.locator('[data-testid="tag-color"][data-color="red"]').click()
    await expect(a.page.locator('[data-testid="tag-color"][data-color="red"]')).toHaveAttribute(
      'aria-pressed',
      'true',
    )
    await expect(chips(b.page, N3)).toHaveAttribute('data-dr-tag-color', 'red', { timeout: 2_000 })
    expect((await boardList(a.page)).idea).toEqual({ name: 'Idea', color: 'red' })
  })

  await test.step('delete “Idea” everywhere (after a confirmation): gone from both notes and the list, for bob too; Ctrl+Z brings it all back, then the colour', async () => {
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
    await pressUndo(a.page)
    await expect(chips(b.page, N3)).toHaveText(['Idea'], { timeout: 2_000 })
    await expect(chips(b.page, N2)).toHaveText(['Idea', 'User research'])
    // lb_doc is not part of the undo: the notes' copies put the definition back (./runtime.ts)
    await expect.poll(async () => (await boardList(b.page)).idea).toEqual({ name: 'Idea', color: 'red' })
    // once more: the recolour goes back (the notes' copies, and the list follows them)
    await pressUndo(a.page)
    await expect(chips(b.page, N3)).toHaveAttribute('data-dr-tag-color', 'green', { timeout: 2_000 })
    await expect.poll(async () => (await boardList(b.page)).idea).toEqual({ name: 'Idea', color: 'green' })
  })

  await test.step('bob deletes the tag alice is showing only: her filter ends by itself', async () => {
    await openTagsPanel(a.page)
    await row(a.page, 'idea').getByTestId('tag-filter').click()
    await expect(a.page.getByTestId('tag-filter-bar')).toBeVisible()
    await openTagsPanel(b.page)
    await row(b.page, 'idea').getByTestId('tag-edit').click()
    await b.page.getByTestId('tag-delete').click()
    await b.page.getByTestId('tag-delete-confirm').click()
    await expect(a.page.getByTestId('tag-filter-bar')).toHaveCount(0, { timeout: 3_000 })
    await expect.poll(() => veilHoles(a.page)).toBeNull()
  })
})

test('search by tag and the CSV tags column: the panel’s tag filter lists the carriers, #terms match tags only, a word finds a tag name; the export has a tags column', async ({
  canvasSession,
}) => {
  const a = await canvasSession('alice')
  await taggedNotes([a.page], { [N1]: [RESEARCH], [N2]: [RESEARCH, IDEA] }, [RESEARCH, IDEA])
  await settled(
    a.page,
    canvasCall(a.page, 'create', 'note', { id: 'tg-plain', x: 0, y: 300, text: 'Research budget for Q4' }),
  )
  const results = () =>
    a.page.getByTestId('search-result').evaluateAll((els) => els.map((e) => e.getAttribute('data-shape-id')))

  await a.page.locator('.excalidraw').focus()
  await a.page.keyboard.press('ControlOrMeta+f')
  const search =
    (await a.page.getByTestId('search-input').count()) > 0 &&
    (await a.page.getByTestId('search-tag-filter').count()) > 0
  if (search) await a.page.keyboard.press('Escape')
  // K3-3: the export dialog opens from the board menu (Board menu > Export > Export...)
  const exportDialog = (await a.page.getByTestId('main-menu.button').count()) > 0
  test.skip(
    !search && !exportDialog,
    "needs 3b's search panel with ./SearchTagFilter.tsx (a change request) and 3e's export dialog",
  )

  await test.step('Ctrl+F → Tag: Idea lists the one note carrying it', async () => {
    if (!search) {
      test
        .info()
        .annotations.push({ type: 'skipped step', description: "search by tag: needs 3b's panel to use it" })
      return
    }
    await a.page.locator('.excalidraw').focus()
    await a.page.keyboard.press('ControlOrMeta+f')
    await expect(a.page.getByTestId('search-input')).toBeFocused()
    const select = a.page.getByTestId('search-tag-filter')
    await expect(select.locator('option')).toHaveText(['Any tag', 'Idea (1)', 'Research (2)'])
    await select.selectOption('idea')
    await expect.poll(results).toEqual([N2])
    await select.selectOption('')
    const input = a.page.getByTestId('search-input')
    await input.fill('#res')
    await expect.poll(results).toEqual([N1, N2])
    await input.fill('research')
    await expect.poll(async () => (await results())[0]).toBe('tg-plain')
    await input.fill('#idea search')
    await expect.poll(results).toEqual([N2])
    await a.page.keyboard.press('Escape')
  })

  await test.step('Export → CSV: a tags column with the names as the board shows them', async () => {
    if (!exportDialog) {
      test.info().annotations.push({ type: 'skipped step', description: "CSV: needs 3e's export dialog" })
      return
    }
    await canvasCall(a.page, 'select', [])
    await openBoardExport(a.page)
    const dialog = a.page.getByTestId('export-dialog')
    await expect(dialog).toBeVisible()
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

/** A forged push on a raw socket with the page's own ticket: a tag on N1 and a board-list entry. */
async function forgeTagWrites(page: Page, board: string) {
  const { socket, welcome } = await forgeSession(page, board)
  try {
    expect(welcome.readonly).toBe(true)
    const el = await item(page, N1)
    await socket.send({
      type: 'push',
      seq: 1,
      base: welcome.clock,
      ops: [{ k: 'p', id: N1, pv: el?.version ?? 1, c: { 'tag:forged': { name: 'Forged', color: 'red' } } }],
      doc: { set: { 'tagDef:forged': { name: 'Forged', color: 'red' } } },
    } as never)
    const ack = (await socket.next('ack')) as {
      r: { ok: boolean }[]
      docDenied?: { keys: string[]; code: string }
    }
    expect(ack.r.every((r) => !r.ok)).toBe(true)
    expect(ack.docDenied?.keys).toEqual(['tagDef:forged'])
  } finally {
    await socket.close()
  }
}

test('read-only people: a viewer and a commenter see chips, the panel and a note’s tags and can filter, with no way to change them; their forged writes never land', async ({
  canvasSession,
  board,
}) => {
  const a = await canvasSession('alice')
  await taggedNotes(
    [a.page],
    { [N1]: [RESEARCH], [N2]: [RESEARCH, IDEA, BLOCKED, tag('q3', 'Q3', 'yellow')] },
    [RESEARCH, IDEA, BLOCKED],
  )

  for (const [handle, role] of [
    ['carol', 'viewer'],
    ['dave', 'commenter'],
  ] as const) {
    await test.step(`${handle} (${role})`, async () => {
      const c = await canvasSession(handle, { role })
      await tagsReady(c.page)
      await cameraAt(c.page, { x: 360, y: 100 }, 1)
      await expect(chips(c.page, N1)).toHaveText(['Research'])
      const bar = await hostSlot(c.page, 'selectionBar')
      // A note without tags: no Tags button, and the picker does not open.
      await selectIds(c.page, [N3])
      if (bar) await expect(c.page.getByTestId('selection-tags')).toHaveCount(0)
      await c.page.evaluate(() =>
        (window as unknown as { __lobbyTags: { rt: { openPicker(): void } } }).__lobbyTags.rt.openPicker(),
      )
      await expect(c.page.getByTestId('tag-picker')).toHaveCount(0)
      // The note with four tags (two names and "+2" on it): "Show tags" lists all four, read-only.
      await selectIds(c.page, [N2])
      if (bar) await expect(c.page.getByTestId('selection-tags')).toHaveAttribute('aria-label', 'Show tags')
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
      await expect(picker).toHaveCount(0)
      // The panel: filter yes, edit no.
      await openTagsPanel(c.page)
      await expect(c.page.getByTestId('tags-readonly-hint')).toBeVisible()
      await expect(c.page.getByTestId('tags-new')).toHaveCount(0)
      await expect(c.page.getByTestId('tag-edit')).toHaveCount(0)
      await row(c.page, 'idea').getByTestId('tag-filter').click()
      await expect(c.page.getByTestId('tag-filter-bar')).toBeVisible()
      await expect.poll(() => veilHoles(c.page)).toEqual([N2])
      await c.page.getByTestId('tag-filter-clear').click()
      // The context menu (3a's shell) offers "Show tags", nothing to change.
      if (await hostSlot(c.page, 'contextMenu')) {
        const box = await c.page.getByTestId('tag-box').first().boundingBox()
        if (!box) throw new Error('no chips')
        await c.page.mouse.click(box.x + 40, box.y + 60, { button: 'right' })
        await expect(c.page.getByTestId('context-menu.dr-tags-open')).toHaveText('Show tags')
        await c.page.keyboard.press('Escape')
      } else
        test.info().annotations.push({ type: 'skipped step', description: "context menu: needs 3a's shell" })
      // Forged: the sync server refuses the read-only session's push, element and list both.
      await forgeTagWrites(c.page, board)
      await a.page.waitForTimeout(1_000)
      expect(await storedTagKeys(a.page, N1)).toEqual(['research'])
      expect(Object.keys(await boardList(a.page)).sort()).toEqual(['blocked', 'idea', 'q3', 'research'])
      await c.context.close()
    })
  }
})

test('name-only guests follow their link’s role: a workshop (editor) guest tags a note with a board tag alice sees; a review (commenter) guest can only look, and a forged write never lands', async ({
  browser,
  canvasSession,
  board,
}) => {
  const a = await canvasSession('alice')
  await taggedNotes([a.page], { [N1]: [RESEARCH] }, [RESEARCH, IDEA])
  // DEF-3F-1 (2C): a join within 5 s of a board-document write gets the cached snapshot's old document, so
  // the guest would not know the board's Idea tag yet (and, since W5-29, a guest cannot create it). This test
  // is about roles: the guests join once the cache has moved on.
  await a.page.waitForTimeout(5_500)

  const workshop = await createGuestLink(a.page, 'workshop')
  const editorGuest = await joinAsGuest(browser, workshop, 'Wes Guest')
  const review = await createGuestLink(a.page, 'review')
  const commenterGuest = await joinAsGuest(browser, review, 'Ria Guest')
  try {
    await test.step('the workshop guest tags a note through the picker (a tag the board has)', async () => {
      const g = editorGuest.page
      await tagsReady(g)
      await cameraAt(g, { x: 360, y: 100 }, 1)
      await selectIds(g, [N3])
      const picker = await openPicker(g)
      await picker.getByTestId('tag-picker-input').fill('Idea')
      await expect(picker.locator('[data-tag-key="idea"]')).toBeVisible()
      await g.keyboard.press('Enter')
      await expect(chips(a.page, N3)).toHaveText(['Idea'], { timeout: 3_000 })
    })
    await test.step('the review guest sees the chips but cannot change them; a forged write is refused', async () => {
      const g = commenterGuest.page
      await tagsReady(g)
      await cameraAt(g, { x: 360, y: 100 }, 1)
      await expect(chips(g, N3)).toHaveText(['Idea'])
      await selectIds(g, [N1])
      if (await hostSlot(g, 'selectionBar'))
        await expect(g.getByTestId('selection-tags')).toHaveAttribute('aria-label', 'Show tags')
      await forgeTagWrites(g, board)
      await a.page.waitForTimeout(1_000)
      expect(await storedTagKeys(a.page, N1)).toEqual(['research'])
      expect(Object.keys(await boardList(a.page)).sort()).toEqual(['idea', 'research'])
    })
  } finally {
    await editorGuest.context.close()
    await commenterGuest.context.close()
  }
})

test('a workshop (editor) guest creates a new tag from the picker: alice sees it (CR-3D-5)', async ({
  browser,
  canvasSession,
}) => {
  // CR-3D-5: the room takes an editor guest's `tagDef:` writes (apps/sync/src/room/merge.ts applyDoc, doc.ts
  // `guests`), so the new tag's definition lands with the note's `tag:<key>`, as the tldraw page let an editor
  // guest create tags. The picker's W5-29 guest guard is gone with the test.fail mark.
  const a = await canvasSession('alice')
  await taggedNotes([a.page], { [N1]: [RESEARCH] }, [RESEARCH])
  const workshop = await createGuestLink(a.page, 'workshop')
  const guest = await joinAsGuest(browser, workshop, 'Wes Guest')
  try {
    const g = guest.page
    await tagsReady(g)
    await cameraAt(g, { x: 360, y: 100 }, 1)
    await selectIds(g, [N3])
    const picker = await openPicker(g)
    await picker.getByTestId('tag-picker-input').fill('From the workshop')
    await g.keyboard.press('Enter')
    await expect(chips(a.page, N3)).toHaveText(['From the workshop'], { timeout: 5_000 })
  } finally {
    await guest.context.close()
  }
})

test('W5-29, CR-3D-5: a name-only workshop guest’s Create is real: no “Change not saved”, alice’s list has it, and the board’s own tag still goes on', async ({
  browser,
  canvasSession,
}) => {
  const a = await canvasSession('alice')
  await taggedNotes([a.page], { [N1]: [RESEARCH] }, [RESEARCH])
  const workshop = await createGuestLink(a.page, 'workshop')
  const guest = await joinAsGuest(browser, workshop, 'Wes Guest')
  try {
    const g = guest.page
    await tagsReady(g)
    await cameraAt(g, { x: 360, y: 100 }, 1)
    await selectIds(g, [N3])
    const picker = await openPicker(g)
    await expect(picker.getByTestId('tag-picker-input')).toHaveAttribute(
      'placeholder',
      'Find or create a tag',
    )
    await picker.getByTestId('tag-picker-input').fill('fans')
    // a Create the room takes (W5-29 hid it while the room refused every guest doc write)
    await expect(picker.getByTestId('tag-create')).toHaveCount(1)
    await g.keyboard.press('Enter')
    await expect(picker.getByTestId('tag-picker-status')).toHaveText(/Created/)
    await expect(chips(a.page, N3)).toHaveText(['fans'], { timeout: 10_000 })
    await expect.poll(async () => Object.keys(await boardList(a.page)).sort()).toEqual(['fans', 'research'])
    await expect(g.getByText('Change not saved')).toHaveCount(0)
    // the board's own tag still goes on
    await picker.getByTestId('tag-picker-input').fill('Research')
    await g.keyboard.press('Enter')
    await expect(chips(a.page, N3)).toHaveText(['fans', 'Research'], { timeout: 10_000 })
    await expect(g.getByText('Change not saved')).toHaveCount(0)
  } finally {
    await guest.context.close()
  }
})

test('the look at 390 px, light and dark: the picker stays on screen clear of the toolbar, the panel and the filter bar fit', async ({
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
  await taggedNotes([a.page], { [N1]: [RESEARCH, BLOCKED], [N2]: five, [N3]: [IDEA] }, five)
  await a.page.setViewportSize({ width: 390, height: 844 })
  for (const scheme of ['light', 'dark'] as const) {
    await test.step(scheme, async () => {
      await a.page.emulateMedia({ colorScheme: scheme })
      await cameraAt(a.page, { x: 360, y: 200 }, 1)
      await selectIds(a.page, [N2])
      await openPicker(a.page)
      await expect.poll(() => insideViewport(a.page, '[data-testid="tag-picker"]', 4)).toBe(true)
      const picker = await a.page.getByTestId('tag-picker').boundingBox()
      const slot = a.page.locator('[data-lobby-slot="toolbar"] > *').first()
      const toolbar = (await slot.count()) > 0 ? await slot.boundingBox() : null
      if (!picker) throw new Error('no picker')
      if (toolbar) expect(picker.y + picker.height).toBeLessThanOrEqual(toolbar.y)
      await capture(`excalidraw-tags-picker-390-${scheme}.png`, a.page, test.info())
      await a.page.keyboard.press('Escape')
      await openTagsPanel(a.page)
      await row(a.page, 'research').getByTestId('tag-filter').click()
      await row(a.page, 'research').getByTestId('tag-edit').click()
      expect(await a.page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
        true,
      )
      await capture(`excalidraw-tags-panel-390-${scheme}.png`, a.page, test.info())
      await a.page.getByTestId('dock-panel-close').click() // close the dock (a sheet on a phone)
      await expect.poll(() => insideViewport(a.page, '[data-testid="tag-filter-bar"]', 4)).toBe(true)
      await capture(`excalidraw-tags-filter-390-${scheme}.png`, a.page, test.info())
      await a.page.getByTestId('tag-filter-clear').click()
    })
  }
})
