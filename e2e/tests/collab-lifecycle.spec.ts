// Milestone-0 demonstrations 1-3, on one board that lives through all three steps:
//   1) two sessions see one another and their edits,
//   2) a reload preserves everything,
//   3) a SIGKILLed and restarted sync server preserves everything (fresh context), and the
//      connection indicator goes offline -> online.
// (Folds in the original baseline m0.spec.ts: custom shape + geo edits, getCollaborators, reload,
// SIGKILL/restart, an edit made while the server is down reaching the peer, a fresh session.)
import { join } from 'node:path'
import type { Browser } from '@playwright/test'
import {
  arrowBindings,
  type BoardDocument,
  boardDocument,
  documentDiff,
  edit,
  expectConn,
  expectConverged,
  getShape,
  insertFiles,
  openSession,
  pageShapes,
  read,
  type Session,
  shapeBounds,
  shapeCenterOnScreen,
  shapeText,
  startTextEditing,
  stopTextEditing,
  toScreen,
  typeText,
  waitForBoard,
  waitForValue,
} from './support/board.ts'
import { plainText, richText } from './support/editor.ts'
import { expect, test } from './support/fixtures.ts'
import { captureSideBySide } from './support/screenshots.ts'
import { FIXTURES_DIR } from './support/stack.ts'

const ID = {
  noteA: 'shape:note-alice',
  noteB: 'shape:note-bob',
  frame: 'shape:frame-sprint',
  inFrame1: 'shape:frame-child-1',
  inFrame2: 'shape:frame-child-2',
  from: 'shape:arrow-from',
  to: 'shape:arrow-to',
  undo: 'shape:undo-target',
  card: 'shape:card-deck',
}
const DERIVATIVE_SRC = /^\/files\/ast_[0-9A-Za-z]{20}\/ver_[0-9A-Za-z]{20}\/d\/drv_[0-9A-Za-z]{20}\?board=/
const STABLE_REF = /^\/files\/ast_[0-9A-Za-z]{20}\/ver_[0-9A-Za-z]{20}\/original$/

/** What an image shape renders: every <img> src and whether it decoded. */
function renderedImages(s: Session, shapeId: string) {
  const imgs = s.page.locator(`[data-shape-id="${shapeId}"] img.tl-image`)
  return imgs.evaluateAll((els) =>
    els.map((i) => ({ src: i.getAttribute('src') ?? '', loaded: (i as HTMLImageElement).naturalWidth > 0 })),
  )
}

async function expectDerivativeImage(s: Session, shapeId: string, board: string) {
  await expect
    .poll(() => renderedImages(s, shapeId), { timeout: 30_000, message: `${s.user}: image derivative` })
    .toEqual([{ src: expect.stringMatching(DERIVATIVE_SRC), loaded: true }])
  const [img] = await renderedImages(s, shapeId)
  expect(img?.src.endsWith(`?board=${board}`)).toBe(true)
}

const shapeOfType = (doc: BoardDocument, type: string) => {
  const shape = Object.values(doc.shapes).find((sh) => sh.type === type)
  if (!shape) throw new Error(`no ${type} shape on the board`)
  return shape.id
}

const boundTerminals = async (s: Session, arrowId: string) =>
  (await arrowBindings(s.page, arrowId)).map((x) => `${x.props.terminal}->${x.toId}`).sort()

/** Everything step 1 created is in this tab's document AND rendered. */
async function expectFullBoard(s: Session, expected: BoardDocument, board: string) {
  await expect
    .poll(async () => documentDiff(expected, await boardDocument(s.page)), {
      timeout: 20_000,
      message: `${s.user}: records that differ from the expected board`,
    })
    .toEqual([])
  // Off-screen shapes are culled from the DOM, so show the whole board before checking what renders.
  await edit(s.page, (ed) => ed.zoomToFit())
  await expect(s.page.locator(`[data-shape-id="${ID.noteA}"] .tl-rich-text`)).toHaveText('Hello from alice')
  await expect(s.page.locator('.tl-frame-heading').filter({ hasText: 'Sprint' })).toBeVisible()
  await expect(s.page.getByTestId('file-card').filter({ hasText: 'deck' })).toBeVisible()
  expect(await boundTerminals(s, shapeOfType(expected, 'arrow'))).toEqual([
    `end->${ID.to}`,
    `start->${ID.from}`,
  ])
  await expectDerivativeImage(s, shapeOfType(expected, 'image'), board)
}

