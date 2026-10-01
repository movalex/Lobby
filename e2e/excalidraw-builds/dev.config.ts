import { defineConfig, devices } from '@playwright/test'
import { API_URL, RUN_TAG, SYNC_URL, WEB_PORT, WEB_URL } from '../tests/support/ports.ts'
import type { StackEngine } from '../tests/support/stack.ts'

// The Excalidraw board page under the Vite DEV server (`vite dev`: React StrictMode, no production build),
// against the same api + sync + worker stack as e2e/excalidraw (sync on DRAFTROOM_ENGINE=excalidraw). Every
// other suite serves a production build (`vite build` + `vite preview`), so StrictMode's double-mount of
// effects was never under test: LEAD-1 (docs/EXCALIDRAW-CUTOVER.md, the lead's wave-4 findings) was a board
// that never connected there.
//
//   E2E_PORT_BASE=<base> pnpm --filter @draftroom/e2e excalidraw:dev
//
// The dev server is on WEB_PORT (the api's PUBLIC_ORIGIN, so its Origin check passes) and proxies /api,
// /files and /connect like `pnpm dev`. The dev-auth guard is on by itself (import.meta.env.DEV), so the
// facade and the debug handle are there, as in e2e/excalidraw. Output goes to e2e/test-results/ld-<tag>.
export default defineConfig<Record<never, never>, { engine: StackEngine }>({
  testDir: '.',
  testMatch: /dev-.*\.spec\.ts$/,
  outputDir: `../test-results/ld-${RUN_TAG}`,
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  reporter: 'list',
  // the dev server compiles the board page and pre-bundles the engine on the first request
  timeout: 240_000,
  expect: { timeout: 15_000 },
  use: {
    baseURL: WEB_URL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    engine: 'excalidraw',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: [
    {
      command: `pnpm --filter @draftroom/web exec vite --port ${WEB_PORT} --strictPort`,
      url: WEB_URL,
      env: {
        DRAFTROOM_API_ORIGIN: API_URL,
        DRAFTROOM_SYNC_ORIGIN: SYNC_URL,
        WEB_PORT: String(WEB_PORT),
        VITE_LOBBY_ENGINE: 'excalidraw',
      },
      reuseExistingServer: false,
      timeout: 180_000,
    },
  ],
})
