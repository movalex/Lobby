// Port of e2e/tests/collab-lifecycle.spec.ts to the Excalidraw engine (docs/EXCALIDRAW-CONTRACTS.md §9;
// the tldraw version stays in e2e/tests and runs on the default build). One board lives through three
// steps:
//   1) two sessions see one another (roster, cursors) and their edits: a note typed through the lease, a
//      note made on the other tab, a free text made with Lobby's T tool, a frame with children, an arrow
//      drawn with the real pointer and bound at both ends (the server re-snaps it when its target moves),
//      and undo/redo with the real keys;
//   2) a reload of both tabs preserves all of it (same convergence hash as before, tombstones included);
//   3) a SIGKILLed and restarted sync server preserves every acknowledged edit; the tabs say offline and
//      back; an edit made while the server is down is kept on the device and reaches the peer after the
//      restart; a fresh session loads exactly that board.
// Every check against "the server" reads the test snapshot (the sync server runs with test hooks here).
// Not ported here: the image upload and the file card (wave 3g, media), the sign-in form (the board page
// is behind the dev-auth guard until wave 4).
import type { Browser } from '@playwright/test'
import {
  type CanvasSession,
  collaborators,
  createItem,
  createNote,
  editingId,
  expect,
  expectConverged,
  expectSaved,
  hash,
  item,
  itemCenterOnScreen,
  items,
  openCanvasSession,
  saveState,
  sceneToScreen,
  selectNone,
  setTool,
  startTextEditing,
  stopTextEditing,
  test,
  typeText,
  updateItem,
  waitForCanvas,
  waitForItem,
  waitForTextEditor,
  zoomToFit,
} from '../tests/support/canvas.ts'
import {
  cursorOf,
  expectSaveState,
  expectServerConverged,
  labelText,
  pressRedo,
  pressUndo,
  saveIndicator,
  serverSnapshot,
} from '../tests/support/excalidraw.ts'
import type { TestUser } from '../tests/support/users.ts'

const ID = {
  noteA: 'note-alice',
  noteB: 'note-bob',
  frame: 'frame-sprint',
  inFrame1: 'frame-child-1',
  inFrame2: 'frame-child-2',
  from: 'arrow-from',
  to: 'arrow-to',
  undo: 'undo-target',
}

/** The arrow's two bound targets (start, end) as this tab holds them. */
async function arrowEnds(page: CanvasSession['page'], id: string): Promise<[string | null, string | null]> {
  const a = (await item(page, id)) as {
    startBinding?: { elementId: string } | null
    endBinding?: { elementId: string } | null
  } | null
  return [a?.startBinding?.elementId ?? null, a?.endBinding?.elementId ?? null]
}

const position = async (page: CanvasSession['page'], id: string) => {
  const el = await item(page, id)
  return el ? [Math.round(el.x), Math.round(el.y)] : null
}