test.describe
  .serial('board lifecycle: two sessions, reload, server kill', () => {
    let browser: Browser
    let board: string
    let a: Session
    let b: Session
    let before: BoardDocument | undefined

    test.beforeAll(async ({ browser: br, stack }) => {
      await stack.ensureRunning()
      browser = br
      board = `e2e-lifecycle-${Date.now().toString(36)}`
      a = await openSession(browser, board, 'alice')
      b = await openSession(browser, board, 'bob')
    })

    test.afterAll(async () => {
      await Promise.all([a?.context.close(), b?.context.close()])
    })

    test('1) two sessions see one another and their edits', async () => {
      await test.step('presence: each sees the other in the presence list', async () => {
        await expect(a.page.locator('[data-testid="presence-user"][data-user-id="bob"]')).toBeVisible()
        await expect(b.page.locator('[data-testid="presence-user"][data-user-id="alice"]')).toBeVisible()
        await expect(a.page.locator('[data-testid="presence-user"][data-user-id="alice"]')).toHaveCount(0)
      })

      await test.step('presence: collaborator cursors (editor state and DOM)', async () => {
        for (const [mover, watcher] of [
          [b, a],
          [a, b],
        ] as const) {
          const p = await toScreen(mover.page, { x: 900, y: 300 })
          await mover.page.mouse.move(p.x - 40, p.y - 40)
          await mover.page.mouse.move(p.x, p.y, { steps: 5 })
          await expect
            .poll(() =>
              read(
                watcher.page,
                (ed, n) => ed.getCollaborators().find((c) => c.userName === n)?.cursor ?? null,
                mover.user,
              ),
            )
            .toMatchObject({ x: expect.any(Number), y: expect.any(Number) })
          await expect(
            watcher.page.locator('.tl-collaborator__cursor').filter({ hasText: mover.user }),
          ).toBeVisible()
        }
      })

      await test.step('notes: text typed on A appears on B; a note made on B appears on A', async () => {
        await edit(a.page, (ed, id) => ed.createShape({ id, type: 'note', x: 60, y: 60 }), ID.noteA)
        await startTextEditing(a.page, ID.noteA)
        await typeText(a.page, 'Hello from alice')
        await stopTextEditing(a.page)
        await expect.poll(() => shapeText(b.page, ID.noteA)).toBe('Hello from alice')
        await expect(b.page.locator(`[data-shape-id="${ID.noteA}"] .tl-rich-text`)).toHaveText(
          'Hello from alice',
        )

        await edit(
          b.page,
          (ed, { id, text }) =>
            ed.createShape({ id, type: 'note', x: 60, y: 300, props: { richText: text, color: 'yellow' } }),
          { id: ID.noteB, text: richText('From bob') },
        )
        await expect(a.page.locator(`[data-shape-id="${ID.noteB}"] .tl-rich-text`)).toHaveText('From bob')
      })

      await test.step('text: B makes a text shape with the text tool; A sees it', async () => {
        await edit(b.page, (ed) => ed.setCurrentTool('text'))
        const at = await toScreen(b.page, { x: 340, y: 330 })
        await b.page.mouse.click(at.x, at.y)
        await expect.poll(() => read(b.page, (ed) => ed.getEditingShapeId())).toMatch(/^shape:/)
        await typeText(b.page, 'Label by bob')
        await stopTextEditing(b.page)
        await expect
          .poll(async () =>
            (await pageShapes(a.page))
              .filter((s) => s.type === 'text')
              .map((s) => plainText(s.props.richText)),
          )
          .toEqual(['Label by bob'])
      })

      await test.step('frame containing shapes', async () => {
        await edit(
          a.page,
          (ed, ids) => {
            ed.createShape({
              id: ids.frame,
              type: 'frame',
              x: 320,
              y: 40,
              props: { w: 380, h: 220, name: 'Sprint' },
            })
            ed.createShapes([
              { id: ids.child1, type: 'geo', parentId: ids.frame, x: 30, y: 60, props: { w: 140, h: 100 } },
              {
                id: ids.child2,
                type: 'geo',
                parentId: ids.frame,
                x: 210,
                y: 60,
                props: { w: 140, h: 100, geo: 'ellipse', color: 'blue' },
              },
            ])
          },
          { frame: ID.frame, child1: ID.inFrame1, child2: ID.inFrame2 },
        )
        await expect
          .poll(() => read(b.page, (ed, id) => ed.getSortedChildIdsForParent(id), ID.frame))
          .toEqual([ID.inFrame1, ID.inFrame2])
        await expect(b.page.locator('.tl-frame-heading').filter({ hasText: 'Sprint' })).toBeVisible()
        await expect(b.page.locator(`[data-shape-id="${ID.inFrame2}"]`)).toBeVisible()
      })

      await test.step('an arrow drawn on A between two shapes is bound to both, on both clients', async () => {
        await edit(
          a.page,
          (ed, ids) =>
            ed.createShapes([
              { id: ids.from, type: 'geo', x: 760, y: 80, props: { w: 120, h: 90, color: 'green' } },
              { id: ids.to, type: 'geo', x: 760, y: 360, props: { w: 120, h: 90, color: 'red' } },
            ]),
          { from: ID.from, to: ID.to },
        )
        // Drawn like a user: the arrow tool, dragged from one shape to the other.
        await edit(a.page, (ed) => ed.setCurrentTool('arrow'))
        const p1 = await shapeCenterOnScreen(a.page, ID.from)
        const p2 = await shapeCenterOnScreen(a.page, ID.to)
        await a.page.mouse.move(p1.x, p1.y)
        await a.page.mouse.down()
        await a.page.mouse.move(p2.x, p2.y, { steps: 15 })
        await a.page.mouse.up()
        const arrowId = await waitForValue(
          async () => (await pageShapes(a.page)).find((s) => s.type === 'arrow')?.id,
        )
        const expected = [`end->${ID.to}`, `start->${ID.from}`]
        await expect.poll(() => boundTerminals(a, arrowId)).toEqual(expected)
        await expect.poll(() => boundTerminals(b, arrowId)).toEqual(expected)

        // Moving the bound target on A moves the arrow's end on B (B recomputes it from the binding).
        const arrowBottomOnB = async () => {
          const box = await shapeBounds(b.page, arrowId)
          return box ? box.y + box.h : Number.NaN
        }
        const start = await arrowBottomOnB()
        expect(start).toBeGreaterThan(0)
        await edit(a.page, (ed, id) => ed.updateShape({ id, type: 'geo', y: 560 }), ID.to)
        await expect.poll(async () => (await arrowBottomOnB()) - start).toBeGreaterThan(150)
        await expect.poll(() => boundTerminals(b, arrowId)).toEqual(expected)
      })

      await test.step('local undo/redo on A propagates to B', async () => {
        const position = (s: Session) => getShape(s.page, ID.undo).then((sh) => (sh ? [sh.x, sh.y] : null))
        await edit(
          a.page,
          (ed, id) => ed.createShape({ id, type: 'geo', x: 1000, y: 80, props: { w: 100, h: 100 } }),
          ID.undo,
        )
        await expect.poll(() => position(b)).toEqual([1000, 80])
        await edit(
          a.page,
          (ed, id) => {
            ed.markHistoryStoppingPoint('move undo target')
            ed.updateShape({ id, type: 'geo', x: 1100, y: 240 })
          },
          ID.undo,
        )
        await expect.poll(() => position(b)).toEqual([1100, 240])

        await a.page.keyboard.press('ControlOrMeta+z')
        await expect.poll(() => position(a)).toEqual([1000, 80])
        await expect.poll(() => position(b)).toEqual([1000, 80])

        await a.page.keyboard.press('ControlOrMeta+Shift+z')
        await expect.poll(() => position(a)).toEqual([1100, 240])
        await expect.poll(() => position(b)).toEqual([1100, 240])
      })

      await test.step('a custom file card (shared schema) created on A renders on B', async () => {
        await edit(
          a.page,
          (ed, id) =>
            ed.createShape({
              id,
              type: 'dr-file-card',
              x: 320,
              y: 420,
              props: {
                w: 280,
                h: 92,
                name: 'deck.pdf',
                kind: 'pdf',
                status: 'ready',
                pageCount: 4,
                // Valid for the schema but not a stored upload, so the card renders from its hint props.
                assetId: 'ast_0123456789',
                versionId: 'ver_0123456789',
                mimeType: 'application/pdf',
                sizeBytes: 2274,
              },
            }),
          ID.card,
        )
        await expect(b.page.getByTestId('file-card').filter({ hasText: 'deck.pdf' })).toBeVisible()
      })

      await test.step('an uploaded image resolves to a board-scoped derivative on both clients', async () => {
        await insertFiles(a.page, [join(FIXTURES_DIR, 'image.png')])
        const imageId = await waitForValue(
          async () => (await pageShapes(a.page)).find((s) => s.type === 'image')?.id,
          { timeout: 20_000 },
        )
        // The durable record holds only the stable reference: no host, no board, no signature.
        await expect
          .poll(async () => {
            const doc = await boardDocument(a.page)
            const asset = doc.assets[String(doc.shapes[imageId]?.props.assetId)] as
              | { props?: { src?: unknown } }
              | undefined
            return asset?.props?.src ?? null
          })
          .toMatch(STABLE_REF)
        // Shrink it so it does not cover the rest of the board.
        await edit(
          a.page,
          (ed, id) => ed.updateShape({ id, type: 'image', x: 1000, y: 420, props: { w: 320, h: 180 } }),
          imageId,
        )
        await expectDerivativeImage(a, imageId, board)
        await expectDerivativeImage(b, imageId, board)
      })

      await expectConverged(a.page, [b.page])
      before = await boardDocument(a.page)

      for (const s of [a, b]) {
        await edit(s.page, (ed) => {
          ed.selectNone()
          ed.zoomToFit()
        })
      }
      await captureSideBySide('two-browsers-collab.png', a.page, b.page, test.info())
    })

    test('2) reload preserves all of it', async () => {
      const expected = before
      test.skip(!expected, 'needs the board from step 1')
      if (!expected) return
      await Promise.all([a.page.reload(), b.page.reload()])
      await Promise.all([waitForBoard(a.page), waitForBoard(b.page)])
      await expectFullBoard(a, expected, board)
      await expectFullBoard(b, expected, board)
    })

    test('3) SIGKILLed sync server: acknowledged edits survive; clients go offline -> online', async ({
      stack,
    }) => {
      test.skip(!before, 'needs the board from step 1')
      await expectConverged(a.page, [b.page])
      // B has rendered this edit, so the server committed it before broadcasting.
      await edit(
        a.page,
        (ed, { id, text }) => ed.updateShape({ id, type: 'note', props: { richText: text } }),
        { id: ID.noteB, text: richText('Edited just before the crash') },
      )
      await expect(b.page.locator(`[data-shape-id="${ID.noteB}"] .tl-rich-text`)).toHaveText(
        'Edited just before the crash',
      )
      await expectConverged(a.page, [b.page])
      const acknowledged = await boardDocument(a.page)

      await stack.sync.kill()
      await expectConn(a.page, 'offline')
      await expectConn(b.page, 'offline')
      await expect(a.page.getByTestId('offline-banner')).toBeVisible()

      // An edit made while the server is down stays in A's tab and is pushed after the restart.
      await edit(
        a.page,
        (ed, id) => ed.updateShape({ id, type: 'dr-file-card', props: { name: 'deck-renamed-offline.pdf' } }),
        ID.card,
      )

      await stack.sync.start()
      await expectConn(a.page, 'online')
      await expectConn(b.page, 'online')
      await expect(a.page.getByTestId('offline-banner')).toHaveCount(0)
      await expect(
        b.page.getByTestId('file-card').filter({ hasText: 'deck-renamed-offline.pdf' }),
      ).toBeVisible()

      // A fresh context loads from SQLite: every acknowledged record, plus the offline edit, nothing else.
      const expected = structuredClone(acknowledged)
      const card = expected.shapes[ID.card]
      if (card) card.props = { ...card.props, name: 'deck-renamed-offline.pdf' }
      const c = await openSession(browser, board, 'carol')
      try {
        await expectFullBoard(c, expected, board)
        await expectConverged(c.page, [a.page, b.page])
      } finally {
        await c.context.close()
      }
      expect(stack.sync.logs()).not.toMatch(/room error|room open failed|ERR_INVALID_STATE|Error:/)
    })
  })
