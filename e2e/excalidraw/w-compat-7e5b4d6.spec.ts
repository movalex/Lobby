// OWNER: WS1 (wave W, the stale pair; docs/WAVE-W-CONTRACTS.md §2 and §9.1, EXCALIDRAW-CONTRACTS.md §0b). A tab of the
// web deployed before wave W (7e5b4d6, CONTRACTS_REV 14, wave V; a build of it with dev auth, served on this run's web
// origin by l-compat-kit.ts serveOldWeb) beside a tab of this tree's web, on one board, through this tree's api (every
// wave W switch on: e2e/tests/support/stack.ts) and sync. Wave W changes no wire: `git diff 7e5b4d6 --
// packages/canvas-schema` holds only a test (wave-w-kinds.test.ts), so the old tab's frames are parsed with this
// package's own schemas (they ARE 7e5b4d6's). The old tab's board socket is not relayed: CDP hands over every frame.
//
// This tree's tab places a doc card (the palette's insert, words typed in its panel under the lease) and a deck as
// slides: WS1 writes the slide frames and their page images itself (`kind: 'deck-slide'` frames, `kind: 'deck-page'`
// images of a fixture PDF's pages 1..8, `ver_….p<n>`, one transact), so the spec does not wait for WS4. The old tab
// keeps the board live, drops no frame, pushes nothing while it only receives, holds the card as a labelled rectangle
// (its words plain) and the slides as frames with their images loaded, and its own plain edit of the card's words
// (its in-place editor, under the lease) survives: this tree's tab shows it on the face. While the old tab types, this
// tree's panel says so and stays read-only.
//
// Run (the old build is made outside the repo, as l-compat-kit.ts describes; 7e5b4d6's own steps):
//   git archive 7e5b4d6b | tar -x -C <dir> && cd <dir> && pnpm install --frozen-lockfile --offline --ignore-scripts
//   VITE_DRAFTROOM_DEV_AUTH=1 GIT_COMMIT=7e5b4d6b0000 pnpm --filter @draftroom/web exec vite build --outDir <dist>
//   cd <this tree>/e2e && E2E_OLD_WEB_DIST=<dist> E2E_OLD_WEB_COMMIT=7e5b4d6 E2E_PORT_BASE=<base> \
//     pnpm exec playwright test excalidraw/w-compat-7e5b4d6.spec.ts --project=chromium --workers=1
// (On Windows keep <dir> short: the install's paths pass 260 characters under the session scratchpad.)
// Without E2E_OLD_WEB_DIST it is skipped, saying so.
import type { Page } from '@playwright/test'
import * as Rev14 from '../../packages/canvas-schema/src/protocol.ts'
import { DECK_LIMITS, deckSlideName } from '../../packages/contracts/src/index.ts'
import {
  type CanvasSession,
  dblclickItem,
  expect,
  expectSaved,
  hash,
  item,
  items,
  saveState,
  startTextEditingWithKeyboard,
  stopTextEditing,
  test,
  typeText,
} from '../tests/support/canvas.ts'
import { serverSnapshot, storedElement } from '../tests/support/excalidraw.ts'
import { makePdf } from '../tests/support/media-2.ts'
import type { Users } from '../tests/support/users.ts'
import { withCanvas } from './canvas-ux-kit.ts'
import {
  OLD_WEB_COMMIT,
  OLD_WEB_DIST,
  OLD_WEB_LAUNCH,
  OLD_WEB_SKIP_REASON,
  type OldFrameSchemas,
  type OldSocketWatch,
  serveOldWeb,
  watchOldSocket,
} from './l-compat-kit.ts'
import { openTab, sidOf } from './l6-kit.ts'
import { cardItems, type FileFacts, fileCard, insertFiles } from './media-kit.ts'
import {
  expectEditing,
  face,
  insertFromPalette,
  kindOf,
  labelIdOf,
  panel,
  panelStatus,
  panelText,
  typeInPanel,
  withDocCards,
  wordsOf,
} from './w1-kit.ts'

test.use({ viewport: { width: 1440, height: 900 }, launchOptions: OLD_WEB_LAUNCH })

/** 7e5b4d6's schemas: this package's (wave W changed none of it; see the header). */
const REV14_SCHEMAS: OldFrameSchemas = Rev14 as unknown as OldFrameSchemas

const pushes = (s: OldSocketWatch) => s.sent.filter((t) => t === 'push').length
const roomRev = (page: Page) => withCanvas(page, (c) => c.room.contractsRev(), null)

interface OldPair {
  readonly a: CanvasSession
  readonly b: CanvasSession
  readonly s: OldSocketWatch
  readonly served: string[]
  readonly pageErrors: string[]
}

