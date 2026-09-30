// OWNER: 3f. Private brainstorming on the Excalidraw board page, ported from tests/private-notes.spec.ts,
// tests/workshops-3.fix.spec.ts (DANA2-02 / R2-01, A11Y2-01 / R2-06, R2-02 / R2-03, R2-12),
// tests/workshops-2.fix.spec.ts (F6, F5, SEAM-07) and tests/facilitation-polish.fix.spec.ts (R1).
// alice = board owner (she starts and reveals), bob = editor, carol = viewer.
//
// Each tldraw test is split: drafting, privacy, the frame, the panel and cancel in one test, the reveal and
// what follows it in its own ("(CR 2F-2)" in the title). The reveal was blocked until the room implemented
// `serverWrite` (CR 2F-2, spike B's part 3, merged at the wave-3 integration): place-notes then answered 503
// on a board whose room was open. The reveal tests must pass now. Their assertions are already written for this engine: a placed note is a `stickynote`
// with `customData.lobbyServer.privateNote {session, author?}`, its text in its bound label, the author as
// its `lobbyServer.createdBy` (docs/research/excalidraw/wave3/3F.md).
import type { Page } from '@playwright/test'
import {
  type CanvasElement,
  item,
  itemBounds,
  items,
  itemText,
  select,
  tool,
  viewport,
} from '../tests/support/canvas.ts'
import { capture } from '../tests/support/screenshots.ts'
import { closeWorkshopPopover, openWorkshopPopover } from '../tests/support/workshops.ts'
import {
  expect,
  expectItemsEverywhere,
  post,
  reloadBoard,
  seed,
  showAll,
  test,
  type WorkshopCanvasSession,
  waitForWorkshopBoard,
} from './workshops-kit.ts'

/** The note-author labels (the workshops feature's overlay, CR-3F-4) on the notes `ids`. */
const authorLabels = (page: Page, ids: readonly string[]) =>
  page.locator(ids.map((id) => `[data-testid="note-author"][data-note-id="${id}"]`).join(', '))

interface ApiPrivateState {
  session: { id: string; status: string; frameId: string; anonymous: boolean } | null
  counts: { notes: number; people: number }
  myNotes: { id: string; text: string; color: string }[]
  canReveal: boolean
}

