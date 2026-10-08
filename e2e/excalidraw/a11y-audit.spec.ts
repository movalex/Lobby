// An accessibility audit of the Excalidraw board page (owner 3i, docs/EXCALIDRAW-MIGRATION.md §4.8 (4) "axe
// on the board page"), in two layers:
//  - axe (wave C4, CR-3I-1): @axe-core/playwright runs axe's WCAG 2.0 to 2.2 A and AA rules and its best
//    practices on the sign-in page, the dashboard and the board, on a desktop and at 390 px, in light and dark
//    (the "axe:" tests below). The exceptions are recorded in AXE_EXCEPTIONS and AXE_INCOMPLETE_OK, with reasons.
//  - the hand audit (the "passes the audit" tests): the rules axe would flag first, written by hand while axe was not a
//    dependency, kept as the fallback and for what axe does not know about Lobby: every visible control has an
//    accessible name, ids are unique, ARIA id references resolve, images have alternative text, the page has one
//    main landmark and a named canvas, and over the canvas only the known live regions speak. Run on the desktop
//    board with content and a panel open, and on a phone with the sheet open.
import AxeBuilder from '@axe-core/playwright'
import type { Page } from '@playwright/test'
import { signInContext } from '../tests/support/api.ts'
import { expect, test, zoomToFit } from '../tests/support/canvas.ts'
import { focusCanvas, frame, intoFrame, note, PHONE, textItem, waitForA11y } from './a11y-kit.ts'

interface Finding {
  rule: string
  what: string
}

