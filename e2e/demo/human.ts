// Human-paced input for the demo recording: eased, slightly curved cursor moves, visible typing at a
// realistic speed, and a drawn cursor. Headless Chromium never paints the OS cursor, so every desktop
// page gets an overlay arrow that follows the real pointer events (plus a click ripple and keycaps for
// Tab / Enter / Esc); the phone gets a touch dot instead. Nothing here changes what the app does.
import type { BrowserContext, Locator, Page } from '@playwright/test'

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** A small deterministic PRNG (mulberry32), so every run types and moves the same way. */
export function rng(seed: number) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const ease = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2)

/**
 * Demo-only presentation tweaks, injected as a stylesheet: the dev sign-in badge is drawn like the
 * production account button (its "DEV" tag is dev-only UI). The 960 px wide windows are narrower than
 * the board's top bar was laid out for, so it drops the workspace breadcrumb (the logo still links
 * home) and, on the desktops, its comment-tool button (the toolbar has the same tool; the phone keeps
 * it, as its toolbar has no room), sits a little tighter and shows
 * the Timer button as its icon: the board title keeps its room when a vote, brainstorm or link chip
 * joins the bar.
 */
const DEMO_CSS = `
.dr-devbadge__tag { display: none !important; }
.dr-topbar__ws, .dr-topbar__slash { display: none !important; }
.dr-topbar { gap: 7px !important; }
.dr-topbar .dr-wk-pill__label { display: none !important; }
@media (min-width: 700px) { .dr-topbar .dr-ctopbar__tool { display: none !important; } }
.dr-topbar__board { min-width: 84px !important; }
.dr-devbadge {
  height: 32px !important; border: 1px solid var(--dr-line) !important; border-radius: 999px !important;
  background: var(--dr-surface) !important;
}
.dr-devbadge .dr-avatar--sm { width: 24px !important; height: 24px !important; font-size: 10px !important; }
`

/**
 * The overlay cursor, click ripple and keycaps (desktop), or a touch dot (phone). Runs in the page.
 * It also reports fullscreen as unavailable: in headless Chromium a fullscreen element takes the
 * virtual screen's size and the recording tears, so Present uses its in-window mode (the app's own
 * fallback when a browser refuses fullscreen) and fills the recorded window instead.
 */
