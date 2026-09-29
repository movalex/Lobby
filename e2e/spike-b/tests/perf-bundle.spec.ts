// §8.4 "Bundle": gzip JS + CSS of the spike board route, with spike A13's method (e2e/spike/tests/
// render-a13-runtime.spec.ts): every same-origin .js and .css response while /b/:boardId opens and
// settles, gzip-sized from the built files on disk (apps/web/dist/spike-b-<web port>/). Reported against
// A13's same-method number for today's tldraw board route, 1086.2 KiB gzip (not re-measured here), and
// A13's engine route, 1306.9 KiB. Not timing-gated; 3 runs (fresh build each). Needs M1 (the board page).
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { gzipSync } from 'node:zlib'
import { expect, test } from '@playwright/test'
import { watchPage } from '../../spike/support/watch.ts'
import { writeEvidence } from '../support/checks.ts'
import { harness } from '../support/harness.ts'
import type { O3Stack } from '../support/stack.ts'

test.setTimeout(10 * 60_000)

let stack: O3Stack
test.beforeAll(async () => {
  stack = await harness.startStack()
})
test.afterAll(async () => {
  await stack?.stop()
})

test('§8.4 bundle: the JS and CSS the spike board route loads, gzip', async () => {
  const testInfo = test.info()
  const b = await harness.launchBrowser(stack, harness.devUser('Bundle'), { name: 'Bundle', relay: false })
  try {
    const { boardId } = await stack.createBoard({ owner: b.user, title: 'O3 bundle' })
    const watch = watchPage(b.page)
    await b.openBoard(boardId)
    await b.page.waitForTimeout(2_000)
    const dist = join(import.meta.dirname, '..', '..', '..', 'apps', 'web', stack.ports.webOutDir)
    const files = [
      ...new Set(
        watch.responses
          .filter((r) => r.status === 200)
          .map((r) => new URL(r.url).pathname)
          .filter((p) => /\.(js|css)$/.test(p)),
      ),
    ]
    const rows = files.map((p) => {
      const buf = readFileSync(join(dist, p))
      return { file: p, raw: buf.length, gzip: gzipSync(buf).length }
    })
    const kib = (n: number) => Math.round((n / 1024) * 10) / 10
    const sum = (k: 'raw' | 'gzip', ext: string) =>
      rows.filter((r) => r.file.endsWith(ext)).reduce((a, r) => a + r[k], 0)
    const out = {
      jsFiles: rows.filter((r) => r.file.endsWith('.js')).length,
      cssFiles: rows.filter((r) => r.file.endsWith('.css')).length,
      jsGzipKiB: kib(sum('gzip', '.js')),
      cssGzipKiB: kib(sum('gzip', '.css')),
      totalGzipKiB: kib(sum('gzip', '.js') + sum('gzip', '.css')),
      totalRawKiB: kib(sum('raw', '.js') + sum('raw', '.css')),
      baselines: { a13TldrawBoardRouteKiB: 1086.2, a13EngineRouteKiB: 1306.9 },
      top: rows
        .sort((x, y) => y.gzip - x.gzip)
        .slice(0, 8)
        .map((r) => `${r.file} ${kib(r.gzip)}`),
    }
    console.log('O3-BUNDLE', JSON.stringify(out))
    writeEvidence(testInfo, 'perf-bundle', out)
    expect(out.jsFiles).toBeGreaterThan(0)
  } finally {
    await b.close()
  }
})