/** The audit: returns every finding (an empty list passes). */
const audit = (page: Page) =>
  page.evaluate((): Finding[] => {
    const out: Finding[] = []
    const visible = (el: Element) => {
      const h = el as HTMLElement
      if (!h.getClientRects().length) return false
      if (h.closest('[hidden], [aria-hidden="true"], [inert]')) return false
      const s = getComputedStyle(h)
      return s.visibility !== 'hidden' && s.display !== 'none'
    }
    const describe = (el: Element) =>
      `${el.tagName.toLowerCase()}${el.getAttribute('data-testid') ? `[data-testid=${el.getAttribute('data-testid')}]` : ''}${el.className && typeof el.className === 'string' ? `.${el.className.split(' ').filter(Boolean).slice(0, 2).join('.')}` : ''}`
    const byIds = (ids: string | null) =>
      (ids ?? '')
        .split(/\s+/)
        .filter(Boolean)
        .map((id) => document.getElementById(id))
    const nameOf = (el: Element): string => {
      const labelled = byIds(el.getAttribute('aria-labelledby'))
      if (labelled.length && labelled.every(Boolean))
        return labelled
          .map((l) => l?.textContent ?? '')
          .join(' ')
          .trim()
      const aria = el.getAttribute('aria-label')?.trim()
      if (aria) return aria
      if (
        el instanceof HTMLInputElement ||
        el instanceof HTMLTextAreaElement ||
        el instanceof HTMLSelectElement
      ) {
        const labels = el.labels
          ? [...el.labels]
              .map((l) => l.textContent ?? '')
              .join(' ')
              .trim()
          : ''
        if (labels) return labels
        if (el instanceof HTMLInputElement && el.type === 'hidden') return 'hidden'
        return (el.getAttribute('title') ?? el.getAttribute('placeholder') ?? '').trim()
      }
      const text = (el.textContent ?? '').trim()
      if (text) return text
      const img = el.querySelector('img[alt]')
      if (img?.getAttribute('alt')?.trim()) return img.getAttribute('alt')?.trim() ?? ''
      return (el.getAttribute('title') ?? '').trim()
    }

    // 1. named controls (button-name, link-name, label)
    for (const el of document.querySelectorAll(
      'button, a[href], input:not([type="hidden"]), select, textarea, [role="button"], [role="menuitem"], [role="tab"], [role="checkbox"], [role="switch"]',
    )) {
      if (!visible(el)) continue
      // Excalidraw's own text editor is named by the note it edits only while open; skip its hidden input
      if (el.classList.contains('excalidraw-wysiwyg')) continue
      if (!nameOf(el)) out.push({ rule: 'control-name', what: describe(el) })
    }
    // 2. unique ids (duplicate-id)
    const seen = new Map<string, number>()
    for (const el of document.querySelectorAll('[id]')) seen.set(el.id, (seen.get(el.id) ?? 0) + 1)
    for (const [id, n] of seen) if (n > 1 && id) out.push({ rule: 'duplicate-id', what: id })
    // 3. ARIA references resolve (aria-valid-attr-value)
    for (const attr of ['aria-controls', 'aria-labelledby', 'aria-describedby']) {
      for (const el of document.querySelectorAll(`[${attr}]`)) {
        for (const id of (el.getAttribute(attr) ?? '').split(/\s+/).filter(Boolean)) {
          if (!document.getElementById(id))
            out.push({ rule: `${attr}-missing`, what: `${describe(el)} → #${id}` })
        }
      }
    }
    // 4. images (image-alt)
    for (const img of document.querySelectorAll('img')) {
      if (visible(img) && !img.hasAttribute('alt')) out.push({ rule: 'image-alt', what: describe(img) })
    }
    // 5. landmarks: one main, a named canvas region
    const mains = document.querySelectorAll('main, [role="main"]')
    if (mains.length !== 1) out.push({ rule: 'landmark-one-main', what: String(mains.length) })
    const region = document.querySelector('[data-lobby-board-canvas]')
    if (!region?.getAttribute('aria-label')) out.push({ rule: 'region-name', what: 'the board canvas' })
    // 6. over the canvas, only the known live regions speak (the canvas announcer, the lease status, and
    // since the wave-3 integration the two polite status lines the tldraw page has too: the private
    // brainstorm's start (3f, A11Y2-01) and the mind map's status (3d); since wave 5 the announcer's polite
    // tool line (W5-43))
    const known = new Set([
      'canvas-announcer',
      'canvas-announcer-tool',
      'lease-status',
      'pn-start-announce',
      'mindmap-status',
    ])
    for (const el of region?.querySelectorAll('[aria-live], [role="status"], [role="alert"]') ?? []) {
      const id = el.getAttribute('data-testid') ?? ''
      if (!known.has(id)) out.push({ rule: 'live-region', what: describe(el) })
    }
    const announcers = document.querySelectorAll('[data-testid="canvas-announcer"]')
    if (announcers.length !== 1) out.push({ rule: 'one-announcer', what: String(announcers.length) })
    // 7. landmark structure (W5-57): a contentinfo (the page footer) is top level, never inside main
    // (landmark-contentinfo-is-top-level; the engine renders a <footer role="contentinfo"> in the canvas);
    // two landmarks of one role never share a name (landmark-unique); and the canvas region and the
    // board's application (what takes the keyboard inside it) are named apart, so a screen reader does
    // not say the board's name twice on the way in
    const SECTIONING = 'article, aside, main, nav, section, [role="main"], [role="region"]'
    const LANDMARK_ROLES = ['banner', 'complementary', 'contentinfo', 'form', 'main', 'navigation', 'region']
    // a landmark's own name (aria-labelledby, aria-label, title), never its text
    const landmarkName = (el: Element): string => {
      const labelled = byIds(el.getAttribute('aria-labelledby'))
      if (labelled.length && labelled.every(Boolean))
        return labelled
          .map((l) => l?.textContent ?? '')
          .join(' ')
          .trim()
      return (el.getAttribute('aria-label') ?? el.getAttribute('title') ?? '').trim()
    }
    const landmarkRole = (el: Element): string | null => {
      const explicit = el.getAttribute('role')
      if (explicit) return LANDMARK_ROLES.includes(explicit) ? explicit : null
      const tag = el.tagName.toLowerCase()
      if (tag === 'main') return 'main'
      if (tag === 'nav') return 'navigation'
      if (tag === 'aside') return 'complementary'
      if (tag === 'header' && !el.parentElement?.closest(SECTIONING)) return 'banner'
      if (tag === 'footer' && !el.parentElement?.closest(SECTIONING)) return 'contentinfo'
      if ((tag === 'section' || tag === 'form') && landmarkName(el))
        return tag === 'section' ? 'region' : 'form'
      return null
    }
    const landmarks = new Map<string, number>()
    // an open modal dialog (showModal) leaves only itself in the accessibility tree: the page behind it
    // is inert, its landmarks included
    const modal = document.querySelector('dialog:modal')
    for (const el of document.querySelectorAll('main, nav, aside, header, footer, section, form, [role]')) {
      if (!visible(el) || (modal && !modal.contains(el))) continue
      const role = landmarkRole(el)
      if (!role) continue
      if (role === 'contentinfo' && el.parentElement?.closest('main, [role="main"]'))
        out.push({ rule: 'landmark-contentinfo-is-top-level', what: describe(el) })
      const key = `${role} "${landmarkName(el)}"`
      landmarks.set(key, (landmarks.get(key) ?? 0) + 1)
    }
    // (one main is rule 5's)
    for (const [key, n] of landmarks)
      if (n > 1 && !key.startsWith('main ')) out.push({ rule: 'landmark-unique', what: key })
    const regionName = region ? landmarkName(region) : ''
    for (const app of region?.querySelectorAll('[role="application"]') ?? []) {
      if (landmarkName(app) === regionName)
        out.push({ rule: 'region-application-same-name', what: regionName })
    }
    return out
  })

