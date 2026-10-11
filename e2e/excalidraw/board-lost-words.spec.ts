// Hotfix H2 (wave M follow-up 0, docs/PROGRESS.md): words typed into a label that was just made were lost
// when its editor closed before the room acknowledged the label's create. Seen in ai-actions' "DEMO 1:00"
// (N, a click, the idea typed, Escape) about 1 run in 3 with permessage-deflate on; the deployed web too, on
// any network whose ack takes longer than typing a few words. The label stayed empty on every tab while the
// page said Saved.
//
// Deterministic here: alice's board socket is relayed (spike-b/support/relay.ts), and from the moment her page
// pushes the label's create (`isTextCreate`) every frame the room sends her is held (`holdDown`): the create's
// `changes` echo and its `ack` reach her page only after she typed and left the editor. Her own frames still
// go up at once, and the relay records each one (`watchUp`), so each test also checks the order the lease
// needs: the push that writes the words goes up BEFORE the lease's release (only the holder writes its words,
// AGENTS.md). The server's test snapshot is the truth; every test ends with the words on both tabs, on the
// server, and on alice's page after a reload.
//
// The variants: a note made with N or the toolbar's Note (the New element rule: its editor opens at once and
// Excalidraw makes the label while the lease is still pending), left with Escape, Tab or Ctrl/Cmd+Enter (the
// next note) or a click away; a free text (T: its own create goes up before its lease is asked for); a
// rectangle's label and an arrow's label (bound text) made after the grant (Lobby's own requests), with bob
// asking for the rectangle's lease right after alice left it; keys typed while a note's lease is pending (the
// "Opening the note… (N typed)" buffer, the grant held with the lease hook), more typed once it opened.
// Before the fix the notes lost every word (the label stayed empty everywhere, Saved showing) and the labels
// made after the grant had their words pushed after the release, by a non-holder; the free text passed.
//
//   cd e2e && E2E_PORT_BASE=<base> pnpm exec playwright test excalidraw/board-lost-words.spec.ts --project=chromium

import type { Page } from '@playwright/test'
import { holdDown, watchUp } from '../spike-b/support/relay.ts'
import { waitForValue } from '../tests/support/board.ts'
import {
  type CanvasSession,
  createItem,
  createNote,
  dblclickItem,
  editingId,
  expect,
  expectSaved,
  items,
  itemText,
  select,
  TEXT_EDITOR,
  test,
  waitForCanvas,
  waitForItem,
} from '../tests/support/canvas.ts'
import { leaseHook, openRelayedCanvasSession, storedElement } from '../tests/support/excalidraw.ts'
import type { Stack } from '../tests/support/stack.ts'
import { emptyCanvasPoint, focusBoard, settled } from './board-kit.ts'
import { waitForCanvasUx } from './canvas-ux-kit.ts'

test.use({ viewport: { width: 1440, height: 900 } })

const WORDS = 'Let the villain narrate the ending'

// ---- the page's frames, as the relay saw them go up -----------------------------------------------------

interface UpOp {
  readonly k: string
  readonly id: string
  /** a create's element type */
  readonly type?: string
  /** the op as sent (kept in memory for the order checks, never printed) */
  readonly json: string
}

interface UpFrame {
  readonly type: string
  /** a lease message's lease id */
  readonly id?: string
  readonly ops: readonly UpOp[]
}

function parseUp(frame: string | Buffer): UpFrame | null {
  if (typeof frame !== 'string') return null
  try {
    const m = JSON.parse(frame) as {
      type?: string
      id?: unknown
      ops?: { k: string; id?: string; el?: { id?: string; type?: string } }[]
    }
    return {
      type: m.type ?? '?',
      ...(typeof m.id === 'string' ? { id: m.id } : {}),
      ops: (m.ops ?? []).map((op) => ({
        k: op.k,
        id: (op.k === 'c' ? op.el?.id : op.id) ?? '',
        ...(op.el?.type ? { type: op.el.type } : {}),
        json: JSON.stringify(op),
      })),
    }
  } catch {
    return null
  }
}

