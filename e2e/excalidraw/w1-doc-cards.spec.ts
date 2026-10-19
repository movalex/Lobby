// OWNER: WS1 (wave W, doc cards; docs/WAVE-W-CONTRACTS.md §2). Doc cards on the Excalidraw board page, in a real
// browser against the real api (DRAFTROOM_DOC_CARDS=on: e2e/tests/support/stack.ts) and sync:
//  - the palette's Doc card: a card in one undo step, its panel open for typing under the lease (granted, never
//    Excalidraw's editor), the formatted face, every word on the server, one undo step for the edit session, the
//    lease given back on Done;
//  - two tabs: Bob sees "Alice is editing" and a read-only panel that takes no key; once she is done, Edit;
//  - Enter on a selected card opens the panel, Escape closes it and gives the board the keyboard back;
//  - Text → doc card in one undo step; ticking a box on the face writes the tick (one undo step);
//  - links: https and board paths only, opened with noopener; no HTML from the words;
//  - an export (SVG) never holds the face: the export layer draws the words with their marks taken out;
//  - a phone: a double-tap on the card opens the panel as a sheet, with no sideways scroll;
//  - nothing leaves Lobby's origins.
//
//   E2E_PORT_BASE=<base> pnpm exec playwright test excalidraw/w1-doc-cards.spec.ts --project=chromium --workers=1

import AxeBuilder from '@axe-core/playwright'
import { signInContext } from '../tests/support/api.ts'
import {
  createItem,
  dblclickItem,
  editingId,
  expect,
  expectSaved,
  item,
  leaseHolder,
  select,
  selection,
  TEXT_EDITOR,
  test,
  waitForCanvas,
} from '../tests/support/canvas.ts'
import { storedElement } from '../tests/support/excalidraw.ts'
import { downloadFrom } from '../tests/support/present-export.ts'
import { withCanvas } from './canvas-ux-kit.ts'
import { openBoardExport } from './present-kit.ts'
import {
  docCardsOn,
  expectEditing,
  expectNoInPlaceEditor,
  face,
  focusBoard,
  foreignRequestsOf,
  insertFromPalette,
  kindOf,
  labelIdOf,
  panel,
  panelStatus,
  panelText,
  placeDocCard,
  runPalette,
  typeInPanel,
  withDocCards,
  wordsOf,
} from './w1-kit.ts'

test.use({ viewport: { width: 1440, height: 900 } })

test('w1: the palette inserts a doc card; its panel types under the lease; the face formats; one undo step per edit session; Done gives the lease back', async ({
  canvasSession,
  stack,
  board,
}) => {
  const a = await withDocCards(await canvasSession('alice'))
  const foreign = foreignRequestsOf(a.page)
  const id = await insertFromPalette(a.page)
  expect(kindOf(await item(a.page, id))).toBe('doc-card')
  await expectEditing(a.page)
  await expect(panelText(a.page)).toBeFocused()
  // the new card's title is selected: typing replaces it
  await a.page.keyboard.type('Launch plan', { delay: 10 })
  // Enter continues the checklist (an unticked box)
  await typeInPanel(a.page, '- [ ] book the room\n**bold** words and a [link](https://example.com)')
  await expect(panelText(a.page)).toHaveValue(
    '# Launch plan\n\n- [ ] book the room\n- [ ] **bold** words and a [link](https://example.com)',
  )
  // the panel holds the lease: the board names this tab, no in-place editor ever opened
  await expect.poll(async () => (await leaseHolder(a.page, id))?.uid).toBe(a.id)
  await expectNoInPlaceEditor(a.page)
  await expectSaved(a.page)
  const words = await panelText(a.page).inputValue()
  await expect.poll(() => wordsOf(a.page, id)).toBe(words)
  const stored = await storedElement(stack, board, (await labelIdOf(a.page, id)) as string)
  expect(stored?.originalText).toBe(words)
  // the face: a heading, a checklist box, bold words, a safe link opened with no opener
  const f = face(a.page, id)
  await expect(f.locator('h2')).toHaveText('Launch plan')
  await expect(f.getByTestId('doc-card-check')).toHaveCount(2)
  await expect(f.locator('strong')).toHaveText('bold')
  const link = f.getByTestId('doc-card-link')
  await expect(link).toHaveAttribute('href', 'https://example.com/')
  await expect(link).toHaveAttribute('rel', 'noopener noreferrer')
  await expect(link).toHaveAttribute('target', '_blank')
  // Done: the panel closes, the lease goes back, the card is selected and the board has the keyboard
  await a.page.getByTestId('doc-editor-done').click()
  await expect(panel(a.page)).toHaveCount(0)
  await expect.poll(() => leaseHolder(a.page, id)).toBeNull()
  await expect.poll(() => selection(a.page)).toEqual([id])
  // one undo step for the whole edit session, then the insert
  await focusBoard(a.page)
  await a.page.keyboard.press('ControlOrMeta+z')
  await expect.poll(() => wordsOf(a.page, id)).toBe('# Untitled doc\n\n')
  await a.page.keyboard.press('ControlOrMeta+z')
  await expect.poll(async () => (await item(a.page, id))?.isDeleted ?? true).toBe(true)
  await a.page.keyboard.press('ControlOrMeta+Shift+z')
  await a.page.keyboard.press('ControlOrMeta+Shift+z')
  await expect.poll(() => wordsOf(a.page, id)).toBe(words)
  await expectSaved(a.page)
  expect(foreign).toEqual([])
})

