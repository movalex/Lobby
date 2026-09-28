import { expect, test } from '@playwright/test'
import { openSpike } from '../support/page.ts'
import { filePickerCalls, instrumentFilePickers, watchPage } from '../support/watch.ts'

// SCAFFOLD smoke (spike A): the engine page loads behind VITE_LOBBY_ENGINE=excalidraw + dev auth, the API
// is exposed, a sticky note with a bound label made through api.updateScene renders and reads back, the
// fonts come from /excalidraw-assets/, and nothing errors or leaves localhost.

const LABEL = 'Hello Lobby'

test('engine page: API, a sticky note with a bound label, self-hosted fonts, no foreign requests', async ({
  page,
}) => {
  const watch = watchPage(page)
  await openSpike(page, 'engine', { role: 'editor', theme: 'light' })

  // The API and the fixed appState defaults (plan §2.3.2).
  const state = await page.evaluate(() => {
    const spike = window.__lobbySpike
    const api = spike?.api
    if (!spike || !api) throw new Error('no __lobbySpike.api')
    const s = api.getAppState()
    return {
      role: spike.role,
      hasSetRole: typeof spike.setRole === 'function',
      methods: ['updateScene', 'getSceneElements', 'setActiveTool', 'onPointerDown', 'registerAction'].filter(
        (m) => typeof api[m] === 'function',
      ),
      fontFamily: s.currentItemFontFamily,
      roughness: s.currentItemRoughness,
      theme: s.theme,
      assetPath: (window as unknown as { EXCALIDRAW_ASSET_PATH?: unknown }).EXCALIDRAW_ASSET_PATH,
      throttle: (window as unknown as { EXCALIDRAW_THROTTLE_RENDER?: unknown }).EXCALIDRAW_THROTTLE_RENDER,
      elements: api.getSceneElementsIncludingDeleted().length,
    }
  })
  expect(state).toEqual({
    role: 'editor',
    hasSetRole: true,
    methods: ['updateScene', 'getSceneElements', 'setActiveTool', 'onPointerDown', 'registerAction'],
    fontFamily: 6,
    roughness: 0,
    theme: 'light',
    assetPath: '/excalidraw-assets/',
    throttle: true,
    elements: 0,
  })
  // ui={false}: no toolbar, menu or control. (Empty .layer-ui__wrapper and footer containers still render;
  // the full visual pin is A5.)
  await expect(page.locator('.excalidraw .App-toolbar, .excalidraw .main-menu-trigger')).toHaveCount(0)
  await expect(
    page
      .locator('.excalidraw')
      .locator('button, [role=button], input, select, a[href]')
      .filter({ visible: true }),
  ).toHaveCount(0)

  // A sticky note with a bound Nunito label, as a remote/server scene would arrive.
  const readBack = await page.evaluate((text) => {
    const spike = window.__lobbySpike
    const api = spike?.api
    if (!spike || !api) throw new Error('no __lobbySpike.api')
    const { lib } = spike
    const elements = lib.convertToExcalidrawElements(
      [
        {
          type: 'stickynote',
          id: 'note-1',
          x: 200,
          y: 150,
          width: 250,
          height: 250,
          label: { text, fontFamily: lib.FONT_FAMILY.Nunito },
        },
      ],
      { regenerateIds: false },
    ) // the default regenerates every id (element dist/dev/index.js:24527)
    api.updateScene({ elements, captureUpdate: lib.CaptureUpdateAction.NEVER })
    const scene = api.getSceneElements()
    const note = scene.find((e) => e.id === 'note-1')
    const label = scene.find((e) => e.type === 'text')
    return {
      count: scene.length,
      noteType: note?.type,
      labelContainer: label?.containerId,
      boundToNote: note?.boundElements?.some((b) => b.id === label?.id && b.type === 'text') ?? false,
      text: label?.text?.replace(/\n/g, ' '),
      fontFamily: label?.fontFamily,
    }
  }, LABEL)
  expect(readBack).toEqual({
    count: 2,
    noteType: 'stickynote',
    labelContainer: 'note-1',
    boundToNote: true,
    text: LABEL,
    fontFamily: 6,
  })

  // It renders: the note's fill at an inset corner, and dark label pixels inside the label's box, read
  // from Excalidraw's static canvas (2D).
  let paint: Record<string, unknown> = {}
  await expect
    .poll(
      async () => {
        paint = await page.evaluate(() => {
          const spike = window.__lobbySpike
          const api = spike?.api
          const canvas = document.querySelector<HTMLCanvasElement>('canvas.excalidraw__canvas.static')
          const ctx = canvas?.getContext('2d')
          if (!spike || !api || !canvas || !ctx) return { ready: false }
          const s = api.getAppState()
          const scene = api.getSceneElements()
          const note = scene.find((e) => e.id === 'note-1')
          const label = scene.find((e) => e.type === 'text')
          if (!note || !label) return { ready: false }
          const box = canvas.getBoundingClientRect()
          const sx = canvas.width / box.width
          const sy = canvas.height / box.height
          const px = (sceneX: number, sceneY: number) => {
            const v = spike.lib.sceneCoordsToViewportCoords({ sceneX, sceneY }, s)
            return { x: Math.round((v.x - box.left) * sx), y: Math.round((v.y - box.top) * sy) }
          }
          const corner = px(note.x + 12, note.y + 12)
          const [r, g, b] = ctx.getImageData(corner.x, corner.y, 1, 1).data
          const hex = note.backgroundColor.replace('#', '')
          const want = [0, 2, 4].map((i) => Number.parseInt(hex.slice(i, i + 2), 16))
          const fillMatches = [r, g, b].every((c, i) => Math.abs((c ?? -999) - (want[i] ?? 999)) <= 24)
          const a = px(label.x, label.y)
          const z = px(label.x + label.width, label.y + label.height)
          const data = ctx.getImageData(a.x, a.y, Math.max(1, z.x - a.x), Math.max(1, z.y - a.y)).data
          let dark = 0
          for (let i = 0; i < data.length; i += 4) {
            if ((data[i] ?? 255) + (data[i + 1] ?? 255) + (data[i + 2] ?? 255) < 3 * 110) dark++
          }
          return {
            ready: true,
            fillMatches,
            labelPainted: dark >= 20,
            fill: [r, g, b],
            want,
            darkPixels: dark,
          }
        })
        return { ready: paint.ready, fillMatches: paint.fillMatches, labelPainted: paint.labelPainted }
      },
      { message: 'the note and its label are painted on the static canvas' },
    )
    .toEqual({ ready: true, fillMatches: true, labelPainted: true })
  const painted = await page.evaluate(() => document.fonts.check('20px Nunito'))
  expect(painted).toBe(true)

  // Fonts: the label's Nunito came from /excalidraw-assets/fonts/, and no font request went anywhere else.
  await expect
    .poll(() =>
      watch.responses.filter((r) => new URL(r.url).pathname.startsWith('/excalidraw-assets/fonts/Nunito/')),
    )
    .not.toHaveLength(0)
  const fontResponses = watch.responses.filter((r) => /\.woff2(\?|$)/.test(r.url))
  for (const r of fontResponses) {
    const u = new URL(r.url)
    expect(`${u.host}${u.pathname}`, 'font served locally').toMatch(
      /^127\.0\.0\.1:\d+\/(excalidraw-assets\/fonts\/|assets\/)/,
    )
    expect(r.status, r.url).toBe(200)
  }

  await page.waitForTimeout(500) // let late font/network work settle before the final checks
  // Numbers for docs/research/excalidraw/spike-a/SCAFFOLD.md.
  console.log(
    'SCAFFOLD-METRICS',
    JSON.stringify({
      paint,
      requests: watch.requests.length,
      fontFiles: fontResponses.map((r) => new URL(r.url).pathname),
      foreign: watch.foreignRequests().length,
      consoleErrors: watch.consoleErrors.length,
    }),
  )
  expect(watch.foreignRequests(), 'requests to non-localhost hosts').toEqual([])
  expect(watch.consoleErrors, 'console errors').toEqual([])
  expect(watch.pageErrors, 'page errors').toEqual([])
})

