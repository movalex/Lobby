import { defineConfig, devices } from '@playwright/test'
import { stackFromEnv } from '../spike-b/support/ports.ts'

// B9's workstation half (e2e/spike-b/tests/b9-visibility.spec.ts) on LOBBY'S BOARD PAGE, the page the
// cut-over shipped (docs/EXCALIDRAW-CUTOVER.md G2, G10), instead of spike B's board page that
// e2e/spike-b/playwright.config.ts builds (VITE_LOBBY_BOARD_PAGE=spike). Everything else is spike B's
// config: the same spike B stack (SPIKE_B_PORT_BASE: sync = base, api = base + 1, web = base + 2; the spec
// starts api, sync and the worker through O3's harness), the web build with the dev-auth guard served by
// vite preview, one worker. Only the board page differs (Lobby's: the level-of-detail pass, Lobby's
// overlays and image loader), and the build folder and the output folder get a `-lobby` suffix so a spike
// page run on the same base never serves or overwrites this one's files.
//
//   SPIKE_B9_WS=1 SPIKE_B_PORT_BASE=7820 pnpm --filter @draftroom/e2e exec playwright test -c perf/b9-lobby.config.ts
const stack = stackFromEnv()
const outDir = `${stack.webOutDir}-lobby`

export default defineConfig({
  testDir: '../spike-b/tests',
  testMatch: /b9-visibility\.spec\.ts$/,
  outputDir: `../test-results/${stack.runTag}-lobby`,
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  reporter: 'list',
  timeout: 180_000,
  expect: { timeout: 15_000 },
  // no trace or screenshots: a measurement (the spec sets the same)
  use: { baseURL: stack.webUrl, trace: 'off', screenshot: 'off' },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: [
    {
      command: `pnpm --filter @draftroom/web exec vite build --outDir ${outDir} && pnpm --filter @draftroom/web exec vite preview --outDir ${outDir} --port ${stack.web} --strictPort`,
      url: stack.webUrl,
      env: {
        VITE_DRAFTROOM_DEV_AUTH: '1',
        // Lobby's board page (canvas/board/route.tsx): no build choice, so /b/:id is LobbyBoardPage
        VITE_LOBBY_BOARD_PAGE: '',
        DRAFTROOM_API_ORIGIN: stack.apiUrl,
        DRAFTROOM_SYNC_ORIGIN: stack.syncUrl,
      },
      reuseExistingServer: false,
      timeout: 240_000,
    },
  ],
})
