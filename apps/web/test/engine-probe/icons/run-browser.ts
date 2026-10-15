/**
 * Wave Q (WS1) probe: the built-in icons as the pinned Excalidraw draws them (docs/WAVE-Q-CONTRACTS.md §7), against
 * a mounted <Excalidraw> of the pinned build in headless Chromium (the probe page of ../browser/, through its
 * `window.__probe.api`). Sixty icons (a spread over both sets plus the tricky ones: filled dots, filled squares and
 * stacks, rounded rectangles, ellipses, 0.01-long dots) are made by iconElements at size M (96 px) and put on the
 * scene; then, at zoom 0.5, 1 and 2, in the light and the dark theme:
 *
 *  - the static canvas is saved as a PNG (test-results/engine-probe/icons-<theme>-<zoom>.png);
 *  - every icon on screen is compared with the browser's own raster of the set's ORIGINAL SVG file at the same
 *    pixel size (ink: half the stroke's contrast or more, alpha >= 50% on the SVG side; IoU = shared ink / ink of
 *    either). PASS when every
 *    icon's IoU is at least MIN_IOU, the dark theme draws the ink light, no page error and no foreign request.
 *
 *   node apps/web/test/engine-probe/icons/run-browser.ts [--port=7759]   (default: E2E_PORT_BASE + 39 when set)
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { indexKeysBetween } from '@draftroom/canvas-schema/engine'
import { type IconGeometry, type IconSetId, IconShard } from '@draftroom/contracts'
import { iconSetFile } from '@draftroom/icon-sets/files'
import { pinnedIcons } from '@draftroom/icon-sets/generate'
import { iconElements } from '../../../src/features/elements/icons/elements.ts'
import { buildProbePage, openProbePage, PROBE_PORT_OFFSET, probePort } from '../browser/browser.ts'

/**
 * Every icon drawn by Excalidraw shares at least this much ink with its original SVG. Measured on the pinned nightly
 * (2026-10-15): the worst icon at 0.5x about 0.86, at 1x about 0.95, at 2x about 0.98 (at 0.5x the 4 px strokes are
 * mostly edge pixels); the gate catches a lost part, fill or dot, not a pixel of anti-aliasing.
 */
const MIN_IOU = 0.8
const CELL = 120
const COLS = 10
const ZOOMS = [0.5, 1, 2]
const TRICKY = [
  'lucide:chart-scatter',
  'lucide:grip',
  'lucide:ellipsis',
  'lucide:square',
  'lucide:circle',
  'lucide:rectangle-horizontal',
  'lucide:info',
  'lucide:heart',
  'tabler:dice-5',
  'tabler:app-window-bottom',
  'tabler:stack-front',
  'tabler:percentage-100',
  'tabler:transform-point-top-left',
  'tabler:circle',
  'tabler:heart',
  'tabler:dots',
]

const port = probePort(PROBE_PORT_OFFSET.icons, 7759)
const outDir = fileURLToPath(new URL('../../../../../test-results/engine-probe/', import.meta.url))
mkdirSync(outDir, { recursive: true })

// the icons: the tricky ones, then a spread over the whole index
const generated = pinnedIcons()
const geometry = new Map<string, IconGeometry>()
for (const f of generated.files)
  if (f.name.startsWith('shard-'))
    for (const [k, g] of Object.entries(IconShard.parse(JSON.parse(f.content)).icons)) geometry.set(k, g)
const all = generated.index.icons.map(([set, name]) => `${set}:${name}`)
const picked = TRICKY.filter((k) => geometry.has(k))
const step = Math.floor(all.length / (60 - picked.length))
for (let n = 0; picked.length < 60 && n < all.length; n += step)
  if (!picked.includes(all[n] as string)) picked.push(all[n] as string)

const elements: Record<string, unknown>[] = []
const cells: { key: string; x: number; y: number; svg: string }[] = []
for (const [n, key] of picked.entries()) {
  const [set, name] = key.split(':') as [IconSetId, string]
  const x = (n % COLS) * CELL
  const y = Math.floor(n / COLS) * CELL
  const out = iconElements(set, name, geometry.get(key) as IconGeometry, { size: 'M', now: 1 })
  for (const e of out.elements) elements.push({ ...e, x: (e.x as number) + x, y: (e.y as number) + y })
  const file = iconSetFile(set, set === 'lucide' ? `icons/${name}.svg` : `icons/outline/${name}.svg`)
  cells.push({ key, x, y, svg: readFileSync(file, 'utf8') })
}
const keys = indexKeysBetween(null, null, elements.length)
elements.forEach((e, n) => {
  e.index = keys[n]
})

interface Run {
  theme: string
  zoom: number
  icons: number
  minIou: number
  worst: string
  lightInk: boolean
}

