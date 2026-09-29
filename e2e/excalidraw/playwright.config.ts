import { defineConfig, devices } from '@playwright/test'
import { API_URL, RUN_TAG, SYNC_URL, WEB_PORT, WEB_URL } from '../tests/support/ports.ts'
import type { StackEngine } from '../tests/support/stack.ts'

// PORTED specs on the Excalidraw engine (docs/EXCALIDRAW-CONTRACTS.md §9). Frozen at wave 1.
//
//   E2E_PORT_BASE=<base> pnpm --filter @draftroom/e2e excalidraw [-- <spec>]
//
// Same stack fixture as the default suite (tests/support/fixtures.ts: api + sync + worker per run, dev
// sign-in), with the sync server on DRAFTROOM_ENGINE=excalidraw and the web app built with
// VITE_LOBBY_ENGINE=excalidraw and the dev-auth guard (the Excalidraw board page is behind both until
// wave 4). The fixture's `engine: 'excalidraw'` option makes the stack launcher start sync with
// EXCALIDRAW_SYNC_ENV (tests/support/stack.ts: the engine, its test hooks, backups off until 2B ports the
// backup job to lb_* files) UNDER any per-spec `syncEnv`, so a spec's test.use({ syncEnv }) keeps the
// engine (CR W1-2E-1, docs/EXCALIDRAW-CONTRACTS.md §12).
//
// Specs live here as `<feature>-<topic>.spec.ts` and import `test`/`expect` and the helpers from
// ../tests/support/canvas.ts. The default suite (../playwright.config.ts, tests/) is the tldraw app and is
// never pointed at this build. Build and output folders are per web port and prefixed `lc-`, so a run of
// the default suite on another E2E_PORT_BASE never shares them.
const WEB_OUT_DIR = `dist/lc-${RUN_TAG}`

export default defineConfig<Record<never, never>, { engine: StackEngine }>({
  testDir: '.',
  testMatch: /.*\.spec\.ts$/,
  outputDir: `../test-results/lc-${RUN_TAG}`,
  // one shared api + sync per run (specs may SIGKILL sync): one test at a time
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  reporter: 'list',
  timeout: 120_000,
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
      command: `pnpm --filter @draftroom/web exec vite build --outDir ${WEB_OUT_DIR} && pnpm --filter @draftroom/web exec vite preview --outDir ${WEB_OUT_DIR} --port ${WEB_PORT} --strictPort`,
      url: WEB_URL,
      env: {
        DRAFTROOM_API_ORIGIN: API_URL,
        DRAFTROOM_SYNC_ORIGIN: SYNC_URL,
        VITE_LOBBY_ENGINE: 'excalidraw',
        VITE_DRAFTROOM_DEV_AUTH: '1',
      },
      reuseExistingServer: false,
      timeout: 180_000,
    },
  ],
})