/** alice on this tree's web (doc cards on), bob (an editor) on the 7e5b4d6 build, watched. */
async function openPair(
  browser: Parameters<typeof openTab>[0],
  board: string,
  users: Users,
  canvasSession: (u: string) => Promise<CanvasSession>,
): Promise<OldPair> {
  const a = await withDocCards(await canvasSession('alice'))
  const served: string[] = []
  const pageErrors: string[] = []
  let sock: OldSocketWatch | null = null
  const b = await openTab(browser, board, users, 'bob', {
    role: 'editor',
    beforeOpen: async (page) => {
      await serveOldWeb(page.context(), OLD_WEB_DIST as string, served)
      page.on('pageerror', (e) => pageErrors.push(String(e).slice(0, 300)))
      sock = await watchOldSocket(page, REV14_SCHEMAS)
    },
  })
  return { a, b, s: sock as unknown as OldSocketWatch, served, pageErrors }
}

/**
 * The deck as WS4 places it (docs/WAVE-W-CONTRACTS.md §6), written here in ONE transact: per page a frame of kind
 * 'deck-slide' (1600 wide at the page's aspect, named "<n> · <its first line>") and inside it an image of kind
 * 'deck-page' showing the PDF version's page (`ver_….p<n>`), in a 5-wide grid right of `at`.
 */
async function placeSlides(page: Page, facts: FileFacts, pages: number, at: { x: number; y: number }) {
  return withCanvas(
    page,
    (c, a) => {
      const id = (p: string) => {
        const bytes = new Uint8Array(12)
        crypto.getRandomValues(bytes)
        return `${p}${Array.from(bytes, (x) => (x % 36).toString(36)).join('')}`
      }
      const w = a.width
      const h = Math.round((w * 792) / 612)
      const frames: string[] = []
      const images: string[] = []
      c.transact('e2e: insert as slides', (tx) => {
        for (let n = 1; n <= a.pages; n++) {
          const col = (n - 1) % a.cols
          const row = Math.floor((n - 1) / a.cols)
          const x = a.at.x + col * (w + a.gap)
          const y = a.at.y + row * (h + a.gap)
          const frame = id('ws')
          tx.create('frame', {
            id: frame,
            x,
            y,
            width: w,
            height: h,
            name: a.names[n - 1],
            customData: { lobby: { kind: 'deck-slide' } },
          })
          const image = id('wp')
          tx.create('image', {
            id: image,
            x,
            y,
            width: w,
            height: h,
            fileId: `${a.facts.versionId}.p${n}`,
            status: 'saved',
            scale: [1, 1],
            frameId: frame,
            customData: {
              lobby: {
                kind: 'deck-page',
                file: { ...a.facts },
                pdfPage: n,
                alt: `Slide ${n} of ${a.pages}`,
              },
            },
          })
          frames.push(frame)
          images.push(image)
        }
      })
      return { frames, images }
    },
    {
      facts,
      pages,
      at,
      width: DECK_LIMITS.slideWidth,
      gap: DECK_LIMITS.gridGap,
      cols: DECK_LIMITS.gridColumns,
      names: Array.from({ length: pages }, (_, i) => deckSlideName(i + 1, `Page ${i + 1} of ${pages}`)),
    },
  )
}

/** The loader's state of an image in a tab (the old build's canvas has the same `files.status`). */
const fileStatus = (page: Page, id: string) => withCanvas(page, (c, i) => c.files.status(i), id)