/** A push of the page that creates a text element: the label Excalidraw makes when its editor opens, or a free text. */
const isTextCreate = (frame: string | Buffer): boolean => {
  const f = parseUp(frame)
  return f?.type === 'push' && f.ops.some((op) => op.k === 'c' && op.type === 'text')
}

/** Records every frame `page` sends from now on; returns the log and the removal. */
function recordUp(page: Page): { log: UpFrame[]; stop: () => void } {
  const log: UpFrame[] = []
  const stop = watchUp(page, (m) => {
    const f = parseUp(m)
    if (f) log.push(f)
  })
  return { log, stop }
}

/**
 * Where the words went up (the first push with an op on `label` carrying them) and where the release of
 * `lease` did (-1: not sent).
 */
function orderOf(log: readonly UpFrame[], label: string, lease: string, words: string) {
  const wordsAt = log.findIndex(
    (f) =>
      f.type === 'push' && f.ops.some((op) => op.id === label && op.json.includes(JSON.stringify(words))),
  )
  const releaseAt = log.findIndex((f) => f.type === 'lease.release' && f.id === lease)
  return { wordsAt, releaseAt }
}

/** The holder wrote its words: they went up, and before the lease's release (if the release went up yet). */
function expectHolderOrder(log: readonly UpFrame[], label: string, lease: string, words: string): void {
  const { wordsAt, releaseAt } = orderOf(log, label, lease, words)
  expect(wordsAt, 'a push of this tab carried the words').toBeGreaterThanOrEqual(0)
  expect(releaseAt, 'the release went up').toBeGreaterThanOrEqual(0)
  expect(wordsAt, 'the words went up before the lease was released (the holder writes them)').toBeLessThan(
    releaseAt,
  )
}

// ---- reading the words back -----------------------------------------------------------------------------

const storedText = async (stack: Stack, board: string, id: string): Promise<string | null> =>
  ((await storedElement(stack, board, id)) as { originalText?: string; isDeleted?: boolean } | null)
    ?.originalText ?? null

/** The words are on the server (the label), in every page (its container's text), and after a reload of `reloaded`. */
async function expectWordsEverywhere(
  stack: Stack,
  board: string,
  o: { container: string; label: string; words: string; pages: readonly Page[]; reloaded: Page },
): Promise<void> {
  await expect.poll(() => storedText(stack, board, o.label), { message: 'the stored label' }).toBe(o.words)
  for (const p of o.pages)
    await expect.poll(() => itemText(p, o.container), { message: 'a tab’s label' }).toBe(o.words)
  await o.reloaded.reload()
  await waitForCanvas(o.reloaded)
  await expect.poll(() => itemText(o.reloaded, o.container), { message: 'after a reload' }).toBe(o.words)
  await expectSaved(o.reloaded)
}

// ---- driving the editor -----------------------------------------------------------------------------------

/** The open editor has the keyboard and takes text (a granted lease, or the New element rule's open). */
async function waitWritable(page: Page): Promise<void> {
  const editor = page.locator(TEXT_EDITOR)
  await expect(editor).toBeFocused()
  await expect(editor).toHaveJSProperty('readOnly', false)
}

type Leave = (page: Page) => Promise<void>
const pressEscape: Leave = (page) => page.keyboard.press('Escape')
/**
 * The quick ways on from a note (canvas-ux ported/notes.ts, RETRO-09): Tab and Ctrl/Cmd+Enter commit the words
 * and open the next note beside or below it, through the lease (its editor waits for its grant, held here).
 */
const nextNoteBeside: Leave = (page) => page.keyboard.press('Tab')
const nextNoteBelow: Leave = (page) => page.keyboard.press('ControlOrMeta+Enter')
/** A click on empty canvas: the editor's blur submits it. */
const clickAway: Leave = async (page) => {
  const p = await emptyCanvasPoint(page)
  await page.mouse.click(p.x, p.y)
}

