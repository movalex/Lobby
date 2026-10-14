// Keyboard traversal on the Excalidraw board page (docs/EXCALIDRAW-MIGRATION.md §4.8 (2); owner 3i): F6
// enters the canvas from anywhere, Alt+Arrow walks the board in reading order, Ctrl/Cmd+Shift+↓/↑ go inside
// a frame and back out, Enter edits the selected note through the lease; "Skip to canvas" enters the
// canvas the same way; the canvas the keyboard lands on is named after the board (A11Y2-09). The live
// region says each step. Replaces the traversal half of tldraw's own keyboard navigation (Tab with a
// selection), which the key allowlist gives back to the browser on the new canvas.
import {
  clickItem,
  expect,
  items,
  itemText,
  pushedOps,
  select,
  setViewport,
  test,
  typeText,
  viewport,
  waitForItem,
  waitForTextEditor,
  zoomToFit,
} from '../tests/support/canvas.ts'
import {
  announcer,
  boardHasFocus,
  focusCanvas,
  focusOf,
  frame,
  intoFrame,
  note,
  selected,
  textItem,
  waitForA11y,
  withCanvas,
} from './a11y-kit.ts'
import {
  commentOnElement,
  commentRow,
  followingSid,
  noteAt,
  openCommentsPanel,
  panAway,
  pressCommentTool,
  sessionId,
  threadPopover,
} from './comments-kit.ts'

test.use({ viewport: { width: 1440, height: 900 } })

/**
 * Every distinct camera position the board shows, frame by frame, for the next `ms` (as "x,y,zoom"): an
 * animated move shows many, an immediate one its start and where it lands.
 */
const cameraFrames = (page: import('@playwright/test').Page, ms = 700) =>
  withCanvas(
    page,
    (c, span) =>
      new Promise<string[]>((done) => {
        const seen: string[] = []
        const t0 = performance.now()
        const tick = () => {
          const v = c.viewport.get()
          const k = `${Math.round(v.x)},${Math.round(v.y)},${v.zoom.toFixed(3)}`
          if (seen[seen.length - 1] !== k) seen.push(k)
          if (performance.now() - t0 < span) requestAnimationFrame(tick)
          else done(seen)
        }
        tick()
      }),
    ms,
  )

/** A text "Agenda" on top, a frame "Retro" holding one note, and a loose note to its right. */
async function seed(page: import('@playwright/test').Page) {
  const agenda = await textItem(page, 0, -200, 'Agenda')
  const retro = await frame(page, 0, 0, 800, 500, 'Retro')
  const inner = await note(page, 100, 100, 'Keep me')
  await intoFrame(page, [inner], retro)
  const loose = await note(page, 1000, 100, 'Loose note')
  await zoomToFit(page)
  return { agenda, retro, inner, loose }
}

