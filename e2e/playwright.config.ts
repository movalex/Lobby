import { defineConfig, devices } from '@playwright/test'
import { API_URL, RUN_TAG, SYNC_URL, WEB_PORT, WEB_URL } from './tests/support/ports.ts'
import type { StackEngine } from './tests/support/stack.ts'

// The browser suite (docs/EXCALIDRAW-CONTRACTS.md §9): the specs in ./excalidraw against the production
// build of the web app with the dev-auth guard (the facade and the debug handle, dev sign-in), the real api,
// sync and preview worker started per run by the stack fixture (tests/support/fixtures.ts). Since wave 4
// part 2 (docs/EXCALIDRAW-CUTOVER.md G10) this is the one suite: the tldraw suite (./tests/*.spec.ts) left
// with the tldraw board page; bridge release R0 on main keeps it.
//
//   E2E_PORT_BASE=<base> pnpm --filter @draftroom/e2e test [-- <spec>]
//
// Browsers: chromium runs the whole suite. WebKit (the Safari engine, Macs and iPads) and Firefox run only the
// short smoke in excalidraw/xbrowser-smoke.spec.ts (XBROWSER; docs/PROGRESS.md "Unmeasured: ... iPad/Safari,
// Firefox"): sign in, the dashboard, open a board, a note typed through the lease, reload. The same spec also
// runs on chromium, the control that tells a browser difference from a broken spec. The package scripts pick
// the projects (`test` and `excalidraw`: chromium; `xbrowser`: webkit and firefox); the engines come from
// `pnpm --filter @draftroom/e2e install-browsers:xbrowser` (`playwright install webkit firefox`).
//
// The other configs: excalidraw-builds/prod.config.ts (the production build without the guard),
// excalidraw-builds/dev.config.ts (the Vite dev server), spike/ and spike-b/ (the spike suites).
//
// Per-run build folder (inside apps/web/dist/, relative to the web package): parallel runs with
// different E2E_PORT_BASE values must not build into, or serve, each other's files.
const WEB_OUT_DIR = `dist/${RUN_TAG}`

/** The one spec the non-chromium projects run. */
const XBROWSER_SMOKE = /xbrowser-smoke\.spec\.ts$/

export default defineConfig<Record<never, never>, { engine: StackEngine }>({
  testDir: './excalidraw',
  testMatch: /.*\.spec\.ts$/,
  // Per run as well: Playwright empties its output dir when a run starts.
  outputDir: `./test-results/${RUN_TAG}`,
  // Every test drives one shared api + sync server on fixed ports (the preview proxy targets them) and
  // some tests SIGKILL the sync server, so tests run one at a time. Separate runs on other ports
  // (E2E_PORT_BASE, see tests/support/ports.ts) can run side by side.
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  // CI (.github/workflows/ci.yml): one retry, because a 2-core runner is slower than the machine the timings were
  // set on (a test that passes on the retry is reported "flaky", not hidden), and GitHub annotations on failures.
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['list'], ['github']] : 'list',
  timeout: 120_000,
  expect: { timeout: 15_000 },
  use: {
    baseURL: WEB_URL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    engine: 'excalidraw',
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    { name: 'webkit', testMatch: XBROWSER_SMOKE, use: { ...devices['Desktop Safari'] } },
    { name: 'firefox', testMatch: XBROWSER_SMOKE, use: { ...devices['Desktop Firefox'] } },
  ],
  // The api, sync server and preview worker are started (and killed) by the tests' own fixture
  // (tests/support/stack.ts); only the static web build is served here.
  webServer: [
    {
      command: `pnpm --filter @draftroom/web exec vite build --outDir ${WEB_OUT_DIR} && pnpm --filter @draftroom/web exec vite preview --outDir ${WEB_OUT_DIR} --port ${WEB_PORT} --strictPort`,
      url: WEB_URL,
      env: {
        // same-origin: vite preview proxies /api and /files to the test api, /connect to the test sync
        DRAFTROOM_API_ORIGIN: API_URL,
        DRAFTROOM_SYNC_ORIGIN: SYNC_URL,
        // the dev-auth guard: the facade (window.lobbyCanvas) and the debug handle the suites drive
        VITE_DRAFTROOM_DEV_AUTH: '1',
      },
      reuseExistingServer: false,
      timeout: 180_000,
    },
  ],
})