test('w-compat: the 7e5b4d6 web beside a doc card and deck slides: every frame, nothing pushed, a labelled rectangle and frames with images; its own edit of the card survives', async ({
  browser,
  board,
  users,
  canvasSession,
  stack,
}) => {
  test.skip(!OLD_WEB_DIST, OLD_WEB_SKIP_REASON)
  test.setTimeout(300_000)
  const p = await openPair(browser, board, users, canvasSession)
  const { a, b, s } = p
  try {
    await test.step('bob is the deployed 7e5b4d6 build (rev 14 in its connect URL), the room says 14', async () => {
      test
        .info()
        .annotations.push({ type: 'previous web', description: `${OLD_WEB_COMMIT} (${OLD_WEB_DIST})` })
      expect(p.served.some((x) => x.startsWith('/assets/'))).toBe(true)
      await expect.poll(() => s.connectUrls.length).toBeGreaterThan(0)
      for (const u of s.connectUrls) expect(new URL(u).searchParams.get('rev')).toBe('14')
      await expect.poll(() => roomRev(a.page)).toBe(14)
      await expect.poll(() => roomRev(b.page)).toBe(14)
    })
    const bsid = await sidOf(b.page)

    // the deck's PDF, its 8 pages rendered by the worker (what a deck card's pages are)
    await insertFiles(a.page, [await makePdf('deck.pdf', 8)])
    await expect(fileCard(a.page, 'deck.pdf')).toHaveAttribute('data-status', 'ready', { timeout: 90_000 })
    const deck = (await cardItems(a.page)).find((c) => c.facts.name === 'deck.pdf')
    if (!deck) throw new Error('no deck card')
    await expectSaved(a.page)
    await expect.poll(() => item(b.page, deck.id).then((e) => e?.id ?? null)).toBe(deck.id)

    let card = ''
    const words = '# Kickoff\n- [ ] agenda\n- [x] room\n**Owner:** Alice'
    let placed: { frames: string[]; images: string[] } = { frames: [], images: [] }

    await test.step('alice places a doc card and the deck as slides: bob holds each with its kind, drops no frame and pushes nothing', async () => {
      const before = pushes(s)
      card = await insertFromPalette(a.page)
      // the words in one go (typed, Enter would continue the list on its own)
      await panelText(a.page).fill(words)
      await a.page.getByTestId('doc-editor-done').click()
      await expect(panel(a.page)).toHaveCount(0)
      placed = await placeSlides(a.page, deck.facts, 8, { x: 2000, y: 0 })
      await expectSaved(a.page)
      expect((await saveState(a.page)).lastReject).toBeNull()
      // the card: a rectangle of kind doc-card with its bound label holding the plain words
      await expect.poll(() => wordsOf(b.page, card)).toBe(words)
      const oldCard = await item(b.page, card)
      expect(oldCard?.type).toBe('rectangle')
      expect(kindOf(oldCard)).toBe('doc-card')
      const label = await item(b.page, (await labelIdOf(b.page, card)) as string)
      expect(label).toMatchObject({
        type: 'text',
        containerId: card,
        textAlign: 'left',
        verticalAlign: 'top',
      })
      expect(kindOf(await storedElement(stack, board, card))).toBe('doc-card')
      // the slides: frames of kind deck-slide holding images of kind deck-page, the pages loaded in bob's tab
      for (const [i, f] of placed.frames.entries()) {
        await expect.poll(() => item(b.page, f).then((e) => e?.type ?? null), { message: f }).toBe('frame')
        expect(kindOf(await item(b.page, f))).toBe('deck-slide')
        expect((await item(b.page, f))?.name).toBe(deckSlideName(i + 1, `Page ${i + 1} of 8`))
        const img = placed.images[i] as string
        const el = await item(b.page, img)
        expect(el).toMatchObject({ type: 'image', frameId: f, fileId: `${deck.facts.versionId}.p${i + 1}` })
        expect(kindOf(el)).toBe('deck-page')
      }
      for (const img of placed.images)
        await expect.poll(() => fileStatus(b.page, img), { timeout: 90_000, message: img }).toBe('loaded')
      await expectSaved(b.page)
      await s.settled()
      expect(s.dropped, 'frames the 7e5b4d6 web’s socket would drop').toEqual([])
      expect(pushes(s), 'bob only received').toBe(before)
    })

    await test.step('bob edits the card’s words in place (his in-place editor, under the lease): alice’s panel says so and stays read-only; his words survive', async () => {
      await startTextEditingWithKeyboard(b.page, card)
      await b.page.keyboard.press('ControlOrMeta+End')
      await typeText(b.page, '\nfrom the old tab')
      // alice opens the card meanwhile: Bob is typing, so her panel is read-only and names him
      await dblclickItem(a.page, card)
      await expect(panel(a.page)).toHaveAttribute('data-phase', 'denied')
      await expect(panelStatus(a.page)).toHaveText(`${b.name} is editing this doc card.`)
      await expect(panelText(a.page)).toHaveJSProperty('readOnly', true)
      await stopTextEditing(b.page)
      await expectSaved(b.page)
      expect((await saveState(b.page)).lastReject).toBeNull()
      const after = `${words}\nfrom the old tab`
      await expect.poll(() => wordsOf(a.page, card)).toBe(after)
      const stored = await storedElement(stack, board, (await labelIdOf(a.page, card)) as string)
      expect(stored?.originalText).toBe(after)
      expect(kindOf(await storedElement(stack, board, card))).toBe('doc-card')
      // alice's panel shows his words, and she may edit now
      await expect(panelText(a.page)).toHaveValue(after)
      await expect(a.page.getByTestId('doc-editor-edit')).toBeEnabled()
      await a.page.getByTestId('doc-editor-edit').click()
      await expectEditing(a.page)
      await typeInPanel(a.page, ' (seen)')
      await a.page.getByTestId('doc-editor-done').click()
      await expectSaved(a.page)
      await expect.poll(() => wordsOf(b.page, card)).toBe(`${after} (seen)`)
      await expect(face(a.page, card)).toContainText('from the old tab (seen)')
    })

    await test.step('every tab holds the server’s board; bob’s socket dropped nothing, was never closed by the room, never reconnected; his page threw nothing', async () => {
      const server = await serverSnapshot(stack, board)
      await expect.poll(() => hash(a.page)).toBe(server.hash)
      await expect.poll(() => hash(b.page)).toBe(server.hash)
      await s.settled()
      expect(s.dropped, 'frames the 7e5b4d6 web’s socket would drop').toEqual([])
      expect(s.closing).toEqual([])
      expect(s.extensions, 'one board socket handshake: no reconnect').toHaveLength(1)
      expect(p.pageErrors, 'page errors in the 7e5b4d6 web').toEqual([])
      await expect(b.page.getByTestId('conn-status')).not.toHaveAttribute('data-state', /offline|error/)
      expect(await sidOf(b.page)).toBe(bsid)
      expect((await items(b.page)).filter((e) => kindOf(e) === 'deck-page')).toHaveLength(8)
    })
  } finally {
    await b.context.close()
  }
})