test('an unknown spike page shows the list of pages, not an error', async ({ page }) => {
  const watch = watchPage(page)
  await openSpike(page, 'no-such-page', { waitReady: false })
  await expect(page.getByTestId('spike-missing')).toContainText('engine')
  expect(watch.consoleErrors).toEqual([])
  expect(watch.foreignRequests()).toEqual([])
})

// The helpers later checks rely on (A4, A6, B5: "0 downloads, 0 dialogs"): each counter really counts.
test('harness self-test: foreign requests are blocked but recorded; downloads, dialogs, pickers count', async ({
  page,
}) => {
  const watch = watchPage(page)
  await instrumentFilePickers(page)
  await openSpike(page, 'engine')
  watch.reset()
  const fetched = await page.evaluate(() =>
    fetch('https://blocked.invalid/probe').then(
      () => 'reached',
      () => 'blocked',
    ),
  )
  expect(fetched).toBe('blocked')
  expect(watch.foreignRequests()).toEqual(['https://blocked.invalid/probe'])

  await page.evaluate(() => {
    const a = document.createElement('a')
    a.href = URL.createObjectURL(new Blob(['x'], { type: 'text/plain' }))
    a.download = 'probe.txt'
    document.body.append(a)
    a.click()
    a.remove()
    alert('probe')
    void (window as unknown as { showSaveFilePicker: () => Promise<unknown> })
      .showSaveFilePicker()
      .catch(() => {})
  })
  await expect.poll(() => watch.downloads).toBe(1)
  expect(watch.dialogs).toBe(1)
  expect(await filePickerCalls(page)).toEqual({
    showSaveFilePicker: 1,
    showOpenFilePicker: 0,
    showDirectoryPicker: 0,
  })
})
