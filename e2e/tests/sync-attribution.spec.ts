// SEAM-01 in real browsers: a note's "last edited by" belongs to whoever wrote its text, and a guest's
// note says "(guest)". alice (a member, "Alice Park") and a workshop guest who calls himself "Alice"
// work on one board. tldraw itself stamps the attribution (NoteShapeUtil.onBeforeUpdate on typing,
// onBeforeDuplicate on duplicate and paste; Lobby's per-property undo patches it back), so these are
// the real client paths the sync server's rule (apps/sync/src/attribution.ts) must keep working,
// next to the writes only a forged client sends, which it must refuse or strip without a push loop.
import type { Browser, BrowserContext, Page } from '@playwright/test'
import { edit, read, waitForBoard } from './support/board.ts'
import {
  closeShare,
  openMoreWaysToShare,
  openShareFromButton,
  shareDialog,
  signedInContext,
} from './support/dashboard-share.ts'
import { type EditorLike, plainText, richText } from './support/editor.ts'
import { expect, test } from './support/fixtures.ts'

// The text lease would veto the second writer's text edit for 5 s; it is not what this file tests.
test.use({ syncEnv: { TEXT_LEASE_MS: '300' } })

interface Note {
  id: string
  type: string
  x: number
  y: number
  props: { richText: unknown; textLastEditedBy: string | null } & Record<string, unknown>
}
/** The tldraw 5.4.2 Editor methods this file uses (window.editor is the real Editor). */
interface Ed {
  store: { put(records: unknown[]): void }
  getShape(id: string): Note | undefined
  getCurrentPageShapes(): Note[]
  createShape(partial: object): Ed
  updateShape(partial: object): Ed
  deleteShapes(ids: string[]): Ed
  duplicateShapes(ids: string[], offset?: { x: number; y: number }): Ed
  getContentFromCurrentPage(ids: string[]): unknown
  putContentOntoCurrentPage(content: unknown, opts?: { point?: { x: number; y: number } }): Ed
  markHistoryStoppingPoint(name?: string): string
  undo(): Ed
  redo(): Ed
  selectNone(): Ed
  zoomToFit(opts?: object): Ed
}
const run = <T, A = undefined>(page: Page, fn: (ed: Ed, arg: A) => T, arg?: A): Promise<T> =>
  read(page, fn as unknown as (e: EditorLike, a: A) => T, arg)
/** Runs `fn` for its side effects (Editor mutators return the editor, which cannot come back). */
const act = <A = undefined>(page: Page, fn: (ed: Ed, arg: A) => unknown, arg?: A): Promise<void> =>
  edit(page, fn as unknown as (e: EditorLike, a: A) => unknown, arg)
const fit = (page: Page) => act(page, (ed) => ed.zoomToFit({ animation: { duration: 0 } }))

const noteOf = (page: Page, id: string) =>
  run(page, (ed, shapeId: string) => ed.getShape(shapeId) ?? null, id)
/** [text, attribution] of a note as `page` has it (null when it has no such note). */
const stateOf = async (page: Page, id: string) => {
  const n = await noteOf(page, id)
  return n ? [plainText(n.props.richText), n.props.textLastEditedBy] : null
}
/** The ids of the notes on the page whose text is `text`. */
const notesWithText = (page: Page, text: string) =>
  run(
    page,
    (ed, t: string) =>
      ed
        .getCurrentPageShapes()
        .filter((s) => s.type === 'note')
        .filter((s) => {
          const doc = s.props.richText as { content?: { content?: { text?: string }[] }[] }
          return (
            (doc.content ?? []).map((p) => (p.content ?? []).map((c) => c.text ?? '').join('')).join('\n') ===
            t
          )
        })
        .map((s) => s.id),
    text,
  )

/** Creates a note and types `text` into it the way tldraw does (updateShapes -> onBeforeUpdate stamps). */
const writeNote = (page: Page, id: string, text: string, at: { x: number; y: number }) =>
  run(
    page,
    (ed, a: { id: string; doc: unknown; x: number; y: number }) => {
      ed.markHistoryStoppingPoint('new note')
      ed.createShape({ id: a.id, type: 'note', x: a.x, y: a.y, props: {} })
      ed.updateShape({ id: a.id, type: 'note', props: { richText: a.doc } })
      return null
    },
    { id, doc: richText(text), ...at },
  )