async function privateState(s: WorkshopCanvasSession, board: string): Promise<ApiPrivateState> {
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

/** Opens the "Private notes" panel (the top-bar chip, or the dock on a phone). */
async function openPanel(page: Page) {
  const panel = page.getByTestId('pn-panel')
  if (!(await panel.isVisible())) {
    const chip = page.getByTestId('pn-chip')
    if (await chip.isVisible()) await chip.click()
    else {
      const toggle = page.getByTestId('dock-rail-toggle')
      if (await toggle.isVisible()) await toggle.click()
      await page.getByTestId('dock-tab-private-notes').click()
    }
  }
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

interface PlacedNote {
  id: string
  frameId: string | null
  text: string
  backgroundColor: string
  author: string | null
  privateNote: Record<string, unknown>
}

const sessionOf = (el: CanvasElement) =>
  (el.customData?.lobbyServer as { privateNote?: { session?: string } } | undefined)?.privateNote?.session

/** The notes a session placed, as this page holds them. */
async function placedNotes(page: Page, sessionId: string): Promise<PlacedNote[]> {
  const all = await items(page)
  const out: PlacedNote[] = []
  for (const el of all) {
    if (el.type !== 'stickynote' || sessionOf(el) !== sessionId) continue
    const server = el.customData?.lobbyServer as {
      privateNote: Record<string, unknown>
      createdBy?: { uid?: string } | null
    }
    out.push({
      id: el.id,
      frameId: el.frameId,
      text: await itemText(page, el.id),
      backgroundColor: String((el as { backgroundColor?: string }).backgroundColor),
      author: server.createdBy?.uid ?? null,
      privateNote: server.privateNote,
    })
  }
  return out
}

/** Everything this browser holds or received that could carry text: DOM, the canvas, the network. */
async function everythingSeen(s: WorkshopCanvasSession): Promise<string> {
  await s.net.settle()
  const dom = await s.page.evaluate(() => document.documentElement.outerHTML)
  const elements = JSON.stringify(await items(s.page))
  return [
    dom,
    elements,
    ...s.net.responses.map((r) => r.body),
    ...s.net.events.map((e) => e.raw),
    ...s.net.wsFrames,
  ].join('\n')
}

const within = (outer: { x: number; y: number; width: number; height: number }, b: typeof outer) =>
  b.x >= outer.x - 0.5 &&
  b.y >= outer.y - 0.5 &&
  b.x + b.width <= outer.x + outer.width + 0.5 &&
  b.y + b.height <= outer.y + outer.height + 0.5

async function expectEveryNoteInFrame(page: Page, notes: PlacedNote[], frameRef: string) {
  const frameId = frameRef.replace(/^shape:/, '')
  const frame = await itemBounds(page, frameId)
  expect(frame, 'the frame is on the board').not.toBeNull()
  for (const n of notes) {
    expect(n.frameId).toBe(frameId)
    const b = await itemBounds(page, n.id)
    if (!b || !frame) throw new Error(`no bounds for ${n.id}`)
    expect(within(frame, b)).toBe(true)
  }
}

const ALICE_TEXTS = ['Alice: fewer status meetings', 'Alice: a shared review checklist']
const BOB_TEXTS = [
  'Bob: pair on the tricky bits',
  'Bob: write the release notes while we build, not the night before, so nobody has to guess what changed or why it matters to clients',
]

// ---- private-notes.spec.ts ---------------------------------------------------------------------------------

test('private notes: nobody sees another person’s drafts; the counts are live; a draft can be taken back', async ({
  join,
  board,
}, testInfo) => {
  const alice = await join('alice', 'owner')
  const bob = await join('bob', 'editor')

  await startBrainstorm(alice.page, { prompt: 'What should we change?', anonymous: false, target: 'new' })
  const started = await privateState(alice, board)
  expect(started.session).toMatchObject({ status: 'open', anonymous: false })
  // The "Private ideas" frame the session made is on the board, for bob too.
  const frameId = (started.session?.frameId ?? '').replace(/^shape:/, '')
  await expectItemsEverywhere([alice, bob], [frameId])
  expect(await itemText(bob.page, frameId)).toBe('Private ideas')
  // Bob sees the session and its prompt through the chip, without reloading.
  await expect(bob.page.getByTestId('pn-chip')).toBeVisible()
  const bobPanel = await openPanel(bob.page)
  await expect(bobPanel.getByTestId('pn-prompt')).toHaveText('What should we change?')
  await expect(bobPanel.getByTestId('pn-mode')).toHaveText('Names shown')

  await writeNote(alice.page, ALICE_TEXTS[0] as string, 'yellow')
  // Typed key by key: the board's single-key shortcuts (r, t, d, e, n…) stay out of the text box.
  await writeNote(bob.page, BOB_TEXTS[0] as string, 'blue', true)
  expect(await tool(bob.page)).toBe('select')
  await writeNote(alice.page, ALICE_TEXTS[1] as string)
  await writeNote(bob.page, BOB_TEXTS[1] as string, 'green')
  for (const s of [alice, bob])
    await expect(s.page.getByTestId('pn-counts')).toHaveText('4 notes from 2 people')
  await expect(bob.page.getByTestId('pn-chip-counts')).toHaveText('4 notes from 2 people')
  await capture('lc-private-notes-drafting.png', bob.page, testInfo)

  const bobSaw = await everythingSeen(bob)
  for (const t of ALICE_TEXTS) expect(bobSaw, 'bob never received alice’s draft').not.toContain(t)
  const aliceSaw = await everythingSeen(alice)
  for (const t of BOB_TEXTS) expect(aliceSaw, 'the facilitator never received bob’s draft').not.toContain(t)
  const asBob = await privateState(bob, board)
  expect(asBob.myNotes.map((n) => n.text).sort()).toEqual([...BOB_TEXTS].sort())
  expect(JSON.stringify(asBob)).not.toContain('Alice:')
  const aliceNote = (await privateState(alice, board)).myNotes[0]?.id
  expect(
    await bob.api
      .fetch('PATCH', `/api/private-notes/${aliceNote}`, { text: 'hijacked' })
      .then((r) => r.status()),
  ).toBe(404)
  // Bob can take his own draft back and write it again.
  const bobNote = bobPanel.getByTestId('pn-note').filter({ hasText: BOB_TEXTS[0] as string })
  await bobNote.getByTestId('pn-note-delete').click()
  await expect(bob.page.getByTestId('pn-counts')).toHaveText('3 notes from 2 people')
  await writeNote(bob.page, BOB_TEXTS[0] as string, 'blue')
  await expect(alice.page.getByTestId('pn-counts')).toHaveText('4 notes from 2 people')
  await expect(alice.page.getByTestId('pn-reveal')).toHaveText('Reveal 4 notes')
})

test('private notes: the reveal puts every note in the frame for everyone, with its author; "Show me" shows the frame (CR 2F-2)', async ({
  join,
  board,
}) => {
  const alice = await join('alice', 'owner')
  const bob = await join('bob', 'editor')
  await startBrainstorm(alice.page, { prompt: 'What should we change?', anonymous: false, target: 'new' })
  const started = await privateState(alice, board)
  const sid = started.session?.id as string
  const frameRef = started.session?.frameId as string
  await writeNote(alice.page, ALICE_TEXTS[0] as string, 'yellow')
  await writeNote(bob.page, BOB_TEXTS[0] as string, 'blue')
  await writeNote(alice.page, ALICE_TEXTS[1] as string)
  await writeNote(bob.page, BOB_TEXTS[1] as string, 'green')

  await alice.page.getByTestId('pn-reveal').click()
  for (const s of [alice, bob]) {
    await expect.poll(async () => (await placedNotes(s.page, sid)).length, { timeout: 20_000 }).toBe(4)
    const notes = await placedNotes(s.page, sid)
    expect(notes.map((n) => n.text).sort()).toEqual([...ALICE_TEXTS, ...BOB_TEXTS].sort())
    await expectEveryNoteInFrame(s.page, notes, frameRef)
    for (const n of notes) {
      const author = n.text.startsWith('Alice') ? alice.id : bob.id
      expect(n.author).toBe(author)
      expect(n.privateNote).toEqual({ session: sid, author })
    }
    await expect(s.page.getByTestId('pn-toast')).toContainText(
      '4 notes from the private brainstorm are now on the board',
    )
    await expect(s.page.getByTestId('pn-chip')).toHaveCount(0)
  }
  // Grouped by author: alice's two notes on one row, bob's after them.
  const byText = new Map((await placedNotes(alice.page, sid)).map((n) => [n.text, n.id]))
  const [a0, a1] = await Promise.all(ALICE_TEXTS.map((t) => itemBounds(alice.page, byText.get(t) as string)))
  expect(a0?.y).toBe(a1?.y)
  expect(await privateState(alice, board)).toMatchObject({ session: null, myNotes: [] })
  expect((await privateState(bob, board)).myNotes).toEqual([])
  // "Show me" brings the whole frame into view.
  await alice.page.getByTestId('pn-toast-show').click()
  const frameId = frameRef.replace(/^shape:/, '')
  await expect
    .poll(async () => {
      const [v, f] = await Promise.all([viewport(alice.page), itemBounds(alice.page, frameId)])
      return !!f && within(v, f)
    })
    .toBe(true)
  // Names show like any note's (the tldraw spec's attributions); the board's "Hide note authors" hides
  // them on the placed notes too (CR-3F-4).
  const labels = authorLabels(alice.page, [...byText.values()])
  await expect(labels).toHaveCount(4)
  await expect(labels.filter({ hasText: alice.name.split(' ')[0] ?? alice.name })).toHaveCount(2)
  await expect(labels.first()).toBeVisible()
  const pop = await openWorkshopPopover(alice.page)
  await pop.getByTestId('session-hide-authors').check()
  await closeWorkshopPopover(alice.page)
  await expect(labels).toHaveCount(0)
})

test('private notes: a viewer sees the prompt and counts but cannot write; only the starter or an owner may reveal', async ({
  join,
  board,
}) => {
  const alice = await join('alice', 'owner')
  const bob = await join('bob', 'editor')
  const carol = await join('carol', 'viewer')

  // Into a frame alice already has, selected.
  await seed(alice.page, { frames: [{ id: 'retro', x: 0, y: 0, w: 700, h: 500, name: 'Retro' }] })
  await select(alice.page, ['retro'])
  await startBrainstorm(alice.page, { prompt: 'What went well?', anonymous: true, target: 'selected' })
  const sid = (await privateState(alice, board)).session?.id as string
  expect((await privateState(alice, board)).session).toMatchObject({
    frameId: 'shape:retro',
    anonymous: true,
  })

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
  await expect((await openPanel(bob.page)).getByTestId('pn-reveal')).toHaveCount(0)
  expect((await bob.api.fetch('POST', `/api/private-brainstorms/${sid}/reveal`)).status()).toBe(403)
  await expect(alice.page.getByTestId('pn-reveal')).toHaveText('Reveal 3 notes')
  // Picking an existing frame makes no new one.
  expect((await items(alice.page)).filter((e) => e.type === 'frame').map((e) => e.id)).toEqual(['retro'])
})

test('private notes: an anonymous reveal names nobody, and a doubled reveal places each note once (CR 2F-2)', async ({
  join,
  board,
}) => {
  const alice = await join('alice', 'owner')
  const bob = await join('bob', 'editor')
  await seed(alice.page, { frames: [{ id: 'retro', x: 0, y: 0, w: 700, h: 500, name: 'Retro' }] })
  await select(alice.page, ['retro'])
  await startBrainstorm(alice.page, { prompt: 'What went well?', anonymous: true, target: 'selected' })
  const sid = (await privateState(alice, board)).session?.id as string
  await writeNote(bob.page, 'Anonymous: the demo went smoothly', 'light-green')
  await writeNote(bob.page, 'Anonymous: we shipped on time')
  await writeNote(alice.page, 'Anonymous: the new board is fast')
  const statuses = await alice.page.evaluate((path) => {
    const once = () =>
      fetch(path, { method: 'POST', headers: { accept: 'application/json' } }).then((r) => r.status)
    return Promise.all([once(), once()])
  }, `/api/private-brainstorms/${sid}/reveal`)
  expect(statuses).toEqual([200, 200])
  await expect(alice.page.getByTestId('pn-toast')).toContainText(
    '3 notes from the private brainstorm are now on the board',
  )
  for (const s of [alice, bob]) {
    await expect.poll(async () => (await placedNotes(s.page, sid)).length, { timeout: 20_000 }).toBe(3)
    const notes = await placedNotes(s.page, sid)
    expect(new Set(notes.map((n) => n.text)).size).toBe(3)
    await expectEveryNoteInFrame(s.page, notes, 'shape:retro')
    for (const n of notes) {
      expect(n.author).toBeNull()
      expect(n.privateNote).toEqual({ session: sid })
      expect(JSON.stringify(await item(s.page, n.id))).not.toMatch(/usr_/)
    }
    // …and no note-author label on them (the tldraw spec's attribution check)
    await showAll(s.page)
    await expect(
      authorLabels(
        s.page,
        notes.map((n) => n.id),
      ),
    ).toHaveCount(0)
  }
  expect((await alice.api.fetch('POST', `/api/private-brainstorms/${sid}/reveal`)).status()).toBe(200)
  await alice.page.waitForTimeout(500) // a duplicate would arrive over the socket within this
  expect(await placedNotes(bob.page, sid)).toHaveLength(3)
})

test('private notes: when the canvas is down at reveal, the facilitator is offered "Place notes" and drafts are frozen', async ({
  join,
  board,
  stack,
}) => {
  const alice = await join('alice', 'owner')
  const bob = await join('bob', 'editor')
  await startBrainstorm(alice.page, { prompt: 'Risks?', anonymous: false, target: 'new' })
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
    const bobNote = (await privateState(bob, board)).myNotes[0]?.id
    expect((await bob.api.fetch('PATCH', `/api/private-notes/${bobNote}`, { text: 'x' })).status()).toBe(409)
  } finally {
    await stack.sync.start()
  }
  await expect(alice.page.getByTestId('conn-status')).toHaveAttribute('data-state', 'online', {
    timeout: 30_000,
  })
})

test('private notes: once the canvas is back, "Place notes" finishes a reveal that failed (CR 2F-2)', async ({
  join,
  board,
  stack,
}) => {
  const alice = await join('alice', 'owner')
  const bob = await join('bob', 'editor')
  await startBrainstorm(alice.page, { prompt: 'Risks?', anonymous: false, target: 'new' })
  const sid = (await privateState(alice, board)).session?.id as string
  await writeNote(bob.page, 'Risk: the vendor is late', 'red')
  await stack.sync.kill()
  try {
    await alice.page.getByTestId('pn-reveal').click()
    await expect(alice.page.getByTestId('pn-place')).toBeVisible()
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
    backgroundColor: '#ef8c82',
  })
})