test('F6 from the top bar enters the board on the first item; Alt+Arrow walks the reading order, into a frame and out; the live region says each step', async ({
  canvasSession,
}, testInfo) => {
  const a = await canvasSession('alice')
  await waitForA11y(a.page)
  const { agenda, retro, inner, loose } = await seed(a.page)
  const say = announcer(a.page)

  await test.step('F6 from the Share button: the board has the keyboard and the first item is selected', async () => {
    await a.page.getByTestId('share-button').focus()
    await a.page.keyboard.press('F6')
    await expect.poll(() => boardHasFocus(a.page)).toBe(true)
    expect(await selected(a.page)).toEqual([agenda])
    await expect(say).toHaveText('Text: Agenda. 1 of 3')
  })

  await test.step('Alt+→ and Alt+↓ move on, Alt+← and Alt+↑ back, wrapping at both ends', async () => {
    await a.page.keyboard.press('Alt+ArrowRight')
    await expect.poll(() => selected(a.page)).toEqual([retro])
    await expect(say).toHaveText('Frame: Retro. 2 of 3')
    await a.page.keyboard.press('Alt+ArrowDown')
    await expect.poll(() => selected(a.page)).toEqual([loose])
    await expect(say).toHaveText('Sticky note: Loose note. 3 of 3')
    await a.page.keyboard.press('Alt+ArrowRight')
    await expect.poll(() => selected(a.page)).toEqual([agenda])
    await a.page.keyboard.press('Alt+ArrowLeft')
    await expect.poll(() => selected(a.page)).toEqual([loose])
    await a.page.keyboard.press('Alt+ArrowUp')
    await expect.poll(() => selected(a.page)).toEqual([retro])
    await a.page.screenshot({ path: testInfo.outputPath('traversal-frame-selected.png') })
  })

  await test.step('Ctrl/Cmd+Shift+↓ goes inside the frame, Alt+Arrow stays inside, Ctrl/Cmd+Shift+↑ comes out', async () => {
    await a.page.keyboard.press('ControlOrMeta+Shift+ArrowDown')
    await expect.poll(() => selected(a.page)).toEqual([inner])
    await expect(say).toHaveText('Sticky note: Keep me. 1 of 1 in Retro')
    await a.page.keyboard.press('Alt+ArrowRight')
    await expect.poll(() => selected(a.page)).toEqual([inner])
    await a.page.keyboard.press('ControlOrMeta+Shift+ArrowUp')
    await expect.poll(() => selected(a.page)).toEqual([retro])
    await expect(say).toHaveText('Frame: Retro. 2 of 3')
  })

  await test.step('Alt+R says the selection again', async () => {
    await expect(say).toHaveText('Frame: Retro. 2 of 3')
    const heard: string[] = []
    await a.page.exposeFunction('__heard', (t: string) => heard.push(t))
    await a.page.evaluate(() => {
      const region = document.querySelector('[data-testid="canvas-announcer"]') as HTMLElement
      new MutationObserver(() =>
        (window as unknown as { __heard(t: string): void }).__heard(region.textContent ?? ''),
      ).observe(region, { childList: true, characterData: true, subtree: true })
    })
    await a.page.keyboard.press('Alt+r')
    await expect.poll(() => heard.at(-1)).toBe('Frame: Retro. 2 of 3')
    expect(heard).toContain('')
  })

  await test.step('Enter on a note reached with the keyboard edits it through the lease, caret at the end', async () => {
    await a.page.keyboard.press('Alt+ArrowRight')
    await expect.poll(() => selected(a.page)).toEqual([loose])
    await a.page.keyboard.press('Enter')
    await waitForTextEditor(a.page, loose)
    await typeText(a.page, ' (kbd)')
    await a.page.keyboard.press('Escape')
    await expect.poll(() => itemText(a.page, loose)).toBe('Loose note (kbd)')
    await expect.poll(() => boardHasFocus(a.page)).toBe(true)
  })

  await test.step('an item off screen is brought into view', async () => {
    await setViewport(a.page, { x: 5000, y: 5000, zoom: 1 })
    await focusCanvas(a.page)
    await a.page.keyboard.press('Alt+ArrowRight')
    await expect.poll(() => selected(a.page)).toEqual([agenda])
    const inView = async () => {
      const v = await viewport(a.page)
      return v.x <= 0 && v.y <= -200 && v.x + v.width >= 60 && v.y + v.height >= -170
    }
    await expect.poll(inView).toBe(true)
  })
})

test('"Skip to canvas" enters the board like F6; the keyboard lands on a canvas named "<title> board" that says its keys, and keeps the name through a rename', async ({
  canvasSession,
}) => {
  const a = await canvasSession('alice')
  await waitForA11y(a.page)
  const first = await note(a.page, 0, 0, 'First idea')
  await note(a.page, 300, 0, 'Second idea')
  await zoomToFit(a.page)
  const title = ((await a.page.getByTestId('board-title').textContent()) ?? '').trim()

  // from the top of the page, the first Tab is the skip link
  await a.page.evaluate(() => {
    document.body.tabIndex = -1
    document.body.focus()
  })
  await a.page.keyboard.press('Tab')
  expect(await focusOf(a.page)).toBe('skip-to-canvas')
  await a.page.keyboard.press('Enter')
  await expect.poll(() => boardHasFocus(a.page)).toBe(true)
  expect(await selected(a.page)).toEqual([first])
  await expect(announcer(a.page)).toHaveText('Sticky note: First idea. 1 of 2')

  const named = () =>
    a.page.evaluate(() => {
      const el = document.activeElement as HTMLElement
      const hint = document.getElementById(el.getAttribute('aria-describedby') ?? '')
      return {
        name: el.getAttribute('aria-label'),
        role: el.getAttribute('role'),
        hint: hint?.textContent ?? '',
      }
    })
  const n = await named()
  expect(n.name).toBe(`${title} board`)
  expect(n.role).toBe('application')
  expect(n.hint).toContain('Alt with the arrow keys moves between items')
  await expect(a.page.getByRole('application', { name: `${title} board` })).toBeVisible()

  // a rename: the canvas follows the new title
  await a.page.getByTestId('board-title').click()
  const input = a.page.getByTestId('board-title-input')
  await input.fill('Sprint review')
  await input.press('Enter')
  await expect(a.page.getByRole('application', { name: 'Sprint review board' })).toBeAttached()

  // F6 from the dock's rail: back on the board, the selection kept and said again
  await a.page.getByTestId('dock-tab-contents').focus()
  await a.page.keyboard.press('F6')
  await expect.poll(() => boardHasFocus(a.page)).toBe(true)
  expect(await selected(a.page)).toEqual([first])
  await expect(announcer(a.page)).toHaveText('Sticky note: First idea. 1 of 2')
})