test('w1: two tabs: Bob sees Alice is editing and a read-only panel that takes no key; when she is done he edits', async ({
  canvasSession,
  stack,
  board,
}) => {
  const a = await withDocCards(await canvasSession('alice'))
  const b = await withDocCards(await canvasSession('bob', { role: 'editor' }))
  const id = await insertFromPalette(a.page)
  await typeInPanel(a.page, 'Alice writes')
  await expectSaved(a.page)
  await expect.poll(() => wordsOf(b.page, id)).toContain('Alice writes')
  // Bob double-clicks the card: his panel opens read-only, naming Alice
  await dblclickItem(b.page, id)
  await expect(panel(b.page)).toBeVisible()
  await expect(panel(b.page)).toHaveAttribute('data-phase', 'denied')
  await expect(panelStatus(b.page)).toHaveText(`${a.name} is editing this doc card.`)
  await expect(panelText(b.page)).toHaveJSProperty('readOnly', true)
  await expectNoInPlaceEditor(b.page)
  const before = await panelText(b.page).inputValue()
  await panelText(b.page).focus()
  await b.page.keyboard.type('Bob tries', { delay: 10 })
  await b.page.keyboard.press('Backspace')
  await expect(panelText(b.page)).toHaveValue(before)
  // Bob's board shows Alice's words as she types them
  await typeInPanel(a.page, ' and more')
  await expect(panelText(b.page)).toHaveValue(/and more$/)
  // Alice is done: Bob's panel says nobody is editing and offers Edit
  await a.page.getByTestId('doc-editor-done').click()
  await expect(b.page.getByTestId('doc-editor-edit')).toBeEnabled()
  await b.page.getByTestId('doc-editor-edit').click()
  await expectEditing(b.page)
  await typeInPanel(b.page, '\nBob adds a line')
  await expectSaved(b.page)
  await expect.poll(() => wordsOf(a.page, id)).toMatch(/Bob adds a line$/)
  await expect(face(a.page, id)).toContainText('Bob adds a line')
  expect((await storedElement(stack, board, (await labelIdOf(a.page, id)) as string))?.originalText).toMatch(
    /Alice writes and more\nBob adds a line$/,
  )
  await b.page.getByTestId('doc-editor-done').click()
  await expect.poll(() => leaseHolder(a.page, id)).toBeNull()
})

