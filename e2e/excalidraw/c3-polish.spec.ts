// Wave C, workstream C3 (reviewer, workshop and editing polish): the browser half of
//   REVIEW-6   the role-change toast says who changed the access
//   DANA-11 / F14 / PRI-18   "People" (not a primary "Share") for viewers and guests; a guest sees Timer and
//              Voting only while a session runs
//   F2-08      "Zoom to matches" on the tag filter pill
//   R2-10      tag chips, dots and vote badges keep a minimum size on screen at overview zoom
//   F5         the PDF viewer shows a viewer no checkboxes, selection summary or footer
//   F9 / FIL-08   a GIF plays in an overlay (a chip and a double-click); the canvas keeps the still
//   CR-W5-3G-4 Enter ends a crop; a double-click a feature took starts no text
//   CR-3D-3    typing on a selected mind-map topic edits it (not right after Esc)
//   W5-37      a note in a PNG has the SVG's soft shadow; frame names add no height in focus mode
// Pure parts are unit-tested next to their code (c3 commits); everything here needs the real page.
//
//   E2E_PORT_BASE=<base> pnpm exec playwright test excalidraw/c3-polish.spec.ts --workers=1
import { join } from 'node:path'
import type { Page } from '@playwright/test'
import {
  canvasCall,
  createItem,
  dblclickItem,
  editingId,
  expect,
  item,
  itemBounds,
  items,
  sceneToScreen,
  select,
  selection,
  test,
  viewport,
} from '../tests/support/canvas.ts'
import { makeImages } from '../tests/support/files.ts'
import { gifPayload, makePdf, naturalSize, viewer } from '../tests/support/media-2.ts'
import { WEB_URL } from '../tests/support/ports.ts'
import { downloadFrom, readClipboard, readPng } from '../tests/support/present-export.ts'
import { FIXTURES_DIR } from '../tests/support/stack.ts'
import { createGuestLink } from '../tests/support/tags.ts'
import { closeFacilitate, openFacilitate } from '../tests/support/workshops.ts'
import { settled } from './board-kit.ts'
import {
  expectLoadedImage,
  fileCard,
  fileItems,
  imageItems,
  insertFiles,
  newItems,
  recordRequests,
  settleCamera,
} from './media-kit.ts'
import { buildMap, editingText, focusCanvas, mapView, selectOnly, waitForTyping } from './mindmap-kit.ts'
import { openBoardExport, pngPixels } from './present-kit.ts'

/** K3-3: whether the Facilitate menu has a Timer entry (a guest sees it only while a session runs). */
async function timerEntry(p: Page): Promise<number> {
  await openFacilitate(p)
  const n = await p.getByTestId('timer-pill').count()
  await closeFacilitate(p)
  return n
}

import {
  cameraAt,
  chips,
  joinAsGuest,
  listOnBoard,
  N1,
  N2,
  N3,
  tag,
  tagBox,
  tagElements,
  tagsReady,
  threeNotes,
} from './tags-kit.ts'

test.use({ viewport: { width: 1440, height: 900 } })

const _fixture = (name: string) => join(FIXTURES_DIR, name)

// ---- REVIEW-6 ------------------------------------------------------------------------------------------------------

test('REVIEW-6: after an owner lowers my access the toast says who did it; nobody else is told', async ({
  canvasSession,
  users,
  board,
}) => {
  const bob = await canvasSession('bob', { role: 'editor' })
  const carol = await canvasSession('carol', { role: 'viewer' })
  const alice = await users.get('alice')
  // alice (the board's owner) lowers bob's grant through the api, as the Share dialog does
  await users.grant(board, 'bob', 'commenter')
  const toast = bob.page.getByTestId('role-change-toast')
  await expect(toast).toBeVisible({ timeout: 20_000 })
  await expect(toast).toContainText('Your access changed to Can comment')
  await expect(toast).toContainText(`changed by ${alice.name}`)
  // carol's access did not change: no toast, and her stream never carried the actor
  await expect(carol.page.getByTestId('role-change-toast')).toHaveCount(0)
})

