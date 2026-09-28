// Private brainstorming (docs/WAVE3-CONTRACTS.md "private-notes"; build plan §9), driven through the
// real UI by two people: alice = board owner (she starts and reveals), bob = editor, carol = viewer.
// What each person could see is asserted in their own browser (the DOM, the tldraw store) and on the
// wire as the browser received it (every API response, every server-sent event, every WebSocket frame,
// recorded through the DevTools protocol by support/workshops.ts), plus through the API as that person.
import type { Page } from '@playwright/test'
import { edit, read, shapeBounds } from './support/board.ts'
import { capture } from './support/screenshots.ts'
import { expect, openWorkshopPopover, test, type WorkshopSession } from './support/workshops.ts'

interface PlacedNote {
  id: string
  parentId: string
  text: string
  color: string
  growY: number
  textLastEditedBy: string | null
  meta: Record<string, unknown>
}

interface ApiPrivateState {
  session: { id: string; status: string; frameId: string; anonymous: boolean } | null
  counts: { notes: number; people: number }
  myNotes: { id: string; text: string; color: string }[]
  canReveal: boolean
}

async function privateState(s: WorkshopSession, board: string): Promise<ApiPrivateState> {
  const res = await s.api.fetch('GET', `/api/boards/${board}/private-brainstorm`)
  expect(res.status()).toBe(200)
  return (await res.json()) as ApiPrivateState
}

/** Starts a brainstorm through the workshop tools popover and the setup dialog. */
async function startBrainstorm(
  page: Page,
  opts: { prompt: string; anonymous: boolean; target: 'new' | 'selected' },
) {
  const pop = await openWorkshopPopover(page)
  await pop.getByTestId('pn-start').click()
  const dialog = page.getByTestId('pn-setup-dialog')
  await expect(dialog).toBeVisible()
  await dialog.getByTestId('pn-prompt-input').fill(opts.prompt)
  await dialog.getByTestId(opts.target === 'new' ? 'pn-target-new' : 'pn-target-selected').check()
  const anon = dialog.getByTestId('pn-anonymous')
  if ((await anon.isChecked()) !== opts.anonymous) await anon.click()
  await dialog.getByTestId('pn-setup-submit').click()
  await expect(dialog).toHaveCount(0)
  await expect(page.getByTestId('pn-panel')).toHaveAttribute('data-state', 'open')
}

/** Opens the "Private notes" panel from the top-bar chip. */
async function openPanel(page: Page) {
  const panel = page.getByTestId('pn-panel')
  if (!(await panel.isVisible())) await page.getByTestId('pn-chip').click()
  await expect(panel).toBeVisible()
  return panel
}

/** Writes one private note in the panel (as a user would; `typed` sends real key presses). */
async function writeNote(page: Page, text: string, color = 'black', typed = false) {
  const panel = await openPanel(page)
  if (typed) await panel.getByTestId('pn-compose-text').pressSequentially(text)
  else await panel.getByTestId('pn-compose-text').fill(text)
  await panel.locator(`[data-testid="pn-color"][data-color="${color}"]`).check({ force: true })
  await panel.getByTestId('pn-add').click()
  await expect(panel.getByTestId('pn-note-text').filter({ hasText: text })).toBeVisible()
  await expect(panel.getByTestId('pn-compose-text')).toHaveValue('')
}

/** Notes a session placed, as this page's tldraw store holds them. */
const placedNotes = (page: Page, sessionId: string) =>
  read(
    page,
    (ed, sid) =>
      ed.store
        .allRecords()
        .filter((r) => {
          const s = r as unknown as {
            typeName: string
            type?: string
            meta?: Record<string, { session?: string }>
          }
          return s.typeName === 'shape' && s.type === 'note' && s.meta?.drPrivateNote?.session === sid
        })
        .map((r) => {
          const s = r as unknown as {
            id: string
            parentId: string
            meta: Record<string, unknown>
            props: {
              richText: { content?: { content?: { text?: string }[] }[] }
              color: string
              growY: number
              textLastEditedBy: string | null
            }
          }
          const text = (s.props.richText.content ?? [])
            .map((p) => (p.content ?? []).map((t) => t.text ?? '').join(''))
            .join('\n')
          return {
            id: s.id,
            parentId: s.parentId,
            text,
            color: s.props.color,
            growY: s.props.growY,
            textLastEditedBy: s.props.textLastEditedBy,
            meta: s.meta,
          }
        }),
    sessionId,
  ) as Promise<PlacedNote[]>

