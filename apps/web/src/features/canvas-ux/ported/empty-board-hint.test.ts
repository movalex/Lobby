// K2-4 (wave K, UXD-03): the empty board's "start here" card and dot grid. Rendered to static markup with a fake
// canvas (no DOM in the unit tests); the e2e half is e2e/excalidraw/k2-empty-board.spec.ts.
import { readFileSync } from 'node:fs'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import {
  type CanvasFeatureContext,
  type CommandSpec,
  createFeatureRegistries,
  type MenuEntrySpec,
  markRoomReady,
} from '../../../canvas/api/index.ts'
import {
  AI_IDEAS_ID,
  boardLooksEmpty,
  EmptyBoardGrid,
  EmptyBoardHint,
  GRID_MIN_SCREEN,
  GRID_STEP,
  gridLayout,
  hintActions,
  MINDMAP_START_ID,
} from './EmptyBoardHint.tsx'
import { feature } from './index.tsx'
import { TEMPLATES_PANEL } from './Toolbar.tsx'

function fakeCtx(opts: { items?: number; readOnly?: boolean; ready?: boolean } = {}) {
  const registries = createFeatureRegistries()
  const opened: (string | null)[] = []
  const canvas = {
    items: () => Array.from({ length: opts.items ?? 0 }, (_, i) => ({ id: `e${i}`, type: 'rectangle' })),
    readOnly: () => opts.readOnly ?? false,
    viewport: { get: () => ({ x: -100, y: -50, width: 1000, height: 800, zoom: 1 }) },
  }
  // the board session marks the first welcome and its catch-up (K.1); a fake board is all there unless told not
  if (opts.ready !== false) markRoomReady(canvas)
  const ctx = {
    canvas,
    registries,
    openPanel: (id: string | null) => opened.push(id),
  } as unknown as CanvasFeatureContext
  return { ctx, registries, opened }
}

const panel = { id: TEMPLATES_PANEL, label: 'Templates', icon: () => null, order: 1, component: () => null }
const command = (id: string, run = vi.fn(), enabled?: () => boolean): CommandSpec => ({
  id,
  label: id,
  run,
  ...(enabled ? { enabled } : {}),
})

const html = (ctx: CanvasFeatureContext) => renderToStaticMarkup(createElement(EmptyBoardHint, { ctx }))

