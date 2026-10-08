// Wave K (K4-1): "Start something", the template row above Recent boards, and the workspace menu that took over
// the Internal only control. Component tests in Node: the row is a plain function of its props, so a test reads
// the tree it returns and presses a tile; the menu uses hooks, so its markup is rendered with react-dom/server.
// The behaviour in a browser (creating a board from a tile and landing on it, the switch in the menu, the shield)
// is e2e/excalidraw/k4-dashboard.spec.ts.
//
// Not here: the acceptance's "cards and the row call prefetchBoardCode() on pointerenter and focus". The lead's
// note for this wave: K1 prefetches the board code itself through document-level delegation, so neither the
// cards nor the row import or call it.
import type { InternalOnlySettings, WorkspaceSummary } from '@draftroom/contracts'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { InternalOnlyState } from './InternalOnly.tsx'
import { StartRow } from './StartRow.tsx'
import {
  START_TILES,
  type StartChoice,
  showStartRow,
  startRowOffered,
  startTiles,
  startTitle,
} from './start-row-model.ts'
import { templateCatalog } from './template-catalog.ts'
import { TEMPLATE_IDS } from './template-paths.ts'
import { byTestId, fire, textOf } from './test-tree.ts'
import { WorkspaceMenu } from './WorkspaceMenu.tsx'

const catalog = templateCatalog()

describe('the tiles of the row', () => {
  it('start with a blank board, the Lobby tour and the four everyday templates, then the six agency ones', () => {
    expect(START_TILES.map((t) => t.choice)).toEqual([
      'blank',
      'lobby-tour',
      'brainstorm',
      'retrospective',
      'mood-board',
      'storyboard',
      'creative-brief',
      'client-feedback',
      'shot-list',
      'launch-timeline',
      'prioritisation-2x2',
      'kanban',
    ])
  })

  it('name every template as the picker does (so a tile reads right before the catalog has loaded)', () => {
    for (const t of START_TILES.filter((t) => t.choice !== 'blank'))
      expect(t.name, t.choice).toBe(catalog.find((e) => e.id === t.choice)?.name)
    expect(START_TILES[0]?.name).toBe('Blank board')
  })

  it('are all real templates (Pitch outline and Production plan stay in the full picker)', () => {
    for (const t of START_TILES) if (t.choice !== 'blank') expect(TEMPLATE_IDS).toContain(t.choice)
    expect(START_TILES.map((t) => t.choice)).not.toContain('pitch-outline')
  })

  it('carry no catalog entry until it has loaded, and then the template it names', () => {
    expect(startTiles(null).every((t) => t.entry === null)).toBe(true)
    const loaded = startTiles(catalog)
    expect(loaded[0]?.entry).toBeNull()
    for (const t of loaded.slice(1)) expect(t.entry?.id, t.choice).toBe(t.choice)
  })

  it('title a new board for its template, or "Untitled board"', () => {
    expect(startTitle(null)).toBe('Untitled board')
    expect(startTitle(catalog.find((e) => e.id === 'kanban') ?? null)).toBe('Kanban columns')
  })
})

describe('who sees the row', () => {
  const base = {
    canCreate: true,
    guest: false,
    section: { kind: 'recent' } as const,
    searching: false,
    pickerHidden: false,
  }

  it('creators on the landing view', () => {
    expect(showStartRow(base)).toBe(true)
  })

  it('not people who cannot create (an outside account, a viewer, a workspace guest), nor a name-only guest', () => {
    expect(showStartRow({ ...base, canCreate: false })).toBe(false)
    expect(showStartRow({ ...base, guest: true })).toBe(false)
    expect(showStartRow({ ...base, canCreate: false, guest: true })).toBe(false)
  })

  it('not off the landing view, nor while searching, nor for someone who asked not to see templates', () => {
    for (const section of [
      { kind: 'all' },
      { kind: 'archived' },
      { kind: 'trash' },
      { kind: 'project', projectId: 'prj_1' },
    ] as const)
      expect(showStartRow({ ...base, section }), section.kind).toBe(false)
    expect(showStartRow({ ...base, searching: true })).toBe(false)
    expect(showStartRow({ ...base, pickerHidden: true })).toBe(false)
  })
})