/** Everything this browser holds or received that could carry text: DOM, canvas store, network. */
async function everythingSeen(s: WorkshopSession): Promise<string> {
  await s.net.settle()
  const dom = await s.page.evaluate(() => document.documentElement.outerHTML)
  const records = await s.page.evaluate(() => JSON.stringify(window.editor?.store.allRecords() ?? []))
  return [
    dom,
    records,
    ...s.net.responses.map((r) => r.body),
    ...s.net.events.map((e) => e.raw),
    ...s.net.wsFrames,
  ].join('\n')
}

async function expectEveryNoteInFrame(page: Page, notes: PlacedNote[], frameId: string) {
  const frame = await shapeBounds(page, frameId)
  expect(frame, 'the frame is on the board').not.toBeNull()
  for (const n of notes) {
    expect(n.parentId).toBe(frameId)
    const b = await shapeBounds(page, n.id)
    if (!b || !frame) throw new Error(`no bounds for ${n.id}`)
    expect(b.x).toBeGreaterThanOrEqual(frame.x)
    expect(b.y).toBeGreaterThanOrEqual(frame.y)
    expect(b.x + b.w).toBeLessThanOrEqual(frame.x + frame.w + 0.5)
    expect(b.y + b.h).toBeLessThanOrEqual(frame.y + frame.h + 0.5)
  }
}

const ALICE_TEXTS = ['Alice: fewer status meetings', 'Alice: a shared review checklist']
const BOB_TEXTS = [
  'Bob: pair on the tricky bits',
  // long enough that the sync server's tall estimate differs from what tldraw measures
  'Bob: write the release notes while we build, not the night before, so nobody has to guess what changed or why it matters to clients',
]