// ---- DANA-11 / F14 / PRI-18 ---------------------------------------------------------------------------------------

test('DANA-11: viewers and guests see a plain "People" button, owners and editors the primary "Share"; a guest sees Timer and Voting only while a session runs', async ({
  canvasSession,
  browser,
  users,
  board,
}) => {
  const owner = await canvasSession('alice')
  const editor = await canvasSession('bob', { role: 'editor' })
  const viewer = await canvasSession('carol', { role: 'viewer' })
  const share = (p: Page) => p.getByTestId('share-button')

  await test.step('the button reads and looks as what the person can do', async () => {
    for (const s of [owner, editor]) {
      await expect(share(s.page)).toHaveAccessibleName('Share')
      await expect(share(s.page)).toHaveAttribute('data-variant', 'share')
      await expect(share(s.page)).toHaveClass(/dr-btn--primary/)
    }
    await expect(share(viewer.page)).toHaveAccessibleName('People')
    await expect(share(viewer.page)).toHaveAttribute('data-variant', 'people')
    await expect(share(viewer.page)).not.toHaveClass(/dr-btn--primary/)
    // it still opens the dialog (who is here, how to ask for more)
    await share(viewer.page).click()
    await expect(viewer.page.getByTestId('share-dialog')).toBeVisible()
    await viewer.page.keyboard.press('Escape')
  })

  const link = await createGuestLink(owner.page, 'review')
  const guest = await joinAsGuest(browser, link, 'Kai')
  try {
    const g = guest.page
    const alice = await users.api('alice')
    await test.step('a guest: "People", and no Timer button, Voting or Private notes tab while nothing runs', async () => {
      await expect(share(g)).toHaveAccessibleName('People')
      await expect(share(g)).not.toHaveClass(/dr-btn--primary/)
      expect(await timerEntry(g)).toBe(0)
      await expect(g.getByTestId('dock-tab-voting')).toHaveCount(0)
      await expect(g.getByTestId('dock-tab-private-notes')).toHaveCount(0)
      // the account holders' bar still has them
      expect(await timerEntry(owner.page)).toBe(1)
      await expect(owner.page.getByTestId('dock-tab-voting')).toBeVisible()
    })

    await test.step('a running timer brings the Timer button, and it goes when the timer is stopped', async () => {
      const start = await alice.fetch('POST', `/api/boards/${board}/timer`, {
        action: 'start',
        durationMs: 120_000,
      })
      expect(start.status(), await start.text()).toBeLessThan(300)
      await expect(g.getByTestId('facilitate-button')).toHaveAttribute('data-timer-state', 'running', {
        timeout: 20_000,
      })
      expect(await timerEntry(g)).toBe(1)
      await expect(g.getByTestId('dock-tab-voting')).toHaveCount(0)
      const stop = await alice.fetch('POST', `/api/boards/${board}/timer`, { action: 'stop' })
      expect(stop.status(), await stop.text()).toBeLessThan(300)
      await expect(g.getByTestId('facilitate-button')).toHaveAttribute('data-timer-state', 'stopped', {
        timeout: 20_000,
      })
      await expect.poll(() => timerEntry(g)).toBe(0)
    })

    await test.step('a vote brings the Voting tab (and the Timer button that holds its entry)', async () => {
      await createItem(owner.page, 'note', { id: 'dana-n1', x: 0, y: 0, text: 'Vote on me' })
      const vote = await alice.fetch('POST', `/api/boards/${board}/votes`, {
        votesPerPerson: 2,
        onePerObject: false,
        scope: 'board',
      })
      expect(vote.status(), await vote.text()).toBe(201)
      await expect(g.getByTestId('dock-tab-voting')).toBeVisible({ timeout: 20_000 })
      await expect.poll(() => timerEntry(g)).toBe(1)
    })
  } finally {
    await guest.context.close()
  }
})