test('private notes: cancel discards drafts; a double Ctrl+Enter adds a note once; nothing reaches the board', async ({
  join,
  board,
}) => {
  const alice = await join('alice', 'owner')
  const bob = await join('bob', 'editor')
  await startBrainstorm(alice.page, { prompt: 'Second round', anonymous: true, target: 'new' })
  const second = (await privateState(alice, board)).session?.id as string
  await writeNote(bob.page, 'Never shown to anyone', 'violet')
  const compose = (await openPanel(bob.page)).getByTestId('pn-compose-text')
  await bob.net.settle()
  const addRequests = () => bob.net.responses.filter((r) => r.path.endsWith('/notes')).length
  const before = addRequests()
  await compose.fill('Only once')
  await compose.evaluate((el) => {
    for (let i = 0; i < 2; i++)
      el.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true, cancelable: true }),
      )
  })
  await expect(compose).toHaveValue('')
  await bob.page.waitForTimeout(750) // a second request would have been answered by now
  await bob.net.settle()
  expect(addRequests()).toBe(before + 1)
  expect((await privateState(bob, board)).myNotes.filter((n) => n.text === 'Only once')).toHaveLength(1)
  await alice.page.getByTestId('pn-cancel').click()
  await alice.page.getByTestId('pn-cancel-confirm').click()
  await expect(bob.page.getByTestId('pn-toast')).toContainText('cancelled')
  await expect(bob.page.getByTestId('pn-chip')).toHaveCount(0)
  expect(await placedNotes(bob.page, second)).toEqual([])
  const aliceSawSecond = await everythingSeen(alice)
  expect(aliceSawSecond).not.toContain('Never shown to anyone')
  expect(aliceSawSecond).not.toContain('Only once')
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
  await capture('lc-private-notes-dialog-phone-dark.png', alice.page, testInfo)
  const box = await dialog.boundingBox()
  expect(box && box.x >= 0 && box.x + box.width <= 390).toBe(true)
  await dialog.getByTestId('pn-setup-submit').click()
  const panel = alice.page.getByTestId('pn-panel')
  await expect(panel).toBeVisible()
  await panel.getByTestId('pn-compose-text').fill('A note on a phone')
  await panel.getByTestId('pn-add').click()
  await expect(panel.getByTestId('pn-note-text')).toHaveText('A note on a phone')
  await capture('lc-private-notes-panel-phone-dark.png', alice.page, testInfo)
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
})

