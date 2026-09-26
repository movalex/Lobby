import { defineConfig, devices } from '@playwright/test'

export const SYNC_PORT = process.env.E2E_SYNC_PORT ?? '5881'
const WEB_PORT = process.env.E2E_WEB_PORT ?? '4191'
const WEB_URL = `http://localhost:${WEB_PORT}`

export default defineConfig({
  testDir: './tests',
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  reporter: 'list',
  timeout: 120_000,
  use: { baseURL: WEB_URL, trace: 'retain-on-failure' },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  // The sync server is started/killed by the test itself (it must SIGKILL and restart it).
  webServer: [
    {
      command: `pnpm --filter @draftroom/web build && pnpm --filter @draftroom/web exec vite preview --port ${WEB_PORT} --strictPort`,
      url: WEB_URL,
      env: { VITE_SYNC_URL: `ws://localhost:${SYNC_PORT}` },
      reuseExistingServer: false,
      timeout: 180_000,
    },
  ],
})
