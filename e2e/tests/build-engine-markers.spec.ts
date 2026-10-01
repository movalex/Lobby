// The default (tldraw) web build carries nothing of the Excalidraw engine (docs/EXCALIDRAW-CONTRACTS.md §11
// "normal build, engine markers"; WAVE-3.md §3): since wave 4 the engine route ships on the engine flag alone
// (docs/EXCALIDRAW-CUTOVER.md G2), so this guards the other side of that test, which the integrators
// checked by hand until now. It reads this run's own build (playwright.config.ts builds apps/web/dist/<tag>).
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { RUN_TAG } from './support/ports.ts'
import { REPO_ROOT } from './support/stack.ts'

const DIST = join(REPO_ROOT, 'apps/web', 'dist', RUN_TAG)

/**
 * Strings only the engine build has: the board page's ids and classes, the engine globals, the asset
 * prefix, the engine's text editor, the ported features' chrome, and the spike pages. Each was checked
 * absent from the default build and present in the engine build on 2026-09-30 (`window.editor` and
 * "Connecting to board" are in both and are no markers).
 */
const ENGINE_MARKERS = [
  'data-engine',
  'lobby-board',
  '__lobbyBoard',
  'data-lobby-board-canvas',
  'lobby-canvas-screen',
  'EXCALIDRAW_ASSET_PATH',
  'excalidraw-assets',
  'excalidraw-wysiwyg',
  'data-lobby-canvas',
  'navigation-overlay',
  'lobby-slot--mainMenu',
  'canvas-announcer',
  'dr-cnav',
  'template-insert-retry',
  'spike-board',
  '__lobbySpike',
]

function* walk(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) yield* walk(p)
    else yield p
  }
}

test('the default (tldraw) build has no /excalidraw-assets/ and 0 engine-marker hits', () => {
  expect(existsSync(join(DIST, 'index.html')), `${DIST} is this run's build`).toBe(true)
  expect(existsSync(join(DIST, 'excalidraw-assets'))).toBe(false)
  const hits: string[] = []
  for (const f of walk(DIST)) {
    if (!/\.(m?js|css|html)$/.test(f)) continue
    const code = readFileSync(f, 'utf8')
    for (const m of ENGINE_MARKERS) if (code.includes(m)) hits.push(`${m} in ${f.slice(DIST.length + 1)}`)
  }
  expect(hits).toEqual([])
})
