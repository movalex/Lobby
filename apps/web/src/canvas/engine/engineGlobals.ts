// Engine globals Excalidraw reads at run time (docs/EXCALIDRAW-MIGRATION.md §2.3.2, §2.12). This module
// is imported first by ExcalidrawHost.tsx, so it is evaluated before @excalidraw/excalidraw is.
//
// - EXCALIDRAW_ASSET_PATH: base URL of the self-hosted fonts. Excalidraw builds each font URL as
//   new URL('./fonts/<Family>/<file>.woff2', <asset path>) and only falls back to esm.sh when every
//   listed base fails (ExcalidrawFontFace.createUrls, @excalidraw/excalidraw dist/dev/chunk-FN755BR4.js
//   ~1226-1249). The files are served by apps/web/build/excalidraw-assets.ts.
// - EXCALIDRAW_THROTTLE_RENDER: renders are throttled to animation frames (React 18+ only; dist/dev
//   index.js ~24464).

declare global {
  interface Window {
    EXCALIDRAW_ASSET_PATH?: string | string[]
    EXCALIDRAW_THROTTLE_RENDER?: boolean
  }
}

/** Where apps/web/build/excalidraw-assets.ts serves (dev) and copies (build) the engine's font files. */
export const EXCALIDRAW_ASSET_PATH = '/excalidraw-assets/'

export function installEngineGlobals(): void {
  window.EXCALIDRAW_ASSET_PATH = EXCALIDRAW_ASSET_PATH
  window.EXCALIDRAW_THROTTLE_RENDER = true
}

installEngineGlobals()
