// Headless check of the rehearsal stack from the workstation (never the user's browser): does the web
// build load on the LAN origin, does Clerk's sign-in widget render there (the dev instance's origin
// question), what does the console say. Prints statuses, hosts and counts; no cookies, keys or bodies.
import { createRequire } from 'node:module'
const require = createRequire('C:/Users/Chase/Documents/GitHub/Draftroom/e2e/package.json')
const { chromium } = require('@playwright/test')
const ORIGIN = process.argv[2] ?? 'https://192.168.10.1:8443'
const browser = await chromium.launch()
const ctx = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1280, height: 800 } })
const page = await ctx.newPage()
const consoleMsgs = [], failures = [], clerk = new Map(), ownOrigin = new Map()
page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') consoleMsgs.push(`${m.type()}: ${m.text().slice(0, 160)}`) })
page.on('pageerror', (e) => consoleMsgs.push(`pageerror: ${String(e.message).slice(0, 160)}`))
page.on('requestfailed', (r) => failures.push(`${r.method()} ${new URL(r.url()).host}${new URL(r.url()).pathname.slice(0, 60)} ${r.failure()?.errorText}`))
page.on('response', (r) => {
  const u = new URL(r.url())
  const key = `${u.host} ${r.status()}`
  if (/clerk/.test(u.host)) clerk.set(key, (clerk.get(key) ?? 0) + 1)
  else if (u.origin === ORIGIN) ownOrigin.set(key, (ownOrigin.get(key) ?? 0) + 1)
  else ownOrigin.set(`OTHER ${key}`, (ownOrigin.get(`OTHER ${key}`) ?? 0) + 1)
})
const t0 = Date.now()
const resp = await page.goto(ORIGIN + '/', { waitUntil: 'networkidle', timeout: 60000 })
console.log('GET / ->', resp?.status(), 'in', Date.now() - t0, 'ms; title:', JSON.stringify(await page.title()))
// Clerk mounts its widget under .cl-rootBox / .cl-signIn-root; give it up to 25 s.
let clerkWidget = false
try { await page.waitForSelector('.cl-rootBox, .cl-signIn-root, .cl-card', { timeout: 25000 }); clerkWidget = true } catch {}
await page.waitForTimeout(1500)
const texts = await page.evaluate(() => Array.from(document.querySelectorAll('h1,h2,button,.cl-headerTitle')).map((e) => e.textContent?.trim()).filter(Boolean).slice(0, 12))
console.log('final url:', page.url().replace(/[?#].*/, ''))
console.log('clerk widget rendered:', clerkWidget)
console.log('visible headings/buttons:', JSON.stringify(texts))
console.log('own-origin responses:', JSON.stringify(Object.fromEntries(ownOrigin)))
console.log('clerk responses:', JSON.stringify(Object.fromEntries(clerk)))
console.log('failed requests:', failures.length, failures.slice(0, 5))
console.log('console errors/warnings:', consoleMsgs.length); for (const m of consoleMsgs.slice(0, 8)) console.log('  ', m)
await page.screenshot({ path: 'shots/signin.png', fullPage: false })
// A deep link must come back as the SPA (sign-in gate), not a 404.
const r2 = await page.goto(ORIGIN + '/b/board-probe-does-not-exist', { waitUntil: 'networkidle', timeout: 30000 })
console.log('GET /b/<id> ->', r2?.status(), 'final url path:', new URL(page.url()).pathname)
await page.screenshot({ path: 'shots/deeplink.png' })
await browser.close()
