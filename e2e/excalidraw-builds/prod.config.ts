import { defineConfig, devices } from '@playwright/test'
import { API_URL, RUN_TAG, SYNC_URL, WEB_PORT, WEB_URL } from '../tests/support/ports.ts'
import type { StackEngine } from '../tests/support/stack.ts'

// The PRODUCTION Excalidraw web build (docs/EXCALIDRAW-CUTOVER.md G2): `vite build` with
// VITE_LOBBY_ENGINE=excalidraw and WITHOUT the dev-auth guard (no VITE_DRAFTROOM_DEV_AUTH), as the static
// site is built at the cut-over, served by `vite preview`, against the api + sync + worker stack (sync on
// DRAFTROOM_ENGINE=excalidraw). No facade, no debug handle: the specs drive the page as a person does and
// read the DOM, the network and the build output.
//
//   E2E_PORT_BASE=<base> pnpm --filter @draftroom/e2e excalidraw:prod
//
// The build goes to apps/web/dist/lp-<tag> (the specs read it), output to e2e/test-results/lp-<tag>.
export const WEB_OUT_DIR = `dist/lp-${RUN_TAG}`

export default defineConfig<Record<never, never>, { engine: StackEngine }>({
  testDir: '.',
  testMatch: /prod-.*\.spec\.ts$/,
  outputDir: `../test-results/lp-${RUN_TAG}`,
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
        // the production build: no dev auth (set empty so a developer's shell cannot turn it on)
        VITE_DRAFTROOM_DEV_AUTH: '',
        VITE_LOBBY_BOARD_PAGE: '',
      },
      reuseExistingServer: false,
      timeout: 180_000,
    },
  ],
})
