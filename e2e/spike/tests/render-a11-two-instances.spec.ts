import { expect, type Page, test } from '@playwright/test'
import type { EchoProbe, RenderApi, RenderEngine } from '../fixtures/render-types.ts'
import { openSpike } from '../support/page.ts'
import { watchPage } from '../support/watch.ts'

// A11 (docs/EXCALIDRAW-MIGRATION.md §8.2, §4.6), part 2, for the record: two <Excalidraw> instances
// (Lobby's ExcalidrawHost) on one page. Each probe records what works and what leaks; the spec fails only
// if the page cannot run the probes. The findings go to docs/research/excalidraw/spike-a/A11.md.

interface Side {
  api: RenderApi
  probe: EchoProbe
  id: string
  root: HTMLElement
  pixel(x: number, y: number): number[] | null
  dark(r: { x: number; y: number; w: number; h: number }): number
}
interface TwoExtra {
  a: Side
  b: Side
  engine: RenderEngine
  unmountB(): void
  mountB(): void
}

const YELLOW = [0xff, 0xdf, 0x6b]
const near = (a: number[] | null, b: readonly number[], tol = 16) =>
  !!a && b.every((c, i) => Math.abs((a[i] ?? -999) - c) <= tol)

const addNote = (
  page: Page,
  side: 'a' | 'b',
  id: string,
  x: number,
  y: number,
  extra: Record<string, unknown> = {},
) =>
  page.evaluate(
    ({ side, id, x, y, extra }) => {
      const t = window.__lobbySpike?.extra as unknown as TwoExtra
      const s = t[side]
      const els = t.engine.convertToExcalidrawElements(
        [
          {
            type: 'stickynote',
            id,
            x,
            y,
            width: 200,
            height: 200,
            backgroundColor: '#ffdf6b',
            label: { text: `${side} ${id}`, fontFamily: 6 },
            ...extra,
          },
        ],
        { regenerateIds: false },
      )
      const current = s.api.getSceneElementsIncludingDeleted()
      s.probe.applyServer([...current, ...els.map((e) => ({ ...e, created: null }))])
    },
    { side, id, x, y, extra },
  )

const sel = (page: Page, side: 'a' | 'b') =>
  page.evaluate((side) => {
    const s = ((window.__lobbySpike as { extra: unknown }).extra as TwoExtra)[side]
    const ids = s.api.getAppState().selectedElementIds as Record<string, boolean>
    return Object.keys(ids).filter((k) => ids[k])
  }, side)

const clientOf = (page: Page, side: 'a' | 'b', x: number, y: number) =>
  page.evaluate(
    ({ side, x, y }) => {
      const spike = window.__lobbySpike
      const s = ((spike as { extra: unknown }).extra as TwoExtra)[side]
      if (!spike) throw new Error('no spike')
      return spike.lib.sceneCoordsToViewportCoords({ sceneX: x, sceneY: y }, s.api.getAppState())
    },
    { side, x, y },
  )

const count = (page: Page, side: 'a' | 'b') =>
  page.evaluate((side) => {
    const s = ((window.__lobbySpike as { extra: unknown }).extra as TwoExtra)[side]
    return s.api.getSceneElements().length
  }, side)