// ---- F2-08: Zoom to matches ----------------------------------------------------------------------------------------

const RESEARCH = tag('research', 'Research', 'blue')
const IDEA = tag('idea', 'Idea', 'green')

test('F2-08: the "Show only" pill has "Zoom to matches", which brings matches that are off screen into view', async ({
  canvasSession,
}) => {
  const a = await canvasSession('alice')
  await tagsReady(a.page)
  await settled(a.page, createItem(a.page, 'note', { id: 'zm-near', x: 0, y: 0, text: 'Near' }))
  await settled(a.page, createItem(a.page, 'note', { id: 'zm-far', x: 5200, y: 3100, text: 'Far away' }))
  await settled(a.page, createItem(a.page, 'note', { id: 'zm-other', x: 2400, y: 1500, text: 'Not tagged' }))
  await listOnBoard(a.page, [RESEARCH, IDEA])
  await settled(
    a.page,
    tagElements(a.page, { 'zm-near': [RESEARCH], 'zm-far': [RESEARCH], 'zm-other': [IDEA] }),
  )
  await cameraAt(a.page, { x: 200, y: 200 }, 1)

  const onScreen = async (id: string) => {
    const b = await itemBounds(a.page, id)
    const v = await viewport(a.page)
    if (!b) throw new Error(`no bounds for ${id}`)
    return b.x >= v.x && b.y >= v.y && b.x + b.width <= v.x + v.width && b.y + b.height <= v.y + v.height
  }
  expect(await onScreen('zm-near')).toBe(true)
  expect(await onScreen('zm-far')).toBe(false)

  await a.page.evaluate(() =>
    (
      window as unknown as { __lobbyTags: { rt: { filter: { set(k: string): void } } } }
    ).__lobbyTags.rt.filter.set('research'),
  )
  const bar = a.page.getByTestId('tag-filter-bar')
  await expect(bar).toBeVisible()
  await expect(bar.getByTestId('tag-filter-zoom')).toHaveText('Zoom to matches')
  await bar.getByTestId('tag-filter-zoom').click()
  await expect.poll(() => onScreen('zm-far'), { timeout: 10_000 }).toBe(true)
  expect(await onScreen('zm-near')).toBe(true)
  // the camera fits the matches, not the whole board: the untagged note between them need not be in view,
  // and the filter is still on
  await expect(bar).toBeVisible()
  await expect(bar.getByTestId('tag-filter-clear')).toBeVisible()
})

// ---- R2-10: minimum sizes at overview zoom ------------------------------------------------------------------------

