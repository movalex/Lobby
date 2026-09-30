// OWNER: 3h. Copies of a board on the new canvas (ported from e2e/tests/history.spec.ts, which keeps running
// on the default tldraw build): duplicate from the dashboard card menu, a Trash round trip, and the .json
// export from the History panel imported on the dashboard. The dashboard is engine-neutral; what these check
// on the new canvas is that every copy opens on the Excalidraw board page with the same frame, notes and
// bound connector, and that the export is an archive v2 of elements. Images and PDF cards are 3g's
// (files.insert) and are left out here; 2F's api-history spec covers the api half of the same routes.
//
//   E2E_PORT_BASE=<base> pnpm --filter @draftroom/e2e excalidraw history-copies
import { readFileSync } from 'node:fs'
import type { Page } from '@playwright/test'
import type { Api } from '../tests/support/api.ts'
import { type CanvasElement, expect, test, waitForCanvas } from '../tests/support/canvas.ts'
import { openHistory } from '../tests/support/history.ts'
import { boundEnds, describeServerBoard, describeTab, drawFrameBoard, serverElements } from './history-kit.ts'

const boardCard = (page: Page, boardId: string) =>
  page.locator(`[data-testid="board-card"][data-board-id="${boardId}"]`)

async function cardMenu(page: Page, boardId: string, action: string) {
  await boardCard(page, boardId).getByTestId('board-card-menu').click()
  await boardCard(page, boardId).locator(`[role="menuitem"][data-action="${action}"]`).click()
}

async function grants(api: Api, boardId: string) {
  const members = await api.members(boardId)
  return Object.fromEntries(members.filter((m) => m.source === 'grant').map((m) => [m.user.id, m.role]))
}

type Any = Record<string, unknown>
const bound = (e: Any) =>
  ((e.boundElements as { id: string; type: string }[] | null) ?? []) as { id: string; type: string }[]

/** What a person sees, without ids: kind, place, the frame it is in (by name) and its words. */
function describeWithoutIds(all: readonly CanvasElement[]): string[] {
  const byId = new Map(all.map((e) => [e.id, e as unknown as Any]))
  return all
    .map((e) => e as unknown as Any)
    .filter((e) => !e.isDeleted && !(e.type === 'text' && e.containerId))
    .map((e) => {
      const label = bound(e).find((b) => b.type === 'text')
      const text =
        e.type === 'frame'
          ? String(e.name ?? '')
          : label
            ? String(byId.get(label.id)?.originalText ?? '')
            : String(e.originalText ?? '')
      const frame = e.frameId ? String(byId.get(e.frameId as string)?.name ?? '?') : ''
      return `${e.type}|${Math.round(e.x as number)},${Math.round(e.y as number)}|${frame}|${text}`
    })
    .sort()
}

test('duplicate from the dashboard card menu: duplicate-dialog prefilled “<title> (copy)” makes a private copy with the same content', async ({
  canvasSession,
  board,
  users,
  stack,
}) => {
  const a = await canvasSession('alice')
  const ids = await drawFrameBoard(a.page, 'dd')
  const aliceApi = await users.api('alice')
  const title = await a.page.getByTestId('board-title').innerText()
  const source = await describeServerBoard(stack, board)

  await a.page.goto(`/w/${users.devStudioId}`)
  await a.page.getByTestId('nav-all').click()
  await cardMenu(a.page, board, 'duplicate')
  const dialog = a.page.getByTestId('duplicate-dialog')
  await expect(dialog).toBeVisible()
  await expect(dialog.getByTestId('duplicate-title')).toHaveValue(`${title} (copy)`)
  await expect(dialog.getByTestId('duplicate-keep-sharing')).not.toBeChecked()
  const created = a.page.waitForResponse(
    (r) => r.request().method() === 'POST' && r.url().endsWith(`/api/boards/${board}/duplicate`),
  )
  await dialog.getByTestId('duplicate-submit').click()
  const res = await created
  expect(res.status()).toBe(201)
  const copy = ((await res.json()) as { board: { id: string } }).board.id
  await expect(dialog).toHaveCount(0)
  await expect(a.page.getByTestId('dashboard-toast')).toContainText(`Duplicated as “${title} (copy)”`)
  await expect(boardCard(a.page, copy)).toHaveAttribute('data-role', 'owner')
  expect(await aliceApi.getBoard(copy)).toMatchObject({
    board: { title: `${title} (copy)`, visibility: 'private' },
    role: 'owner',
  })
  expect(await grants(aliceApi, copy)).toEqual({ [a.id]: 'owner' })

  await boardCard(a.page, copy).getByRole('link').first().click()
  await expect(a.page).toHaveURL(new RegExp(`/b/${copy}$`))
  await waitForCanvas(a.page)
  await expect(a.page.getByTestId('board-title')).toHaveText(`${title} (copy)`)
  await expect.poll(() => describeTab(a.page)).toEqual(source)
  expect(await boundEnds(a.page, ids.arrow)).toEqual([`end->${ids.box}`, `start->${ids.note1}`])
})