test('w1: Enter on the selected card opens its panel; Escape closes it and the board has the keyboard back', async ({
  canvasSession,
}) => {
  const a = await withDocCards(await canvasSession('alice'))
  const id = await placeDocCard(a.page, '# Notes\n- one')
  await expectSaved(a.page)
  await select(a.page, [id])
  await focusBoard(a.page)
  await a.page.keyboard.press('Enter')
  await expectEditing(a.page)
  await expect(panelText(a.page)).toBeFocused()
  await expectNoInPlaceEditor(a.page)
  // Enter continues the list
  await a.page.keyboard.type('\ntwo', { delay: 10 })
  await a.page.keyboard.press('Escape')
  await expect(panel(a.page)).toHaveCount(0)
  await expect.poll(() => a.page.evaluate(() => !!document.activeElement?.closest('.excalidraw'))).toBe(true)
  await expect.poll(() => selection(a.page)).toEqual([id])
  await expect.poll(() => wordsOf(a.page, id)).toBe('# Notes\n- one\n- two')
  await expectSaved(a.page)
})

test('w1: Text to doc card in one undo step; ticking a box on the face writes the tick in one undo step', async ({
  canvasSession,
}) => {
  const a = await withDocCards(await canvasSession('alice'))
  const t = await createItem(a.page, 'text', { x: 100, y: 100, text: '# Todo\n- [ ] first' })
  await expectSaved(a.page)
  await select(a.page, [t])
  await runPalette(a.page, 'Turn text into doc card', 'doc-card.from-text')
  await expect.poll(async () => (await item(a.page, t))?.isDeleted).toBe(true)
  const [id] = await selection(a.page)
  expect(kindOf(await item(a.page, id as string))).toBe('doc-card')
  await expect.poll(() => wordsOf(a.page, id as string)).toBe('# Todo\n- [ ] first')
  await expectSaved(a.page)
  // the face's box: one tick, one step
  await face(a.page, id as string)
    .getByTestId('doc-card-check')
    .click()
  await expect.poll(() => wordsOf(a.page, id as string)).toBe('# Todo\n- [x] first')
  await expectSaved(a.page)
  await expect.poll(() => leaseHolder(a.page, id as string)).toBeNull()
  await focusBoard(a.page)
  await a.page.keyboard.press('ControlOrMeta+z')
  await expect.poll(() => wordsOf(a.page, id as string)).toBe('# Todo\n- [ ] first')
  // and one more brings the text back, the card gone
  await a.page.keyboard.press('ControlOrMeta+z')
  await expect.poll(async () => (await item(a.page, t))?.isDeleted).toBe(false)
  await expect.poll(async () => (await item(a.page, id as string))?.isDeleted ?? true).toBe(true)
  await expectSaved(a.page)
})

test('w1: words are never HTML and only safe links are links; an SVG export holds no face, only the words without their marks', async ({
  canvasSession,
}) => {
  const a = await withDocCards(await canvasSession('alice'))
  const foreign = foreignRequestsOf(a.page)
  const words =
    '# Title <img src=x onerror="window.__pwned=1">\n[bad](javascript:window.__pwned=2)\n[good](https://example.com)\n[board](/b/brd_x)\n**strong**'
  const id = await placeDocCard(a.page, words)
  await expectSaved(a.page)
  const f = face(a.page, id)
  await expect(f.locator('h2')).toContainText('<img src=x')
  await expect(f.locator('img')).toHaveCount(0)
  await expect(f.getByTestId('doc-card-link')).toHaveCount(2)
  await expect(f.getByTestId('doc-card-nolink')).toHaveText('bad')
  expect(await a.page.evaluate(() => (window as unknown as { __pwned?: number }).__pwned ?? null)).toBeNull()
  // the engine's own export draws the plain words (marks and all); the Export dialog's SVG adds the layer
  const raw = await withCanvas(a.page, (c, ids) => c.export.svg({ ids }), [id])
  expect(raw).not.toContain('lobby-doc')
  await openBoardExport(a.page)
  const dialog = a.page.getByTestId('export-dialog')
  await dialog.getByTestId('export-area-board').check()
  const svg = (await downloadFrom(a.page, () => dialog.getByTestId('export-svg').click())).bytes.toString(
    'utf8',
  )
  await a.page.keyboard.press('Escape')
  expect(svg).toContain('data-layer="doc-cards"')
  expect(svg).not.toContain('lobby-doc')
  expect(svg).not.toContain('doc-card-face')
  expect(svg).not.toContain('<foreignObject')
  const layer = svg.slice(svg.indexOf('data-layer="doc-cards"'))
  expect(layer).toContain('>Title &lt;img src=x onerror=&quot;window.__pwned=1&quot;&gt;<')
  expect(layer).not.toContain('**')
  expect(layer).not.toContain('](')
  expect(foreign).toEqual([])
})

