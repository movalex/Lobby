// Helpers of the wave Q WS4 specs (q4-*.spec.ts): the `.excalidrawlib` normaliser run by the REAL engine in the page
// (the library module bundled once with Vite's own API, served from a route on the app's origin), the fixture files,
// and the kits' expected element counts from the templates package.
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Page } from '@playwright/test'
import type {
  LibraryImportReport,
  LibraryRefusal,
  NormaliseLibraryOptions,
} from '../../apps/web/src/canvas/library/index.ts'
import type { ImportLibraryInput } from '../../packages/contracts/src/library.ts'

const webDir = fileURLToPath(new URL('../../apps/web/', import.meta.url))
const fixtureDir = fileURLToPath(new URL('../../apps/web/src/canvas/library/fixtures/', import.meta.url))

export const fixtureText = (name: string) => readFileSync(join(fixtureDir, name), 'utf8')

/** The page-side path the bundle is served from (a route on the app's own origin). */
const BUNDLE_URL = '/__q4/q4-library.js'

const BUILD = `
import { build } from 'vite'
await build({
  configFile: false,
  root: process.cwd(),
  logLevel: 'error',
  publicDir: false,
  define: { 'process.env.NODE_ENV': '"production"' },
  build: {
    outDir: process.argv[1],
    emptyOutDir: true,
    minify: false,
    lib: { entry: 'src/canvas/library/index.ts', formats: ['es'], fileName: 'q4-library' },
    rollupOptions: { output: { inlineDynamicImports: true } },
  },
})
`

let bundle: string | null = null

/** The library module as one JS file (built once per run, in a temp folder; dependencies are the app's own). */
export function libraryBundle(): string {
  if (bundle) return bundle
  const out = mkdtempSync(join(tmpdir(), 'lobby-q4-lib-'))
  execFileSync(process.execPath, ['--input-type=module', '-e', BUILD, out], {
    cwd: webDir,
    stdio: ['ignore', 'ignore', 'inherit'],
    timeout: 240_000,
  })
  bundle = readFileSync(join(out, 'q4-library.js'), 'utf8')
  return bundle
}

type LibraryModule = {
  normaliseExcalidrawLib(
    file: File,
    opts: NormaliseLibraryOptions,
  ): Promise<
    | { ok: true; input: ImportLibraryInput; report: LibraryImportReport; warnings: string[] }
    | { ok: false; code: LibraryRefusal }
  >
}
declare global {
  interface Window {
    __q4Lib?: LibraryModule
  }
}

/** Serves the bundle on the page's origin and loads it as `window.__q4Lib` (the page must be on the app's origin). */
export async function loadLibraryModule(page: Page): Promise<void> {
  const source = libraryBundle()
  await page.route(`**${BUNDLE_URL}`, (route) =>
    route.fulfill({ status: 200, contentType: 'text/javascript', body: source }),
  )
  await page.evaluate(`import('${BUNDLE_URL}').then((m) => { window.__q4Lib = m })`)
}

export interface FileSpec {
  text?: string
  name: string
  /** the file's MIME type ('' for the browser's guess, as a picker gives for `.excalidrawlib`) */
  type?: string
  /** instead of text: this many zero bytes */
  bytes?: number
}

/** Runs the normaliser in the page on a file made there. */
export async function normaliseInPage(page: Page, file: FileSpec, opts: NormaliseLibraryOptions) {
  return await page.evaluate(
    async ({ file, opts }) => {
      const lib = window.__q4Lib
      if (!lib) throw new Error('the library module is not loaded')
      const f = new File(file.bytes ? [new Uint8Array(file.bytes)] : [file.text ?? ''], file.name, {
        type: file.type ?? '',
      })
      return await lib.normaliseExcalidrawLib(f, opts)
    },
    { file, opts },
  )
}