function installOverlay(opts: { css: string; touch: boolean; accent: string }) {
  try {
    Object.defineProperty(Document.prototype, 'fullscreenEnabled', { configurable: true, get: () => false })
  } catch {
    // Not fatal: Present would still work, only the recording of it would suffer.
  }
  const install = () => {
    if (document.getElementById('__demo_overlay')) return
    const root = document.createElement('div')
    root.id = '__demo_overlay'
    root.setAttribute('aria-hidden', 'true')
    root.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:2147483647;'
    const style = document.createElement('style')
    style.textContent = `${opts.css}
#__demo_cursor { position: fixed; left: 0; top: 0; width: 26px; height: 26px; transform: translate(-200px,-200px);
  filter: drop-shadow(0 2px 3px rgba(0,0,0,.35)); will-change: transform; }
.__demo_ripple { position: fixed; width: 34px; height: 34px; margin: -17px 0 0 -17px; border-radius: 50%;
  border: 3px solid ${opts.accent}; opacity: .9; animation: __demo_ripple .5s ease-out forwards; }
@keyframes __demo_ripple { from { transform: scale(.35); opacity: .95 } to { transform: scale(1.35); opacity: 0 } }
.__demo_touch { position: fixed; width: 44px; height: 44px; margin: -22px 0 0 -22px; border-radius: 50%;
  background: rgba(254,90,5,.35); border: 2px solid rgba(254,90,5,.9); animation: __demo_touch .55s ease-out forwards; }
@keyframes __demo_touch { from { transform: scale(.6); opacity: 1 } to { transform: scale(1.25); opacity: 0 } }
#__demo_keys { position: fixed; left: 50%; bottom: 96px; transform: translateX(-50%); display: flex; gap: 8px; }
.__demo_key { font: 600 18px/1 "Segoe UI", system-ui, sans-serif; color: #fff; background: rgba(33,49,80,.92);
  border: 1px solid rgba(255,255,255,.25); border-bottom-width: 3px; border-radius: 9px; padding: 9px 14px;
  box-shadow: 0 6px 18px rgba(0,0,0,.25); animation: __demo_key 1.1s ease-out forwards; }
@keyframes __demo_key { 0% { transform: translateY(8px); opacity: 0 } 12% { transform: none; opacity: 1 }
  75% { opacity: 1 } 100% { opacity: 0 } }`
    root.appendChild(style)
    if (!opts.touch) {
      const cursor = document.createElement('div')
      cursor.id = '__demo_cursor'
      cursor.innerHTML =
        '<svg width="26" height="26" viewBox="0 0 26 26"><path d="M4 2.5v19.2l5.1-4.9 3.3 7.4 3.5-1.5-3.3-7.3h7.1z" fill="#fff" stroke="#1d2433" stroke-width="1.6" stroke-linejoin="round"/></svg>'
      root.appendChild(cursor)
      const keys = document.createElement('div')
      keys.id = '__demo_keys'
      root.appendChild(keys)
      const move = (e: PointerEvent | MouseEvent) => {
        cursor.style.transform = `translate(${e.clientX - 4}px, ${e.clientY - 2}px)`
      }
      window.addEventListener('pointermove', move, true)
      window.addEventListener('mousemove', move, true)
      window.addEventListener(
        'pointerdown',
        (e) => {
          move(e)
          const r = document.createElement('div')
          r.className = '__demo_ripple'
          r.style.left = `${e.clientX}px`
          r.style.top = `${e.clientY}px`
          root.appendChild(r)
          setTimeout(() => r.remove(), 600)
        },
        true,
      )
      const names: Record<string, string> = { Tab: 'Tab ⇥', Enter: 'Enter ↵', Escape: 'Esc' }
      window.addEventListener(
        'keydown',
        (e) => {
          const shown = names[e.key]
          if (!shown || e.repeat) return
          const k = document.createElement('div')
          k.className = '__demo_key'
          k.textContent = (e.shiftKey ? 'Shift + ' : '') + shown
          keys.replaceChildren(k)
          setTimeout(() => k.remove(), 1150)
        },
        true,
      )
    } else {
      window.addEventListener(
        'pointerdown',
        (e) => {
          const r = document.createElement('div')
          r.className = '__demo_touch'
          r.style.left = `${e.clientX}px`
          r.style.top = `${e.clientY}px`
          root.appendChild(r)
          setTimeout(() => r.remove(), 650)
        },
        true,
      )
    }
    document.documentElement.appendChild(root)
    // Modal dialogs (<dialog> + showModal) sit in the browser's top layer, above any z-index. The
    // overlay is a manual popover, so it lives in the top layer too, and it is raised again whenever a
    // dialog opens: the cursor stays visible over the New board, Export and preview dialogs.
    root.setAttribute('popover', 'manual')
    root.style.cssText +=
      'margin:0;padding:0;border:0;background:transparent;width:100vw;height:100vh;max-width:none;max-height:none;overflow:visible;'
    const raise = () => {
      try {
        if (root.matches(':popover-open')) root.hidePopover()
        root.showPopover()
      } catch {
        // An older engine without popovers: the overlay simply stays under modal dialogs.
      }
    }
    raise()
    new MutationObserver((changes) => {
      if (changes.some((c) => c.target instanceof HTMLDialogElement && c.target.open)) raise()
    }).observe(document.documentElement, { subtree: true, attributes: true, attributeFilter: ['open'] })
  }
  if (document.readyState === 'loading')
    document.addEventListener('DOMContentLoaded', install, { once: true })
  else install()
}

export async function prepareContext(context: BrowserContext, opts: { touch?: boolean } = {}) {
  await context.addInitScript(installOverlay, { css: DEMO_CSS, touch: !!opts.touch, accent: '#FE5A05' })
}

export interface Point {
  x: number
  y: number
}

/** One person at a keyboard and mouse (or a finger on a phone). */
export class Actor {
  readonly name: string
  readonly page: Page
  readonly touch: boolean
  private pos: Point
  private readonly random: () => number

