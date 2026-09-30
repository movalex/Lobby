// Wave 2F on the whole Excalidraw stack (real api, real sync on DRAFTROOM_ENGINE=excalidraw, the
// Excalidraw board page): the api's history features read and seed the new canvas through the sync
// internal routes. A note written on the canvas is in a v2 checkpoint (previewed as elements), survives
// duplicate, restore-as-new, and a v2 archive export/import (each copy opened on the canvas), its file
// reference follows it, and its deletion shows in "Recently deleted". The server writes to an OPEN board
// (restore, place-notes) wait for the room's CR 2F-2 and are not exercised here.
import type { Page } from '@playwright/test'
import {
  createNote,
  deleteItem,
  expect,
  expectSaved,
  items,
  openCanvasSession,
  test,
} from '../tests/support/canvas.ts'

/** The label text of every note on the page (the canvas holds elements; a note's text is its label). */
async function noteTexts(page: Page): Promise<string[]> {
  const all = (await items(page)) as unknown as Record<string, unknown>[]
  const notes = new Set(all.filter((e) => e.type === 'stickynote' && !e.isDeleted).map((e) => e.id))
  return all
    .filter((e) => e.type === 'text' && !e.isDeleted && notes.has(e.containerId as string))
    .map((e) => String(e.originalText))
    .sort()
}

test('history on the new canvas: checkpoint, duplicate, restore, export and import', async ({
  canvasSession,
  board,
  users,
  browser,
}) => {
  const alice = await canvasSession('alice')
  const api = await users.api('alice')
  const who = await users.get('alice')
  const id = await createNote(alice.page, { x: 100, y: 120, text: 'keep me' })
  await createNote(alice.page, { x: 400, y: 120, text: 'and me' })
  await expectSaved(alice.page)
  await expect.poll(() => noteTexts(alice.page)).toEqual(['and me', 'keep me'])

  // a manual checkpoint is a v2 body, previewed as elements
  const saved = await api.fetch('POST', `/api/boards/${board}/snapshots`, { name: 'Two notes' })
  expect(saved.status()).toBe(201)
  const checkpoint = (await saved.json()) as { id: string; recordCount: number }
  expect(checkpoint.recordCount).toBe(4) // two notes and their labels
  const preview = await api.fetch('GET', `/api/snapshots/${checkpoint.id}/content`)
  expect(preview.status()).toBe(200)
  const content = (await preview.json()) as {
    format?: string
    elements?: { id: string }[]
    records: unknown[]
  }
  expect(content.format).toBe('lobby-elements')
  expect(content.records).toEqual([])
  expect(content.elements?.map((e) => e.id)).toContain(id)

  const openCopy = async (boardId: string) => {
    const s = await openCanvasSession(browser, boardId, who)
    await expect.poll(() => noteTexts(s.page)).toEqual(['and me', 'keep me'])
    await s.context.close()
  }

  // duplicate: the live board, seeded as elements into a new board
  const dup = await api.fetch('POST', `/api/boards/${board}/duplicate`, {})
  expect(dup.status()).toBe(201)
  await openCopy(((await dup.json()) as { board: { id: string } }).board.id)

  // the board changes, then its checkpoint is restored as a new board with the old content
  await deleteItem(alice.page, id)
  await expectSaved(alice.page)
  const restored = await api.fetch('POST', `/api/snapshots/${checkpoint.id}/restore-as-new`, {})
  expect(restored.status()).toBe(201)
  await openCopy(((await restored.json()) as { board: { id: string } }).board.id)

  // the deleted note is listed in "Recently deleted" with its text
  const deleted = await api.fetch('GET', `/api/boards/${board}/deleted`)
  expect(deleted.status()).toBe(200)
  const list = (await deleted.json()) as { entries: { shapeId: string; type: string; label: string }[] }
  expect(list.entries).toContainEqual(
    expect.objectContaining({ shapeId: `shape:${id}`, type: 'note', label: 'keep me' }),
  )

  // a v2 archive of the checkpoint's copy round-trips through import
  const source = ((await restored.json()) as { board: { id: string } }).board.id
  const exported = await api.fetch('GET', `/api/boards/${source}/export`)
  expect(exported.status()).toBe(200)
  const archive = (await exported.json()) as { format: string; version: number; elements: unknown[] }
  expect(archive).toMatchObject({ format: 'lobby-board', version: 2 })
  const imported = await api.fetch(
    'POST',
    `/api/workspaces/${users.devStudioId}/boards/import?title=Imported`,
    archive,
  )
  expect(imported.status(), await imported.text()).toBe(201)
  await openCopy(((await imported.json()) as { board: { id: string } }).board.id)
})