describe('the empty board hint (K2-4)', () => {
  it('K.1: nothing before the room’s first welcome and its catch-up, so a populated board never flashes it', () => {
    const { ctx } = fakeCtx({ ready: false })
    expect(html(ctx)).toBe('')
    expect(renderToStaticMarkup(createElement(EmptyBoardGrid, { ctx }))).toBe('')
    markRoomReady(ctx.canvas)
    expect(html(ctx)).toContain('data-testid="empty-board-hint"')
  })

  it('shows only while the board has no element, for people who can edit', () => {
    const { ctx, registries } = fakeCtx({ items: 0 })
    registries.panels.register(panel as never)
    const out = html(ctx)
    expect(out).toContain('data-testid="empty-board-hint"')
    expect(out).toContain('Start your board')
    expect(out).toContain('Double-click to add a sticky note')
    expect(out).toContain('data-testid="empty-hint-templates"')
  })

  it('hides on the first element', () => {
    const { ctx, registries } = fakeCtx({ items: 1 })
    registries.panels.register(panel as never)
    expect(html(ctx)).toBe('')
    expect(renderToStaticMarkup(createElement(EmptyBoardGrid, { ctx }))).toBe('')
  })

  it('a board opened with a template to insert (?template=) shows nothing while it is still empty', () => {
    vi.stubGlobal('location', { search: '?template=retro' })
    try {
      const { ctx } = fakeCtx({ items: 0 })
      expect(html(ctx)).toBe('')
      expect(renderToStaticMarkup(createElement(EmptyBoardGrid, { ctx }))).toBe('')
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('K.1: once the first view drops ?template= (its insert failed), the card shows without anything else changing', async () => {
    const { computed, subscribeValue } = await import('../../../lib/signals.ts')
    const { startParamsDropped } = await import('./navigation/start-view.ts')
    const loc = { search: '?template=retro' }
    vi.stubGlobal('location', loc)
    try {
      const { ctx } = fakeCtx({ items: 0 })
      const empty = computed('test-empty', () => boardLooksEmpty(ctx))
      let changes = 0
      const off = subscribeValue(empty, () => changes++)
      expect(empty.get()).toBe(false)
      // the first view drops the param (history.replaceState) and says so
      loc.search = ''
      startParamsDropped.set(startParamsDropped.get() + 1)
      expect(empty.get()).toBe(true)
      expect(changes).toBeGreaterThan(0)
      off()
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('a viewer (or a commenter) gets one read-only line and no buttons', () => {
    const { ctx, registries } = fakeCtx({ readOnly: true })
    registries.panels.register(panel as never)
    registries.commands.register(command(MINDMAP_START_ID))
    const out = html(ctx)
    expect(out).toContain('data-readonly="true"')
    expect(out).toContain('Nothing on this board yet.')
    expect(out).not.toContain('<button')
  })

  it('its buttons dispatch the existing ids: the templates panel, the mind map command, AI ideas', () => {
    const { ctx, registries, opened } = fakeCtx()
    registries.panels.register(panel as never)
    const mindmap = vi.fn()
    const ideas = vi.fn()
    registries.commands.register(command(MINDMAP_START_ID, mindmap))
    registries.commands.register(command(AI_IDEAS_ID, ideas, () => true))
    const actions = hintActions(ctx)
    expect(actions.map((a) => a.label)).toEqual(['Browse templates', 'Start a mind map', 'Ideas with AI'])
    for (const a of actions) a.run()
    expect(opened).toEqual([TEMPLATES_PANEL])
    expect(mindmap).toHaveBeenCalledTimes(1)
    expect(ideas).toHaveBeenCalledTimes(1)
  })

  it('"Ideas with AI" only when the AI status says enabled (the command’s enabled)', () => {
    const { ctx, registries } = fakeCtx()
    registries.commands.register(command(AI_IDEAS_ID, vi.fn(), () => false))
    expect(hintActions(ctx).map((a) => a.id)).toEqual([])
    expect(html(ctx)).not.toContain('empty-hint-ai')
  })

  it('without an AI command it uses the AI menu’s own "ai.ideas" entry, when that entry is visible', () => {
    const run = vi.fn()
    let on = false
    const entry: MenuEntrySpec = {
      id: 'ai',
      group: 'ai',
      order: 1,
      label: 'AI',
      submenu: [{ id: AI_IDEAS_ID, group: 'ai', order: 4, label: 'Generate ideas…', visible: () => on, run }],
    } as MenuEntrySpec
    const { ctx, registries } = fakeCtx()
    registries.contextMenu.register(entry)
    expect(hintActions(ctx).some((a) => a.id === 'ai')).toBe(false)
    on = true
    const ai = hintActions(ctx).find((a) => a.id === 'ai')
    expect(ai?.label).toBe('Ideas with AI')
    ai?.run()
    // at the middle of the view, nothing selected
    expect(run).toHaveBeenCalledWith(ctx, { ids: [], point: { x: 400, y: 350 }, hit: null })
  })

  it('the buttons are the only pointer-active parts: both layers take no pointer events, the card neither', () => {
    const overlays = feature.overlays ?? []
    for (const id of ['canvas-ux.empty-grid', 'canvas-ux.empty-hint'])
      expect(overlays.find((o) => o.id === id)?.pointer, id).toBe('none')
    const css = readFileSync(new URL('../canvas-ux.css', import.meta.url), 'utf8')
    const rule = (sel: string) =>
      new RegExp(`${sel.replace(/[.]/g, '\\.')}\\s*\\{[^}]*pointer-events:\\s*(\\w+)`)
    expect(rule('.cux-empty-hint').exec(css)?.[1]).toBe('none')
    expect(rule('.cux-empty-grid').exec(css)?.[1]).toBe('none')
    expect(rule('.cux-empty-hint__btn').exec(css)?.[1]).toBe('auto')
  })
})

describe('the dot grid (K2-4)', () => {
  it('pans and zooms with the camera', () => {
    expect(gridLayout({ x: 0, y: 0, zoom: 1 })).toEqual({ size: GRID_STEP, offsetX: 0, offsetY: 0 })
    const g = gridLayout({ x: 10, y: -5, zoom: 2 })
    expect(g.size).toBe(GRID_STEP * 2)
    expect(g.offsetX).toBeCloseTo(GRID_STEP * 2 - 20)
    expect(g.offsetY).toBeCloseTo(10)
  })

  it('zoomed out, the step doubles so dots never crowd closer than the minimum', () => {
    for (const zoom of [0.1, 0.25, 0.4, 0.5, 0.58]) {
      const g = gridLayout({ x: 0, y: 0, zoom })
      expect(g.size, String(zoom)).toBeGreaterThanOrEqual(GRID_MIN_SCREEN)
      expect(g.size, String(zoom)).toBeLessThan(GRID_MIN_SCREEN * 2)
    }
  })

  it('renders on an empty board with the camera’s step and offset', () => {
    const { ctx } = fakeCtx()
    const out = renderToStaticMarkup(createElement(EmptyBoardGrid, { ctx }))
    expect(out).toContain('data-testid="empty-board-grid"')
    expect(out).toContain('background-size:24px 24px')
    expect(out).toContain('background-position:4px 2px')
  })
})
