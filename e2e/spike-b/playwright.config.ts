import { defineConfig, devices } from '@playwright/test'
import { stackFromEnv } from './support/ports.ts'

// Spike B acceptance checks (docs/EXCALIDRAW-MIGRATION.md §8.3, §8.6), frozen at the contracts step C0.
// Run: SPIKE_B_PORT_BASE=<base> pnpm --filter @draftroom/e2e spike-b [-- <spec>]
//
// The web app is built with the dev-auth guard into a per-stack folder
// (apps/web/dist/spike-b-<web port>) and served by vite preview, which proxies /api and /files to the
// stack's api (base + 1) and /connect to its sync (base). The api and sync processes are started and
// killed by the specs through O3's harness (support/harness.ts, reusing e2e/tests/support/stack.ts), with
// DRAFTROOM_ENGINE=excalidraw, DRAFTROOM_TEST_HOOKS=1 and DRAFTROOM_BACKUP_STORE=off.
//
// B8 (the R0 stand-in: today's tldraw sync next to the Excalidraw one) left with the tldraw engine at wave
// 4 part 2; its specs and tooling are on main's history (e2e/spike-b/b8 before docs/EXCALIDRAW-CUTOVER.md G10).
const stack = stackFromEnv()

export default defineConfig({
  testDir: './tests',
  outputDir: `../test-results/${stack.runTag}`,
  // one stack per run (specs SIGKILL its sync); separate runs on other bases may run side by side
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  reporter: 'list',
  timeout: 180_000,
  expect: { timeout: 15_000 },
  use: { baseURL: stack.webUrl, trace: 'retain-on-failure', screenshot: 'only-on-failure' },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: [
    {
      command: `pnpm --filter @draftroom/web exec vite build --outDir ${stack.webOutDir} && pnpm --filter @draftroom/web exec vite preview --outDir ${stack.webOutDir} --port ${stack.web} --strictPort`,
      url: stack.webUrl,
      env: {
        VITE_DRAFTROOM_DEV_AUTH: '1',
        // on engine/excalidraw /b/:id is Lobby's board page unless this is set (wave 2, W1-8); on
        // spike/excalidraw nothing reads it (App.tsx routes /b/:id to the spike page)
        VITE_LOBBY_BOARD_PAGE: 'spike',
        DRAFTROOM_API_ORIGIN: stack.apiUrl,
        DRAFTROOM_SYNC_ORIGIN: stack.syncUrl,
      },
      reuseExistingServer: false,
      timeout: 240_000,
    },
  ],
})