const typeInto = (page: Page, id: string, text: string) =>
  run(
    page,
    (ed, a: { id: string; doc: unknown }) => {
      ed.markHistoryStoppingPoint('edit note')
      ed.updateShape({ id: a.id, type: 'note', props: { richText: a.doc } })
      return null
    },
    { id, doc: richText(text) },
  )

/** alice creates a workshop link that lets name-only guests in (Share dialog); returns its URL. */
async function workshopGuestLink(page: Page, board: string): Promise<string> {
  await page.goto(`/b/${board}`)
  await waitForBoard(page)
  await openShareFromButton(page)
  const dialog = shareDialog(page)
  await openMoreWaysToShare(page) // DANA-03: the workshop link is under "More ways to share"
  await dialog.getByTestId('workshop-link-guests').check()
  await dialog.getByTestId('workshop-link-create').click()
  const row = dialog.getByTestId('workshop-link-row')
  await expect(row).toHaveCount(1)
  const url = await row.getByTestId('review-link-url').inputValue()
  await closeShare(page)
  return url
}

/** A fresh context that joins `link` as the guest `name`, counting the document pushes it sends. */
async function joinAsGuest(
  browser: Browser,
  link: string,
  name: string,
  opts: { viewport: { width: number; height: number }; colorScheme: 'light' | 'dark' },
) {
  const context = await browser.newContext(opts)
  const page = await context.newPage()
  const pushes: string[] = []
  page.on('websocket', (ws) => {
    ws.on('framesent', (f) => {
      const text = typeof f.payload === 'string' ? f.payload : f.payload.toString('utf8')
      if (text.includes('"type":"push"') && text.includes('"diff"')) pushes.push(text)
    })
  })
  await page.goto(link)
  await page.getByTestId('invite-guest-name').fill(name)
  await page.getByTestId('invite-guest-join').click()
  await expect(page).toHaveURL(/\/b\/[a-z0-9-]+$/, { timeout: 30_000 })
  await waitForBoard(page)
  const id = (await page.getByTestId('user-menu').getAttribute('data-user-id')) ?? ''
  expect(id).toMatch(/^usr_/)
  return { context, page, id, pushes }
}

/** The attribution label tldraw draws on a note (".tl-note__attribution"), as its text. */
const label = (page: Page, id: string) => page.locator(`[id="${id}"] .tl-note__attribution`)