test('two Excalidraw instances on one page: what works and what leaks (for the record)', async ({ page }) => {
  const watch = watchPage(page)
  await openSpike(page, 'render-two')
  const record: Record<string, unknown> = {}

  // 1. both mount with their own API
  const mount = await page.evaluate(() => {
    const t = window.__lobbySpike?.extra as unknown as TwoExtra
    return {
      ids: [t.a.id, t.b.id],
      containers: document.querySelectorAll('.excalidraw').length,
      darkContainers: [...document.querySelectorAll('.excalidraw')].map((e) =>
        e.classList.contains('theme--dark'),
      ),
      themes: [t.a.api.getAppState().theme, t.b.api.getAppState().theme],
    }
  })
  record.mount = mount
  expect(mount.containers).toBe(2)
  expect(mount.ids[0]).not.toBe(mount.ids[1])

  // 2. scenes are separate; each renders its own
  await addNote(page, 'a', 'na', 60, 60)
  await addNote(page, 'b', 'nb', 60, 300)
  await page.waitForTimeout(300)
  const scenes = {
    aCount: await count(page, 'a'),
    bCount: await count(page, 'b'),
    aPixelNa: await page.evaluate(() =>
      ((window.__lobbySpike as { extra: unknown }).extra as TwoExtra).a.pixel(72, 72),
    ),
    bPixelNaSpot: await page.evaluate(() =>
      ((window.__lobbySpike as { extra: unknown }).extra as TwoExtra).b.pixel(72, 72),
    ),
    bPixelNb: await page.evaluate(() =>
      ((window.__lobbySpike as { extra: unknown }).extra as TwoExtra).b.pixel(72, 312),
    ),
  }
  record.scenes = scenes
  expect(scenes.aCount).toBe(2)
  expect(scenes.bCount).toBe(2)
  expect(near(scenes.aPixelNa, YELLOW)).toBe(true)

  // 3. selection by click, and a key (Delete) go to the instance that has focus
  const pa = await clientOf(page, 'a', 160, 100)
  await page.mouse.click(pa.x, pa.y)
  record.selectAfterClickA = { a: await sel(page, 'a'), b: await sel(page, 'b') }
  await page.keyboard.press('Delete')
  await page.waitForTimeout(100)
  record.deleteInA = { a: await count(page, 'a'), b: await count(page, 'b') }

  // 4. text editing in B only: double-click B's note, type, Escape
  const pb = await clientOf(page, 'b', 160, 400)
  await page.mouse.dblclick(pb.x, pb.y)
  await page.waitForTimeout(100)
  const editor = await page.evaluate(() => {
    const t = window.__lobbySpike?.extra as unknown as TwoExtra
    const ta = document.querySelector('textarea.excalidraw-wysiwyg')
    return {
      textareas: document.querySelectorAll('textarea.excalidraw-wysiwyg').length,
      inB: !!ta && (document.querySelector('[data-testid="instance-b"]')?.contains(ta) ?? false),
      editingA: !!t.a.api.getAppState().editingTextElement,
      editingB: !!t.b.api.getAppState().editingTextElement,
    }
  })
  await page.keyboard.type(' typed')
  await page.keyboard.press('Escape')
  await page.waitForTimeout(100)
  const labels = await page.evaluate(() => {
    const t = window.__lobbySpike?.extra as unknown as TwoExtra
    const texts = (s: Side) =>
      s.api
        .getSceneElements()
        .filter((e) => e.type === 'text')
        .map((e) => e.text)
    return { a: texts(t.a), b: texts(t.b) }
  })
  record.textEditingInB = { editor, labels }

  // 5. render overrides of A do not reach B
  await addNote(page, 'a', 'na2', 60, 60)
  await page.evaluate(() => {
    const t = window.__lobbySpike?.extra as unknown as TwoExtra
    t.a.api.setElementRenderOverrides(new Map([['na2', { offset: { x: 300, y: 0 } }]]))
    t.b.api.setElementRenderOverrides(null)
  })
  await page.waitForTimeout(200)
  record.overridesIsolated = {
    aMoved: near(
      await page.evaluate(() =>
        ((window.__lobbySpike as { extra: unknown }).extra as TwoExtra).a.pixel(372, 72),
      ),
      YELLOW,
    ),
    bStill: near(
      await page.evaluate(() =>
        ((window.__lobbySpike as { extra: unknown }).extra as TwoExtra).b.pixel(72, 312),
      ),
      [0x71, 0x5c, 0x1a],
      90,
    ),
  }

  // 6. the shared editor jotai store (index.js:398): Tab's shape-switch panel atom set by A is read by B.
  //    Single instance: the first Tab on a selected rectangle opens the panel, the second converts it
  //    (index.js:43955-43980). With A's panel open, does B's FIRST Tab convert B's rectangle?
  const tab = await page.evaluate(async () => {
    const t = window.__lobbySpike?.extra as unknown as TwoExtra
    const mk = (s: Side, id: string, y: number) => {
      const els = t.engine.convertToExcalidrawElements(
        [{ type: 'rectangle', id, x: 600, y, width: 120, height: 80 }],
        { regenerateIds: false },
      )
      s.probe.applyServer([...s.api.getSceneElementsIncludingDeleted(), ...els])
      s.api.updateScene({ appState: { selectedElementIds: { [id]: true } } })
    }
    mk(t.a, 'ra', 60)
    mk(t.b, 'rb', 300)
    await new Promise((r) => setTimeout(r, 100))
    const press = (s: Side) => {
      const container = s.root.querySelector<HTMLElement>('.excalidraw')
      container?.focus()
      container?.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Tab', code: 'Tab', bubbles: true, cancelable: true }),
      )
    }
    const typeOf = (s: Side, id: string) => s.api.getSceneElements().find((e) => e.id === id)?.type
    press(t.a)
    await new Promise((r) => setTimeout(r, 100))
    const aAfterFirst = typeOf(t.a, 'ra')
    press(t.b)
    await new Promise((r) => setTimeout(r, 100))
    const bAfterFirst = typeOf(t.b, 'rb')
    return { aAfterFirst, bAfterFirst }
  })
  record.sharedJotaiTab = tab

  // 7. unmount B: A keeps working; mount a fresh B
  await page.evaluate(() => ((window.__lobbySpike as { extra: unknown }).extra as TwoExtra).unmountB())
  await page.waitForTimeout(300)
  await addNote(page, 'a', 'na3', 60, 300)
  await page.waitForTimeout(200)
  const afterUnmount = {
    containers: await page.evaluate(() => document.querySelectorAll('.excalidraw').length),
    aPixel: await page.evaluate(() =>
      ((window.__lobbySpike as { extra: unknown }).extra as TwoExtra).a.pixel(72, 312),
    ),
  }
  const pa3 = await clientOf(page, 'a', 160, 400)
  await page.mouse.click(pa3.x, pa3.y)
  const aSelectAfterUnmount = await sel(page, 'a')
  record.afterUnmountB = {
    ...afterUnmount,
    aSelect: aSelectAfterUnmount,
    aPainted: near(afterUnmount.aPixel, YELLOW),
  }
  await page.evaluate(() => ((window.__lobbySpike as { extra: unknown }).extra as TwoExtra).mountB())
  await page.waitForFunction(() => {
    const t = window.__lobbySpike?.extra as unknown as TwoExtra | undefined
    return !!t?.b && !t.b.api.isDestroyed && document.querySelectorAll('.excalidraw').length === 2
  })
  await addNote(page, 'b', 'nb2', 60, 60)
  await page.waitForTimeout(300)
  record.remountB = {
    bCount: await count(page, 'b'),
    bPixel: await page.evaluate(() =>
      ((window.__lobbySpike as { extra: unknown }).extra as TwoExtra).b.pixel(72, 72),
    ),
  }

  record.errors = { console: watch.consoleErrors, page: watch.pageErrors }
  record.foreign = watch.foreignRequests()
  console.log('A11-METRICS two-instances', JSON.stringify(record))
  // the record is the result; these only guard that the page itself ran
  expect(watch.pageErrors).toEqual([])
  expect(watch.foreignRequests()).toEqual([])
})