// ---- workshops-3.fix.spec.ts --------------------------------------------------------------------------------

const PROMPT = 'What went well this sprint?'

interface FrameInfo {
  id: string
  name: string
  frameId: string | null
  bounds: { x: number; y: number; width: number; height: number }
  children: number
}

async function frames(page: Page): Promise<FrameInfo[]> {
  const all = await items(page)
  const out: FrameInfo[] = []
  for (const f of all.filter((e) => e.type === 'frame')) {
    const b = await itemBounds(page, f.id)
    out.push({
      id: f.id,
      name: String((f as { name?: string | null }).name ?? ''),
      frameId: f.frameId,
      bounds: b ?? { x: 0, y: 0, width: 0, height: 0 },
      children: all.filter((e) => e.frameId === f.id && !(e.type === 'text' && e.containerId)).length,
    })
  }
  return out
}

const overlap = (a: FrameInfo['bounds'], b: FrameInfo['bounds']) =>
  a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height

/** A retro frame with six notes, fitted in the view (as in the review: "2 · What went well"). */
async function busyFrameInView(page: Page) {
  await seed(page, {
    frames: [{ id: 'wentwell', x: -560, y: 216, w: 800, h: 960, name: '2 · What went well' }],
    notes: Array.from({ length: 6 }, (_, i) => ({
      id: `ww${i}`,
      x: -560 + 40 + (i % 3) * 240,
      y: 216 + 84 + Math.floor(i / 3) * 240,
      frameId: 'wentwell',
    })),
  })
  await page.evaluate(() =>
    (
      window as unknown as { __lobbyBoard: { canvas: { viewport: { fit(ids?: string[]): void } } } }
    ).__lobbyBoard.canvas.viewport.fit(['wentwell']),
  )
}