test('w1: on a phone a double-tap on the card opens its panel as a sheet, with no sideways scroll', async ({
  browser,
  board,
  users,
}) => {
  const who = await users.grant(board, 'bob', 'editor')
  const context = await browser.newContext({
    viewport: { width: 375, height: 812 },
    isMobile: true,
    hasTouch: true,
    deviceScaleFactor: 2,
  })
  try {
    await docCardsOn(context)
    const page = await context.newPage()
    await signInContext(context, who.handle, who.name)
    await page.goto(`/b/${board}`)
    await waitForCanvas(page)
    const id = await placeDocCard(page, '# Phone\n- [ ] tap twice', { x: -200, y: -150 })
    await expectSaved(page)
    await withCanvas(page, (c, cid) => c.viewport.fit([cid]), id)
    const b = await withCanvas(page, (c, cid) => c.bounds(cid), id)
    const p = await withCanvas(
      page,
      (c, bb) => c.sceneToScreen({ x: (bb?.x ?? 0) + 40, y: (bb?.y ?? 0) + (bb?.height ?? 0) - 30 }),
      b,
    )
    await page.touchscreen.tap(p.x, p.y)
    await page.waitForTimeout(80)
    await page.touchscreen.tap(p.x, p.y)
    await expect(panel(page)).toBeVisible()
    await expectEditing(page)
    await expectNoInPlaceEditor(page)
    const sheet = await page.getByTestId('dock-panel-doc-card').boundingBox()
    expect(sheet?.width ?? 0).toBeGreaterThanOrEqual(360)
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
    await page.getByTestId('doc-editor-done').click()
    await expect(panel(page)).toHaveCount(0)
  } finally {
    await context.close()
  }
})