  constructor(name: string, page: Page, opts: { touch?: boolean; seed?: number; start?: Point } = {}) {
    this.name = name
    this.page = page
    this.touch = !!opts.touch
    this.random = rng(opts.seed ?? 7)
    const vp = page.viewportSize() ?? { width: 960, height: 1080 }
    this.pos = opts.start ?? { x: Math.round(vp.width * 0.6), y: Math.round(vp.height * 0.55) }
  }

  get position(): Point {
    return { ...this.pos }
  }

  /** Re-draws the overlay cursor where the pointer is (after a navigation re-created the overlay). */
  async nudge() {
    if (this.touch) return
    await this.page.mouse.move(this.pos.x + 1, this.pos.y)
    await this.page.mouse.move(this.pos.x, this.pos.y)
  }

  /** An eased, slightly curved move; `ms` defaults to a speed that grows with the distance. */
  async move(to: Point, ms?: number) {
    if (this.touch) {
      this.pos = { ...to }
      return
    }
    const from = this.pos
    const dx = to.x - from.x
    const dy = to.y - from.y
    const dist = Math.hypot(dx, dy)
    if (dist < 1) return
    const duration = ms ?? Math.min(1100, 260 + dist * 0.75)
    // A gentle arc: the control point sits off the straight line by a few percent of the distance.
    const bend = (this.random() - 0.5) * 0.22 * dist
    const cx = (from.x + to.x) / 2 + (-dy / dist) * bend
    const cy = (from.y + to.y) / 2 + (dx / dist) * bend
    const steps = Math.max(6, Math.round(duration / 16))
    const t0 = Date.now()
    for (let i = 1; i <= steps; i++) {
      const t = ease(i / steps)
      const x = (1 - t) * (1 - t) * from.x + 2 * (1 - t) * t * cx + t * t * to.x
      const y = (1 - t) * (1 - t) * from.y + 2 * (1 - t) * t * cy + t * t * to.y
      await this.page.mouse.move(x, y)
      const due = t0 + (duration * i) / steps
      const wait = due - Date.now()
      if (wait > 0) await sleep(wait)
    }
    this.pos = { ...to }
  }

  /** Moves there and clicks (or taps, on a phone). */
  async click(at: Point, opts: { ms?: number; hold?: number } = {}) {
    if (this.touch) {
      this.pos = { ...at }
      await this.page.touchscreen.tap(at.x, at.y)
      return
    }
    await this.move(at, opts.ms)
    await sleep(90)
    await this.page.mouse.down()
    await sleep(opts.hold ?? 70)
    await this.page.mouse.up()
  }

  /** The visible centre of an element (or a point inside it, as fractions of its box). */
  async pointOf(target: Locator, at: { u?: number; v?: number } = {}): Promise<Point> {
    await target.waitFor({ state: 'visible', timeout: 20_000 })
    await target.scrollIntoViewIfNeeded()
    const box = await target.boundingBox()
    if (!box) throw new Error(`${this.name}: no box for ${target}`)
    return { x: box.x + box.width * (at.u ?? 0.5), y: box.y + box.height * (at.v ?? 0.5) }
  }

  async clickOn(target: Locator, opts: { ms?: number; u?: number; v?: number } = {}) {
    await this.click(await this.pointOf(target, opts), opts)
  }

  async hover(target: Locator, opts: { ms?: number; u?: number; v?: number } = {}) {
    await this.move(await this.pointOf(target, opts), opts.ms)
  }

  /** Presses and drags with the mouse (a connector, a selection box). */
  async drag(from: Point, to: Point, ms = 700) {
    await this.move(from)
    await sleep(120)
    await this.page.mouse.down()
    await sleep(80)
    await this.move(to, ms)
    await sleep(120)
    await this.page.mouse.up()
  }

  /** Types like a person: about 11 characters a second, a little slower after spaces and punctuation. */
  async type(text: string, cps = 11) {
    const base = 1000 / cps
    for (const ch of text) {
      await this.page.keyboard.type(ch)
      let wait = base * (0.65 + this.random() * 0.7)
      if (ch === ' ') wait += base * 0.4
      if (/[,.!?:]/.test(ch)) wait += base * 1.2
      await sleep(wait)
    }
  }

  async press(key: string, after = 260) {
    await this.page.keyboard.press(key)
    await sleep(after)
  }

  pause(ms: number) {
    return sleep(ms)
  }
}
