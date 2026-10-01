import { defineConfig, devices } from '@playwright/test'

// Spike B contracts step C0: checks of the frozen contracts that need a browser (no stack, no web build,
// no listening port: pages are served by page.route). Run: pnpm --filter @draftroom/e2e spike-b:contracts
export default defineConfig({
  testDir: '.',
  outputDir: '../../test-results/spike-b-contracts',
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  reporter: 'list',
  timeout: 60_000,
  use: { trace: 'off', screenshot: 'off' },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
})
