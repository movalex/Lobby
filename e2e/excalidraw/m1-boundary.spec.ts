// Hotfix H1 (wave M, M1-2; the first-time scout's FTU-1): one feature's error can never blank the board again.
// Through the dev-auth debug handle, a test-only feature (canvas/board/probe.tsx CRASH_PROBE_FEATURE) whose screen
// overlay throws while anything is selected and whose selection-bar item always throws, next to the board page's
// probe feature. Selecting a note must leave the board alive: no page error, the facade installed, the selection
// bar with its other items, the probe's other overlays. Each crash logs one line (`feature_crash <id>`), the
// overlay comes back when the selection changes, and after 3 crashes within a minute it stays off until a reload.
//
//   E2E_PORT_BASE=<base> pnpm exec playwright test excalidraw/m1-boundary.spec.ts --project=chromium --workers=1
import type { Page } from '@playwright/test'
import {
  createNote,
  expect,
  expectSaved,
  select,
  selection,
  test,
  waitForCanvas,
} from '../tests/support/canvas.ts'

const installProbes = (page: Page) =>
  page.evaluate(() => {
    const h = (window as { __lobbyBoard?: { installProbe?: () => void; installCrashProbe?: () => void } })
      .__lobbyBoard
    if (!h?.installProbe || !h.installCrashProbe)
      throw new Error('no probe installers on window.__lobbyBoard')
    h.installProbe()
    h.installCrashProbe()
  })

test('a feature overlay and a selection-bar item that throw on a selection: the board, the bar and the other overlays stay; one log line per crash; back on a new selection; off after 3 crashes in a minute', async ({
  canvasSession,
}) => {
  const a = await canvasSession('alice')
  const page = a.page
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(`${e.name}: ${e.message}`.slice(0, 300)))
  const crashLines: string[] = []
  page.on('console', (m) => {
    if (m.text().startsWith('feature_crash')) crashLines.push(m.text())
  })
  const notes: string[] = []
  for (const x of [0, 300, 600, 900]) {
    notes.push(await createNote(page, { x, y: 0, text: `Note ${x}` }))
    await expectSaved(page)
  }
  await installProbes(page)
  await expect(page.getByTestId('crash-probe-ok')).toBeAttached()
  await expect(page.getByTestId('probe-screen')).toBeVisible()
  await expect(page.getByTestId('probe-topbar')).toBeVisible()

  const alive = async () => {
    expect(errors).toEqual([])
    expect(await page.evaluate(() => typeof (window as { lobbyCanvas?: unknown }).lobbyCanvas)).toBe('object')
    await expect(page.locator('.excalidraw canvas').first()).toBeVisible()
    await expect(page.getByTestId('probe-screen')).toBeVisible()
    await expect(page.getByTestId('probe-pin').first()).toBeAttached()
    await expect(page.getByTestId('probe-topbar')).toBeVisible()
  }
  const overlayCrashes = () => crashLines.filter((l) => l === 'feature_crash overlay:crash-probe').length
  const itemCrashes = () =>
    crashLines.filter((l) => l === 'feature_crash selectionBar:crash-probe.item').length

  await test.step('select a note: only the crashing overlay and item drop out', async () => {
    await select(page, [notes[0] as string])
    // the board first (without the boundary, React unmounts the whole page here)
    await page.waitForTimeout(500)
    await alive()
    await expect.poll(overlayCrashes).toBe(1)
    await expect.poll(itemCrashes).toBe(1)
    expect(await selection(page)).toEqual([notes[0]])
    await expect(page.getByTestId('crash-probe-ok')).toHaveCount(0)
    const bar = page.getByTestId('selection-bar')
    await expect(bar).toBeVisible()
    await expect(bar.getByTestId('selection-lock')).toBeVisible()
    // every log line is exactly the id: no props, no content
    for (const l of crashLines) expect(l).toMatch(/^feature_crash [a-zA-Z0-9:._-]+$/)
  })

  await test.step('a new selection (here: none) gives the overlay another try', async () => {
    await select(page, [])
    await expect(page.getByTestId('crash-probe-ok')).toBeAttached()
    await alive()
  })

  await test.step('3 crashes within a minute: it stays off until a reload, the board still alive', async () => {
    await select(page, [notes[1] as string])
    await expect.poll(overlayCrashes).toBe(2)
    await select(page, [])
    await expect(page.getByTestId('crash-probe-ok')).toBeAttached()
    await select(page, [notes[2] as string])
    await expect.poll(overlayCrashes).toBe(3)
    await select(page, [])
    // off: no marker even with nothing selected, and no further crash on the next selection
    await page.waitForTimeout(500)
    await expect(page.getByTestId('crash-probe-ok')).toHaveCount(0)
    await select(page, [notes[3] as string])
    await page.waitForTimeout(500)
    expect(overlayCrashes()).toBe(3)
    expect(itemCrashes()).toBe(3)
    await alive()
    await expect(page.getByTestId('selection-bar').getByTestId('selection-lock')).toBeVisible()
  })

  await test.step('a reload brings it back (it is off for this page load only)', async () => {
    await page.reload()
    await waitForCanvas(page)
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            typeof (window as { __lobbyBoard?: { installCrashProbe?: unknown } }).__lobbyBoard
              ?.installCrashProbe,
        ),
      )
      .toBe('function')
    await installProbes(page)
    await expect(page.getByTestId('crash-probe-ok')).toBeAttached()
    expect(errors).toEqual([])
  })
})