test('trash restore keeps content: a board trashed from the dashboard and restored from Trash opens with the same objects', async ({
  canvasSession,
  board,
  users,
  stack,
}) => {
  const a = await canvasSession('alice')
  const ids = await drawFrameBoard(a.page, 'tr')
  const aliceApi = await users.api('alice')
  const wid = users.devStudioId
  const before = await describeServerBoard(stack, board)

  await a.page.goto(`/w/${wid}`)
  await a.page.getByTestId('nav-all').click()
  await cardMenu(a.page, board, 'trash')
  await expect(boardCard(a.page, board)).toHaveCount(0)
  await expect
    .poll(async () => (await aliceApi.listBoards(wid, 'trashed')).some((x) => x.id === board))
    .toBe(true)
  expect((await aliceApi.fetch('GET', `/api/boards/${board}/export`)).status()).toBe(404)

  await a.page.goto(`/w/${wid}/trash`)
  await expect(a.page.getByTestId('trash-note')).toBeVisible()
  await expect(boardCard(a.page, board)).toHaveAttribute('data-status', 'trashed')
  await cardMenu(a.page, board, 'restore')
  await expect(boardCard(a.page, board)).toHaveCount(0)
  await expect.poll(async () => (await aliceApi.getBoard(board)).board.status).toBe('active')

  await a.page.goto(`/w/${wid}`)
  await a.page.getByTestId('nav-all').click()
  await boardCard(a.page, board).getByRole('link').first().click()
  await expect(a.page).toHaveURL(new RegExp(`/b/${board}$`))
  await waitForCanvas(a.page)
  await expect.poll(() => describeTab(a.page)).toEqual(before)
  expect(await boundEnds(a.page, ids.arrow)).toEqual([`end->${ids.box}`, `start->${ids.note1}`])
  expect(await describeServerBoard(stack, board)).toEqual(before)
})