test.describe
  .serial('board lifecycle on the Excalidraw engine: two sessions, reload, server kill', () => {
    let browser: Browser
    let board: string
    let a: CanvasSession
    let b: CanvasSession
    let carol: TestUser
    let before: { hash: string; arrow: string; ids: string[] } | undefined

    test.beforeAll(async ({ browser: br, stack, users }) => {
      await stack.ensureRunning()
      browser = br
      board = await users.createBoard('Lifecycle board')
      carol = await users.grant(board, 'carol', 'editor')
      a = await openCanvasSession(browser, board, await users.get('alice'))
      b = await openCanvasSession(browser, board, await users.grant(board, 'bob', 'editor'))
    })

    test.afterAll(async () => {
      await Promise.all([a?.context.close(), b?.context.close()])
    })

    test('1) two sessions see one another and their edits', async ({ stack }) => {
      await test.step('presence: each sees the other in the roster, with the ticket’s identity', async () => {
        await expect
          .poll(async () => (await collaborators(a.page)).map((c) => [c.uid, c.name]))
          .toContainEqual([b.id, b.name])
        await expect
          .poll(async () => (await collaborators(b.page)).map((c) => [c.uid, c.name]))
          .toContainEqual([a.id, a.name])
      })

      await test.step('presence: collaborator cursors follow the real pointer', async () => {
        for (const [mover, watcher] of [
          [b, a],
          [a, b],
        ] as const) {
          const p = await sceneToScreen(mover.page, { x: 900, y: 300 })
          await mover.page.mouse.move(p.x - 40, p.y - 40)
          await mover.page.mouse.move(p.x, p.y, { steps: 5 })
          await expect(cursorOf(watcher.page, mover.name)).toBeVisible()
        }
      })

      await test.step('notes: text typed on A (through the lease) appears on B; a note made on B appears on A', async () => {
        const noteA = await createNote(a.page, { x: 60, y: 60 })
        await startTextEditing(a.page, noteA)
        await typeText(a.page, 'Hello from alice')
        await stopTextEditing(a.page)
        await expect.poll(() => labelText(b.page, noteA)).toBe('Hello from alice')
        ID.noteA = noteA

        await createItem(b.page, 'note', {
          id: ID.noteB,
          x: 60,
          y: 300,
          text: 'From bob',
          backgroundColor: '#ffec99',
        })
        await expect.poll(() => labelText(a.page, ID.noteB)).toBe('From bob')
      })

      await test.step('text: B makes a free text with Lobby’s T tool and types it; A sees it', async () => {
        expect(await setTool(b.page, 'text')).toBe(true)
        const at = await sceneToScreen(b.page, { x: 340, y: 330 })
        await b.page.mouse.click(at.x, at.y)
        await waitForTextEditor(b.page)
        await typeText(b.page, 'Label by bob')
        await stopTextEditing(b.page)
        await expect
          .poll(async () =>
            (await items(a.page))
              .filter((e) => e.type === 'text' && !(e as { containerId?: string | null }).containerId)
              .map((e) => (e as { originalText?: string }).originalText),
          )
          .toEqual(['Label by bob'])
      })

      await test.step('a frame holding two shapes', async () => {
        await createItem(a.page, 'frame', {
          id: ID.frame,
          x: 320,
          y: 40,
          width: 380,
          height: 220,
          name: 'Sprint',
        })
        await createItem(a.page, 'rectangle', {
          id: ID.inFrame1,
          x: 350,
          y: 100,
          width: 140,
          height: 100,
          frameId: ID.frame,
        })
        await createItem(a.page, 'ellipse', {
          id: ID.inFrame2,
          x: 530,
          y: 100,
          width: 140,
          height: 100,
          frameId: ID.frame,
          strokeColor: '#1971c2',
        })
        await expect
          .poll(async () =>
            (await items(b.page))
              .filter((e) => (e as { frameId?: string | null }).frameId === ID.frame)
              .map((e) => e.id)
              .sort(),
          )
          .toEqual([ID.inFrame1, ID.inFrame2].sort())
        expect(await labelText(b.page, ID.frame)).toBe('Sprint')
      })

      let arrowId = ''
      await test.step('an arrow drawn on A between two shapes is bound to both, on both clients', async () => {
        await createItem(a.page, 'rectangle', {
          id: ID.from,
          x: 760,
          y: 80,
          width: 120,
          height: 90,
          strokeColor: '#2f9e44',
        })
        await createItem(a.page, 'rectangle', {
          id: ID.to,
          x: 760,
          y: 360,
          width: 120,
          height: 90,
          strokeColor: '#e03131',
        })
        await waitForItem(b.page, ID.to)
        await selectNone(a.page)
        expect(await setTool(a.page, 'arrow')).toBe(true)
        const p1 = await itemCenterOnScreen(a.page, ID.from)
        const p2 = await itemCenterOnScreen(a.page, ID.to)
        await a.page.mouse.move(p1.x, p1.y)
        await a.page.mouse.down()
        await a.page.mouse.move(p2.x, p2.y, { steps: 15 })
        await a.page.mouse.up()
        await expect
          .poll(async () => (await items(a.page)).find((e) => e.type === 'arrow')?.id ?? null)
          .not.toBeNull()
        arrowId = (await items(a.page)).find((e) => e.type === 'arrow')?.id as string
        await expect.poll(() => arrowEnds(a.page, arrowId)).toEqual([ID.from, ID.to])
        await expect.poll(() => arrowEnds(b.page, arrowId)).toEqual([ID.from, ID.to])
        await expectSaved(a.page)

        // Moving the bound target on A moves the arrow's end on B (the server re-snaps it, §2.9.4 rule 7).
        const arrowBottomOnB = async () => {
          const el = await item(b.page, arrowId)
          return el ? el.y + el.height : Number.NaN
        }
        const start = await arrowBottomOnB()
        expect(start).toBeGreaterThan(0)
        await updateItem(a.page, ID.to, { y: 560 })
        await expect.poll(async () => (await arrowBottomOnB()) - start).toBeGreaterThan(150)
        await expect.poll(() => arrowEnds(b.page, arrowId)).toEqual([ID.from, ID.to])
      })

      await test.step('local undo/redo on A (the real keys) propagates to B', async () => {
        await createItem(a.page, 'rectangle', { id: ID.undo, x: 1000, y: 80, width: 100, height: 100 })
        await expect.poll(() => position(b.page, ID.undo)).toEqual([1000, 80])
        await updateItem(a.page, ID.undo, { x: 1100, y: 240 })
        await expect.poll(() => position(b.page, ID.undo)).toEqual([1100, 240])
        await expectSaved(a.page)

        await pressUndo(a.page)
        await expect.poll(() => position(a.page, ID.undo)).toEqual([1000, 80])
        await expect.poll(() => position(b.page, ID.undo)).toEqual([1000, 80])

        await pressRedo(a.page)
        await expect.poll(() => position(a.page, ID.undo)).toEqual([1100, 240])
        await expect.poll(() => position(b.page, ID.undo)).toEqual([1100, 240])
      })

      await expectSaved(a.page)
      await expectSaved(b.page)
      await expectConverged(a.page, [b.page])
      const snap = await expectServerConverged(stack, board, [a.page, b.page])
      expect(await editingId(a.page)).toBeNull()
      before = {
        hash: snap.hash,
        arrow: arrowId,
        ids: snap.elements
          .filter((e) => !e.isDeleted)
          .map((e) => e.id)
          .sort(),
      }
      for (const s of [a, b]) {
        await selectNone(s.page)
        await zoomToFit(s.page)
      }
    })

    test('2) reload preserves all of it', async ({ stack }) => {
      const expected = before
      test.skip(!expected, 'needs the board from step 1')
      if (!expected) return
      await Promise.all([a.page.reload(), b.page.reload()])
      await Promise.all([waitForCanvas(a.page), waitForCanvas(b.page)])
      // the same element map (every field, tombstones included) as before the reload, on both tabs
      await expect.poll(() => hash(a.page)).toBe(expected.hash)
      await expect.poll(() => hash(b.page)).toBe(expected.hash)
      expect((await serverSnapshot(stack, board)).hash).toBe(expected.hash)
      expect(await labelText(a.page, ID.noteA)).toBe('Hello from alice')
      expect(await labelText(b.page, ID.noteB)).toBe('From bob')
      expect(await arrowEnds(b.page, expected.arrow)).toEqual([ID.from, ID.to])
      await expectSaveState(a.page, 'saved')
    })

    test('3) SIGKILLed sync server: acknowledged edits survive; the tabs go offline and back; an offline edit is kept', async ({
      stack,
    }) => {
      test.skip(!before, 'needs the board from step 1')
      await expectConverged(a.page, [b.page])
      // B has this edit, so the server committed it before broadcasting it.
      await updateItem(a.page, ID.noteB, { backgroundColor: '#b2f2bb' })
      await waitForItem(
        b.page,
        ID.noteB,
        (el) => (el as { backgroundColor?: string }).backgroundColor === '#b2f2bb',
      )
      await expectSaved(a.page)
      const acknowledged = await serverSnapshot(stack, board)

      await stack.sync.kill()
      await expectSaveState(a.page, 'offline')
      await expectSaveState(b.page, 'offline')

      // An edit made while the server is down stays on A's device and is pushed after the restart.
      await updateItem(a.page, ID.undo, { x: 1300, y: 300 })
      await expect.poll(async () => (await saveState(a.page)).offlineChanges).toBe(1)
      await expect(saveIndicator(a.page)).toContainText('Offline')

      await stack.sync.start()
      await expectSaved(a.page)
      await expectSaveState(b.page, 'saved')
      await expect.poll(() => position(b.page, ID.undo)).toEqual([1300, 300])

      // what was acknowledged before the kill is stored, unchanged but for the offline edit
      const after = await serverSnapshot(stack, board)
      const changed = after.elements
        .filter((e) => JSON.stringify(e) !== JSON.stringify(acknowledged.elements.find((x) => x.id === e.id)))
        .map((e) => e.id)
      expect(changed).toEqual([ID.undo])
      expect(after.elements.length).toBe(acknowledged.elements.length)

      // A fresh context loads the stored board: every acknowledged element plus the offline edit.
      const c = await openCanvasSession(browser, board, carol)
      try {
        await expectServerConverged(stack, board, [a.page, b.page, c.page])
        expect(await labelText(c.page, ID.noteA)).toBe('Hello from alice')
        expect(await position(c.page, ID.undo)).toEqual([1300, 300])
      } finally {
        await c.context.close()
      }
      expect(stack.sync.logs()).not.toMatch(/room error|room open failed|ERR_INVALID_STATE|Error:/)
    })
  })
