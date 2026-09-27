import { defineConfig, devices } from '@playwright/test'
import { API_URL, RUN_TAG, SYNC_URL, WEB_PORT, WEB_URL } from './tests/support/ports.ts'

// Per-run build folder (inside apps/web/dist/, relative to the web package): parallel runs with
// different E2E_PORT_BASE values must not build into, or serve, each other's files.
const WEB_OUT_DIR = `dist/${RUN_TAG}`

export default defineConfig({
  testDir: './tests',
  // Per run as well: Playwright empties its output dir when a run starts.
  outputDir: `./test-results/${RUN_TAG}`,
  // Every test drives one shared api + sync server on fixed ports (the preview proxy targets them) and
  // some tests SIGKILL the sync server, so tests run one at a time. Separate runs on other ports
  // (E2E_PORT_BASE, see tests/support/ports.ts) can run side by side.
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  reporter: 'list',
  timeout: 120_000,
  expect: { timeout: 15_000 },
  use: { baseURL: WEB_URL, trace: 'retain-on-failure', screenshot: 'only-on-failure' },
  projects: [
    // The Playwright headless shell: everything except MP4 playback.
    { name: 'chromium', use: { ...devices['Desktop Chrome'] }, grepInvert: /@chrome/ },
    // Branded Chrome ships the proprietary H.264/AAC decoders the headless shell lacks.
    { name: 'chrome', use: { ...devices['Desktop Chrome'], channel: 'chrome' }, grep: /@chrome/ },
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
        // exposes window.editor in the build (the suites drive tldraw through it)
        VITE_DRAFTROOM_DEV_AUTH: '1',
      },
      reuseExistingServer: false,
      timeout: 180_000,
    },
  ],
})