test('export .json from History and import it on the dashboard: the same frame, notes and connector under fresh ids; broken files are refused without a new board', async ({
  canvasSession,
  board,
  users,
  stack,
}, testInfo) => {
  const a = await canvasSession('alice')
  const ids = await drawFrameBoard(a.page, 'ex')
  const aliceApi = await users.api('alice')
  const wid = users.devStudioId
  const title = await a.page.getByTestId('board-title').innerText()
  const source = await serverElements(stack, board)

  let file = ''
  await test.step('export-json downloads “<title>.lobby.json”, an archive v2 of elements', async () => {
    await openHistory(a.page)
    const download = a.page.waitForEvent('download')
    await a.page.getByTestId('export-json').click()
    const d = await download
    expect(d.suggestedFilename()).toBe(`${title}.lobby.json`)
    file = testInfo.outputPath(d.suggestedFilename())
    await d.saveAs(file)
    await expect(a.page.getByTestId('history-status')).toContainText('Board exported as a .json file')
    const archive = JSON.parse(readFileSync(file, 'utf8')) as {
      format: string
      version: number
      elements: { id: string; type: string; isDeleted?: boolean }[]
      assets: unknown[]
    }
    expect(archive).toMatchObject({ format: 'lobby-board', version: 2 })
    const live = archive.elements.filter((e) => !e.isDeleted)
    expect(live.map((e) => e.id).sort()).toEqual(source.map((e) => e.id).sort())
    expect(archive.assets).toEqual([])
  })

  let imported = ''
  await test.step('import-board-file on the dashboard makes a new private board', async () => {
    await a.page.goto(`/w/${wid}`)
    await a.page.getByTestId('nav-all').click()
    const response = a.page.waitForResponse(
      (r) => r.request().method() === 'POST' && r.url().includes(`/api/workspaces/${wid}/boards/import`),
    )
    await a.page.getByTestId('import-board-file').setInputFiles(file)
    const res = await response
    expect(res.status()).toBe(201)
    const body = (await res.json()) as { board: { id: string; title: string }; droppedFiles: number }
    imported = body.board.id
    expect(body.droppedFiles).toBe(0)
    expect(body.board.title).toBe(title)
    await expect(a.page.getByTestId('dashboard-toast')).toHaveText(`Imported “${body.board.title}”.`)
    await expect(boardCard(a.page, imported)).toHaveAttribute('data-role', 'owner')
    expect(await aliceApi.getBoard(imported)).toMatchObject({
      board: { visibility: 'private' },
      role: 'owner',
    })
    expect(await grants(aliceApi, imported)).toEqual({ [a.id]: 'owner' })
  })

  await test.step('the imported board reproduces the content under fresh ids, and opens on the canvas', async () => {
    const stored = await serverElements(stack, imported)
    expect(describeWithoutIds(stored)).toEqual(describeWithoutIds(source))
    const sourceIds = new Set(source.map((e) => e.id))
    expect(stored.filter((e) => sourceIds.has(e.id))).toEqual([])
    await boardCard(a.page, imported).getByRole('link').first().click()
    await expect(a.page).toHaveURL(new RegExp(`/b/${imported}$`))
    await waitForCanvas(a.page)
    const arrow = stored.find((e) => e.type === 'arrow')
    const box = stored.find((e) => e.type === 'rectangle')
    const note1 = stored.find((e) => {
      const l = bound(e as unknown as Any).find((b) => b.type === 'text')
      return (
        e.type === 'stickynote' &&
        (stored.find((x) => x.id === l?.id) as { originalText?: string } | undefined)?.originalText ===
          'Ship the moodboard'
      )
    })
    expect(note1?.frameId).toBe(stored.find((e) => e.type === 'frame')?.id)
    expect(await boundEnds(a.page, arrow?.id ?? '')).toEqual([`end->${box?.id}`, `start->${note1?.id}`])
    expect(ids.frame).not.toBe(stored.find((e) => e.type === 'frame')?.id)
  })

  await test.step('a corrupt .json and a foreign JSON are refused and make no board', async () => {
    await a.page.goto(`/w/${wid}`)
    await a.page.getByTestId('nav-all').click()
    const count = async () => (await aliceApi.listBoards(wid)).length
    const boardsBefore = await count()
    await a.page.getByTestId('import-board-file').setInputFiles({
      name: 'broken.lobby.json',
      mimeType: 'application/json',
      buffer: Buffer.from('{"format":"lobby-board","elements":['),
    })
    await expect(
      a.page.locator('.dr-notice').filter({ hasText: 'That file is not a Lobby board export (.json).' }),
    ).toBeVisible()
    const refused = a.page.waitForResponse((r) => r.url().includes(`/api/workspaces/${wid}/boards/import`))
    await a.page.getByTestId('import-board-file').setInputFiles({
      name: 'other-app.json',
      mimeType: 'application/json',
      buffer: Buffer.from(JSON.stringify({ format: 'tldraw-file', records: [] })),
    })
    expect((await refused).status()).toBe(400)
    await expect(
      a.page
        .locator('.dr-notice')
        .filter({ hasText: 'can’t be imported' })
        .or(a.page.locator('.dr-notice').filter({ hasText: "can't be imported" })),
    ).toBeVisible()
    expect(await count()).toBe(boardsBefore)
  })
})