async function startBrainstorm3(page: Page, target: 'new' | 'selected') {
  await startBrainstorm(page, { prompt: PROMPT, anonymous: true, target })
}

test('private notes: a new "Private ideas" frame lands in free space, is shown, and Cancel removes it (DANA2-02, R2-01)', async ({
  join,
}, testInfo) => {
  // Two starts: by a host of its own, as the tests after it (the api allows a person 10 starts a minute,
  // private-notes.ts `startsPerMinute`, and alice's in the tests before it use them up once reveals pass)
  const host = await join('dana', 'editor')
  const page = host.page
  await busyFrameInView(page)
  await expect.poll(async () => (await frames(page)).length).toBe(1)

  // Nothing selected: the only option is a new frame in view.
  await startBrainstorm3(page, 'new')
  await expect.poll(async () => (await frames(page)).length).toBe(2)
  const all = await frames(page)
  const created = all.find((f) => f.name === 'Private ideas')
  const existing = all.find((f) => f.id === 'wentwell')
  expect(created, JSON.stringify(all)).toBeTruthy()
  expect(existing).toBeTruthy()
  if (!created || !existing) return
  // Top level, beside (not over, not inside) the frame that was in view.
  expect(created.frameId).toBeNull()
  expect(overlap(created.bounds, existing.bounds)).toBe(false)
  // The camera shows it (once the panel has taken its width).
  await expect.poll(async () => within(await viewport(page), created.bounds), { timeout: 5_000 }).toBe(true)
  expect(existing.children).toBe(6)
  await capture('lc-workshops3-started-new-frame.png', page, testInfo)

  // Cancel: the empty frame made for it goes away again.
  const panel = page.getByTestId('pn-panel')
  await panel.getByTestId('pn-cancel').click()
  await panel.getByTestId('pn-cancel-confirm').click()
  await expect(page.getByTestId('pn-toast')).toContainText('cancelled')
  await expect.poll(async () => (await frames(page)).map((f) => f.name)).toEqual(['2 · What went well'])
  await expect(panel.getByTestId('pn-ended')).toHaveAttribute('data-state', 'cancelled')

  // A second brainstorm on a board whose view is full of frames never overlaps the first frame.
  await startBrainstorm3(page, 'new')
  await expect.poll(async () => (await frames(page)).length).toBe(2)
  const again = await frames(page)
  expect(again.filter((f) => f.name === 'Private ideas')).toHaveLength(1)
  for (const f of again) expect(f.frameId, f.name).toBeNull()
  for (const x of again)
    for (const y of again)
      if (x.id !== y.id) expect(overlap(x.bounds, y.bounds), `${x.name} × ${y.name}`).toBe(false)
})