test('the board page passes the audit on a desktop with content and a panel open', async ({
  canvasSession,
}) => {
  const a = await canvasSession('alice')
  await waitForA11y(a.page)
  const retro = await frame(a.page, 0, 0, 800, 500, 'Retro')
  const inner = await note(a.page, 100, 100, 'Inside')
  await intoFrame(a.page, [inner], retro)
  await note(a.page, 1000, 100, 'Loose')
  await textItem(a.page, 0, -200, 'Agenda')
  await zoomToFit(a.page)
  await focusCanvas(a.page)
  await a.page.keyboard.press('Alt+ArrowRight')
  // W5-57: the board's application is there to be named apart from its region (rule 7)
  await expect(a.page.locator('[data-lobby-board-canvas] [role="application"]')).toHaveCount(1)
  expect(await audit(a.page)).toEqual([])
  await a.page.getByTestId('dock-tab-contents').click()
  await expect(a.page.getByTestId('dock-panel-contents')).toBeVisible()
  expect(await audit(a.page)).toEqual([])
  await a.page.getByTestId('share-button').click()
  await expect(a.page.getByTestId('share-dialog')).toBeVisible()
  expect(await audit(a.page)).toEqual([])
})

test('the board page passes the audit on a phone with the Board actions sheet open, and for a viewer', async ({
  canvasSession,
}) => {
  const a = await canvasSession('alice')
  await waitForA11y(a.page)
  await note(a.page, 0, 0, 'Phone')
  await a.page.setViewportSize(PHONE)
  await a.page.getByTestId('phone-sheet-open').click()
  await expect(a.page.getByTestId('phone-sheet')).toBeVisible()
  expect(await audit(a.page)).toEqual([])
  const v = await canvasSession('carol', { role: 'viewer' })
  await waitForA11y(v.page)
  expect(await audit(v.page)).toEqual([])
})

// ---- axe (wave C4, CR-3I-1) --------------------------------------------------------------------------------------

/** The rule sets axe runs: WCAG 2.0, 2.1 and 2.2 A and AA, and axe's own best practices (landmarks, regions...). */
const AXE_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice']

interface AxeException {
  /** the axe rule id */
  rule: string
  /** a part of the node's selector (axe's `target`) */
  target: string
  reason: string
}

/**
 * Violations that are known and accepted, each with the rule, the node and why. None today: the first run
 * (2026-10-03, axe-core 4.13.0) found no violation on any page, viewport or theme below. A new one is a
 * regression to fix, or, when it is in a part Lobby does not own, a line here with the reason. Remove a line when
 * it stops matching.
 */
