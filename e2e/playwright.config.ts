import { defineConfig, devices } from '@playwright/test'

export const SYNC_PORT = process.env.E2E_SYNC_PORT ?? '5881'
const WEB_PORT = process.env.E2E_WEB_PORT ?? '4191'
const WEB_URL = `http://127.0.0.1:${WEB_PORT}`

export default defineConfig({
  testDir: './tests',
  // Every test drives one shared sync server on a fixed port (the preview proxy targets it) and some
  // tests SIGKILL it, so tests run one at a time.
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
  // The sync server and the preview worker are started (and killed) by the tests' own fixture
  // (tests/support/stack.ts); only the static web build is served here.
  webServer: [
    {
      command: `pnpm --filter @draftroom/web build && pnpm --filter @draftroom/web exec vite preview --port ${WEB_PORT} --strictPort`,
      url: WEB_URL,
      env: {
        // same-origin: vite preview proxies /connect, /files, /dev-api to the test sync server
        DRAFTROOM_SYNC_ORIGIN: `http://127.0.0.1:${SYNC_PORT}`,
        VITE_DRAFTROOM_DEV_AUTH: '1',
      },
      reuseExistingServer: false,
      timeout: 180_000,
    },
  ],
})
