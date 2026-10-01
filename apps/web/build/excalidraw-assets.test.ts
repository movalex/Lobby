// Unit test of the assets plugin's gate. The vitest projects do not include apps/web/build, so this runs
// with Node's test runner:  node --test apps/web/build/excalidraw-assets.test.ts
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { excalidrawAssetsEnabled } from './excalidraw-assets.ts'

test('the fonts ship in every build since wave 4 part 2 (no engine flag, with or without the local-dev guard)', () => {
  // the e2e builds (VITE_DRAFTROOM_DEV_AUTH=1), the dev server (DEV) and the production build (neither)
  assert.equal(excalidrawAssetsEnabled({ VITE_DRAFTROOM_DEV_AUTH: '1', DEV: false }), true)
  assert.equal(excalidrawAssetsEnabled({ DEV: true }), true)
  assert.equal(excalidrawAssetsEnabled({ DEV: false }), true)
  // the former engine flag changes nothing
  assert.equal(excalidrawAssetsEnabled({ VITE_LOBBY_ENGINE: 'tldraw', DEV: false }), true)
})
