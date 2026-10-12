// Node-only test support (wave N, N6-3): Lobby's font files as the build serves them, for the vector PDF tests in
// features/present-export. The lookup lives here, inside canvas/**, because only the canvas may know where the
// engine's package keeps its files (AGENTS.md: @excalidraw/* stays behind the canvas boundary). Imported by tests
// only, never by the app.
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'

/** The engine's own font folder (dist/prod/fonts), which build/excalidraw-assets.ts serves at /excalidraw-assets/fonts/. */
function engineFontsDir(): string {
  const require = createRequire(import.meta.url)
  return join(dirname(require.resolve('@excalidraw/excalidraw')), 'fonts')
}

/**
 * The bytes of `/excalidraw-assets/fonts/<Family>/<file>.woff2` as the build serves them, or null for any other path,
 * for a family the build leaves out (Liberation) or for a file that is not there.
 */
export function servedFontFile(url: string): Uint8Array | null {
  const m = /^\/excalidraw-assets\/fonts\/([\w-]+)\/([\w.-]+\.woff2)$/.exec(url)
  if (!m || m[1] === 'Liberation') return null
  try {
    return new Uint8Array(readFileSync(join(engineFontsDir(), m[1] as string, m[2] as string)))
  } catch {
    return null
  }
}