/** A point on the canvas, as a share of the canvas region. */
async function canvasPoint(page: Page, fx: number, fy: number) {
  const box = await page.locator('[data-lobby-board-canvas]').boundingBox()
  if (!box) throw new Error('no board canvas')
  return { x: box.x + box.width * fx, y: box.y + box.height * fy }
}

/** The bound text of `container` in `page`'s scene (its label), or null. */
async function labelOf(page: Page, container: string): Promise<string | null> {
  const els = (await items(page)) as unknown as { id: string; type: string; containerId?: string | null }[]
  return els.find((e) => e.type === 'text' && e.containerId === container)?.id ?? null
}

/**
 * The race, on `a` (relayed): from the moment its page pushes a text create, the room's frames are held;
 * `open` opens a new label's editor (and returns the container), the words are typed once the label's create
 * went up, `leave` leaves the editor, then the held frames go through. Returns the ids and the frames sent.
 */
async function typeBeforeTheAck(
  a: CanvasSession,
  open: () => Promise<void>,
  find: () => Promise<{ container: string; label: string; lease: string }>,
  leave: Leave,
  words = WORDS,
): Promise<{ container: string; label: string; lease: string; log: UpFrame[] }> {
  const up = recordUp(a.page)
  const hold = holdDown(a.page, { when: isTextCreate, ms: 15_000 })
  let ids: { container: string; label: string; lease: string }
  try {
    await open()
    // the text element's create went up: the room's echo and ack of it are held from here on
    await hold.started
    ids = await find()
    await waitWritable(a.page)
    await a.page.keyboard.type(words)
    await leave(a.page)
    await expect(a.page.locator(TEXT_EDITOR)).toHaveCount(0)
    // whatever the page sends when the editor closes goes up while the room's answers are still held
    await a.page.waitForTimeout(300)
    expect(hold.held(), 'the room’s ack of the create is still held (the race window)').toContain('ack')
  } finally {
    hold.release()
  }
  // what goes up once the room's answers arrive is recorded too, until Saved
  try {
    await expectSaved(a.page)
  } finally {
    up.stop()
  }
  return { ...ids, log: up.log }
}

/** Presses N (or clicks the toolbar's Note), then clicks the canvas; returns `find` for the new note. */
function newNoteWith(a: CanvasSession, via: 'key' | 'toolbar') {
  let before = new Set<string>()
  return {
    open: async () => {
      before = new Set((await items(a.page)).map((e) => e.id))
      await focusBoard(a.page)
      if (via === 'key') await a.page.keyboard.press('n')
      else await a.page.getByTestId('tools.note').click()
      const at = await canvasPoint(a.page, 0.45, 0.45)
      await a.page.mouse.click(at.x, at.y)
    },
    find: async () => {
      const note = (await items(a.page)).find((e) => !before.has(e.id) && e.type === 'stickynote')
      if (!note) throw new Error('no note was made')
      const label = await waitForValue(() => labelOf(a.page, note.id), { message: 'the new note’s label' })
      return { container: note.id, label, lease: note.id }
    },
  }
}

async function alice(
  browser: Parameters<typeof openRelayedCanvasSession>[0],
  board: string,
  users: { get(h: string): Promise<Parameters<typeof openRelayedCanvasSession>[2]> },
): Promise<CanvasSession> {
  const a = await openRelayedCanvasSession(browser, board, await users.get('alice'))
  await waitForCanvasUx(a.page)
  return a
}

// ---- the New element rule: a note made with the note tool ---------------------------------------------------