await buildProbePage()
const s = await openProbePage(port)
try {
  const runs: Run[] = []
  for (const theme of ['light', 'dark'] as const) {
    for (const zoom of ZOOMS) {
      const r = await s.page.evaluate(
        async ({ elements, cells, theme, zoom }) => {
          const api = window.__probe.api as unknown as {
            updateScene(scene: Record<string, unknown>): void
            getAppState(): { width: number; height: number }
          }
          const margin = 16
          api.updateScene({
            elements,
            appState: { theme, zoom: { value: zoom }, scrollX: margin / zoom, scrollY: margin / zoom },
          })
          for (let n = 0; n < 4; n++) await new Promise((ok) => requestAnimationFrame(() => ok(null)))
          const canvas = document.querySelector('canvas.excalidraw__canvas.static') as HTMLCanvasElement
          const ctx = canvas.getContext('2d') as CanvasRenderingContext2D
          const dpr = canvas.width / canvas.clientWidth
          const px = Math.round(96 * zoom * dpr)
          const bg = ctx.getImageData(1, canvas.height - 2, 1, 1).data
          const lum = (d: Uint8ClampedArray, i: number) =>
            0.299 * (d[i] as number) + 0.587 * (d[i + 1] as number) + 0.114 * (d[i + 2] as number)
          const bgLum = lum(bg, 0)
          // ink: at least half the contrast of the strongest stroke pixel (the SVG side: alpha >= 50%)
          const whole = ctx.getImageData(0, 0, canvas.width, canvas.height).data
          let contrast = 0
          for (let i = 0; i < whole.length; i += 4)
            contrast = Math.max(contrast, Math.abs(lum(whole, i) - bgLum))
          const ref = document.createElement('canvas')
          ref.width = ref.height = px
          const rctx = ref.getContext('2d', { willReadFrequently: true }) as CanvasRenderingContext2D
          const out: { key: string; iou: number; inkLum: number }[] = []
          for (const cell of cells) {
            const sx = Math.round((cell.x + margin / zoom) * zoom * dpr)
            const sy = Math.round((cell.y + margin / zoom) * zoom * dpr)
            if (sx + px > canvas.width || sy + px > canvas.height) continue
            const got = ctx.getImageData(sx, sy, px, px).data
            rctx.clearRect(0, 0, px, px)
            const svg = cell.svg
              .replace(/<!--[\s\S]*?-->/g, '')
              .replace(/width="24"/, `width="${px}"`)
              .replace(/height="24"/, `height="${px}"`)
            const img = new Image(px, px)
            img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`
            await img.decode()
            rctx.drawImage(img, 0, 0, px, px)
            const want = rctx.getImageData(0, 0, px, px).data
            let both = 0
            let either = 0
            let inkSum = 0
            let inkCount = 0
            for (let i = 0; i < got.length; i += 4) {
              const a = Math.abs(lum(got, i) - bgLum) >= contrast / 2 ? 1 : 0
              const b = (want[i + 3] as number) >= 128 ? 1 : 0
              both += a & b
              either += a | b
              if (a) {
                inkSum += lum(got, i)
                inkCount++
              }
            }
            const inkLum = inkCount ? inkSum / inkCount : 0
            out.push({ key: cell.key, iou: either ? both / either : 1, inkLum })
          }
          return { out, bgLum, png: canvas.toDataURL('image/png') }
        },
        { elements, cells, theme, zoom },
      )
      writeFileSync(
        `${outDir}icons-${theme}-${zoom}.png`,
        Buffer.from(r.png.slice('data:image/png;base64,'.length), 'base64'),
      )
      const worst = [...r.out].sort((a, b) => a.iou - b.iou)[0]
      // dark: the ink is lighter than the background; light: darker
      const lightInk = r.out.every((o) => (theme === 'dark' ? o.inkLum > r.bgLum : o.inkLum < r.bgLum))
      runs.push({
        theme,
        zoom,
        icons: r.out.length,
        minIou: Math.round((worst?.iou ?? 0) * 1e4) / 1e4,
        worst: worst?.key ?? '',
        lightInk,
      })
    }
  }
  const pass =
    runs.every((r) => r.icons > 0 && r.minIou >= MIN_IOU && r.lightInk) &&
    s.pageErrors.length === 0 &&
    s.foreignRequests.length === 0
  writeFileSync(
    `${outDir}icons-browser.json`,
    JSON.stringify({ browser: s.browserVersion, pass, minIou: MIN_IOU, icons: picked, runs }, null, 1),
  )
  console.log(
    `icons drawn by Excalidraw vs their SVG: ${pass ? 'PASS' : 'FAIL'} — ${runs
      .map((r) => `${r.theme} ${r.zoom}x: ${r.icons} icons, min IoU ${r.minIou} (${r.worst})`)
      .join('; ')}; page errors ${s.pageErrors.length}, foreign requests ${s.foreignRequests.length}`,
  )
  if (!pass) process.exitCode = 1
} finally {
  await s.close()
}