test('private notes: nobody sees another person’s drafts, and the reveal puts every note in the frame for everyone', async ({
  join,
  board,
}, testInfo) => {
  const alice = await join('alice', 'owner')
  const bob = await join('bob', 'editor')

  await startBrainstorm(alice.page, { prompt: 'What should we change?', anonymous: false, target: 'new' })
  const started = await privateState(alice, board)
  const sid = started.session?.id as string
  const frameId = started.session?.frameId as string
  expect(started.session).toMatchObject({ status: 'open', anonymous: false })
  // Bob sees the session and its prompt through the chip, without reloading.
  await expect(bob.page.getByTestId('pn-chip')).toBeVisible()
  const bobPanel = await openPanel(bob.page)
  await expect(bobPanel.getByTestId('pn-prompt')).toHaveText('What should we change?')
  await expect(bobPanel.getByTestId('pn-mode')).toHaveText('Names shown')

  await writeNote(alice.page, ALICE_TEXTS[0] as string, 'yellow')
  // Typed key by key: the board's single-key shortcuts (r, t, d, e, n…) stay out of the text box.
  await writeNote(bob.page, BOB_TEXTS[0] as string, 'blue', true)
  expect(await read(bob.page, (ed) => ed.getCurrentToolId())).toBe('select')
  await writeNote(alice.page, ALICE_TEXTS[1] as string)
  await writeNote(bob.page, BOB_TEXTS[1] as string, 'green')
  // Everyone sees the live counts (from events), nobody sees anyone else's text.
  for (const s of [alice, bob])
    await expect(s.page.getByTestId('pn-counts')).toHaveText('4 notes from 2 people')
  await expect(bob.page.getByTestId('pn-chip-counts')).toHaveText('4 from 2')
  await capture('private-notes-drafting.png', bob.page, testInfo)

  const bobSaw = await everythingSeen(bob)
  for (const t of ALICE_TEXTS) expect(bobSaw, 'bob never received alice’s draft').not.toContain(t)
  const aliceSaw = await everythingSeen(alice)
  for (const t of BOB_TEXTS) expect(aliceSaw, 'the facilitator never received bob’s draft').not.toContain(t)
  // …and asking the API as bob gives bob his own drafts only.
  const asBob = await privateState(bob, board)
  expect(asBob.myNotes.map((n) => n.text).sort()).toEqual([...BOB_TEXTS].sort())
  expect(JSON.stringify(asBob)).not.toContain('Alice:')
  expect(
    await bob.api
      .fetch('PATCH', `/api/private-notes/${(await privateState(alice, board)).myNotes[0]?.id}`, {
        text: 'hijacked',
      })
      .then((r) => r.status()),
  ).toBe(404)
  // Bob can take his own draft back and write it again.
  const bobNote = bobPanel.getByTestId('pn-note').filter({ hasText: BOB_TEXTS[0] as string })
  await bobNote.getByTestId('pn-note-delete').click()
  await expect(bob.page.getByTestId('pn-counts')).toHaveText('3 notes from 2 people')
  await writeNote(bob.page, BOB_TEXTS[0] as string, 'blue')
  await expect(alice.page.getByTestId('pn-counts')).toHaveText('4 notes from 2 people')

  // Reveal (the starter). Every note lands in the frame, for both of them, with its author.
  await alice.page.getByTestId('pn-reveal').click()
  for (const s of [alice, bob]) {
    await expect.poll(async () => (await placedNotes(s.page, sid)).length, { timeout: 20_000 }).toBe(4)
    const notes = await placedNotes(s.page, sid)
    expect(notes.map((n) => n.text).sort()).toEqual([...ALICE_TEXTS, ...BOB_TEXTS].sort())
    await expectEveryNoteInFrame(s.page, notes, frameId)
    for (const n of notes) {
      const author = n.text.startsWith('Alice') ? alice.id : bob.id
      expect(n.textLastEditedBy).toBe(author)
      expect(n.meta).toEqual({ drPrivateNote: { session: sid, author } })
    }
    for (const t of [...ALICE_TEXTS, ...BOB_TEXTS])
      await expect(s.page.locator('.tl-note__container').filter({ hasText: t.slice(0, 30) })).toHaveCount(1)
    await expect(s.page.getByTestId('pn-toast')).toContainText('4 notes are from the private brainstorm')
    await expect(s.page.getByTestId('pn-chip')).toHaveCount(0)
  }
  // Grouped by author: alice's two notes on one row, bob's after them.
  const byText = new Map((await placedNotes(alice.page, sid)).map((n) => [n.text, n.id]))
  const [a0, a1] = await Promise.all(ALICE_TEXTS.map((t) => shapeBounds(alice.page, byText.get(t) as string)))
  expect(a0?.y).toBe(a1?.y)
  // The revealing tab measured the long note: its height now follows its text, on every client. The
  // sync server's deliberately tall estimate for this text is growY 218 (13 lines of 12 characters);
  // tldraw measures fewer, longer lines.
  const long = byText.get(BOB_TEXTS[1] as string) as string
  const growY = async () => (await placedNotes(bob.page, sid)).find((n) => n.id === long)?.growY ?? -1
  await expect.poll(growY).toBeLessThan(218)
  expect(await growY()).toBeGreaterThan(0)
  // Names show like any note's; the board's "Hide note authors" hides them on the placed notes too.
  await edit(bob.page, (ed) => ed.zoomToFit())
  const attributions = bob.page.locator(
    [...byText.values()].map((id) => `[data-shape-id="${id}"] .tl-note__attribution`).join(', '),
  )
  await expect(attributions).toHaveCount(4)
  await expect(attributions.filter({ hasText: 'Alice' })).toHaveCount(2)
  await expect(attributions.first()).toBeVisible()
  const pop = await openWorkshopPopover(alice.page)
  await pop.getByTestId('session-hide-authors').check()
  await alice.page.keyboard.press('Escape')
  await expect(attributions).toHaveCount(4)
  for (const a of await attributions.all()) await expect(a).toBeHidden()
  // The drafts are gone from the server: nothing is left that says who wrote what.
  expect(await privateState(alice, board)).toMatchObject({ session: null, myNotes: [] })
  expect((await privateState(bob, board)).myNotes).toEqual([])
  // "Show me" brings the whole frame into view.
  await alice.page.getByTestId('pn-toast-show').click()
  await expect
    .poll(() =>
      read(
        alice.page,
        (ed, id) => {
          type Box = { x: number; y: number; w: number; h: number }
          const e = ed as unknown as { getViewportPageBounds(): Box; getShapePageBounds(id: string): Box }
          const v = e.getViewportPageBounds()
          const f = e.getShapePageBounds(id)
          return f.x >= v.x && f.y >= v.y && f.x + f.w <= v.x + v.w && f.y + f.h <= v.y + v.h
        },
        frameId,
      ),
    )
    .toBe(true)
  await capture('private-notes-revealed.png', alice.page, testInfo)
})

