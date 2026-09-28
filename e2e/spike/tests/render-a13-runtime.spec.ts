import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { gzipSync } from 'node:zlib'
import { expect, test } from '@playwright/test'
import { openSpike } from '../support/page.ts'
import { SPIKE_RUN_TAG } from '../support/ports.ts'
import { watchPage } from '../support/watch.ts'

// A13 cross-check (docs/EXCALIDRAW-MIGRATION.md §8.2): what the Excalidraw engine route really loads at
// run time (every same-origin .js and .css response while /spike/engine opens and settles), gzip-sized
// from the built files on disk the same way e2e/spike/csp/dist-report.ts sizes the manifest closure.
// Reported, not gated.

const DIST = join(import.meta.dirname, '..', '..', '..', 'apps', 'web', 'dist', SPIKE_RUN_TAG)

test('A13 runtime: the JS and CSS the engine route loads, gzip', async ({ page }) => {
  const watch = watchPage(page)
  await openSpike(page, 'engine')
  await page.waitForTimeout(2000)
  const files = [
    ...new Set(
      watch.responses
        .filter((r) => r.status === 200)
        .map((r) => new URL(r.url).pathname)
        .filter((p) => /\.(js|css)$/.test(p)),
    ),
  ]
  const rows = files.map((p) => {
    const buf = readFileSync(join(DIST, p))
    return { file: p, raw: buf.length, gzip: gzipSync(buf).length }
  })
  const sum = (k: 'raw' | 'gzip', ext: string) =>
    rows.filter((r) => r.file.endsWith(ext)).reduce((a, r) => a + r[k], 0)
  const kib = (n: number) => Math.round((n / 1024) * 10) / 10
  const out = {
    jsFiles: rows.filter((r) => r.file.endsWith('.js')).length,
    cssFiles: rows.filter((r) => r.file.endsWith('.css')).length,
    jsGzipKiB: kib(sum('gzip', '.js')),
    cssGzipKiB: kib(sum('gzip', '.css')),
    totalGzipKiB: kib(sum('gzip', '.js') + sum('gzip', '.css')),
    totalRawKiB: kib(sum('raw', '.js') + sum('raw', '.css')),
    top: rows
      .sort((a, b) => b.gzip - a.gzip)
      .slice(0, 6)
      .map((r) => `${r.file} ${kib(r.gzip)}`),
  }
  console.log('A13-METRICS runtime', JSON.stringify(out))
  expect(out.jsFiles).toBeGreaterThan(0)
})