describe('who is offered the row at all (the What’s new card asks before it talks about it)', () => {
  const base = { canCreate: true, guest: false, pickerHidden: false }

  it('is creators who can make boards here, not a name-only guest, not someone who hid templates', () => {
    expect(startRowOffered(base)).toBe(true)
    expect(startRowOffered({ ...base, canCreate: false })).toBe(false)
    expect(startRowOffered({ ...base, guest: true })).toBe(false)
    expect(startRowOffered({ ...base, pickerHidden: true })).toBe(false)
  })

  it('is exactly what showing the row on the landing view with no search needs, and no more', () => {
    for (const canCreate of [true, false])
      for (const guest of [true, false])
        for (const pickerHidden of [true, false]) {
          const who = { canCreate, guest, pickerHidden }
          const landing = { ...who, section: { kind: 'recent' } as const, searching: false }
          expect(showStartRow(landing), JSON.stringify(who)).toBe(startRowOffered(who))
          // a search or another view hides it for now, for everybody
          expect(showStartRow({ ...landing, searching: true })).toBe(false)
          expect(showStartRow({ ...landing, section: { kind: 'trash' } })).toBe(false)
        }
  })
})

describe('the row', () => {
  const onChoose = vi.fn<(c: StartChoice, e: unknown) => void>()
  const row = StartRow({ tiles: startTiles(catalog), pending: null, onChoose })

  it('is a labelled section titled "Start something" with one button per tile', () => {
    const html = renderToStaticMarkup(row)
    expect(html).toContain('data-testid="start-row"')
    expect(html).toContain('aria-labelledby="dr-start-h"')
    expect(html).toContain('>Start something<')
    expect(byTestId(row, 'start-tile')).toHaveLength(START_TILES.length)
    // each tile shows its template's plan as a thumbnail (an <svg>), the blank board a plus
    expect(html.match(/class="dr-tthumb"/g)?.length).toBe(START_TILES.length - 1)
    for (const t of START_TILES) expect(html).toContain(`>${t.name}<`)
  })

  it('calls the picker’s onChoose with the choice and its catalog entry on one click', () => {
    for (const tile of byTestId(row, 'start-tile')) {
      onChoose.mockClear()
      const choice = tile.props['data-template-id'] as StartChoice
      fire(tile)
      expect(onChoose).toHaveBeenCalledTimes(1)
      expect(onChoose.mock.calls[0]?.[0]).toBe(choice)
      expect((onChoose.mock.calls[0]?.[1] as { id?: string } | null)?.id ?? null).toBe(
        choice === 'blank' ? null : choice,
      )
    }
  })

  it('shows "Creating…" on the tile being made and disables every tile until the board is made', () => {
    const busy = StartRow({ tiles: startTiles(catalog), pending: 'brainstorm', onChoose })
    const tiles = byTestId(busy, 'start-tile')
    expect(tiles.every((t) => t.props.disabled === true)).toBe(true)
    expect(
      tiles.filter((t) => t.props['aria-busy'] === true).map((t) => t.props['data-template-id']),
    ).toEqual(['brainstorm'])
    expect(textOf(tiles.find((t) => t.props['data-template-id'] === 'brainstorm'))).toContain('Creating…')
    expect(textOf(tiles.find((t) => t.props['data-template-id'] === 'kanban'))).toContain('Kanban columns')
    // and an idle row has none disabled
    expect(byTestId(row, 'start-tile').some((t) => t.props.disabled === true)).toBe(false)
  })

  it('renders at once, without the catalog (names and the blank tile; thumbnails follow)', () => {
    const html = renderToStaticMarkup(StartRow({ tiles: startTiles(null), pending: null, onChoose }))
    expect(html).toContain('>Creative brief<')
    expect(html).not.toContain('dr-tthumb')
  })
})

// ---- the workspace menu --------------------------------------------------------------------------------

const ws = (id: string, name: string, role: WorkspaceSummary['role'] = 'owner'): WorkspaceSummary => ({
  id,
  name,
  role,
})

const settings = (over: Partial<InternalOnlySettings> = {}): InternalOnlySettings => ({
  workspace: false,
  projects: [],
  canChange: true,
  canTurnOff: true,
  outsideAccess: null,
  ...over,
})

const state = (s: InternalOnlySettings | null): InternalOnlyState => ({
  settings: s,
  error: null,
  setWorkspace: async () => {},
  setProject: async () => {},
  reload: () => {},
})

const menu = (props: {
  workspaces: WorkspaceSummary[]
  internal: InternalOnlySettings | null
  open?: boolean
  current?: WorkspaceSummary
}) =>
  renderToStaticMarkup(
    createElement(WorkspaceMenu, {
      workspace: props.current ?? ws('wsp_a', 'Dev Studio'),
      workspaces: props.workspaces,
      projects: [],
      internal: state(props.internal),
      defaultOpen: props.open ?? false,
    }),
  )