test('private notes: "Add your notes" puts the keyboard in the note box; Enter adds, Shift+Enter new line (A11Y2-01, R2-06)', async ({
  join,
}, testInfo) => {
  const host = await join('dave', 'editor')
  const bob = await join('bob', 'editor')
  await startBrainstorm3(host.page, 'new')

  const card = bob.page.getByTestId('pn-start-prompt')
  await expect(card).toBeVisible()
  await expect(bob.page.getByTestId('pn-start-announce')).toContainText(
    `Private brainstorm started: ${PROMPT}`,
  )
  await card.getByTestId('pn-start-prompt-write').click()
  const panel = bob.page.getByTestId('pn-panel')
  const compose = panel.getByTestId('pn-compose-text')
  await expect(compose).toBeFocused()

  // Typed as a person would: every key goes into the note ("e" is the eraser, "t" the text tool).
  await bob.page.keyboard.type('Live on stage')
  await expect(compose).toHaveValue('Live on stage')
  expect(await tool(bob.page)).toBe('select')

  await expect(panel.getByTestId('pn-compose-keys')).toBeVisible()
  await expect(panel.getByTestId('pn-compose-keys')).toContainText('Enter to add')
  await capture('lc-workshops3-typed-in-composer.png', bob.page, testInfo)
  await bob.page.keyboard.press('Enter')
  await expect(panel.getByTestId('pn-note-text')).toHaveText(['Live on stage'])
  await expect(compose).toHaveValue('')
  await expect(compose).toBeFocused()

  await bob.page.keyboard.type('Cold open')
  await bob.page.keyboard.press('Shift+Enter')
  await bob.page.keyboard.type('on the boss')
  await expect(compose).toHaveValue('Cold open\non the boss')
  await bob.page.keyboard.press('Enter')
  await expect(panel.getByTestId('pn-note-text')).toHaveCount(2)
  expect(await tool(bob.page)).toBe('select')

  // The top-bar chip does the same once the panel is closed.
  await bob.page.getByTestId('dock-panel-close').click()
  await expect(panel).toHaveCount(0)
  await bob.page.getByTestId('pn-chip').click()
  await expect(bob.page.getByTestId('pn-compose-text')).toBeFocused()
  await bob.page.keyboard.type('Stream it')
  await expect(bob.page.getByTestId('pn-compose-text')).toHaveValue('Stream it')
  expect(await tool(bob.page)).toBe('select')
})

test('private notes on a phone: the panel shows the timer and "Time\'s up" until it is tapped (R2-02)', async ({
  join,
  board,
}, testInfo) => {
  const host = await join('erin', 'editor')
  const bob = await join('bob', 'editor')
  await bob.page.setViewportSize({ width: 390, height: 844 })
  await startBrainstorm3(host.page, 'new')
  await bob.page.getByTestId('pn-start-prompt-write').click()
  const panel = bob.page.getByTestId('pn-panel')
  await expect(panel.getByTestId('pn-compose-text')).toBeFocused()
  await bob.page.keyboard.type('Friendly team')
  await bob.page.keyboard.press('Enter')
  await expect(panel.getByTestId('pn-note-text')).toHaveText(['Friendly team'])

  expect(
    (await post(host, `/api/boards/${board}/timer`, { action: 'start', durationMs: 4_000 })).status(),
  ).toBe(200)
  const timer = panel.getByTestId('pn-timer')
  await expect(timer).toHaveAttribute('data-state', 'running')
  await expect(timer).toBeInViewport()
  await capture('lc-workshops3-phone-timer-running.png', bob.page, testInfo)
  await expect(timer).toHaveAttribute('data-state', 'finished', { timeout: 10_000 })
  await expect(timer).toContainText("Time's up")
  await expect(timer).toBeInViewport()
  await bob.page.waitForTimeout(4_500) // it stays until tapped (well past the canvas flash's 4 s)
  await expect(timer).toContainText("Time's up")
  await timer.click()
  await expect(timer).toHaveCount(0)
  await bob.page.waitForTimeout(600)
  await expect(timer).toHaveCount(0)
})

test('private notes on a phone: after the reveal the panel closes onto the notes (R2-03) (CR 2F-2)', async ({
  join,
}) => {
  const host = await join('erin', 'editor')
  const bob = await join('bob', 'editor')
  await bob.page.setViewportSize({ width: 390, height: 844 })
  await startBrainstorm3(host.page, 'new')
  await bob.page.getByTestId('pn-start-prompt-write').click()
  const panel = bob.page.getByTestId('pn-panel')
  await bob.page.keyboard.type('Friendly team')
  await bob.page.keyboard.press('Enter')
  await expect(panel.getByTestId('pn-note-text')).toHaveText(['Friendly team'])
  await host.page.getByTestId('pn-panel').getByTestId('pn-reveal').click()
  await expect(panel).toHaveCount(0, { timeout: 15_000 })
  const placed = async () =>
    (await items(bob.page)).filter((e) => e.type === 'stickynote' && !!sessionOf(e)).map((e) => e.id)
  await expect.poll(async () => (await placed()).length).toBe(1)
  const [id] = await placed()
  await expect
    .poll(async () => {
      const [v, b] = await Promise.all([viewport(bob.page), itemBounds(bob.page, id as string)])
      return !!b && within(v, b)
    })
    .toBe(true)
  await bob.page.getByTestId('dock-rail-toggle').click()
  await bob.page.getByTestId('dock-tab-private-notes').click()
  await expect(bob.page.getByTestId('pn-ended')).toHaveAttribute('data-state', 'placed')
  await expect(bob.page.getByTestId('pn-ended')).toContainText('1 note')
})