test('private notes: an anonymous reveal names nobody, and a doubled reveal places each note once', async ({
  join,
  board,
}) => {
  const alice = await join('alice', 'owner')
  const bob = await join('bob', 'editor')
  const carol = await join('carol', 'viewer')

  // Into a frame alice already has, selected.
  await edit(alice.page, (ed) => {
    ed.createShape({
      id: 'shape:retro',
      type: 'frame',
      x: 0,
      y: 0,
      props: { w: 700, h: 500, name: 'Retro' },
    })
    ed.select('shape:retro')
  })
  await startBrainstorm(alice.page, { prompt: 'What went well?', anonymous: true, target: 'selected' })
  const sid = (await privateState(alice, board)).session?.id as string
  expect((await privateState(alice, board)).session).toMatchObject({
    frameId: 'shape:retro',
    anonymous: true,
  })

  // The viewer sees the prompt and counts, and cannot write (not in the UI, not through the API).
  const carolPanel = await openPanel(carol.page)
  await expect(carolPanel.getByTestId('pn-mode')).toHaveText('Anonymous')
  await expect(carolPanel.getByTestId('pn-viewer-hint')).toBeVisible()
  await expect(carolPanel.getByTestId('pn-compose-text')).toHaveCount(0)
  const refused = await carol.api.fetch('POST', `/api/private-brainstorms/${sid}/notes`, {
    text: 'viewer idea',
    color: 'yellow',
  })
  expect(refused.status()).toBe(403)

  await writeNote(bob.page, 'Anonymous: the demo went smoothly', 'light-green')
  await writeNote(bob.page, 'Anonymous: we shipped on time')
  await writeNote(alice.page, 'Anonymous: the new board is fast')
  await expect(carol.page.getByTestId('pn-counts')).toHaveText('3 notes from 2 people')
  // Bob cannot reveal (he did not start it and is not an owner): no button, and the API refuses.
  await expect((await openPanel(bob.page)).getByTestId('pn-reveal')).toHaveCount(0)
  expect((await bob.api.fetch('POST', `/api/private-brainstorms/${sid}/reveal`)).status()).toBe(403)

  // A doubled reveal: two requests from alice's browser at the same moment (a double click, or two
  // tabs). Both succeed; the notes are placed once.
  await expect(alice.page.getByTestId('pn-reveal')).toHaveText('Reveal 3 notes')
  const statuses = await alice.page.evaluate((path) => {
    const once = () =>
      fetch(path, { method: 'POST', headers: { accept: 'application/json' } }).then((r) => r.status)
    return Promise.all([once(), once()])
  }, `/api/private-brainstorms/${sid}/reveal`)
  expect(statuses).toEqual([200, 200])
  await expect(alice.page.getByTestId('pn-toast')).toContainText('3 notes are from the private brainstorm')
  for (const s of [alice, bob, carol]) {
    await expect.poll(async () => (await placedNotes(s.page, sid)).length, { timeout: 20_000 }).toBe(3)
    const notes = await placedNotes(s.page, sid)
    expect(new Set(notes.map((n) => n.text)).size).toBe(3)
    await expectEveryNoteInFrame(s.page, notes, 'shape:retro')
    for (const n of notes) {
      expect(n.textLastEditedBy).toBeNull()
      expect(n.meta).toEqual({ drPrivateNote: { session: sid } })
      await expect(s.page.locator(`[data-shape-id="${n.id}"] .tl-note__attribution`)).toHaveCount(0)
      // no user id at all in the record that reached this browser
      expect(await read(s.page, (ed, id) => JSON.stringify(ed.getShape(id)), n.id)).not.toMatch(/usr_/)
    }
  }
  // A late retry places nothing twice.
  expect((await alice.api.fetch('POST', `/api/private-brainstorms/${sid}/reveal`)).status()).toBe(200)
  await alice.page.waitForTimeout(500) // a duplicate would arrive over the socket within this
  expect(await placedNotes(bob.page, sid)).toHaveLength(3)
})

