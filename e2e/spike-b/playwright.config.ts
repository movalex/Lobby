import { join } from 'node:path'
import { defineConfig, devices } from '@playwright/test'
import { stackFromEnv } from './support/ports.ts'

// Spike B acceptance checks (docs/EXCALIDRAW-MIGRATION.md §8.3, §8.6), frozen at the contracts step C0.
// Run: SPIKE_B_PORT_BASE=<base> pnpm --filter @draftroom/e2e spike-b [-- <spec>]
//
// The web app is built with VITE_LOBBY_ENGINE=excalidraw and the dev-auth guard into a per-stack folder
// (apps/web/dist/spike-b-<web port>) and served by vite preview, which proxies /api and /files to the
// stack's api (base + 1) and /connect to its sync (base). The api and sync processes are started and
// killed by the specs through O3's harness (support/harness.ts, reusing e2e/tests/support/stack.ts), with
// DRAFTROOM_ENGINE=excalidraw, DRAFTROOM_TEST_HOOKS=1 and DRAFTROOM_BACKUP_STORE=off.
//
// Projects:
//  - `chromium`: every spec except B8's staging runs.
//  - `b8-staging`: specs named `b8-staging-*.spec.ts` only, and only when SPIKE_B8_DIR is set (the folder of
//    B8's restored staging copies, §8.6.7): Playwright output inside it, traces, videos and screenshots off.
//    Only O4 and V3 run it.
const stack = stackFromEnv()
const B8_DIR = process.env.SPIKE_B8_DIR

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
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] }, testIgnore: /b8-staging-.*\.spec\.ts$/ },
    ...(B8_DIR
      ? [
          {
            name: 'b8-staging',
            testMatch: /b8-staging-.*\.spec\.ts$/,
            outputDir: join(B8_DIR, 'test-results'),
            use: {
              ...devices['Desktop Chrome'],
              trace: 'off' as const,
              video: 'off' as const,
              screenshot: 'off' as const,
            },
          },
        ]
      : []),
  ],
  webServer: [
    {
      command: `pnpm --filter @draftroom/web exec vite build --outDir ${stack.webOutDir} && pnpm --filter @draftroom/web exec vite preview --outDir ${stack.webOutDir} --port ${stack.web} --strictPort`,
      url: stack.webUrl,
      env: {
        VITE_LOBBY_ENGINE: 'excalidraw',
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
