// An accessibility audit of the Excalidraw board page (owner 3i, docs/EXCALIDRAW-MIGRATION.md §4.8 (4) "axe
// on the board page"). axe-core is not a dependency of this repository (adding it is a lockfile change,
// requested in the wave-3i report), so this spec checks the rules axe would flag first, on the live page:
// every visible control has an accessible name, ids are unique, ARIA id references resolve, images have
// alternative text, the page has one main landmark and a named canvas, and over the canvas only the known
// live regions speak. Run on the desktop board with content and a panel open, and on a phone with the sheet open.
import type { Page } from '@playwright/test'
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