for (const [name, via, leave] of [
  ['N, a click, the words, Escape', 'key', pressEscape],
  ['the toolbar’s Note, a click, the words, Escape', 'toolbar', pressEscape],
  ['N, a click, the words, Tab (the next note beside)', 'key', nextNoteBeside],
  ['N, a click, the words, Ctrl/Cmd+Enter (the next note below)', 'key', nextNoteBelow],
  ['N, a click, the words, a click away', 'key', clickAway],
] as const) {
  test(`H2: ${name} before the label’s create is acknowledged: the words are saved, by the lease holder`, async ({
    browser,
    canvasSession,
    stack,
    board,
    users,
  }) => {
    const a = await alice(browser, board, users)
    try {
      const b = await canvasSession('bob')
      const note = newNoteWith(a, via)
      const r = await typeBeforeTheAck(a, note.open, note.find, leave)
      await expectWordsEverywhere(stack, board, {
        container: r.container,
        label: r.label,
        words: WORDS,
        pages: [a.page, b.page],
        reloaded: a.page,
      })
      expectHolderOrder(r.log, r.label, r.lease, WORDS)
    } finally {
      await a.context.close()
    }
  })
}

// ---- a free text (the T tool): its create goes before its lease is asked for -----------------------------------

test('H2: T, a click, the words, Escape while the text’s create and the grant are held: the words are saved', async ({
  browser,
  canvasSession,
  stack,
  board,
  users,
}) => {
  const a = await alice(browser, board, users)
  try {
    const b = await canvasSession('bob')
    let before = new Set<string>()
    const r = await typeBeforeTheAck(
      a,
      async () => {
        before = new Set((await items(a.page)).map((e) => e.id))
        await focusBoard(a.page)
        await a.page.keyboard.press('t')
        const at = await canvasPoint(a.page, 0.5, 0.5)
        await a.page.mouse.click(at.x, at.y)
      },
      async () => {
        const t = (await items(a.page)).find((e) => !before.has(e.id) && e.type === 'text')
        if (!t) throw new Error('no text was made')
        return { container: t.id, label: t.id, lease: t.id }
      },
      pressEscape,
    )
    await expectWordsEverywhere(stack, board, {
      container: r.container,
      label: r.label,
      words: WORDS,
      pages: [a.page, b.page],
      reloaded: a.page,
    })
    expectHolderOrder(r.log, r.label, r.lease, WORDS)
  } finally {
    await a.context.close()
  }
})

// ---- a label made after the grant (Lobby's own requests): a rectangle's, an arrow's ---------------------------

test('H2: Enter on a rectangle, the words, Escape before its label’s ack; bob asks for the label at once: the words are still alice’s', async ({
  browser,
  canvasSession,
  stack,
  board,
  users,
}) => {
  const a = await alice(browser, board, users)
  try {
    const b = await canvasSession('bob')
    const rect = await settled(
      a.page,
      createItem(a.page, 'rectangle', { x: 200, y: 160, width: 260, height: 160 }),
    )
    await waitForItem(b.page, rect)
    const r = await typeBeforeTheAck(
      a,
      async () => {
        await focusBoard(a.page)
        await select(a.page, [rect])
        await a.page.keyboard.press('Enter') // P1: the lease first, then Excalidraw's Enter makes the label
      },
      async () => {
        const label = await waitForValue(() => labelOf(a.page, rect), { message: 'the rectangle’s label' })
        return { container: rect, label, lease: rect }
      },
      async (page) => {
        await pressEscape(page)
        await expect(page.locator(TEXT_EDITOR)).toHaveCount(0)
        // bob double-clicks the rectangle right away: while alice's words are not written, the lease is hers
        await dblclickItem(b.page, rect)
        await b.page.waitForTimeout(500)
      },
    )
    // whatever bob got (a deny while alice's words were unsent), his editor is left as it is
    if ((await editingId(b.page)) !== null) {
      await b.page.keyboard.press('Escape')
      await expect.poll(() => editingId(b.page)).toBeNull()
    }
    await expectWordsEverywhere(stack, board, {
      container: rect,
      label: r.label,
      words: WORDS,
      pages: [a.page, b.page],
      reloaded: a.page,
    })
    expectHolderOrder(r.log, r.label, r.lease, WORDS)
  } finally {
    await a.context.close()
  }
})

