// Unit test of the assets plugin's gate. The vitest projects do not include apps/web/build, so this runs
// with Node's test runner:  node --test apps/web/build/excalidraw-assets.test.ts
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { excalidrawAssetsEnabled } from './excalidraw-assets.ts'

test('the fonts ship only with the engine route: the engine flag AND the local-dev guard', () => {
  // The spike build (the engine flag + VITE_DRAFTROOM_DEV_AUTH=1) and the dev server (DEV).
  assert.equal(
    excalidrawAssetsEnabled({ VITE_LOBBY_ENGINE: 'excalidraw', VITE_DRAFTROOM_DEV_AUTH: '1', DEV: false }),
    true,
  )
  assert.equal(excalidrawAssetsEnabled({ VITE_LOBBY_ENGINE: 'excalidraw', DEV: true }), true)
  // The engine flag without the guard: no route, so no fonts (the verifier's finding: 233 files, 14 MB).
  assert.equal(excalidrawAssetsEnabled({ VITE_LOBBY_ENGINE: 'excalidraw', DEV: false }), false)
  assert.equal(
    excalidrawAssetsEnabled({ VITE_LOBBY_ENGINE: 'excalidraw', VITE_DRAFTROOM_DEV_AUTH: '0', DEV: false }),
    false,
  )
  // The normal (tldraw) build, guard or not.
  assert.equal(excalidrawAssetsEnabled({ DEV: false }), false)
  assert.equal(excalidrawAssetsEnabled({ VITE_DRAFTROOM_DEV_AUTH: '1', DEV: true }), false)
  assert.equal(
    excalidrawAssetsEnabled({ VITE_LOBBY_ENGINE: 'tldraw', VITE_DRAFTROOM_DEV_AUTH: '1', DEV: true }),
    false,
  )
})
