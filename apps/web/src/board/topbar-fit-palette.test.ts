// W3 (wave M, M3-1): the command palette's "Search or do… Ctrl+K" in the board's top bar folds into the "⋯" menu at narrow
// widths, and keeps its magnifier alone before the bar moves anything. It is a topBar registry item of the command-palette
// feature (not pinned), so it follows the bar's own plan for feature controls (./topbar-fit.ts `topBarPlan`, the chrome's
// `topBarItems`). The button's name, its key hint and what it runs are in the e2e (m3-palette-entry.spec.ts).
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import {
  type CanvasFeatureContext,
  createFeatureRegistries,
  type FeatureRegistries,
} from '../canvas/api/index.ts'
import { topBarItems } from '../canvas/board/chrome.tsx'
import { COMMAND_PALETTE_TOPBAR_ID } from '../features/command-palette/ids.ts'
import { feature as paletteFeature } from '../features/command-palette/index.tsx'
import { barWidthAt, COMPACT_STEPS, compactValue, topBarPlan } from './topbar-fit.ts'

/** The registries of a board page that has only the palette and two other top-bar items: a pinned one and a plain one. */
function registries(): FeatureRegistries {
  const r = createFeatureRegistries()
  for (const t of paletteFeature.topBar ?? []) r.topBar.register(t)
  r.topBar.register({
    id: 'people',
    order: 10,
    pinned: true,
    component: () => createElement('i', { 'data-t': 'people' }),
  })
  r.topBar.register({
    id: 'present',
    order: 30,
    component: () => createElement('i', { 'data-t': 'present' }),
  })
  return r
}

const ctxOf = (r: FeatureRegistries) =>
  ({
    registries: r,
    board: { id: 'brd_test', status: 'active' },
    canvas: { selection: [], readOnly: () => false },
    me: { user: { id: 'usr_test' } },
  }) as unknown as CanvasFeatureContext

describe('the palette entry in the top bar (M3-1)', () => {
  it('is a registered top-bar item, not pinned: the bar folds it with the feature controls', () => {
    const item = registries().topBar.get(COMMAND_PALETTE_TOPBAR_ID)
    expect(item).toBeDefined()
    expect(item?.pinned).not.toBe(true)
    expect(item?.overflowCaption).toBe('Search')
  })

  it('stays in the bar at a wide width and moves to the "⋯" menu on a tablet, a phone and a crowded bar', () => {
    const r = registries()
    const wide = topBarPlan(barWidthAt(1440))
    expect(wide.bar).toContain('features')
    expect(wide.menu).not.toContain('features')
    for (const plan of [topBarPlan(barWidthAt(768)), topBarPlan(barWidthAt(390)), topBarPlan('wide', true)]) {
      expect(plan.bar).not.toContain('features')
      expect(plan.menu).toContain('features')
    }
    // what the chrome puts where: 'all' (a wide bar), 'pinned' (the bar of a folded layout), 'overflow' (its menu rows)
    const html = (mode: 'all' | 'pinned' | 'overflow') =>
      renderToStaticMarkup(createElement('div', null, topBarItems(ctxOf(r), mode)))
    expect(html('all')).toContain('data-testid="topbar-palette"')
    expect(html('pinned')).not.toContain('data-testid="topbar-palette"')
    expect(html('pinned')).toContain('data-t="people"')
    const menu = html('overflow')
    expect(menu).toContain('data-testid="topbar-palette"')
    expect(menu).toContain('data-t="present"')
    // the menu row has its own caption
    expect(menu).toContain('Search')
  })

  it('shows the magnifier alone first: its compact step comes before the Feedback pill’s and the title’s', () => {
    expect(COMPACT_STEPS).toContain('palette')
    expect(COMPACT_STEPS.indexOf('palette')).toBeLessThan(COMPACT_STEPS.indexOf('feedback'))
    expect(COMPACT_STEPS.indexOf('palette')).toBeLessThan(COMPACT_STEPS.indexOf('crumb'))
    // each level keeps the ones before it
    const level = COMPACT_STEPS.indexOf('palette') + 1
    expect(compactValue(level).split(' ')).toContain('palette')
    expect(compactValue(level - 1).split(' ')).not.toContain('palette')
  })
})