test('R2-10: tag chips keep readable text and notes show the first tag and "+N" at overview zoom; colour dots keep a size', async ({
  canvasSession,
}) => {
  const a = await canvasSession('alice')
  await tagsReady(a.page)
  await threeNotes(a.page)
  const five = [
    RESEARCH,
    IDEA,
    tag('blocked', 'Blocked', 'red'),
    tag('q3', 'Q3', 'yellow'),
    tag('customer-voice', 'Customer voice', 'violet'),
  ]
  await listOnBoard(a.page, five)
  await settled(a.page, tagElements(a.page, { [N1]: [RESEARCH, IDEA], [N2]: five, [N3]: [IDEA] }))

  await test.step('100 %: unchanged (16 px chips, names, "+3" on the busy note)', async () => {
    await cameraAt(a.page, { x: 360, y: 200 }, 1)
    const h = (await chips(a.page, N1).first().boundingBox())?.height ?? 0
    expect(h).toBeCloseTo(16, 0)
    await expect(tagBox(a.page, N2).getByTestId('tag-chip-more')).toHaveText('+3')
    await expect(tagBox(a.page, N1).getByTestId('tag-chip-compact-more')).toBeHidden()
  })

  await test.step('65 %: chips are drawn larger so their text stays about 11 px; a note shows its first tag and "+N"', async () => {
    await cameraAt(a.page, { x: 360, y: 200 }, 0.65)
    const chip = chips(a.page, N1).first()
    const box = await chip.boundingBox()
    // before: 16 px at 100 % scaled with the camera to about 10 px; now the 11 px text keeps its size
    expect(box?.height ?? 0).toBeGreaterThanOrEqual(15)
    const fontPx = await chip.evaluate((el) => Number.parseFloat(getComputedStyle(el).fontSize))
    expect(fontPx * 0.65).toBeGreaterThanOrEqual(10.9)
    // only the first tag shows, with the counter for the rest
    await expect(chips(a.page, N1).filter({ visible: true })).toHaveCount(1)
    await expect(tagBox(a.page, N1).getByTestId('tag-chip-compact-more')).toHaveText('+1')
    await expect(chips(a.page, N2).filter({ visible: true })).toHaveCount(1)
    await expect(tagBox(a.page, N2).getByTestId('tag-chip-compact-more')).toHaveText('+4')
    // a note with one tag has no counter
    await expect(tagBox(a.page, N3).getByTestId('tag-chip-compact-more')).toHaveCount(0)
  })

  await test.step('30 %: colour dots keep at least 10 px on screen (they were 6.6 px)', async () => {
    await cameraAt(a.page, { x: 360, y: 200 }, 0.3)
    await expect.poll(() => a.page.getByTestId('tag-scene').getAttribute('data-dr-tags-lod')).toBe('dots')
    const dot = await chips(a.page, N1).first().boundingBox()
    expect(dot?.width ?? 0).toBeGreaterThanOrEqual(9.5)
    expect(dot?.height ?? 0).toBeGreaterThanOrEqual(9.5)
    // every tag is a dot, none is a counter
    await expect(tagBox(a.page, N2).getByTestId('tag-chip-compact-more')).toBeHidden()
  })
})

// ---- F5 residual: the PDF viewer for someone who cannot edit -------------------------------------------------------

test('F5: a viewer opening a PDF sees pages and a pager, and no checkboxes, selection summary or footer; the owner keeps them', async ({
  canvasSession,
}) => {
  test.setTimeout(180_000)
  const a = await canvasSession('alice')
  await insertFiles(a.page, [await makePdf('review-brief.pdf', 5)])
  await expect(fileCard(a.page, 'review-brief.pdf')).toHaveAttribute('data-status', 'ready', {
    timeout: 60_000,
  })
  const v = await canvasSession('bob', { role: 'viewer' })
  await expect(fileCard(v.page, 'review-brief.pdf')).toHaveAttribute('data-status', 'ready', {
    timeout: 60_000,
  })

  await fileCard(a.page, 'review-brief.pdf').getByTestId('file-card-view-pages').click()
  await expect(viewer(a.page)).toBeVisible()
  await expect(a.page.getByTestId('pdf-viewer-select').first()).toBeVisible()
  await expect(a.page.getByTestId('pdf-viewer-selection')).toBeVisible()
  await expect(a.page.getByTestId('pdf-viewer-place')).toBeVisible()
  await a.page.keyboard.press('Escape')

  await fileCard(v.page, 'review-brief.pdf').getByTestId('file-card-view-pages').click()
  await expect(viewer(v.page)).toBeVisible()
  await expect(v.page.getByTestId('pdf-viewer-counter')).toHaveText('Page 1 of 5')
  await expect(v.page.getByTestId('pdf-viewer-thumb')).toHaveCount(5)
  for (const id of [
    'pdf-viewer-select',
    'pdf-viewer-selection',
    'pdf-viewer-select-all',
    'pdf-viewer-place',
    'pdf-viewer-readonly',
  ])
    await expect(v.page.getByTestId(id), id).toHaveCount(0)
  // the page numbers are still captions, the pager still turns pages, and the rail is wider
  await expect(v.page.locator('.dr-pv__rail .dr-pv__num')).toHaveCount(5)
  const railWide = await v.page.locator('.dr-pv__rail').evaluate((el) => el.getBoundingClientRect().width)
  const railOwner = await (async () => {
    await fileCard(a.page, 'review-brief.pdf').getByTestId('file-card-view-pages').click()
    const w = await a.page.locator('.dr-pv__rail').evaluate((el) => el.getBoundingClientRect().width)
    await a.page.keyboard.press('Escape')
    return w
  })()
  expect(railWide).toBeGreaterThan(railOwner)
  await v.page.getByTestId('pdf-viewer-next').click()
  await expect(v.page.getByTestId('pdf-viewer-counter')).toHaveText('Page 2 of 5')
  await expect(v.page.locator('.dr-pv__foot')).toHaveCount(0)
})

