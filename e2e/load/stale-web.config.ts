// The stale-web pair's own Playwright config (e2e/load/stale-web.spec.ts): the browser suite's config with this
// folder as its test dir and the one spec, chromium only. Same stack, ports (E2E_PORT_BASE) and web build.
import { defineConfig, devices } from '@playwright/test'
import base from '../playwright.config.ts'

export default defineConfig({
  ...base,
  testDir: '.',
  testMatch: /stale-web\.spec\.ts$/,
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
})