test('a phone keeps a reminder of the open brainstorm, after writing and after a reload (R2-12)', async ({
  join,
}, testInfo) => {
  const host = await join('carol', 'editor')
  const bob = await join('bob', 'editor')
  await bob.page.setViewportSize({ width: 390, height: 844 })
  await startBrainstorm3(host.page, 'new')
  await expect(bob.page.getByTestId('pn-start-prompt')).toBeVisible()
  await expect(bob.page.getByTestId('pn-reminder')).toHaveCount(0)
  await bob.page.getByTestId('pn-start-prompt-write').click()
  await bob.page.keyboard.type('Friendly team')
  await bob.page.keyboard.press('Enter')
  await expect(bob.page.getByTestId('pn-note-text')).toHaveText(['Friendly team'])
  await bob.page.getByTestId('dock-panel-close').click()
  const reminder = bob.page.getByTestId('pn-reminder')
  await expect(reminder).toContainText('Your notes (1)')
  await reloadBoard(bob)
  await expect(reminder).toBeVisible()
  await expect(reminder).toBeInViewport()
  await capture('lc-workshops3-phone-reminder-after-reload.png', bob.page, testInfo)
  await reminder.click()
  await expect(bob.page.getByTestId('pn-compose-text')).toBeFocused()
  await expect(bob.page.getByTestId('pn-note-text')).toHaveText(['Friendly team'])
  await expect(reminder).toHaveCount(0)
})

// ---- workshops-2.fix.spec.ts ---------------------------------------------------------------------------------

test('private notes: text typed while the previous note is still saving is kept (F6)', async ({ join }) => {
  const alice = await join('alice', 'owner')
  const bob = await join('bob', 'editor')
  await startBrainstorm(alice.page, {
    prompt: 'What would make the trailer unmissable?',
    anonymous: false,
    target: 'new',
  })
  const panel = await openPanel(bob.page)
  const compose = panel.getByTestId('pn-compose-text')

  // A slow network (staging): each "Add note" answer takes 1.5 s.
  await bob.page.route('**/api/private-brainstorms/*/notes', async (route) => {
    await new Promise((r) => setTimeout(r, 1500))
    await route.continue()
  })
  await compose.fill('First idea')
  await panel.getByTestId('pn-add').click()
  expect.soft(await compose.inputValue()).toBe('')
  expect.soft(await compose.evaluate((el) => el === document.activeElement)).toBe(true)
  await compose.fill('Second idea')
  await expect(panel.getByTestId('pn-note-text').filter({ hasText: 'First idea' })).toBeVisible()
  await expect(compose).toHaveValue('Second idea')
  await panel.getByTestId('pn-add').click()
  await expect(panel.getByTestId('pn-note-text')).toHaveText(['First idea', 'Second idea'])
  await bob.page.unroute('**/api/private-brainstorms/*/notes')

  // A refused note comes back to try again, ahead of anything typed since.
  await bob.page.route('**/api/private-brainstorms/*/notes', async (route) => {
    await new Promise((r) => setTimeout(r, 800))
    await route.fulfill({
      status: 429,
      contentType: 'application/json',
      body: JSON.stringify({ error: { code: 'RATE_LIMITED', message: 'That is a lot of changes.' } }),
    })
  })
  await compose.fill('Third idea')
  await panel.getByTestId('pn-add').click()
  await compose.pressSequentially('Fourth')
  await expect(panel.getByTestId('pn-error')).toBeVisible()
  await expect(compose).toHaveValue('Third idea\n\nFourth')
  await bob.page.unroute('**/api/private-brainstorms/*/notes')
})

const guestLinkUrl = async (owner: WorkshopCanvasSession, board: string) => {
  const res = await post(owner, `/api/boards/${board}/review-links`, { role: 'editor', allowGuests: true })
  expect(res.status(), await res.text()).toBe(201)
  return ((await res.json()) as { url: string }).url
}

