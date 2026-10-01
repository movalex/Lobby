/**
 * Runner helper: builds the probe page, serves it on a spike-A port, and opens it in headless
 * Chromium (Playwright from the workspace catalog, resolved through the e2e package that installs it).
 * Every request that is not to 127.0.0.1 is aborted and counted: fonts must come from the package.
 */
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { startProbeServer } from './serve.ts'

const here = fileURLToPath(new URL('.', import.meta.url))
const e2eRequire = createRequire(new URL('../../../../../e2e/package.json', import.meta.url))
const webRequire = createRequire(new URL('../../../package.json', import.meta.url))

type PW = typeof import('@playwright/test')

export const buildProbePage = async () => {
  const vite = (await import(pathToFileURL(webRequire.resolve('vite')).href)) as typeof import('vite')
  const t0 = performance.now()
  await vite.build({ configFile: fileURLToPath(new URL('./vite.config.ts', import.meta.url)), root: here })
  return performance.now() - t0
}

export interface ProbeSession {
  page: import('@playwright/test').Page
  browserVersion: string
  foreignRequests: string[]
  pageErrors: string[]
  consoleErrors: string[]
  served: string[]
  close: () => Promise<void>
}

export const openProbePage = async (port = 7750): Promise<ProbeSession> => {
  const { chromium } = e2eRequire('@playwright/test') as PW
  const { server, url, served } = await startProbeServer(port)
  const browser = await chromium.launch({ headless: true })
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } })
  const foreignRequests: string[] = []
  await context.route('**/*', (route) => {
    const u = new URL(route.request().url())
    if (u.hostname === '127.0.0.1' && u.port === String(port)) return route.continue()
    if (u.protocol === 'data:' || u.protocol === 'blob:') return route.continue()
    foreignRequests.push(u.origin)
    return route.abort()
  })
  const page = await context.newPage()
  const pageErrors: string[] = []
  const consoleErrors: string[] = []
  page.on('pageerror', (e) => pageErrors.push(String(e)))
  page.on('console', (m) => {
    if (m.type() === 'error') consoleErrors.push(m.text().slice(0, 300))
  })
  await page.goto(url)
  await page.waitForFunction(() => window.__probe?.ready === true, null, { timeout: 90_000 })
  const err = await page.evaluate(() => window.__probe.error ?? null)
  if (err) throw new Error(err)
  return {
    page,
    browserVersion: browser.version(),
    foreignRequests,
    pageErrors,
    consoleErrors,
    served,
    close: async () => {
      await browser.close()
      await new Promise<void>((ok) => server.close(() => ok()))
    },
  }
}
