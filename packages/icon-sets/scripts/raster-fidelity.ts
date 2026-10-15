// OWNER: WS1 (wave Q, the icons). The converted icons against a raster of the ORIGINAL SVG files, in Chromium:
//
//   node packages/icon-sets/scripts/raster-fidelity.ts [--sizes 48,96] [--json]
//
// For every included icon, at each size: the set's own SVG file (lucide-static icons/<name>.svg, @tabler/icons
// icons/outline/<name>.svg) drawn by the browser's SVG renderer, and the converted geometry drawn with the canvas as
// Excalidraw draws it (roughness 0: straight segments, round caps and joins, ellipses, rectangles with Excalidraw's
// quadratic corners and adaptive radius), both in black at the set's stroke (2 grid units). Pixels count as ink at
// alpha >= 50%. Reported per size: the IoU (shared ink / ink of either) mean, p1 and min, the mismatched pixels as a
// share of the icon's ink, and the worst icons. Independent of the converter's parser: the browser reads the SVG.
//
// Local only, no network (the page is about:blank, the SVGs go in as data: URLs). Playwright and its Chromium are
// the e2e package's (no new dependency). About a minute.

import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import type { IconGeometry, IconSetId } from '@draftroom/contracts'
import { ICON_SETS_ROOT, iconSetFile } from '../src/files.ts'
import { pinnedIcons } from '../src/generate.ts'

const args = process.argv.slice(2)
const sizesArg = args[args.indexOf('--sizes') + 1]
const SIZES = args.includes('--sizes') && sizesArg ? sizesArg.split(',').map(Number) : [48, 96]
const JSON_OUT = args.includes('--json')

const require = createRequire(join(ICON_SETS_ROOT, '../../e2e/package.json'))
const { chromium } = require('@playwright/test') as typeof import('@playwright/test')

const svgFile = (set: IconSetId, name: string) =>
  iconSetFile(set, set === 'lucide' ? `icons/${name}.svg` : `icons/outline/${name}.svg`)

interface Job {
  key: string
  svg: string
  geometry: IconGeometry
}

const generated = pinnedIcons()
const jobs: Job[] = []
for (const f of generated.files) {
  if (!f.name.startsWith('shard-')) continue
  const shard = JSON.parse(f.content) as { icons: Record<string, IconGeometry> }
  for (const [key, geometry] of Object.entries(shard.icons)) {
    const [set, name] = key.split(':') as [IconSetId, string]
    jobs.push({ key, svg: readFileSync(svgFile(set, name), 'utf8'), geometry })
  }
}
jobs.sort((a, b) => (a.key < b.key ? -1 : 1))

