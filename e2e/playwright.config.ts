import { defineConfig, devices } from '@playwright/test'
import { API_URL, SYNC_URL, WEB_PORT, WEB_URL } from './tests/support/ports.ts'

export default defineConfig({
  testDir: './tests',
  // Every test drives one shared api + sync server on fixed ports (the preview proxy targets them) and
  // some tests SIGKILL the sync server, so tests run one at a time.
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
      command: `pnpm --filter @draftroom/web build && pnpm --filter @draftroom/web exec vite preview --port ${WEB_PORT} --strictPort`,
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