test('H2: a double-click on an arrow, the words in its new label (a bound text), Escape before the label’s ack: the words are saved', async ({
  browser,
  canvasSession,
  stack,
  board,
  users,
}) => {
  const a = await alice(browser, board, users)
  try {
    const b = await canvasSession('bob')
    const arrow = await settled(
      a.page,
      createItem(a.page, 'arrow', {
        x: 160,
        y: 260,
        width: 360,
        height: 0,
        points: [
          [0, 0],
          [360, 0],
        ],
      }),
    )
    await waitForItem(b.page, arrow)
    const words = 'depends on'
    const r = await typeBeforeTheAck(
      a,
      async () => {
        await focusBoard(a.page)
        await dblclickItem(a.page, arrow) // P3: the arrow's label, through the lease
      },
      async () => {
        const label = await waitForValue(() => labelOf(a.page, arrow), { message: 'the arrow’s label' })
        return { container: arrow, label, lease: arrow }
      },
      pressEscape,
      words,
    )
    await expectWordsEverywhere(stack, board, {
      container: arrow,
      label: r.label,
      words,
      pages: [a.page, b.page],
      reloaded: a.page,
    })
    expectHolderOrder(r.log, r.label, r.lease, words)
  } finally {
    await a.context.close()
  }
})

// ---- typing before the grant: the pending buffer ('Opening the note… (N typed)') -------------------------------

test('H2: keys typed while the note’s lease is pending, more after it opens, Escape before the label’s ack: every word is saved', async ({
  browser,
  canvasSession,
  stack,
  board,
  users,
}) => {
  const a = await alice(browser, board, users)
  try {
    const b = await canvasSession('bob')
    // an unlabelled note on the server: its label is made when its editor opens
    const note = await settled(a.page, createNote(a.page, { x: 240, y: 200 }))
    await waitForItem(b.page, note)
    const first = 'Let the villain '
    const rest = 'narrate the ending'
    const up = recordUp(a.page)
    await leaseHook(stack, board, { mode: 'hold' })
    let label: string | null = null
    const hold = holdDown(a.page, { when: isTextCreate, ms: 15_000 })
    try {
      await focusBoard(a.page)
      await select(a.page, [note])
      await a.page.keyboard.press('Enter')
      await expect
        .poll(() =>
          a.page.evaluate(
            () =>
              (window as unknown as { __lobbyBoard: { input: { editorLease: { phase: string } | null } } })
                .__lobbyBoard.input.editorLease?.phase ?? null,
          ),
        )
        .toBe('pending')
      await a.page.keyboard.type(first) // buffered: the lease is not granted yet
      await leaseHook(stack, board, { mode: 'release' }) // the grant goes: the label is made, the keys replayed
      await hold.started
      await expect.poll(() => labelOf(a.page, note)).not.toBeNull()
      label = await labelOf(a.page, note)
      await waitWritable(a.page)
      await expect.poll(() => a.page.locator(TEXT_EDITOR).inputValue()).toBe(first)
      await a.page.keyboard.type(rest)
      await pressEscape(a.page)
      await expect(a.page.locator(TEXT_EDITOR)).toHaveCount(0)
      await a.page.waitForTimeout(300)
      expect(hold.held(), 'the room’s ack of the label’s create is still held').toContain('ack')
    } finally {
      hold.release()
      await leaseHook(stack, board, { mode: 'off' })
    }
    try {
      await expectSaved(a.page)
    } finally {
      up.stop()
    }
    await expectWordsEverywhere(stack, board, {
      container: note,
      label: label as string,
      words: first + rest,
      pages: [a.page, b.page],
      reloaded: a.page,
    })
    expectHolderOrder(up.log, label as string, note, first + rest)
  } finally {
    await a.context.close()
  }
})
