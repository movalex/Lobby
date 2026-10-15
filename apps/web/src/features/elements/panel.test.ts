// Wave Q (WS3): the Elements panel rendered to markup in Node (no DOM): a workspace member gets the Icons, Shapes and
// Library tabs, a name-only guest and a workspace guest Icons and Shapes only; the search box is a combobox over a
// listbox of options; the Shapes tab lists every built-in shape as a draggable option; a viewer's tiles are disabled.
import { PIECES } from '@draftroom/templates/pieces/catalog'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it } from 'vitest'
import type { CanvasFeatureContext } from '../../canvas/api/index.ts'
import { fakeCanvas, fakeCtx } from '../sort/test-kit.ts'
import { resetLibraryClient } from './client.ts'
import { ElementsPanel } from './ElementsPanel.tsx'
import { elementsState } from './state.ts'
import { TEST_WORKSPACE } from './test-kit.ts'

const me = (role: string | null) => ({
  user: { id: 'usr_alice0123456789', name: 'Alice' },
  workspaces: role ? [{ id: TEST_WORKSPACE, name: 'DBC', role }] : [],
  access: { creator: true, reason: 'domain', email: 'alice@darkburn.com' },
})

type Tab = 'icons' | 'shapes' | 'library'

function render(role: string | null, opts: { readOnly?: boolean; tab?: Tab } = {}) {
  const f = fakeCanvas([], { readOnly: opts.readOnly })
  const { ctx } = fakeCtx(f.canvas, {
    me: me(role) as unknown as CanvasFeatureContext['me'],
    workspace: { id: TEST_WORKSPACE, name: 'DBC' },
  })
  if (opts.tab) elementsState(f.canvas).requestedTab.set(opts.tab)
  return renderToStaticMarkup(createElement(ElementsPanel, { ctx, close: () => {} }))
}

const tabsOf = (m: string) => [...m.matchAll(/role="tab"[^>]*data-tab="([a-z]+)"/g)].map((x) => x[1])
const options = (m: string) => [...m.matchAll(/<div [^>]*role="option"[^>]*>/g)].map((x) => x[0])

afterEach(() => resetLibraryClient())

describe('the Elements panel', () => {
  it('offers the Library tab to a workspace member, never to a guest or a stranger to the workspace', () => {
    expect(tabsOf(render('member'))).toEqual(['icons', 'shapes', 'library'])
    expect(tabsOf(render('guest'))).toEqual(['icons', 'shapes'])
    expect(tabsOf(render(null))).toEqual(['icons', 'shapes'])
    expect(render(null)).toContain('placeholder="Search icons and shapes"')
    expect(render('member')).toContain('placeholder="Search icons, shapes and the library"')
  })

  it('is a combobox over a listbox; the Shapes tab lists every built-in shape as a draggable option', () => {
    const m = render('member', { tab: 'shapes' })
    expect(m).toContain('role="combobox"')
    expect(m).toContain('role="listbox"')
    expect(m).toMatch(/role="tab"[^>]*aria-selected="true"[^>]*data-tab="shapes"/)
    const opts = options(m)
    expect(opts).toHaveLength(PIECES.length)
    expect(opts.every((o) => o.includes('draggable="true"') && o.includes('data-source="piece"'))).toBe(true)
    expect(opts.filter((o) => o.includes('aria-selected="true"'))).toHaveLength(1)
    // the combobox points at the active option
    const active = /aria-activedescendant="([^"]+)"/.exec(m)?.[1]
    expect(active && opts[0]?.includes(`id="${active}"`)).toBe(true)
    expect(m).toContain('data-testid="element-options"')
    expect(m).toContain('Insert options')
  })

  it('a read-only canvas shows its tiles disabled and says why', () => {
    const m = render('member', { tab: 'shapes', readOnly: true })
    expect(m).toContain('You can view this board but not add to it.')
    const off = (o: string) => o.includes('aria-disabled="true"') && o.includes('draggable="false"')
    expect(options(m).every(off)).toBe(true)
  })

  it('the Icons tab says it is loading before the icons are in', () => {
    expect(render('member', { tab: 'icons' })).toContain('Loading icons…')
  })
})