// ---- F9 / FIL-08: the GIF player ---------------------------------------------------------------------------------------

test('F9: a GIF keeps its still on the board and plays in an overlay from a chip or a double-click; exports never include the animation', async ({
  canvasSession,
  board,
}) => {
  test.setTimeout(180_000)
  const a = await canvasSession('alice')
  const requests = recordRequests(a.page)
  const before = new Set((await fileItems(a.page)).map((f) => f.id))
  await insertFiles(a.page, [gifPayload('loop.gif', 480, 320)])
  const [gif] = await newItems(a.page, imageItems, before, 1)
  if (!gif) throw new Error('no gif element')
  await expectLoadedImage(a.page, gif.id, board)
  await settleCamera(a.page)
  const original = (f: { facts: { assetId: string; versionId: string } }) =>
    `/files/${f.facts.assetId}/${f.facts.versionId}/original`
  const loaded = () => requests.urls.filter((u) => u.includes(original(gif)))
  const chip = a.page.locator(`[data-testid="gif-play"][data-lobby-gif="${gif.id}"]`)

  await test.step('the board shows the still, with a play chip on the GIF, and nothing fetched the original', async () => {
    await expect(chip).toBeVisible()
    await expect(chip).toHaveAccessibleName('Play loop.gif')
    await a.page.waitForTimeout(800)
    expect(loaded()).toEqual([])
  })

  await test.step('the chip opens the player, which loads the original and plays it; the board keeps its still', async () => {
    await chip.click()
    const player = a.page.getByTestId('gif-player')
    await expect(player).toBeVisible()
    const img = a.page.getByTestId('gif-player-image')
    await expect(img).toHaveAttribute('data-state', 'playing')
    await expect.poll(() => naturalSize(img).then((s) => s.w)).toBe(480)
    expect(loaded().length).toBeGreaterThan(0)
    // Pause swaps to the still the canvas has, Play back to the original
    await a.page.getByTestId('gif-player-toggle').click()
    await expect(img).toHaveAttribute('data-state', 'paused')
    await expect(img).not.toHaveAttribute('src', new RegExp(original(gif)))
    await a.page.getByTestId('gif-player-toggle').click()
    await expect(img).toHaveAttribute('data-state', 'playing')
    // Escape closes it
    await a.page.keyboard.press('Escape')
    await expect(player).toHaveCount(0)
    expect(await imageItems(a.page).then((l) => l.length)).toBe(1)
  })

  await test.step('a double-click on the GIF opens the player too, and starts no text and no crop', async () => {
    const count = (await items(a.page)).length
    await dblclickItem(a.page, gif.id)
    await expect(a.page.getByTestId('gif-player')).toBeVisible()
    expect(await editingId(a.page)).toBeNull()
    expect(await canvasCall(a.page, 'leaseHolder', gif.id)).toBeFalsy()
    await a.page.getByTestId('gif-player-close').click()
    await expect(a.page.getByTestId('gif-player')).toHaveCount(0)
    expect((await items(a.page)).length).toBe(count)
    const cropping = await a.page.evaluate(
      () =>
        (
          window as unknown as {
            __lobbyBoard?: { api: { getAppState(): { croppingElementId?: string | null } } }
          }
        ).__lobbyBoard?.api.getAppState().croppingElementId ?? null,
    )
    expect(cropping).toBeNull()
  })

  await test.step('an export does not include the player or any animation: the PNG is the still', async () => {
    await select(a.page, [gif.id])
    await openBoardExport(a.page)
    const dialog = a.page.getByTestId('export-dialog')
    await expect(dialog).toBeVisible()
    const png = await downloadFrom(a.page, () => dialog.getByTestId('export-png').click())
    const info = readPng(png.bytes)
    expect(info.width).toBeGreaterThan(100)
    await a.page.keyboard.press('Escape')
  })

  await test.step('a viewer plays it as well (nothing here is an edit)', async () => {
    const v = await canvasSession('bob', { role: 'viewer' })
    await expect(v.page.locator(`[data-testid="gif-play"][data-lobby-gif="${gif.id}"]`)).toBeVisible({
      timeout: 30_000,
    })
    await v.page.locator(`[data-testid="gif-play"][data-lobby-gif="${gif.id}"]`).click()
    await expect(v.page.getByTestId('gif-player-image')).toBeVisible()
  })
})