test('a viewer walks the board with the keyboard too (selection only, nothing is written)', async ({
  canvasSession,
}) => {
  const a = await canvasSession('alice')
  await waitForA11y(a.page)
  const one = await note(a.page, 0, 0, 'One')
  const two = await note(a.page, 300, 0, 'Two')
  const v = await canvasSession('carol', { role: 'viewer' })
  await waitForA11y(v.page)
  await expect.poll(async () => (await items(v.page)).length).toBeGreaterThanOrEqual(4)
  await zoomToFit(v.page)
  await v.page.getByTestId('share-button').focus()
  await v.page.keyboard.press('F6')
  await expect.poll(() => selected(v.page)).toEqual([one])
  await v.page.keyboard.press('Alt+ArrowRight')
  await expect.poll(() => selected(v.page)).toEqual([two])
  await expect(announcer(v.page)).toHaveText('Sticky note: Two. 2 of 2')
  expect(await pushedOps(v.page)).toEqual([])
})

test('F6 on an empty board gives the board the keyboard and says there is nothing on it', async ({
  canvasSession,
}) => {
  const a = await canvasSession('alice')
  await waitForA11y(a.page)
  await a.page.getByTestId('share-button').focus()
  await a.page.keyboard.press('F6')
  await expect.poll(() => boardHasFocus(a.page)).toBe(true)
  await expect(announcer(a.page)).toHaveText('Nothing on this board yet.')
  expect(await selected(a.page)).toEqual([])
})

test('collapsed (hidden) items are skipped by Alt+Arrow and left out of the live count and the Contents list', async ({
  canvasSession,
}) => {
  const a = await canvasSession('alice')
  await waitForA11y(a.page)
  const one = await note(a.page, 0, 0, 'One')
  const two = await note(a.page, 300, 0, 'Two')
  const three = await note(a.page, 600, 0, 'Three')
  await zoomToFit(a.page)
  // a mind-map collapse hides a branch through LobbyCanvas.hide (the render override and the guards)
  await withCanvas(a.page, (c, id) => void c.hide('a11y-spec', [id]), two)
  await select(a.page, [one])
  await expect(announcer(a.page)).toHaveText('Sticky note: One. 1 of 2')
  await focusCanvas(a.page)
  await a.page.keyboard.press('Alt+ArrowRight')
  await expect.poll(() => selected(a.page)).toEqual([three])
  await expect(announcer(a.page)).toHaveText('Sticky note: Three. 2 of 2')
  await a.page.getByTestId('dock-tab-contents').click()
  await expect
    .poll(() =>
      a.page
        .getByTestId('board-contents')
        .getByTestId('contents-item')
        .evaluateAll((els) => els.map((e) => e.textContent?.trim() ?? '')),
    )
    .toEqual(['Sticky note: One', 'Sticky note: Three'])
})

// ---- the early wave-5 review (docs/research/excalidraw/REVIEW-W5-EARLY.md) ------------------------------------

