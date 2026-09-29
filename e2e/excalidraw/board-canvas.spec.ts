// 2C's LobbyCanvas members on the real engine (docs/EXCALIDRAW-CONTRACTS.md §2): the board page's
// feature-facing canvas (`window.__lobbyBoard.canvas`, dev-auth builds) against a second tab. Every write
// goes through `transact` and the sync engine, so each check ends on the other tab or the server.
import type { Page } from '@playwright/test'
import type { LobbyCanvas } from '../../apps/web/src/canvas/api/lobby-canvas.ts'
import {
  createItem,
  createNote,
  expect,
  expectConverged,
  expectSaved,
  item,
  items,
  test,
  waitForItem,
} from '../tests/support/canvas.ts'

/** Runs `fn(canvas, arg)` in the page against the board page's LobbyCanvas. */
async function withCanvas<T, A>(
  page: Page,
  fn: (canvas: LobbyCanvas, arg: A) => T | Promise<T>,
  arg: A,
): Promise<T> {
  return (await page.evaluate(
    async ({ src, arg }) => {
      const b = (window as unknown as { __lobbyBoard?: { canvas: unknown } }).__lobbyBoard
      if (!b) throw new Error('no window.__lobbyBoard')
      // the spec's own function, serialized into its own page
      const f = new Function(`return (${src})`)() as (c: unknown, a: unknown) => unknown
      return await f(b.canvas, arg)
    },
    { src: fn.toString(), arg },
  )) as T
}

async function labelText(page: Page, id: string): Promise<string | null> {
  const note = await item(page, id)
  const labelId = (
    (note as { boundElements?: { id: string; type: string }[] } | null)?.boundElements ?? []
  ).find((e) => e.type === 'text')?.id
  const label = (await items(page)).find((e) => e.id === labelId) as { originalText?: string } | undefined
  return label?.originalText ?? null
}

test('reads: text, hit test, hide, overlay coordinates, presence peers with their view, settings and styles', async ({
  canvasSession,
}) => {
  const a = await canvasSession('alice')
  const b = await canvasSession('bob')
  const note = await createNote(a.page, { x: 100, y: 100, size: 200, text: 'Read me' })
  await waitForItem(b.page, note)
  expect(await withCanvas(a.page, (c, id) => c.text.of(id), note)).toBe('Read me')
  expect(await withCanvas(a.page, (c, id) => c.text.canEdit(id), note)).toBe(true)
  expect(await withCanvas(b.page, (c, id) => c.hitTest({ x: 200, y: 200 })?.id === id, note)).toBe(true)
  expect(await withCanvas(b.page, (c) => c.hitTest({ x: 900, y: 900 }), null)).toBeNull()
  // hide: hidden for hit tests and isHidden until the returned function runs
  expect(
    await withCanvas(
      b.page,
      async (c, id) => {
        const show = c.hide('spec', [id])
        await new Promise((r) => requestAnimationFrame(r))
        const hidden = [c.isHidden(id), c.hitTest({ x: 200, y: 200 })]
        show()
        await new Promise((r) => requestAnimationFrame(r))
        return { hidden, after: c.isHidden(id) }
      },
      note,
    ),
  ).toEqual({ hidden: [true, null], after: false })
  // overlay coordinates are sceneToScreen minus the canvas origin
  const o = await withCanvas(
    a.page,
    (c) => {
      const s = c.sceneToScreen({ x: 100, y: 100 })
      const r = c.viewport.screenRect()
      const ov = c.sceneToOverlay({ x: 100, y: 100 })
      return { dx: s.x - r.x - ov.x, dy: s.y - r.y - ov.y, back: c.overlayToScene(ov) }
    },
    null,
  )
  expect(Math.abs(o.dx) + Math.abs(o.dy)).toBeLessThan(1)
  expect(o.back).toEqual({ x: 100, y: 100 })
  // presence: bob's pointer and view reach alice
  await b.page.mouse.move(700, 450)
  await b.page.mouse.move(720, 460, { steps: 3 })
  await expect
    .poll(() =>
      withCanvas(
        a.page,
        (c) => {
          const p = c.presence.peers()[0]
          return p ? { name: p.name, point: !!p.point, view: !!p.view && p.view.width > 0 } : null
        },
        null,
      ),
    )
    .toEqual({ name: b.name, point: true, view: true })
  // settings (local) and the next-element styles (view state, no push)
  const pushes = (await withCanvas(a.page, (c) => c.engine?.pushLog().length ?? 0, null)) as number
  expect(
    await withCanvas(
      a.page,
      (c) => {
        c.settings.set({ grid: true })
        c.styles.setNext({ strokeColor: '#e03131', opacity: 60 })
        return { grid: c.settings.get().grid, next: c.styles.next() }
      },
      null,
    ),
  ).toMatchObject({ grid: true, next: { strokeColor: '#e03131', opacity: 60 } })
  await a.page.waitForTimeout(300)
  expect(await withCanvas(a.page, (c) => c.engine?.pushLog().length ?? 0, null)).toBe(pushes)
})