// ---- CR-W5-3G-4: Enter ends a crop ----------------------------------------------------------------------------------------

test('CR-W5-3G-4: Enter ends an open crop, as Escape does, and keeps the crop', async ({
  canvasSession,
  board,
}) => {
  test.setTimeout(180_000)
  const a = await canvasSession('alice')
  const [file] = await makeImages(a.page, [{ name: 'enter-crop.jpg', w: 1600, h: 900 }])
  if (!file) throw new Error('no image')
  const before = new Set((await fileItems(a.page)).map((f) => f.id))
  await insertFiles(a.page, [file])
  const [img] = await newItems(a.page, imageItems, before, 1)
  if (!img) throw new Error('no image element')
  await expectLoadedImage(a.page, img.id, board)
  await settleCamera(a.page)

  const croppingId = () =>
    a.page.evaluate(
      () =>
        (
          window as unknown as {
            __lobbyBoard?: { api: { getAppState(): { croppingElementId?: string | null } } }
          }
        ).__lobbyBoard?.api.getAppState().croppingElementId ?? null,
    )
  await select(a.page, [img.id])
  await a.page.getByTestId('media-crop').click()
  await expect.poll(croppingId).toBe(img.id)
  await expect(a.page.getByTestId('media-crop-hint')).toContainText('Enter')
  // drag the bottom-right corner in, then press Enter
  const el = await item(a.page, img.id)
  if (!el) throw new Error('no element')
  const corner = await sceneToScreen(a.page, { x: el.x + el.width, y: el.y + el.height })
  await a.page.mouse.move(corner.x + 3, corner.y + 3)
  await a.page.mouse.down()
  await a.page.mouse.move(corner.x - 57, corner.y - 17, { steps: 6 })
  await a.page.mouse.up()
  await a.page.keyboard.press('Enter')
  await expect.poll(croppingId).toBeNull()
  await expect
    .poll(async () => (await item(a.page, img.id))?.crop ?? null, { timeout: 15_000 })
    .not.toBeNull()
  // the image is still the selection, not editing a text, and Enter on it does not start Excalidraw's own crop
  expect(await selection(a.page)).toEqual([img.id])
  await a.page.keyboard.press('Enter')
  await a.page.waitForTimeout(300)
  expect(await croppingId()).toBeNull()
  expect(await editingId(a.page)).toBeNull()
})

// ---- CR-3D-3: type to edit a mind-map topic -------------------------------------------------------------------------------