test('W5-45: the board shows a focus ring when the keyboard arrives (Tab, F6, Escape out of a note), and none after a click', async ({
  canvasSession,
}, testInfo) => {
  const a = await canvasSession('alice')
  await waitForA11y(a.page)
  const id = await note(a.page, 0, 0, 'Ring me')
  await zoomToFit(a.page)
  const ring = a.page.getByTestId('canvas-focus-ring')
  // opening the board puts the keyboard on it without a ring (no key was pressed)
  await expect.poll(() => boardHasFocus(a.page)).toBe(true)
  await expect(ring).toHaveCount(0)

  await test.step('Tab from the dock reaches the board: the ring is drawn on top of the drawing', async () => {
    await a.page.getByTestId('dock-add-note').focus()
    for (let i = 0; i < 6 && !(await boardHasFocus(a.page)); i++) await a.page.keyboard.press('Tab')
    await expect.poll(() => boardHasFocus(a.page)).toBe(true)
    await expect(ring).toBeVisible()
    // P-034: corner marks in the focus colour, not a ring around the whole canvas
    const look = await ring.evaluate((el) => {
      const cs = getComputedStyle(el)
      return { shadow: cs.boxShadow, marks: (cs.backgroundImage.match(/linear-gradient/g) ?? []).length }
    })
    expect(look).toEqual({ shadow: 'none', marks: 8 })
    // it covers the canvas region and lets every click through
    const [r, c] = await Promise.all([
      ring.boundingBox(),
      a.page.locator('[data-lobby-board-canvas]').boundingBox(),
    ])
    expect(r && c && Math.abs(r.width - c.width) < 2 && Math.abs(r.height - c.height) < 2).toBe(true)
    expect(await ring.evaluate((el) => getComputedStyle(el).pointerEvents)).toBe('none')
    await a.page.screenshot({ path: testInfo.outputPath('w5-45-focus-ring.png') })
  })

  await test.step('a click on the board takes the ring away; F6 from the top bar brings it back', async () => {
    const c = await a.page.locator('[data-lobby-board-canvas]').boundingBox()
    if (!c) throw new Error('no canvas')
    await a.page.mouse.click(c.x + c.width - 60, c.y + 60)
    await expect(ring).toHaveCount(0)
    await a.page.getByTestId('share-button').focus()
    await expect(ring).toHaveCount(0)
    await a.page.keyboard.press('F6')
    await expect.poll(() => boardHasFocus(a.page)).toBe(true)
    await expect(ring).toBeVisible()
  })

  await test.step('W5-59: the note editor is named after what it edits; Escape out of it shows the ring again', async () => {
    await select(a.page, [id])
    await a.page.keyboard.press('Enter')
    await waitForTextEditor(a.page, id)
    await expect(ring).toHaveCount(0)
    await expect(a.page.locator('textarea.excalidraw-wysiwyg')).toHaveAttribute(
      'aria-label',
      'Sticky note text',
    )
    await a.page.keyboard.press('Escape')
    await expect.poll(() => boardHasFocus(a.page)).toBe(true)
    await expect(ring).toBeVisible()
  })

  await test.step('K2-1: a pointer move takes the ring away, and Escape out of a note the pointer opened shows none', async () => {
    await a.page.mouse.move(300, 300)
    await a.page.mouse.move(320, 310)
    await expect(ring).toHaveCount(0)
    await clickItem(a.page, id)
    await a.page.keyboard.press('Enter')
    await waitForTextEditor(a.page, id)
    await a.page.keyboard.type('!')
    await a.page.keyboard.press('Escape')
    await expect.poll(() => boardHasFocus(a.page)).toBe(true)
    await a.page.waitForTimeout(150)
    await expect(ring).toHaveCount(0)
  })
})

test('W5-21: with reduced motion, Alt+Arrow and F6 bring an item into view in one jump, at the same zoom', async ({
  canvasSession,
}) => {
  const a = await canvasSession('alice')
  await a.page.emulateMedia({ reducedMotion: 'reduce' })
  await waitForA11y(a.page)
  const near = await note(a.page, 0, 0, 'Near')
  const far = await note(a.page, 6000, 3000, 'Far away')
  await setViewport(a.page, { x: -200, y: -200, zoom: 1 })
  await select(a.page, [near])
  await focusCanvas(a.page)
  // every camera position the board shows, frame by frame, for the next 700 ms
  const cameras = () => cameraFrames(a.page)
  const sampled = cameras()
  await a.page.keyboard.press('Alt+ArrowRight')
  const seen = await sampled
  expect(await selected(a.page)).toEqual([far])
  // the start and where it lands: no frames in between
  expect(seen.length, seen.join(' → ')).toBeLessThanOrEqual(2)
  expect(seen.at(-1)?.endsWith(',1.000')).toBe(true)
  const v = await viewport(a.page)
  expect(v.zoom).toBe(1)
  expect(6000 >= v.x && 6200 <= v.x + v.width).toBe(true)

  // F6 with nothing selected: the first item, brought into view the same way
  await withCanvas(a.page, (c) => c.select([]), null)
  await a.page.getByTestId('share-button').focus()
  const again = cameras()
  await a.page.keyboard.press('F6')
  const seen2 = await again
  expect(await selected(a.page)).toEqual([near])
  expect(seen2.length, seen2.join(' → ')).toBeLessThanOrEqual(2)
  expect((await viewport(a.page)).zoom).toBe(1)
})