test('writes: text.replace through the lease, and the structural tx writes, converge on the other tab', async ({
  canvasSession,
}) => {
  const a = await canvasSession('alice')
  const b = await canvasSession('bob')
  const note = await createNote(a.page, { x: 100, y: 100, text: 'Before' })
  const r1 = await createItem(a.page, 'rectangle', { x: 400, y: 100, width: 100, height: 80 })
  const r2 = await createItem(a.page, 'rectangle', { x: 560, y: 100, width: 100, height: 80 })
  const arrow = await createItem(a.page, 'arrow', {
    x: 500,
    y: 140,
    points: [
      [0, 0],
      [60, 0],
    ],
  })
  await waitForItem(b.page, arrow)

  // programmatic words: the lease is taken and given back, the words reach bob
  expect(await withCanvas(a.page, (c, id) => c.text.replace(id, 'After the replace'), note)).toBe(true)
  await expect.poll(() => labelText(b.page, note)).toBe('After the replace')
  await expect.poll(() => withCanvas(a.page, (c, id) => c.leaseHolder(id), note)).toBeNull()

  // group, reorder, bind in one step each; duplicate copies with a new id
  const gid = await withCanvas(a.page, (c, ids) => c.transact('group', (tx) => tx.group(ids)), [r1, r2])
  await expect.poll(async () => (await item(b.page, r2))?.groupIds).toEqual([gid])
  await withCanvas(a.page, (c, id) => c.transact('front', (tx) => tx.reorder([id], 'back')), r2)
  await withCanvas(
    a.page,
    (c, ids) =>
      c.transact('bind', (tx) => {
        tx.bind(ids.arrow, 'start', ids.r1)
        tx.bind(ids.arrow, 'end', ids.r2)
      }),
    { arrow, r1, r2 },
  )
  await expect
    .poll(async () => {
      const el = (await item(b.page, arrow)) as {
        startBinding?: { elementId: string } | null
        endBinding?: { elementId: string } | null
      } | null
      return [el?.startBinding?.elementId, el?.endBinding?.elementId]
    })
    .toEqual([r1, r2])
  const copies = (await withCanvas(
    a.page,
    (c, id) => Object.fromEntries(c.transact('dup', (tx) => tx.duplicate([id], { x: 0, y: 300 }))),
    note,
  )) as Record<string, string>
  const copy = copies[note] as string
  expect(copy).toBeTruthy()
  await expect.poll(() => labelText(b.page, copy)).toBe('After the replace')
  await expectSaved(a.page)
  await expectConverged(a.page, [b.page])
})

test('history: canUndo, undo and redo, and transact joinPrevious folding a derived write into the step', async ({
  canvasSession,
}) => {
  const a = await canvasSession('alice')
  const b = await canvasSession('bob')
  const box = await createItem(a.page, 'rectangle', { x: 100, y: 100, width: 100, height: 80 })
  const other = await createItem(a.page, 'rectangle', { x: 300, y: 100, width: 100, height: 80 })
  await waitForItem(b.page, other)
  expect(await withCanvas(a.page, (c) => c.history.canUndo(), null)).toBe(true)
  // the user's step (a move), then a derived write joined to it (the other box follows)
  await withCanvas(
    a.page,
    (c, ids) => {
      c.transact('move', (tx) => tx.update(ids.box, { x: 150 }))
      c.transact('follow', (tx) => tx.update(ids.other, { x: 350 }), { joinPrevious: true })
    },
    { box, other },
  )
  await expect
    .poll(async () => [(await item(b.page, box))?.x, (await item(b.page, other))?.x])
    .toEqual([150, 350])
  // one undo reverts both, for everyone; redo brings both back
  await withCanvas(a.page, (c) => c.history.undo(), null)
  await expect
    .poll(async () => [(await item(b.page, box))?.x, (await item(b.page, other))?.x])
    .toEqual([100, 300])
  expect(await withCanvas(a.page, (c) => c.history.canRedo(), null)).toBe(true)
  await withCanvas(a.page, (c) => c.history.redo(), null)
  await expect
    .poll(async () => [(await item(b.page, box))?.x, (await item(b.page, other))?.x])
    .toEqual([150, 350])
  await expectSaved(a.page)
})

test('the camera: an animated set is moving until it lands, stop() ends it, and a text editor opens through text.edit', async ({
  canvasSession,
}) => {
  const a = await canvasSession('alice')
  const note = await createNote(a.page, { x: 100, y: 100, text: 'Edit me' })
  const r = await withCanvas(
    a.page,
    async (c) => {
      c.viewport.set({ x: 500, y: 400, zoom: 0.5 }, { animate: { durationMs: 400 } })
      await new Promise((res) => setTimeout(res, 100))
      const during = c.viewport.moving()
      await new Promise((res) => setTimeout(res, 600))
      const v = c.viewport.get()
      const landed = { x: Math.round(v.x), y: Math.round(v.y), zoom: v.zoom }
      c.viewport.set({ x: 0, y: 0, zoom: 1 }, { animate: { durationMs: 2000 } })
      await new Promise((res) => setTimeout(res, 100))
      c.viewport.stop()
      await new Promise((res) => requestAnimationFrame(() => requestAnimationFrame(res)))
      const stopped = c.viewport.get().zoom
      await new Promise((res) => setTimeout(res, 300))
      return {
        during,
        landed,
        stoppedStays: c.viewport.get().zoom === stopped,
        settled: !c.viewport.moving(),
      }
    },
    null,
  )
  expect(r).toEqual({
    during: true,
    landed: { x: 500, y: 400, zoom: 0.5 },
    stoppedStays: true,
    settled: true,
  })
  await withCanvas(a.page, (c) => c.viewport.set({ x: 0, y: 0, zoom: 1 }), null)
  // text.edit opens the editor through the lease; text.stop closes it
  expect(await withCanvas(a.page, (c, id) => c.text.edit(id, { via: 'api', caret: 'end' }), note)).toBe(true)
  await expect(a.page.locator('textarea.excalidraw-wysiwyg')).toBeFocused()
  expect(await withCanvas(a.page, (c) => !!c.text.editorElement(), null)).toBe(true)
  await withCanvas(a.page, (c) => c.text.stop(), null)
  await expect.poll(() => withCanvas(a.page, (c) => c.editingId(), null)).toBeNull()
  expect(await labelText(a.page, note)).toBe('Edit me')
})
