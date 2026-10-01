// Unit test of the assets plugin's gate. The vitest projects do not include apps/web/build, so this runs
// with Node's test runner:  node --test apps/web/build/excalidraw-assets.test.ts
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { excalidrawAssetsEnabled } from './excalidraw-assets.ts'

test('the fonts ship with the engine route: the engine flag, with or without the local-dev guard (wave 4, G2)', () => {
  // The e2e and spike builds (the engine flag + VITE_DRAFTROOM_DEV_AUTH=1) and the dev server (DEV).
  assert.equal(
    excalidrawAssetsEnabled({ VITE_LOBBY_ENGINE: 'excalidraw', VITE_DRAFTROOM_DEV_AUTH: '1', DEV: false }),
    true,
  )
  assert.equal(excalidrawAssetsEnabled({ VITE_LOBBY_ENGINE: 'excalidraw', DEV: true }), true)
  // The production engine build (the static site at the cut-over): no guard, and the fonts must ship,
  // since /b/<id> opens on Excalidraw there (before wave 4 this was false: no route, so no fonts).
  assert.equal(excalidrawAssetsEnabled({ VITE_LOBBY_ENGINE: 'excalidraw', DEV: false }), true)
  assert.equal(
    excalidrawAssetsEnabled({ VITE_LOBBY_ENGINE: 'excalidraw', VITE_DRAFTROOM_DEV_AUTH: '0', DEV: false }),
    true,
  )
  // The normal (tldraw) build, guard or not: no engine file.
  assert.equal(excalidrawAssetsEnabled({ DEV: false }), false)
  assert.equal(excalidrawAssetsEnabled({ VITE_DRAFTROOM_DEV_AUTH: '1', DEV: true }), false)
  assert.equal(
    excalidrawAssetsEnabled({ VITE_LOBBY_ENGINE: 'tldraw', VITE_DRAFTROOM_DEV_AUTH: '1', DEV: true }),
    false,
  )
})