test('W5-21: with reduced motion, following someone and jumping to a comment move the camera in one jump, not a glide', async ({
  canvasSession,
}) => {
  const a = await canvasSession('alice')
  const b = await canvasSession('bob', { role: 'editor' })
  await b.page.emulateMedia({ reducedMotion: 'reduce' })
  await waitForA11y(b.page)
  const far = await noteAt(a.page, 5000, 3000, 'Far away')
  await waitForItem(b.page, far)

  await test.step('bob follows alice: when she moves far, his camera lands without gliding', async () => {
    const aliceSid = await sessionId(a.page)
    await b.page.evaluate((sid) => {
      const c = (window as unknown as { __lobbyBoard: { canvas: { follow: { start(s: string): void } } } })
        .__lobbyBoard.canvas
      c.follow.start(sid)
    }, aliceSid)
    await expect.poll(() => followingSid(b.page)).toBe(aliceSid)
    const sampled = cameraFrames(b.page)
    await setViewport(a.page, { x: 4800, y: 2800, zoom: 1 })
    const seen = await sampled
    // his start, where he lands (and at most one re-fit of the same spot): never the dozens of frames of a glide
    expect(seen.length, seen.join(' → ')).toBeLessThanOrEqual(3)
    await expect.poll(async () => Math.round((await viewport(b.page)).x)).toBeGreaterThan(4000)
    await b.page.evaluate(() => {
      const c = (window as unknown as { __lobbyBoard: { canvas: { follow: { stop(): void } } } }).__lobbyBoard
        .canvas
      c.follow.stop()
    })
    await expect.poll(() => followingSid(b.page)).toBeNull()
  })

  await test.step('bob jumps to a comment from the comments panel: one jump to the thread, no glide', async () => {
    await setViewport(b.page, { x: 4800, y: 2800, zoom: 1 })
    await pressCommentTool(b.page)
    const threadId = await commentOnElement(b.page, far, 'Look here')
    await b.page.keyboard.press('Escape') // closes the thread
    await expect(threadPopover(b.page)).toHaveCount(0)
    await panAway(b.page)
    await openCommentsPanel(b.page)
    const row = commentRow(b.page, threadId)
    await expect(row).toBeVisible()
    const sampled = cameraFrames(b.page)
    await row.click()
    const seen = await sampled
    await expect(threadPopover(b.page, threadId)).toBeVisible()
    expect(seen.length, seen.join(' → ')).toBeLessThanOrEqual(3)
    const v = await viewport(b.page)
    expect(5000 >= v.x && 5200 <= v.x + v.width, 'the note is in view').toBe(true)
  })
})

test('W5-59: inside a frame a heading is read before the shorter line under it', async ({
  canvasSession,
}) => {
  const a = await canvasSession('alice')
  await waitForA11y(a.page)
  const retro = await frame(a.page, 0, 0, 900, 500, 'Retro')
  // a wide heading and, under it, a short subtitle: their centres are less than 100 px apart, and the
  // subtitle's centre is left of the heading's (tldraw's row rule read the subtitle first)
  const heading = await textItem(a.page, 40, 30, 'What went well this sprint', { fontSize: 40 })
  const subtitle = await textItem(a.page, 40, 90, 'Wins and habits')
  const card = await note(a.page, 40, 200, 'First win')
  await intoFrame(a.page, [heading, subtitle, card], retro)
  await zoomToFit(a.page)
  const [h, s] = await Promise.all([
    withCanvas(a.page, (c, id) => c.bounds(id), heading),
    withCanvas(a.page, (c, id) => c.bounds(id), subtitle),
  ])
  if (!h || !s) throw new Error('no bounds')
  expect(Math.abs(h.y + h.height / 2 - (s.y + s.height / 2))).toBeLessThan(100)
  expect(s.x + s.width / 2).toBeLessThan(h.x + h.width / 2)

  await select(a.page, [retro])
  await focusCanvas(a.page)
  await a.page.keyboard.press('ControlOrMeta+Shift+ArrowDown')
  expect(await selected(a.page)).toEqual([heading])
  await expect(announcer(a.page)).toHaveText('Text: What went well this sprint. 1 of 3 in Retro')
  await a.page.keyboard.press('Alt+ArrowRight')
  expect(await selected(a.page)).toEqual([subtitle])
  await a.page.keyboard.press('Alt+ArrowRight')
  expect(await selected(a.page)).toEqual([card])
})