const AXE_EXCEPTIONS: readonly AxeException[] = []

type AxeResults = Awaited<ReturnType<AxeBuilder['analyze']>>
type AxeNode = AxeResults['incomplete'][number]['nodes'][number]

interface AxeIncompleteOk {
  rule: string
  /** the audit labels (expectAxeClean's `label`) the acceptance applies to: it is per page, never global */
  where: RegExp
  /** axe's own reasons for not deciding (the `messageKey` of the undecided checks): any other reason fails */
  because: readonly string[]
  reason: string
}

/**
 * What axe reports as "incomplete" (it could not decide) and the audit accepts: one line per rule, page and reason
 * axe gave, with why. Any other incomplete result fails, and the failure names the node and axe's reason: it is a new
 * thing a person has to look at. Found on 2026-10-03 (axe-core 4.13.0); the first Linux run may add environment
 * dependent ones (fonts, rendering): add a line with its reason rather than loosening a rule.
 */
const AXE_INCOMPLETE_OK: readonly AxeIncompleteOk[] = [
  {
    rule: 'color-contrast',
    where: /^board/,
    because: ['bgOverlap', 'imgNode', 'shortTextContent'],
    reason:
      "text that sits over the canvas or a dialog backdrop, or over a frame's name (axe cannot read what is behind it); the rendered pixels of a frame name and of every note colour are measured by a11y-contrast.spec.ts",
  },
  {
    rule: 'color-contrast',
    where: /^dashboard/,
    because: ['bgImage', 'bgOverlap', 'shortTextContent'],
    reason:
      'the owner filter draws its arrow as a background image, and the card menu button is a one-character label; NOT measured anywhere else: a pixel check of the dashboard is still to be written',
  },
  {
    rule: 'color-contrast',
    where: /^sign-in/,
    because: ['bgGradient'],
    reason:
      'the wordmark and the tagline sit on the page gradient, which axe cannot sample; NOT measured anywhere else: a pixel check of the sign-in page is still to be written',
  },
  {
    rule: 'aria-valid-attr-value',
    where: /^(dashboard card menu|board 390px)/,
    because: ['controlsWithinPopup'],
    reason:
      'aria-controls on a menu button (the board card menu, the overflow button) with aria-haspopup: axe cannot tell whether the popup is mounted. Only accepted for aria-controls, and ariaControlsResolve() checks that the id exists while the menu is expanded (ARIA allows it to be missing only while collapsed)',
  },
]

/** The messageKey of each check axe could not decide for a node. */
const undecidedKeys = (n: AxeNode): string[] =>
  [...n.any, ...n.all, ...n.none].map((c) => String(c.data?.messageKey ?? c.id))

/** aria-controls on an expanded button must name an element that exists (a collapsed one may name a popup not yet mounted). */
async function ariaControlsResolve(page: Page, n: AxeNode): Promise<boolean> {
  const [selector, ...rest] = n.target
  if (typeof selector !== 'string' || rest.length) return false // inside a frame or a shadow root: not looked at
  return page.evaluate((sel) => {
    const el = document.querySelector(sel)
    if (!el) return false
    const ids = (el.getAttribute('aria-controls') ?? '').split(/\s+/).filter(Boolean)
    if (!ids.length) return false
    return el.getAttribute('aria-expanded') !== 'true' || ids.every((id) => document.getElementById(id))
  }, selector)
}

/** The "incomplete" results of an axe run that no AXE_INCOMPLETE_OK line (for this page) accepts, as lines of text. */
async function undecidedFor(page: Page, results: AxeResults, label: string): Promise<string[]> {
  const undecided: string[] = []
  for (const v of results.incomplete) {
    for (const n of v.nodes) {
      const keys = undecidedKeys(n)
      const accepted = AXE_INCOMPLETE_OK.some(
        (ok) => ok.rule === v.id && ok.where.test(label) && keys.every((k) => ok.because.includes(k)),
      )
      const resolved = v.id !== 'aria-valid-attr-value' || (await ariaControlsResolve(page, n))
      if (!accepted || !resolved)
        undecided.push(`${v.id} ${n.target.join(' >> ')} (axe: ${keys.join(', ') || 'no reason'})`)
    }
  }
  return undecided
}