test("a note's attribution follows whoever wrote its text: typing, undo/redo, duplicate, paste, undo of a delete; forgeries are refused without a loop; a guest's note says (guest)", async ({
  browser,
  board,
}, testInfo) => {
  const alice = await signedInContext(browser, 'alice')
  const contexts: BrowserContext[] = [alice.context]
  try {
    const a = alice.page
    const aliceId = alice.me.user.id
    const link = await workshopGuestLink(a, board)
    // A guest on a phone, dark theme, who calls himself "Alice".
    const guest = await joinAsGuest(browser, link, 'Alice', {
      viewport: { width: 390, height: 844 },
      colorScheme: 'dark',
    })
    contexts.push(guest.context)
    const g = guest.page
    const gid = guest.id

    // 1. Each writes a note: tldraw stamps each with its writer.
    await writeNote(a, 'shape:alices', 'Keep the Q3 launch', { x: 0, y: 0 })
    await writeNote(g, 'shape:guests', 'Ship the teaser first', { x: 260, y: 0 })
    await expect.poll(() => stateOf(g, 'shape:alices')).toEqual(['Keep the Q3 launch', aliceId])
    await expect.poll(() => stateOf(a, 'shape:guests')).toEqual(['Ship the teaser first', gid])

    // 2. On alice's canvas the two labels differ: hers is her first name, the guest's keeps "(guest)".
    for (const p of [a, g]) await fit(p)
    await expect(label(a, 'shape:alices')).toHaveText('Alice')
    await expect(label(a, 'shape:guests')).toHaveText('Alice (guest)')
    await expect(label(g, 'shape:guests')).toHaveText('Alice (guest)')
    await expect(label(g, 'shape:alices')).toHaveText('Alice')
    await a.screenshot({ path: testInfo.outputPath('labels-alice-light.png') })
    await g.screenshot({ path: testInfo.outputPath('labels-guest-dark-390.png') })

    // 3. The guest edits alice's note: now his. Undo gives her words and her name back; redo, his.
    await typeInto(g, 'shape:alices', 'Cancel the Q3 launch')
    await expect.poll(() => stateOf(a, 'shape:alices')).toEqual(['Cancel the Q3 launch', gid])
    await act(g, (ed) => ed.undo())
    await expect.poll(() => stateOf(a, 'shape:alices')).toEqual(['Keep the Q3 launch', aliceId])
    await act(g, (ed) => ed.redo())
    await expect.poll(() => stateOf(a, 'shape:alices')).toEqual(['Cancel the Q3 launch', gid])
    await act(g, (ed) => ed.undo())
    await expect.poll(() => stateOf(a, 'shape:alices')).toEqual(['Keep the Q3 launch', aliceId])
    await expect.poll(() => stateOf(g, 'shape:alices')).toEqual(['Keep the Q3 launch', aliceId])

    // 4. Duplicate and paste of alice's note: the copies are the guest's (onBeforeDuplicate).
    await act(g, (ed) => ed.duplicateShapes(['shape:alices'], { x: 0, y: 260 }))
    await run(g, (ed) => {
      const content = ed.getContentFromCurrentPage(['shape:alices'])
      ed.putContentOntoCurrentPage(content, { point: { x: 700, y: 400 } })
      return null
    })
    await expect.poll(async () => (await notesWithText(a, 'Keep the Q3 launch')).length).toBe(3)
    for (const id of await notesWithText(a, 'Keep the Q3 launch'))
      await expect
        .poll(() => stateOf(a, id))
        .toEqual(['Keep the Q3 launch', id === 'shape:alices' ? aliceId : gid])

    // 5. The guest deletes alice's note, then undoes it: back, with her name.
    await act(g, (ed) => {
      ed.markHistoryStoppingPoint('delete')
      ed.deleteShapes(['shape:alices'])
    })
    await expect.poll(() => noteOf(a, 'shape:alices')).toBeNull()
    await act(g, (ed) => ed.undo())
    await expect.poll(() => stateOf(a, 'shape:alices')).toEqual(['Keep the Q3 launch', aliceId])
    await expect(g.getByTestId('save-rejected-toast')).toHaveCount(0)

    // 6. A forged update (straight into the store, past tldraw's own stamping): new words under
    //    alice's id. The server skips it, the guest's tab snaps back and says so, and it stays quiet.
    await g.waitForTimeout(500)
    const before = guest.pushes.length
    await run(
      g,
      (ed, doc: unknown) => {
        const s = ed.getShape('shape:alices')
        if (s)
          ed.store.put([
            { ...s, props: { ...s.props, richText: doc, textLastEditedBy: s.props.textLastEditedBy } },
          ])
        return null
      },
      richText('Alice: cancel everything'),
    )
    await expect.poll(() => stateOf(g, 'shape:alices')).toEqual(['Keep the Q3 launch', aliceId])
    await expect(g.getByTestId('save-rejected-toast')).toBeVisible()
    await g.waitForTimeout(2_000)
    expect(guest.pushes.length - before, 'the refused write was sent once, never re-sent').toBe(1)
    expect(await stateOf(a, 'shape:alices')).toEqual(['Keep the Q3 launch', aliceId])
    await expect(g.getByTestId('conn-status')).toHaveAttribute('data-state', 'online')

    // 7. A forged create naming alice: the note lands, with nobody's name on it.
    await run(
      g,
      (ed, f: { doc: unknown; by: string }) => {
        const s = ed.getShape('shape:guests')
        if (s)
          ed.store.put([
            {
              ...s,
              id: 'shape:forged',
              x: 520,
              props: { ...s.props, richText: f.doc, textLastEditedBy: f.by },
            },
          ])
        return null
      },
      { doc: richText('Alice: raise prices'), by: aliceId },
    )
    await expect.poll(() => stateOf(a, 'shape:forged')).toEqual(['Alice: raise prices', null])
    await fit(g)
    await fit(a)
    await expect(label(a, 'shape:forged')).toHaveCount(0)
    await expect.poll(() => stateOf(g, 'shape:forged')).toEqual(['Alice: raise prices', null])
    await a.screenshot({ path: testInfo.outputPath('after-alice-light.png') })
  } finally {
    await Promise.all(contexts.map((c) => c.close()))
  }
})