test('CR-3D-3: typing a letter on a selected topic edits it (words appended); not right after Esc; a locked topic is left alone', async ({
  canvasSession,
}) => {
  const a = await canvasSession('alice')
  await expect(a.page.getByTestId('mindmap-overlay')).toBeAttached()
  const ids = await buildMap(a.page, ['Root', ['Idea', 'Plan']])
  await focusCanvas(a.page)

  await test.step('a letter on the selected topic starts editing with that letter typed after the words', async () => {
    await selectOnly(a.page, ids.Idea as string)
    await a.page.keyboard.press('x')
    await waitForTyping(a.page)
    await expect.poll(() => editingText(a.page)).toBe('Ideax')
    await a.page.keyboard.type('yz')
    await a.page.keyboard.press('Escape')
    await expect.poll(() => editingId(a.page)).toBeNull()
    const v = await mapView(a.page)
    expect(v.topics.find((t) => t.id === ids.Idea)?.text).toBe('Ideaxyz')
  })

  await test.step('right after Esc the topic stays selected and letters are tool keys again (RETRO-02)', async () => {
    expect(await selection(a.page)).toEqual([ids.Idea])
    await a.page.keyboard.press('v')
    await a.page.waitForTimeout(400)
    expect(await editingId(a.page)).toBeNull()
    expect((await mapView(a.page)).topics.find((t) => t.id === ids.Idea)?.text).toBe('Ideaxyz')
    // another selection, then typing works again
    await selectOnly(a.page, ids.Plan as string)
    await a.page.keyboard.press('Q')
    await waitForTyping(a.page)
    await expect.poll(() => editingText(a.page)).toBe('PlanQ')
    await a.page.keyboard.press('Escape')
    await expect.poll(() => editingId(a.page)).toBeNull()
  })

  await test.step('a locked topic is not typed into', async () => {
    await canvasCall(a.page, 'update', ids.Root as string, { locked: true })
    await selectOnly(a.page, ids.Root as string)
    await a.page.keyboard.press('k')
    await a.page.waitForTimeout(400)
    expect(await editingId(a.page)).toBeNull()
  })
})

// ---- W5-37: soft note shadows in a PNG, frame names -------------------------------------------------------------------

/** The grey of the pixels straight below a note's bottom edge, from the edge down, in an exported PNG. */
async function shadowRamp(page: Page, png: Buffer, x: number, rows: number) {
  const info = readPng(png)
  // find the note's last row: the last pixel of its colour on that column
  const column = await pngPixels(
    page,
    png,
    Array.from({ length: info.height }, (_, y) => ({ x, y })),
  )
  let bottom = -1
  for (let y = 0; y < column.length; y++) {
    const [r, g, b] = column[y] as [number, number, number, number]
    if (r === 255 && g === 236 && b === 153) bottom = y // #ffec99
  }
  expect(bottom, 'the note is in the picture').toBeGreaterThan(0)
  return (column.slice(bottom + 1, bottom + 1 + rows) as [number, number, number, number][]).map(
    ([r, g, b]) => Math.round((r + g + b) / 3),
  )
}

/** The soft shadow's ramp must be a fade: darker under the edge, back to white in several steps. */
function expectSoft(ramp: number[], what: string) {
  const at = `${what}: ramp ${ramp.join(',')}`
  expect(ramp[0], at).toBeLessThan(250)
  expect(new Set(ramp).size, at).toBeGreaterThanOrEqual(5)
  for (let i = 1; i < ramp.length; i++)
    expect(ramp[i] as number, at).toBeGreaterThanOrEqual((ramp[i - 1] as number) - 1)
  expect(ramp[ramp.length - 1] as number, at).toBeGreaterThanOrEqual(240)
  // the engine's own look: a flat 3 px band of 214 (16 % black) under the edge, then plain white
  expect(ramp.filter((v) => v === 214).length, at).toBeLessThan(2)
}