/** One axe run on the page as it is now: no unexcepted violation, no unaccepted "incomplete" result. */
async function expectAxeClean(page: Page, label: string): Promise<void> {
  const results = await new AxeBuilder({ page }).withTags(AXE_TAGS).analyze()
  const violations = results.violations.flatMap((v) =>
    v.nodes
      .filter(
        (n) =>
          !AXE_EXCEPTIONS.some((e) => e.rule === v.id && n.target.some((t) => String(t).includes(e.target))),
      )
      .map((n) => `${v.id} [${v.impact}] ${n.target.join(' >> ')}: ${v.help}`),
  )
  expect(violations, `axe violations: ${label}`).toEqual([])
  expect(await undecidedFor(page, results, label), `axe could not decide (needs a look): ${label}`).toEqual(
    [],
  )
  // axe really looked: a page it could not read would pass with nothing checked
  expect(results.passes.length, `axe rules that passed: ${label}`).toBeGreaterThan(20)
}

const DESKTOP = { width: 1280, height: 800 }

for (const colorScheme of ['light', 'dark'] as const) {
  test(`axe: the sign-in page, on a desktop and at 390 px (${colorScheme})`, async ({
    browser,
    stackReady: _,
  }) => {
    for (const viewport of [DESKTOP, PHONE]) {
      const context = await browser.newContext({ viewport, colorScheme })
      try {
        const page = await context.newPage()
        await page.goto('/signin')
        await expect(page.getByTestId('signin-form')).toBeVisible()
        await expectAxeClean(page, `sign-in ${viewport.width}px ${colorScheme}`)
      } finally {
        await context.close()
      }
    }
  })

  test(`axe: the dashboard with a board card, its menu and the new-board dialog, on a desktop and at 390 px (${colorScheme})`, async ({
    browser,
    board: _board,
    users,
  }) => {
    for (const viewport of [DESKTOP, PHONE]) {
      const context = await browser.newContext({ viewport, colorScheme })
      try {
        const page = await context.newPage()
        await signInContext(context, 'alice', 'Alice Park')
        await page.goto(`/w/${users.devStudioId}`)
        await expect(page.getByTestId('dashboard')).toBeVisible()
        await expect(page.getByTestId('board-card').first()).toBeVisible()
        await expectAxeClean(page, `dashboard ${viewport.width}px ${colorScheme}`)
        await page.getByTestId('board-card-menu').first().click()
        await expect(page.locator('[role="menuitem"]').first()).toBeVisible()
        await expectAxeClean(page, `dashboard card menu ${viewport.width}px ${colorScheme}`)
        await page.keyboard.press('Escape')
        await page.getByTestId('create-board').click()
        await expect(page.getByTestId('create-board-dialog')).toBeVisible()
        await expectAxeClean(page, `dashboard new-board dialog ${viewport.width}px ${colorScheme}`)
      } finally {
        await context.close()
      }
    }
  })

  test(`axe: the board page on a desktop (content, the contents panel, the share dialog) and at 390 px (the Board actions sheet), and for a viewer (${colorScheme})`, async ({
    canvasSession,
  }) => {
    const a = await canvasSession('alice')
    await a.page.emulateMedia({ colorScheme })
    await waitForA11y(a.page)
    // K2-4: the empty board's start card and dot grid
    await expect(a.page.getByTestId('empty-board-hint')).toBeVisible()
    await expectAxeClean(a.page, `board empty, with the start card ${colorScheme}`)
    const retro = await frame(a.page, 0, 0, 800, 500, 'Retro')
    const inner = await note(a.page, 100, 100, 'Inside')
    await intoFrame(a.page, [inner], retro)
    await note(a.page, 1000, 100, 'Loose')
    await textItem(a.page, 0, -200, 'Agenda')
    await zoomToFit(a.page)
    await expectAxeClean(a.page, `board ${colorScheme}`)

    await a.page.getByTestId('dock-tab-contents').click()
    await expect(a.page.getByTestId('dock-panel-contents')).toBeVisible()
    await expectAxeClean(a.page, `board with the contents panel ${colorScheme}`)
    await a.page.getByTestId('dock-tab-contents').click()
    await expect(a.page.getByTestId('dock-panel-contents')).toHaveCount(0)

    await a.page.getByTestId('share-button').click()
    await expect(a.page.getByTestId('share-dialog')).toBeVisible()
    await expectAxeClean(a.page, `board with the share dialog ${colorScheme}`)
    await a.page.keyboard.press('Escape')
    await expect(a.page.getByTestId('share-dialog')).toHaveCount(0)

    await a.page.setViewportSize(PHONE)
    await expectAxeClean(a.page, `board 390px ${colorScheme}`)
    await a.page.getByTestId('phone-sheet-open').click()
    await expect(a.page.getByTestId('phone-sheet')).toBeVisible()
    await expectAxeClean(a.page, `board 390px with the Board actions sheet ${colorScheme}`)

    const v = await canvasSession('carol', { role: 'viewer' })
    await v.page.emulateMedia({ colorScheme })
    await waitForA11y(v.page)
    await expectAxeClean(v.page, `board as a viewer ${colorScheme}`)
  })
}

