// The onDuplicate rules on the Excalidraw board page (docs/EXCALIDRAW-MIGRATION.md §3.3 "On duplicate /
// paste", canvas-schema custom-data.ts DuplicateRule; owner 3a's "onDuplicate specs", §7.2): whatever makes
// a copy (Ctrl+D, the context menu's Duplicate, an Alt-drag, a paste), the copy keeps its words, its tags and
// its alt text, drops the +1s and the AI mark (identity-bound and create-only keys belong to the original),
// drops a frame's place in the presentation (keeping "skip"), and a copied note never shows a creation date.
// Each copy is checked on bob's tab, so it is what the server stored: a copy that kept someone else's +1
// would have been refused there.
import type { Page } from '@playwright/test'
import {
  clickItem,
  createItem,
  expect,
  expectSaved,
  item,
  items,
  itemText,
  select,
  test,
  updateItem,
  waitForItem,
} from '../tests/support/canvas.ts'
import { settled } from './board-kit.ts'
import { waitForCanvasUx, withCanvas } from './canvas-ux-kit.ts'

test.use({ viewport: { width: 1440, height: 900 } })

type Lobby = Record<string, unknown>
const lobbyOf = async (page: Page, id: string): Promise<Lobby> =>
  ((await item(page, id))?.customData?.lobby as Lobby | undefined) ?? {}

/** The element ids of this type that are not in `known`. */
const newOnes = async (page: Page, type: string, known: readonly string[]) =>
  (await items(page)).filter((e) => e.type === type && !known.includes(e.id)).map((e) => e.id)

async function seed(a: Page, b: Page, aliceId: string, bobId: string) {
  // a tag needs its definition in the board document (canvas-schema doc.ts `tagDef:*`)
  await withCanvas(a, (c) => c.doc.set({ 'tagDef:urgent': { name: 'Urgent', color: 'red' } }), null)
  const note = await settled(
    a,
    createItem(a, 'note', {
      x: 100,
      y: 100,
      text: 'Original',
      customData: {
        lobby: {
          'tag:urgent': { name: 'Urgent', color: 'red' },
          ai: { by: aliceId },
          alt: 'A yellow note',
        },
      },
    }),
  )
  await waitForItem(b, note)
  // bob +1s it (an identity-bound key: only his own)
  await updateItem(b, note, { customData: { lobby: { [`plusOne:${bobId}`]: true } } })
  await expect.poll(async () => (await lobbyOf(a, note))[`plusOne:${bobId}`]).toBe(true)
  const frame = await settled(
    a,
    createItem(a, 'frame', {
      x: 600,
      y: 100,
      width: 300,
      height: 200,
      name: 'Act 1',
      customData: { lobby: { present: { index: 2, skip: true } } },
    }),
  )
  await waitForItem(b, frame)
  await expectSaved(b)
  return { note, frame }
}

/** What a copy of the seeded note and frame must hold (checked on both tabs). */
async function expectCopies(pages: Page[], noteCopy: string, frameCopy: string | null, bobId: string) {
  for (const p of pages) {
    await waitForItem(p, noteCopy)
    await expect.poll(() => itemText(p, noteCopy)).toBe('Original')
    const lobby = await lobbyOf(p, noteCopy)
    expect(lobby['tag:urgent']).toEqual({ name: 'Urgent', color: 'red' })
    expect(lobby.alt).toBe('A yellow note')
    expect(lobby[`plusOne:${bobId}`]).toBeUndefined()
    expect(lobby.ai).toBeUndefined()
    expect((await item(p, noteCopy))?.created ?? null, 'no creation date on a copied note').toBeNull()
    if (frameCopy) {
      await waitForItem(p, frameCopy)
      expect((await lobbyOf(p, frameCopy)).present).toEqual({ skip: true })
    }
  }
}

test('onDuplicate: Ctrl+D copies a note and a frame by the rules (tags and alt kept, +1s and the AI mark dropped, the presentation place dropped, no date), as the server stores them', async ({
  canvasSession,
}) => {
  const a = await canvasSession('alice')
  const b = await canvasSession('bob')
  await waitForCanvasUx(a.page)
  const { note, frame } = await seed(a.page, b.page, a.id, b.id)
  const knownNotes = [note]
  const knownFrames = [frame]
  await select(a.page, [note, frame])
  await a.page.evaluate(() => document.querySelector<HTMLElement>('.excalidraw')?.focus())
  await a.page.keyboard.press('ControlOrMeta+d')
  await expect.poll(async () => (await newOnes(a.page, 'stickynote', knownNotes)).length).toBe(1)
  const [noteCopy] = await newOnes(a.page, 'stickynote', knownNotes)
  const [frameCopy] = await newOnes(a.page, 'frame', knownFrames)
  await expectCopies([a.page, b.page], noteCopy as string, frameCopy ?? null, b.id)
  // the original keeps everything
  const original = await lobbyOf(b.page, note)
  expect(original[`plusOne:${b.id}`]).toBe(true)
  expect(original.ai).toEqual({ by: a.id })
  expect((await lobbyOf(b.page, frame)).present).toEqual({ index: 2, skip: true })
})

test('onDuplicate: the context menu’s Duplicate and an Alt-drag copy by the same rules', async ({
  canvasSession,
}) => {
  const a = await canvasSession('alice')
  const b = await canvasSession('bob')
  await waitForCanvasUx(a.page)
  const { note } = await seed(a.page, b.page, a.id, b.id)
  const known = [note]

  await test.step('context menu → Duplicate', async () => {
    await clickItem(a.page, note, { button: 'right' })
    await a.page.getByTestId('context-menu.duplicate').click()
    await expect.poll(async () => (await newOnes(a.page, 'stickynote', known)).length).toBe(1)
    const [copy] = await newOnes(a.page, 'stickynote', known)
    await expectCopies([a.page, b.page], copy as string, null, b.id)
    known.push(copy as string)
  })

  await test.step('Alt-drag', async () => {
    const box = await withCanvas(
      a.page,
      (c, id) => {
        const bb = c.bounds(id)
        return bb ? c.sceneToScreen({ x: bb.x + bb.width / 2, y: bb.y + bb.height / 2 }) : null
      },
      note,
    )
    if (!box) throw new Error('no note')
    await a.page.mouse.move(box.x, box.y)
    await a.page.keyboard.down('Alt')
    await a.page.mouse.down()
    await a.page.mouse.move(box.x + 60, box.y + 260, { steps: 8 })
    await a.page.mouse.up()
    await a.page.keyboard.up('Alt')
    await expect.poll(async () => (await newOnes(a.page, 'stickynote', known)).length).toBe(1)
    const [copy] = await newOnes(a.page, 'stickynote', known)
    await expectCopies([a.page, b.page], copy as string, null, b.id)
  })
})

test('onDuplicate: copy and paste (Ctrl+C, Ctrl+V) copy by the same rules', async ({ canvasSession }) => {
  const a = await canvasSession('alice')
  const b = await canvasSession('bob')
  await a.context.grantPermissions(['clipboard-read', 'clipboard-write'])
  await waitForCanvasUx(a.page)
  const { note } = await seed(a.page, b.page, a.id, b.id)
  await clickItem(a.page, note)
  await a.page.keyboard.press('ControlOrMeta+c')
  await a.page.keyboard.press('ControlOrMeta+v')
  await expect.poll(async () => (await newOnes(a.page, 'stickynote', [note])).length).toBe(1)
  const [copy] = await newOnes(a.page, 'stickynote', [note])
  await expectCopies([a.page, b.page], copy as string, null, b.id)
})