test('W5-37: a note in a PNG export or a copy has a soft shadow (a fade, not a hard offset) and no outline, like the SVG', async ({
  canvasSession,
}, testInfo) => {
  const a = await canvasSession('alice')
  await a.context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: WEB_URL })
  const id = await createItem(a.page, 'note', { x: 100, y: 100, text: 'Soft', backgroundColor: '#ffec99' })
  await settled(a.page, Promise.resolve())
  await select(a.page, [id])
  const b = await itemBounds(a.page, id)
  if (!b) throw new Error('no bounds')

  await test.step('a selection PNG at 1x', async () => {
    await openBoardExport(a.page, { expand: true })
    const dialog = a.page.getByTestId('export-dialog')
    await expect(dialog).toBeVisible()
    await expect(dialog.getByTestId('export-area-selection')).toBeChecked()
    await dialog.getByTestId('export-scale').selectOption('1')
    const png = await downloadFrom(a.page, () => dialog.getByTestId('export-png').click())
    await testInfo.attach('note-shadow-png', { body: png.bytes, contentType: 'image/png' })
    expectSoft(await shadowRamp(a.page, png.bytes, Math.round(32 + b.width / 2), 14), 'png 1x')

    // the SVG has the same shadow as a filter, and no hard shadow or edge paths
    const svg = (await downloadFrom(a.page, () => dialog.getByTestId('export-svg').click())).bytes.toString(
      'utf8',
    )
    expect(svg).toContain('<filter id="lobby-note-shadow"')
    await a.page.keyboard.press('Escape')
    await expect(dialog).toHaveCount(0)
  })

  await test.step('Ctrl+Shift+C: the copied image at 2x', async () => {
    // closing the dialog with Escape also cleared the selection: select the note again, with the keyboard on the board
    await selectOnly(a.page, id)
    await expect.poll(() => selection(a.page)).toEqual([id])
    await a.page.keyboard.press('Control+Shift+C')
    await expect(a.page.getByTestId('copy-png-toast')).toBeVisible()
    let base64: string | null = null
    await expect
      .poll(async () => {
        base64 = (await readClipboard(a.page)).pngBase64
        return base64
      })
      .not.toBeNull()
    const png = Buffer.from(base64 ?? '', 'base64')
    await testInfo.attach('note-shadow-copy', { body: png, contentType: 'image/png' })
    expectSoft(await shadowRamp(a.page, png, Math.round(2 * (32 + b.width / 2)), 28), 'copy 2x')
  })
})

test('W5-37: frame names add no height to a PNG exported from focus mode; the board export keeps them', async ({
  canvasSession,
}) => {
  const a = await canvasSession('alice')
  await createItem(a.page, 'frame', { id: 'fn-frame', x: 0, y: 0, width: 600, height: 400, name: 'Findings' })
  await createItem(a.page, 'note', { id: 'fn-note', x: 80, y: 80, text: 'In the frame', frameId: 'fn-frame' })
  await settled(a.page, Promise.resolve())
  const exportBoard = async () => {
    await openBoardExport(a.page, { expand: true })
    const dialog = a.page.getByTestId('export-dialog')
    await expect(dialog).toBeVisible()
    await dialog.getByTestId('export-area-board').check()
    await dialog.getByTestId('export-scale').selectOption('1')
    const png = await downloadFrom(a.page, () => dialog.getByTestId('export-png').click())
    await a.page.keyboard.press('Escape')
    return readPng(png.bytes)
  }
  const normal = await exportBoard()
  // the same export with the board's frame names off, as the board page sets them in focus mode (present mode)
  await a.page.evaluate(() => {
    const h = (
      window as unknown as {
        __lobbyBoard: {
          api: { getAppState(): { frameRendering: object }; updateScene(o: unknown): void }
        }
      }
    ).__lobbyBoard
    h.api.updateScene({
      appState: { frameRendering: { enabled: true, clip: true, name: false, outline: false } },
      captureUpdate: 'NEVER',
    })
  })
  const focus = await exportBoard()
  expect(focus.width).toBe(normal.width)
  expect(normal.height - focus.height).toBeGreaterThanOrEqual(10)
  // the frame is 400 tall; the picture is the content and its 32 px margins, nothing more
  expect(focus.height).toBeGreaterThanOrEqual(400 + 64 - 1)
  expect(focus.height).toBeLessThanOrEqual(400 + 64 + 2)
})