test('axe: the audit finds violations that are planted on the board (so an audit that checks nothing cannot pass)', async ({
  canvasSession,
}) => {
  const a = await canvasSession('alice')
  await waitForA11y(a.page)
  await a.page.evaluate(() => {
    const button = document.createElement('button')
    button.id = 'planted-button'
    document.querySelector('[data-lobby-board-canvas]')?.appendChild(button)
    const image = document.createElement('img')
    image.id = 'planted-image'
    image.src = 'data:image/gif;base64,R0lGODlhAQABAAAAACw='
    document.body.appendChild(image)
  })
  const results = await new AxeBuilder({ page: a.page }).withTags(AXE_TAGS).analyze()
  const found = new Map(results.violations.map((v) => [v.id, v.nodes.map((n) => n.target.join(' '))]))
  expect(found.get('button-name')).toEqual(['#planted-button'])
  expect(found.get('image-alt')).toEqual(['#planted-image'])
  await expect(expectAxeClean(a.page, 'planted')).rejects.toThrow(/axe violations: planted/)
})

test('axe: an accepted "incomplete" result is scoped to its page and reason (planted menu buttons)', async ({
  browser,
  stackReady: _,
}) => {
  const context = await browser.newContext({ viewport: DESKTOP })
  try {
    const page = await context.newPage()
    await page.goto('/signin')
    await expect(page.getByTestId('signin-form')).toBeVisible()
    const plant = (expanded: boolean) =>
      page.evaluate((isExpanded) => {
        document.getElementById('planted-menu')?.remove()
        const button = document.createElement('button')
        button.id = 'planted-menu'
        button.textContent = 'Planted menu'
        button.setAttribute('aria-haspopup', 'menu')
        button.setAttribute('aria-expanded', String(isExpanded))
        button.setAttribute('aria-controls', 'planted-popup-that-is-not-mounted')
        document.body.appendChild(button)
      }, expanded)
    const ariaUndecided = async (label: string) => {
      const results = await new AxeBuilder({ page }).withTags(AXE_TAGS).analyze()
      return (await undecidedFor(page, results, label)).filter((u) => u.startsWith('aria-valid-attr-value'))
    }
    // collapsed: ARIA lets the popup stay unmounted, and axe's reason (controlsWithinPopup) is accepted for a menu
    await plant(false)
    expect(await ariaUndecided('dashboard card menu planted')).toEqual([])
    // the same node on a page the acceptance is not written for is a new thing to look at
    expect(await ariaUndecided('sign-in planted')).toHaveLength(1)
    // expanded, but aria-controls names nothing: the id check refuses it, on the page that does accept the reason
    await plant(true)
    expect(await ariaUndecided('dashboard card menu planted')).toHaveLength(1)
  } finally {
    await context.close()
  }
})
