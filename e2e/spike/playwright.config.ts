import { defineConfig, devices } from '@playwright/test'
import {
  SPIKE_API_ORIGIN,
  SPIKE_RUN_TAG,
  SPIKE_SYNC_ORIGIN,
  SPIKE_WEB_PORT,
  SPIKE_WEB_URL,
} from './support/ports.ts'

// Spike A engine checks (docs/EXCALIDRAW-MIGRATION.md §8.2). Run: pnpm --filter @draftroom/e2e spike
// (SPIKE_WEB_PORT picks the port; several owners can run side by side on different ports).
//
// The web app is built with VITE_LOBBY_ENGINE=excalidraw and the dev-auth guard into a per-port folder
// (apps/web/dist/spike-<port>) and served by vite preview. No api or sync server: /spike/:name pages
// run outside the session.
const WEB_OUT_DIR = `dist/${SPIKE_RUN_TAG}`

export default defineConfig({
  testDir: './tests',
  outputDir: `../test-results/${SPIKE_RUN_TAG}`,
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  reporter: 'list',
  timeout: 60_000,
  expect: { timeout: 15_000 },
  use: { baseURL: SPIKE_WEB_URL, trace: 'retain-on-failure', screenshot: 'only-on-failure' },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: [
    {
      command: `pnpm --filter @draftroom/web exec vite build --outDir ${WEB_OUT_DIR} && pnpm --filter @draftroom/web exec vite preview --outDir ${WEB_OUT_DIR} --port ${SPIKE_WEB_PORT} --strictPort`,
      url: SPIKE_WEB_URL,
      env: {
        VITE_LOBBY_ENGINE: 'excalidraw',
        VITE_DRAFTROOM_DEV_AUTH: '1',
        DRAFTROOM_API_ORIGIN: SPIKE_API_ORIGIN,
        DRAFTROOM_SYNC_ORIGIN: SPIKE_SYNC_ORIGIN,
      },
      reuseExistingServer: false,
      timeout: 180_000,
    },
  ],
})
