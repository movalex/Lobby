import { defineConfig, devices } from '@playwright/test'
import { stackFromEnv } from '../ports.ts'

// O3's harness self-test (e2e/spike-b/support/**): the harness's own checks, runnable on O3's branch
// before M1 (no ElementRoom, no engine core needed):
//  - units.spec.ts: pure Node checks of the barrier, recorder, hooks, env guards, convergence logic;
//  - stack.spec.ts: the launcher on the TLDRAW engine (DRAFTROOM_ENGINE=tldraw; O1's room is a stub until
//    M1), dev users and board sharing, two separate browser processes, forge sockets with the page's own
//    ticket, the socket relay (latency, cut with held reconnects, restore), the test routes' 404 path;
//  - barrier.spec.ts: the 20 ms release across separate browser processes on spike A's pages.
// Run: SPIKE_B_PORT_BASE=7880 pnpm --filter @draftroom/e2e exec playwright test -c spike-b/support/selftest/playwright.config.ts
//
// The web build is the spike B one (VITE_LOBBY_ENGINE=excalidraw with the dev-auth guard), served like
// spike-b/playwright.config.ts does, into its own folder and output dir.
const stack = stackFromEnv()
const outDir = `${stack.webOutDir}-selftest`

export default defineConfig({
  testDir: '.',
  outputDir: `../../../test-results/${stack.runTag}-selftest`,
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  reporter: 'list',
  timeout: 180_000,
  expect: { timeout: 15_000 },
  use: { baseURL: stack.webUrl, trace: 'retain-on-failure', screenshot: 'only-on-failure' },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: process.env.O3_SELFTEST_NO_WEB
    ? undefined
    : [
        {
          command: `pnpm --filter @draftroom/web exec vite build --outDir ${outDir} && pnpm --filter @draftroom/web exec vite preview --outDir ${outDir} --port ${stack.web} --strictPort`,
          url: stack.webUrl,
          env: {
            VITE_LOBBY_ENGINE: 'excalidraw',
            VITE_DRAFTROOM_DEV_AUTH: '1',
            DRAFTROOM_API_ORIGIN: stack.apiUrl,
            DRAFTROOM_SYNC_ORIGIN: stack.syncUrl,
          },
          reuseExistingServer: false,
          timeout: 240_000,
        },
      ],
})