test('private notes: a guest cannot start a brainstorm, but writes in one (SEAM-07, the part before the reveal)', async ({
  join,
  browser,
  board,
}) => {
  const alice = await join('alice', 'owner')
  const bob = await join('bob', 'editor')
  const context = await browser.newContext({ viewport: { width: 1280, height: 820 } })
  try {
    const page = await context.newPage()
    await page.goto(await guestLinkUrl(alice, board))
    await page.getByTestId('invite-guest-name').fill('Troll')
    await page.getByTestId('invite-guest-join').click()
    await expect(page).toHaveURL(/\/b\/[a-z0-9-]+$/, { timeout: 30_000 })
    await waitForWorkshopBoard(page)
    const guestTools = await openWorkshopPopover(page)
    await expect(guestTools.getByTestId('pn-start')).toHaveCount(0)
    await closeWorkshopPopover(page)
    await startBrainstorm(bob.page, {
      prompt: 'What would make the trailer unmissable?',
      anonymous: true,
      target: 'new',
    })
    await writeNote(page, 'Something nobody should see')
    await writeNote(bob.page, 'A real idea from bob')
    await expect(bob.page.getByTestId('pn-counts')).toHaveText('2 notes from 2 people')
  } finally {
    await context.close()
  }
})

test('private notes: a guest removed mid-session keeps their draft off the board (SEAM-07) (CR 2F-2)', async ({
  join,
  browser,
  board,
}) => {
  const alice = await join('alice', 'owner')
  const bob = await join('bob', 'editor')
  const context = await browser.newContext({ viewport: { width: 1280, height: 820 } })
  try {
    const page = await context.newPage()
    await page.goto(await guestLinkUrl(alice, board))
    await page.getByTestId('invite-guest-name').fill('Troll')
    await page.getByTestId('invite-guest-join').click()
    await expect(page).toHaveURL(/\/b\/[a-z0-9-]+$/, { timeout: 30_000 })
    await waitForWorkshopBoard(page)
    const guestId = (await page.getByTestId('user-menu').getAttribute('data-user-id')) ?? ''
    await startBrainstorm(bob.page, {
      prompt: 'What would make the trailer unmissable?',
      anonymous: true,
      target: 'new',
    })
    await writeNote(page, 'Something nobody should see')
    await writeNote(bob.page, 'A real idea from bob')
    expect((await alice.api.fetch('DELETE', `/api/boards/${board}/members/${guestId}`)).status()).toBe(200)
    await (await openPanel(bob.page)).getByTestId('pn-reveal').click()
    await expect(bob.page.getByTestId('pn-toast')).toContainText(
      '1 note from the private brainstorm is now on the board',
    )
    const texts = JSON.stringify((await items(bob.page)).filter((e) => !!e.customData?.lobbyServer))
    expect(texts).toContain('A real idea from bob')
    expect(texts).not.toContain('Something nobody should see')
  } finally {
    await context.close()
  }
})

// ---- facilitation-polish.fix.spec.ts (R1) --------------------------------------------------------------------

test('R1: 16 notes revealed into a retro column keep its width and never reach the frame beside it (CR 2F-2)', async ({
  board,
  join,
}) => {
  const alice = await join('alice')
  const bob = await join('bob', 'editor')
  await seed(alice.page, {
    frames: ['2 · What went well', '3 · What to improve', '4 · Actions'].map((name, i) => ({
      id: `fp-col${i}`,
      x: i * 880,
      y: 0,
      w: 800,
      h: 960,
      name,
    })),
    notes: Array.from({ length: 3 }, (_, i) => ({
      id: `fp-prompt${i}`,
      x: 880 + 40 + i * 180,
      y: 120,
      frameId: 'fp-col1',
    })),
  })
  await expectItemsEverywhere([bob], ['fp-prompt2'])
  const target = { frameId: 'shape:fp-col1', pageId: 'page:page', x: 880, y: 0, w: 800, h: 960 }
  const started = await post(alice, `/api/boards/${board}/private-brainstorm`, {
    prompt: 'What slowed us down this sprint?',
    anonymous: true,
    target,
  })
  expect(started.status()).toBe(201)
  const sid = ((await started.json()) as { session: { id: string } }).session.id
  for (let i = 0; i < 16; i++)
    expect(
      (
        await post(i % 2 ? bob : alice, `/api/private-brainstorms/${sid}/notes`, {
          text: `Friction ${i}`,
          color: 'yellow',
        })
      ).status(),
    ).toBe(201)
  expect((await post(alice, `/api/private-brainstorms/${sid}/reveal`)).status()).toBe(200)
  await expect.poll(async () => (await placedNotes(alice.page, sid)).length).toBe(16)
  const [left, mid, right] = await Promise.all(
    ['fp-col0', 'fp-col1', 'fp-col2'].map((id) => itemBounds(alice.page, id)),
  )
  if (!left || !mid || !right) throw new Error('no frame bounds')
  expect(mid).toMatchObject({ x: 880, y: 0, width: 800 })
  expect(mid.height).toBeGreaterThan(960)
  expect(left).toMatchObject({ x: 0, width: 800, height: 960 })
  expect(right).toMatchObject({ x: 1760, width: 800, height: 960 })
  for (const n of await placedNotes(alice.page, sid)) {
    expect(n.frameId).toBe('fp-col1')
    const b = await itemBounds(alice.page, n.id)
    expect(b && b.x >= 880 && b.x + b.width <= 1680).toBe(true)
  }
})