describe('the workspace menu: where the Internal only control went', () => {
  const one = [ws('wsp_a', 'Dev Studio')]

  it('is closed at first: the tile is the one button, and nothing of the control shows yet', () => {
    const html = menu({ workspaces: one, internal: settings() })
    expect(html).toMatch(/<button[^>]*data-testid="workspace-switcher"[^>]*aria-expanded="false"/)
    expect(html).not.toContain('data-testid="workspace-menu"')
    expect(html).not.toContain('data-testid="internal-only"')
  })

  it('opens onto the switch with every test id it had in the sidebar', () => {
    const html = menu({ workspaces: one, internal: settings(), open: true })
    expect(html).toContain('data-testid="workspace-menu"')
    const panel = html.slice(html.indexOf('data-testid="workspace-menu"'))
    expect(panel).toContain('data-testid="internal-only"')
    expect(panel).toContain('data-on="false"')
    expect(panel).toMatch(/<input[^>]*data-testid="internal-only-switch"/)
    expect(panel).toContain('Internal only')
  })

  it('shows the shield on the tile while the workspace is internal only, and not otherwise', () => {
    const on = menu({ workspaces: one, internal: settings({ workspace: true }) })
    expect(on).toContain('data-testid="workspace-internal-badge"')
    const off = menu({ workspaces: one, internal: settings({ workspace: false }) })
    expect(off).not.toContain('workspace-internal-badge')
    // the badge is on the tile even while the menu is closed, and a project's switch does not raise it
    expect(
      menu({
        workspaces: one,
        internal: settings({ projects: [{ projectId: 'prj_a', internalOnly: true }] }),
      }),
    ).not.toContain('workspace-internal-badge')
  })

  it('names the tile button by the words it shows, the shield included (label in name)', () => {
    const buttonOf = (html: string) => html.slice(html.indexOf('<button'), html.indexOf('</button>'))
    const on = buttonOf(menu({ workspaces: one, internal: settings({ workspace: true }) }))
    // no aria-label that replaces the visible words: the name is what is on the tile
    expect(on).not.toMatch(/^<button[^>]*aria-label=/)
    expect(on).toContain('Dev Studio')
    expect(on).toContain('Workspace · Owner')
    expect(on).toMatch(/role="img"[^>]*aria-label="Internal only"/)
    const off = buttonOf(menu({ workspaces: one, internal: settings({ workspace: false }) }))
    expect(off).not.toMatch(/^<button[^>]*aria-label=/)
    expect(off).not.toContain('Internal only')
    // what the button opens is still said, as its description
    expect(off).toMatch(/^<button[^>]*title="Workspace menu"/)
  })

  it('lists the other workspaces beside the control, and keeps a lone workspace a plain tile', () => {
    const many = [ws('wsp_a', 'Dev Studio'), ws('wsp_b', 'Client Lobby', 'member')]
    const html = menu({ workspaces: many, internal: settings(), open: true })
    expect(html).toContain('>Switch workspace<')
    expect(html).toMatch(/data-testid="workspace-option"[^>]*data-workspace-id="wsp_b"/)
    expect(html).toContain('Client Lobby')
    expect(html).not.toContain('data-workspace-id="wsp_a"')
    // a member of a single workspace with the switch off has nothing to open
    const plain = menu({ workspaces: one, internal: settings({ canChange: false }) })
    expect(plain).toContain('<div class="dr-ws" data-testid="workspace-switcher">')
    expect(plain).not.toContain('<button')
    // a guest (no settings) in a workspace of their own: the same plain tile
    expect(menu({ workspaces: one, internal: null })).toContain('<div class="dr-ws"')
  })

  it('shows a member the state while it is on (read only), and offers the other workspaces without it', () => {
    const html = menu({
      workspaces: [ws('wsp_a', 'Dev Studio', 'member'), ws('wsp_b', 'Other')],
      internal: settings({ canChange: false, canTurnOff: false, workspace: true }),
      current: ws('wsp_a', 'Dev Studio', 'member'),
      open: true,
    })
    expect(html).toContain('data-testid="internal-only-state"')
    expect(html).not.toContain('data-testid="internal-only-switch"')
    expect(html).toContain('data-testid="workspace-internal-badge"')
  })
})