test('w1: the panel by keyboard and screen reader: format keys, the toolbar is one stop with arrow keys, Preview is headings and lists, axe finds nothing', async ({
  canvasSession,
}) => {
  const a = await withDocCards(await canvasSession('alice'))
  const id = await placeDocCard(a.page, '# Agenda\nfirst')
  await expectSaved(a.page)
  await select(a.page, [id])
  await focusBoard(a.page)
  await a.page.keyboard.press('Enter')
  await expectEditing(a.page)
  await expect(panelText(a.page)).toBeFocused()
  // Ctrl/Cmd+B with nothing selected: a placeholder to type over; Ctrl/Cmd+Shift+8 makes the line a bullet
  await a.page.keyboard.press('ControlOrMeta+b')
  await a.page.keyboard.type('Big', { delay: 10 })
  await a.page.keyboard.press('ControlOrMeta+Shift+Digit8')
  await expect(panelText(a.page)).toHaveValue('# Agenda\n- first**Big**')
  // Ctrl/Cmd+K is the link (its address selected to type over), not the command palette, inside the panel
  await a.page.keyboard.press('End')
  await a.page.keyboard.press('ControlOrMeta+k')
  // typed at once: the address is already selected
  await a.page.keyboard.type('https://a.example')
  await expect(a.page.getByTestId('command-palette')).toHaveCount(0)
  await expect(panelText(a.page)).toHaveValue('# Agenda\n- first**Big**[link text](https://a.example)')
  // the toolbar: one tab stop, the arrow keys move along it
  const tools = a.page.getByRole('toolbar', { name: 'Format' })
  await tools.getByRole('button', { name: 'Heading 1' }).focus()
  await a.page.keyboard.press('ArrowRight')
  await expect(tools.getByRole('button', { name: 'Heading 2' })).toBeFocused()
  await expect(tools.locator('button[tabindex="0"]')).toHaveCount(1)
  // Preview: real headings and lists for a screen reader
  await a.page.getByTestId('doc-editor-tab-preview').click()
  const preview = a.page.getByTestId('doc-editor-preview')
  await expect(preview.getByRole('heading', { name: 'Agenda' })).toBeVisible()
  await expect(preview.getByRole('list')).toHaveCount(1)
  await expect(preview.locator('strong')).toHaveText('Big')
  await expect(preview.getByRole('link', { name: 'link text' })).toHaveAttribute('href', 'https://a.example/')
  const results = await new AxeBuilder({ page: a.page })
    .include('[data-testid="dock-panel-doc-card"]')
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'])
    .analyze()
  expect(
    results.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`),
  ).toEqual([])
  await a.page.getByTestId('doc-editor-tab-write').click()
  await a.page.keyboard.press('Escape')
  await expect(panel(a.page)).toHaveCount(0)
  await expect.poll(() => wordsOf(a.page, id)).toBe('# Agenda\n- first**Big**[link text](https://a.example)')
  await expectSaved(a.page)
})

test('w1: a card at the 20,000-character cap: the panel stops at the cap, types, lays the words out on the card and the server stores every one', async ({
  canvasSession,
  stack,
  board,
}) => {
  test.setTimeout(180_000)
  const a = await withDocCards(await canvasSession('alice'))
  const line = '- [ ] a checklist line with **bold** words and a [link](https://example.com/x)\n'
  const words = `# Big doc\n${line.repeat(400)}`.slice(0, 20_000)
  const id = await placeDocCard(a.page, words)
  await expectSaved(a.page)
  await select(a.page, [id])
  await focusBoard(a.page)
  await a.page.keyboard.press('Enter')
  await expectEditing(a.page)
  await expect(a.page.getByTestId('doc-editor-count')).toHaveText(
    /^20,000 \/ 20,000 characters · search finds the first 4,000$/,
  )
  // how long the page's main thread is busy while someone types into a full card (the layout of every write)
  await a.page.evaluate(() => {
    const w = window as unknown as { __longTasks: number[] }
    w.__longTasks = []
    new PerformanceObserver((l) => {
      for (const e of l.getEntries()) w.__longTasks.push(e.duration)
    }).observe({ type: 'longtask', buffered: false })
  })
  const ta = panelText(a.page)
  await ta.press('ControlOrMeta+End')
  // at the cap: one more character is refused by the textarea itself
  await a.page.keyboard.type('X')
  await expect(ta).toHaveValue(words)
  for (let i = 0; i < 20; i++) await a.page.keyboard.press('Backspace')
  await a.page.keyboard.type('typed at the end', { delay: 30 })
  const typed = await ta.inputValue()
  expect(typed.length).toBe(20_000 - 20 + 'typed at the end'.length)
  await a.page.getByTestId('doc-editor-done').click()
  await expectSaved(a.page, 60_000)
  await expect.poll(() => wordsOf(a.page, id)).toBe(typed)
  const stored = await storedElement(stack, board, (await labelIdOf(a.page, id)) as string)
  expect(stored?.originalText).toBe(typed)
  // laid out on the card: the card grew to hold every wrapped line
  const card = await item(a.page, id)
  expect(card?.height ?? 0).toBeGreaterThan(5_000)
  expect((stored?.height as number) ?? 0).toBeLessThanOrEqual((card?.height as number) ?? 0)
  const long = await a.page.evaluate(() => (window as unknown as { __longTasks: number[] }).__longTasks)
  test.info().annotations.push({
    type: 'main-thread long tasks while typing into a 20,000-character card',
    description: `${long.length} tasks over 50 ms, longest ${Math.round(Math.max(0, ...long))} ms`,
  })
})

test('w1: with the switch off a doc card is a rectangle with its words: no face, no panel, edited in place under the lease', async ({
  canvasSession,
}) => {
  const a = await canvasSession('alice')
  const id = await placeDocCard(a.page, '# Plain\n- words')
  await expectSaved(a.page)
  await expect(face(a.page, id)).toHaveCount(0)
  await dblclickItem(a.page, id)
  await expect.poll(() => editingId(a.page)).toBe(id)
  await expect(a.page.locator(TEXT_EDITOR)).toBeFocused()
  await expect(panel(a.page)).toHaveCount(0)
  await a.page.keyboard.press('Escape')
  await expect.poll(() => editingId(a.page)).toBeNull()
  expect(await wordsOf(a.page, id)).toBe('# Plain\n- words')
})
