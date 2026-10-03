import { resolve } from 'node:path'
import { defineConfig } from '@playwright/test'
import base from '../../playwright.config.ts'
import { HOST, SYNC_PORT, WEB_PORT, WEB_URL } from '../../tests/support/ports.ts'
import type { StackEngine } from '../../tests/support/stack.ts'
import { localPolicy } from './suite-audit-policy.ts'

// The whole-suite CSP audit: the default suite (../../playwright.config.ts, the specs in e2e/excalidraw,
// one worker) unchanged, except that `vite preview` serves every page and static file with the staging
// policy as Content-Security-Policy-Report-Only (suite-audit-policy.ts, translated for the local stack)
// plus a `report-uri` to a local collector (suite-audit-collector.ts). Nothing is blocked, so the suite
// behaves as usual; the browser reports every load the ENFORCED policy would block. A timeline reporter
// (suite-audit-reporter.ts) records which test ran when, and suite-audit-dedupe.ts summarises.
//
//   E2E_PORT_BASE=6530 CSP_AUDIT_DIR=<dir> pnpm exec playwright test -c spike/csp/suite-audit.config.ts
//   (from e2e/; any spec filter as usual)
//
// The collector listens on CSP_AUDIT_COLLECTOR_PORT (default: the web port + 3); it is started here
// unless one already answers there (start it yourself to keep its reports across runs). Output, all
// under CSP_AUDIT_DIR (default e2e/test-results/csp-audit-<web port>): reports.jsonl, timeline.jsonl.
// CSP_AUDIT_REUSE_BUILD=1 serves an existing build (apps/web/dist/csp-audit-<web port>) without
// rebuilding. The build is the suite's own: VITE_DRAFTROOM_DEV_AUTH=1 (the facade and the debug handle).
// CSP_AUDIT_ENFORCE=1 serves the same value as the enforced Content-Security-Policy instead (to see what a
// reported violation does once it is blocked; the suite is then expected to fail where it reports), and
// CSP_AUDIT_CONNECT_EXTRA="data:" adds sources to connect-src for such an experiment (suite-audit-policy.ts).
// CSP_AUDIT_CONTROL=1 runs the positive control only (suite-audit-control.spec.ts: one deliberate
// violation of each kind from a board page, which must reach the collector).

const WEB_OUT_DIR = `dist/csp-audit-${WEB_PORT}`
const COLLECTOR_PORT = Number(process.env.CSP_AUDIT_COLLECTOR_PORT || WEB_PORT + 3)
const DIR = resolve(
  process.env.CSP_AUDIT_DIR || resolve(import.meta.dirname, `../../test-results/csp-audit-${WEB_PORT}`),
)
const REPORTS = resolve(DIR, 'reports.jsonl')
const TIMELINE = resolve(DIR, 'timeline.jsonl')
process.env.CSP_AUDIT_TIMELINE = TIMELINE

const policy = localPolicy({
  host: HOST,
  syncPort: SYNC_PORT,
  collectorPort: COLLECTOR_PORT,
  extraConnect: (process.env.CSP_AUDIT_CONNECT_EXTRA ?? '').split(/\s+/).filter(Boolean),
})
const viteConfig = resolve(import.meta.dirname, 'suite-audit.vite.config.ts').replaceAll('\\', '/')
const collector = resolve(import.meta.dirname, 'suite-audit-collector.ts').replaceAll('\\', '/')

const [web] = Array.isArray(base.webServer) ? base.webServer : base.webServer ? [base.webServer] : []
if (!web) throw new Error('the default config has no web server to wrap')

const build = `pnpm --filter @draftroom/web exec vite build --outDir ${WEB_OUT_DIR} --emptyOutDir`
const preview = `pnpm --filter @draftroom/web exec vite preview --config ${viteConfig} --outDir ${WEB_OUT_DIR} --port ${WEB_PORT} --strictPort`

export default defineConfig<Record<never, never>, { engine: StackEngine }>({
  ...base,
  // Absolute: Playwright resolves the base config's relative paths against THIS file's folder.
  // CSP_AUDIT_CONTROL=1 runs the positive control (suite-audit-control.spec.ts) instead of the suite.
  ...(process.env.CSP_AUDIT_CONTROL === '1'
    ? { testDir: import.meta.dirname, testMatch: /suite-audit-control\.spec\.ts$/ }
    : { testDir: resolve(import.meta.dirname, '../../excalidraw') }),
  outputDir: resolve(import.meta.dirname, `../../test-results/csp-audit-${WEB_PORT}-out`),
  reporter: [['list'], [resolve(import.meta.dirname, 'suite-audit-reporter.ts')]],
  webServer: [
    {
      command: `node ${collector} --port ${COLLECTOR_PORT} --out "${REPORTS.replaceAll('\\', '/')}"`,
      url: `http://${HOST}:${COLLECTOR_PORT}/healthz`,
      reuseExistingServer: true,
      timeout: 30_000,
    },
    {
      ...web,
      command: process.env.CSP_AUDIT_REUSE_BUILD === '1' ? preview : `${build} && ${preview}`,
      url: WEB_URL,
      env: { ...web.env, CSP_AUDIT_HEADER: policy.header },
    },
  ],
})

export const auditPolicy = policy
