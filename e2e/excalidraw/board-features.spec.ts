// The feature host of the Excalidraw board page (docs/EXCALIDRAW-CONTRACTS.md §3-§4): every place the
// page renders or dispatches registry entries, through a probe CanvasFeature the page installs on
// request in dev-auth builds (apps/web/src/canvas/board/probe.tsx): a dock panel, a pinned top-bar
// item, a scene overlay pinned to an element, a screen overlay that stays in focus mode, the toolbar
// host slot, a command's chord, and the change and input streams (local, remote, history).
import type { Page } from '@playwright/test'
import {
  clickItem,
  createNote,
  dblclickItem,
  editingId,
  expect,
  items,
  sceneToScreen,
  setTool,
  setViewport,
  test,
  tool,
  waitForItem,
} from '../tests/support/canvas.ts'
import { focusBoard } from './board-kit.ts'

interface ProbeView {
  mounted: boolean
  role: string | null
  changes: { source: string; created: string[]; updated: string[]; deleted: string[] }[]
  inputs: number
  commands: number
  toolUps: (string | null)[]
  toolDoubleClicks: (string | null)[]
  toolExits: number
}
const probe = (page: Page) =>
  page.evaluate(() => (window as unknown as { __lobbyProbe?: ProbeView }).__lobbyProbe ?? null)

async function expectPinAt(page: Page, scene: { x: number; y: number }) {
  const want = await sceneToScreen(page, scene)
  await expect
    .poll(async () => {
      const box = await page.getByTestId('probe-pin').boundingBox()
      return box ? Math.max(Math.abs(box.x - want.x), Math.abs(box.y - want.y)) : Number.POSITIVE_INFINITY
    })
    .toBeLessThan(2)
}

test('the feature host renders the registries: dock, top bar, overlays, the toolbar slot, keys, streams and focus mode', async ({
  canvasSession,
}) => {
  const a = await canvasSession('alice')
  const b = await canvasSession('bob')
  await createNote(a.page, { x: 200, y: 200, text: 'Pin me' })
  await a.page.evaluate(() =>
    (window as unknown as { __lobbyBoard?: { installProbe?(): void } }).__lobbyBoard?.installProbe?.(),
  )
  await expect.poll(async () => (await probe(a.page))?.mounted).toBe(true)
  expect((await probe(a.page))?.role).toBe('owner')

  // the dock: the rail's tab opens the panel with the feature context, the panel's close closes it
  await a.page.getByTestId('dock-tab-probe').click()
  await expect(a.page.getByTestId('probe-panel')).toHaveAttribute('data-role', 'owner')
  await expect(a.page.getByTestId('dock-panel-probe')).toBeVisible()
  await a.page.getByTestId('probe-panel-close').click()
  await expect(a.page.getByTestId('probe-panel')).toHaveCount(0)

  // a pinned top-bar item and the toolbar host slot
  await expect(a.page.getByTestId('topbar').getByTestId('probe-topbar')).toBeVisible()
  await expect(a.page.locator('[data-lobby-slot="toolbar"] [data-testid="probe-toolbar"]')).toBeVisible()

  // a scene overlay sits on its element and follows the camera
  await expectPinAt(a.page, { x: 200, y: 200 })
  await setViewport(a.page, { x: -120, y: -60, zoom: 1.5 })
  await expectPinAt(a.page, { x: 200, y: 200 })

  // a command's chord runs it through the key registry, with the board's keyboard
  await focusBoard(a.page)
  await a.page.keyboard.press('ControlOrMeta+Alt+Shift+KeyP')
  await expect(a.page.getByTestId('probe-toast')).toContainText('Probe command ran')
  expect((await probe(a.page))?.commands).toBe(1)
  // the input stream saw the real pointer
  expect((await probe(a.page))?.inputs ?? 0).toBeGreaterThan(0)

  // the change stream: bob's note is remote, alice's own is local, her undo of it is history
  const bobs = await createNote(b.page, { x: 520, y: 200, text: 'Bob' })
  await waitForItem(a.page, bobs)
  await expect
    .poll(async () =>
      (await probe(a.page))?.changes.some((c) => c.source === 'remote' && c.created.includes(bobs)),
    )
    .toBe(true)
  const mine = await createNote(a.page, { x: 200, y: 500, text: 'Mine' })
  await expect
    .poll(async () =>
      (await probe(a.page))?.changes.some((c) => c.source === 'local' && c.created.includes(mine)),
    )
    .toBe(true)
  await focusBoard(a.page)
  await a.page.keyboard.press('ControlOrMeta+z')
  await expect
    .poll(async () =>
      (await probe(a.page))?.changes.some((c) => c.source === 'history' && c.deleted.includes(mine)),
    )
    .toBe(true)
  // bob's change is never reported as alice's own
  expect(
    (await probe(a.page))?.changes.some(
      (c) => c.source !== 'remote' && (c.created.includes(bobs) || c.updated.includes(bobs)),
    ),
  ).toBe(false)

  // a feature's pointer tool: setTool takes its name, a click and a double-click reach it with the
  // element under the pointer (never Excalidraw's editor), and leaving it runs its onExit
  expect(await setTool(a.page, 'probe-tool')).toBe(true)
  expect(await tool(a.page)).toBe('probe-tool')
  const note = (await items(a.page)).find((e) => e.type === 'stickynote' && e.id !== bobs)?.id as string
  await clickItem(a.page, note)
  await expect.poll(async () => (await probe(a.page))?.toolUps).toContain(note)
  await dblclickItem(a.page, note)
  await expect.poll(async () => (await probe(a.page))?.toolDoubleClicks).toContain(note)
  expect(await editingId(a.page)).toBeNull()
  expect(await setTool(a.page, 'select')).toBe(true)
  await expect.poll(async () => (await probe(a.page))?.toolExits).toBe(1)

  // focus mode: the chrome and the layers go, a layer that says `show` stays
  await a.page.getByTestId('probe-screen').click()
  await expect(a.page.getByTestId('lobby-board')).toHaveAttribute('data-focus-mode', 'true')
  await expect(a.page.getByTestId('topbar')).toHaveCount(0)
  await expect(a.page.getByTestId('feature-dock')).toHaveCount(0)
  await expect(a.page.locator('[data-lobby-slot="toolbar"]')).toHaveCount(0)
  await expect(a.page.getByTestId('probe-pin')).toHaveCount(0)
  await expect(a.page.getByTestId('probe-screen')).toBeVisible()
  await a.page.getByTestId('probe-screen').click()
  await expect(a.page.getByTestId('topbar')).toBeVisible()
  await expect(a.page.getByTestId('probe-pin')).toBeVisible()

  // uninstalling undoes every registration and runs the feature's cleanup
  await a.page.evaluate(() =>
    (window as unknown as { __lobbyBoard?: { uninstallProbe?(): void } }).__lobbyBoard?.uninstallProbe?.(),
  )
  await expect(a.page.getByTestId('dock-tab-probe')).toHaveCount(0)
  await expect(a.page.getByTestId('probe-topbar')).toHaveCount(0)
  await expect(a.page.getByTestId('probe-pin')).toHaveCount(0)
  expect((await probe(a.page))?.mounted).toBe(false)
})
