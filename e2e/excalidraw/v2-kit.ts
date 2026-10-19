// OWNER: WS3 (wave V, V2 join codes). Helpers of the v2-* specs: the web switch for a context (a dev-auth build reads
// localStorage `lobby.liveJoinCodes`; LIVE_FLAGS.joinCodes ships off until the lead turns it on), the foreign-request
// tracker (no request may leave Lobby's own origins: the e2e network assertion) and what the join card's QR is made of.
import type { Browser, BrowserContext, Locator, Page, Request } from '@playwright/test'
import { signInContext } from '../tests/support/api.ts'
import { expect } from '../tests/support/canvas.ts'
import { API_URL, WEB_URL } from '../tests/support/ports.ts'

/** features/live/flags.ts LIVE_FLAG_KEYS.joinCodes (e2e declares no dependency on the web package) */
export const JOIN_CODES_FLAG_KEY = 'lobby.liveJoinCodes'
/** A phone (the size of an iPhone 14), touch, as a room's participants join. */
export const PHONE = {
  viewport: { width: 390, height: 844 },
  isMobile: true,
  hasTouch: true,
  deviceScaleFactor: 2,
}
/** contracts join-codes.ts: 8 Crockford characters shown ABCD-2345 */
export const CODE_DISPLAY = /^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/

/** The join codes web switch for every page of a context ('1' on, '0' off). */
export async function withJoinCodesFlag(context: BrowserContext, value: '1' | '0' = '1'): Promise<void> {
  await context.addInitScript(
    ([key, v]) => {
      try {
        localStorage.setItem(key as string, v as string)
      } catch {
        /* a blocked store keeps the shipped value */
      }
    },
    [JOIN_CODES_FLAG_KEY, value],
  )
}

/** Every request of the page that left Lobby's own origins (none may), data: and blob: aside. */
export function foreignRequests(page: Page): string[] {
  const own = new Set([new URL(WEB_URL).origin, new URL(API_URL).origin])
  const foreign: string[] = []
  page.on('request', (r: Request) => {
    const url = new URL(r.url())
    if (url.protocol === 'data:' || url.protocol === 'blob:') return
    if (!own.has(url.origin)) foreign.push(r.url())
  })
  return foreign
}

/** A signed-in account in a context of its own with the join codes switch on. */
export async function signedIn(
  browser: Browser,
  handle: string,
  name: string,
  options: Parameters<Browser['newContext']>[0] = { viewport: { width: 1360, height: 860 } },
): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext(options)
  await withJoinCodesFlag(context)
  await signInContext(context, handle, name)
  return { context, page: await context.newPage() }
}

/** A fresh browser with no account (a phone unless `options` say otherwise), with the join codes switch on. */
export async function anonymous(
  browser: Browser,
  options: Parameters<Browser['newContext']>[0] = PHONE,
  flag: '1' | '0' = '1',
): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext(options)
  expect(await context.cookies()).toEqual([])
  await withJoinCodesFlag(context, flag)
  return { context, page: await context.newPage() }
}

/**
 * The QR the card drew: its source text, and that the svg holds nothing but a white square and one black path (no
 * data:/blob: URL, href, image, canvas or external reference).
 */
export async function qrOf(qr: Locator): Promise<{ url: string; side: number }> {
  await expect(qr).toBeVisible()
  const info = await qr.evaluate((svg) => ({
    url: svg.getAttribute('data-join-url') ?? '',
    tags: [...svg.querySelectorAll('*')].map((e) => e.tagName.toLowerCase()),
    attrs: [svg, ...svg.querySelectorAll('*')].flatMap((e) =>
      [...e.attributes].filter((a) => a.name !== 'data-join-url' && a.name !== 'xmlns').map((a) => a.value),
    ),
    fills: [...svg.querySelectorAll('rect, path')].map((e) => e.getAttribute('fill')),
    viewBox: svg.getAttribute('viewBox') ?? '',
    box: svg.getBoundingClientRect().width,
  }))
  expect(info.tags).toEqual(['rect', 'path'])
  expect(info.fills).toEqual(['#ffffff', '#000000'])
  for (const v of info.attrs)
    for (const banned of ['data:', 'blob:', 'http:', 'https:', 'url('])
      expect(v, banned).not.toContain(banned)
  const side = Number(info.viewBox.split(' ')[2])
  expect(side).toBeGreaterThanOrEqual(21 + 8)
  return { url: info.url, side: info.box }
}