const browser = await chromium.launch()
try {
  const page = await browser.newPage()
  // nothing leaves the machine
  await page.route('**/*', (route) =>
    route.request().url().startsWith('data:') ? route.continue() : route.abort(),
  )
  await page.setContent('<!doctype html><canvas id="a"></canvas><canvas id="b"></canvas>')
  const results: Record<number, { key: string; iou: number; mismatch: number }[]> = {}
  for (const size of SIZES) {
    results[size] = []
    for (let start = 0; start < jobs.length; start += 200) {
      const batch = jobs.slice(start, start + 200)
      const out = await page.evaluate(
        async ({ batch, size }) => {
          const scale = size / 24
          const a = document.getElementById('a') as HTMLCanvasElement
          const b = document.getElementById('b') as HTMLCanvasElement
          a.width = b.width = size
          a.height = b.height = size
          const ca = a.getContext('2d', { willReadFrequently: true }) as CanvasRenderingContext2D
          const cb = b.getContext('2d', { willReadFrequently: true }) as CanvasRenderingContext2D
          const ink = (c: CanvasRenderingContext2D) => {
            const d = c.getImageData(0, 0, size, size).data
            const m = new Uint8Array(size * size)
            for (let n = 0; n < m.length; n++) m[n] = (d[n * 4 + 3] as number) >= 128 ? 1 : 0
            return m
          }
          const radius = (r: number, w: number, h: number) => {
            const x = Math.min(w, h)
            return x <= r / 0.25 ? x * 0.25 : r
          }
          const res: { key: string; iou: number; mismatch: number }[] = []
          for (const job of batch) {
            // the original, drawn by the browser
            ca.clearRect(0, 0, size, size)
            const svg = job.svg
              .replace(/<!--[\s\S]*?-->/g, '')
              .replace(/width="24"/, `width="${size}"`)
              .replace(/height="24"/, `height="${size}"`)
            const img = new Image(size, size)
            img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`
            await img.decode()
            ca.drawImage(img, 0, 0, size, size)
            // the conversion, drawn as Excalidraw draws it
            cb.clearRect(0, 0, size, size)
            cb.lineWidth = 2 * scale
            cb.lineCap = 'round'
            cb.lineJoin = 'round'
            cb.strokeStyle = '#000'
            cb.fillStyle = '#000'
            for (const p of job.geometry) {
              cb.beginPath()
              if (p.t === 'line') {
                for (let n = 0; n < p.p.length; n += 2) {
                  const x = (p.p[n] as number) * scale
                  const y = (p.p[n + 1] as number) * scale
                  if (n === 0) cb.moveTo(x, y)
                  else cb.lineTo(x, y)
                }
                if (p.closed) cb.closePath()
              } else if (p.t === 'ellipse') {
                cb.ellipse(
                  (p.x + p.w / 2) * scale,
                  (p.y + p.h / 2) * scale,
                  (p.w / 2) * scale,
                  (p.h / 2) * scale,
                  0,
                  0,
                  2 * Math.PI,
                )
              } else {
                const x = p.x * scale
                const y = p.y * scale
                const w = p.w * scale
                const h = p.h * scale
                const r = p.r ? radius(p.r * scale, w, h) : 0
                cb.moveTo(x + r, y)
                cb.lineTo(x + w - r, y)
                cb.quadraticCurveTo(x + w, y, x + w, y + r)
                cb.lineTo(x + w, y + h - r)
                cb.quadraticCurveTo(x + w, y + h, x + w - r, y + h)
                cb.lineTo(x + r, y + h)
                cb.quadraticCurveTo(x, y + h, x, y + h - r)
                cb.lineTo(x, y + r)
                cb.quadraticCurveTo(x, y, x + r, y)
                cb.closePath()
              }
              if (p.f) cb.fill()
              cb.stroke()
            }
            const A = ink(ca)
            const B = ink(cb)
            let both = 0
            let either = 0
            let diff = 0
            let inkA = 0
            for (let n = 0; n < A.length; n++) {
              const x = A[n] as number
              const y = B[n] as number
              both += x & y
              either += x | y
              diff += x ^ y
              inkA += x
            }
            res.push({ key: job.key, iou: either ? both / either : 1, mismatch: inkA ? diff / inkA : 0 })
          }
          return res
        },
        { batch, size },
      )
      results[size]?.push(...out)
    }
  }
  const summary = SIZES.map((size) => {
    const rows = [...(results[size] ?? [])].sort((a, b) => a.iou - b.iou)
    const ious = rows.map((r) => r.iou)
    const q = (p: number) => ious[Math.min(ious.length - 1, Math.floor(ious.length * p))] ?? 0
    const r4 = (v: number) => Math.round(v * 1e4) / 1e4
    const mean = r4(ious.reduce((s, v) => s + v, 0) / ious.length)
    return {
      size,
      icons: rows.length,
      iou: { mean, p1: r4(q(0.01)), min: r4(ious[0] ?? 0) },
      mismatchMean: r4(rows.reduce((s, r) => s + r.mismatch, 0) / rows.length),
      below90: rows.filter((r) => r.iou < 0.9).length,
      worst: rows.slice(0, 10).map((r) => [r.key, r4(r.iou)]),
    }
  })
  if (JSON_OUT) console.log(JSON.stringify(summary, null, 2))
  else
    for (const s of summary) {
      const worst = s.worst.map(([k, v]) => `${k} ${v}`).join(', ')
      const mismatch = `${(s.mismatchMean * 100).toFixed(2)}%`
      console.log(
        `${s.size} px: ${s.icons} icons, IoU mean ${s.iou.mean}, p1 ${s.iou.p1}, min ${s.iou.min}; ` +
          `mismatch ${mismatch} of the ink; ${s.below90} below 0.9; worst ${worst}`,
      )
    }
} finally {
  await browser.close()
}