test('private notes: when the canvas is down at reveal, "Place notes" finishes it; cancel discards drafts', async ({
  join,
  board,
  stack,
}) => {
  const alice = await join('alice', 'owner')
  const bob = await join('bob', 'editor')
  await startBrainstorm(alice.page, { prompt: 'Risks?', anonymous: false, target: 'new' })
  const sid = (await privateState(alice, board)).session?.id as string
  await writeNote(bob.page, 'Risk: the vendr is late', 'red')
  // Bob fixes a typo in his own note before the reveal.
  const bobPanel = await openPanel(bob.page)
  await bobPanel.getByTestId('pn-note-edit').click()
  await bobPanel.getByTestId('pn-edit-text').fill('Risk: the vendor is late')
  await bobPanel.getByTestId('pn-note-save').click()
  await expect(bobPanel.getByTestId('pn-note-text')).toHaveText('Risk: the vendor is late')

  await stack.sync.kill()
  try {
    await alice.page.getByTestId('pn-reveal').click()
    await expect(alice.page.getByTestId('pn-error')).toContainText('Place notes')
    await expect(alice.page.getByTestId('pn-place')).toBeVisible()
    await expect(bob.page.getByTestId('pn-placing')).toBeVisible()
    // Revealed: nobody can change a draft any more.
    const bobNote = (await privateState(bob, board)).myNotes[0]?.id
    expect((await bob.api.fetch('PATCH', `/api/private-notes/${bobNote}`, { text: 'x' })).status()).toBe(409)
  } finally {
    await stack.sync.start()
  }
  await expect(alice.page.getByTestId('conn-status')).toHaveAttribute('data-state', 'online', {
    timeout: 30_000,
  })
  await alice.page.getByTestId('pn-place').click()
  for (const s of [alice, bob])
    await expect.poll(async () => (await placedNotes(s.page, sid)).length, { timeout: 20_000 }).toBe(1)
  expect((await placedNotes(bob.page, sid))[0]).toMatchObject({
    text: 'Risk: the vendor is late',
    color: 'red',
  })

  // Cancel: a second brainstorm, discarded. Its text never reaches the board or anyone else.
  await startBrainstorm(alice.page, { prompt: 'Second round', anonymous: true, target: 'new' })
  const second = (await privateState(alice, board)).session?.id as string
  await writeNote(bob.page, 'Never shown to anyone', 'violet')
  await alice.page.getByTestId('pn-cancel').click()
  await alice.page.getByTestId('pn-cancel-confirm').click()
  await expect(bob.page.getByTestId('pn-toast')).toContainText('cancelled')
  await expect(bob.page.getByTestId('pn-chip')).toHaveCount(0)
  expect(await placedNotes(bob.page, second)).toEqual([])
  expect(await everythingSeen(alice)).not.toContain('Never shown to anyone')
  expect((await privateState(bob, board)).session).toBeNull()
})

test('private notes: the panel and the dialog in dark mode at phone width', async ({ join }, testInfo) => {
  const alice = await join('alice', 'owner')
  await alice.page.emulateMedia({ colorScheme: 'dark' })
  await alice.page.setViewportSize({ width: 390, height: 844 })
  // On phones the workshop tools live in the "⋯" menu.
  await alice.page.getByTestId('topbar-overflow').click()
  await alice.page.getByTestId('timer-pill').click()
  await alice.page.getByTestId('pn-start').click()
  const dialog = alice.page.getByTestId('pn-setup-dialog')
  await expect(dialog).toBeVisible()
  await dialog.getByTestId('pn-prompt-input').fill('What should we try next quarter?')
  await capture('private-notes-dialog-phone-dark.png', alice.page, testInfo)
  const box = await dialog.boundingBox()
  expect(box && box.x >= 0 && box.x + box.width <= 390).toBe(true)
  await dialog.getByTestId('pn-setup-submit').click()
  const panel = alice.page.getByTestId('pn-panel')
  await expect(panel).toBeVisible()
  await panel.getByTestId('pn-compose-text').fill('A note on a phone')
  await panel.getByTestId('pn-add').click()
  await expect(panel.getByTestId('pn-note-text')).toHaveText('A note on a phone')
  await capture('private-notes-panel-phone-dark.png', alice.page, testInfo)
  // Nothing sticks out sideways.
  const overflow = await alice.page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)
  expect(overflow).toBeLessThanOrEqual(0)

  // A small laptop in light mode: the chip fits in the top bar next to everything else.
  await alice.page.emulateMedia({ colorScheme: 'light' })
  await alice.page.setViewportSize({ width: 1024, height: 768 })
  await expect(alice.page.getByTestId('pn-chip')).toBeVisible()
  await expect(alice.page.getByTestId('pn-chip')).toHaveAccessibleName(
    /Private brainstorm: 1 note from 1 person/,
  )
  const bar = await alice.page.evaluate(() => {
    const el = document.querySelector('.dr-topbar')
    return el ? el.scrollWidth - el.clientWidth : -1
  })
  expect(bar).toBeLessThanOrEqual(0)
  await capture('private-notes-topbar-1024-light.png', alice.page, testInfo)
})
