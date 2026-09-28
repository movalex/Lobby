// Integration check across ALL board features (integration owner): the keyboard map tldraw 5.4.2 ends
// up with after every feature's overrides run in registry order, the tldraw component slots they
// replace, and the options they set. A key bound twice, or a component slot claimed by two features,
// fails here instead of silently losing one binding at runtime.
//
// tldraw's default kbd table is parsed from the installed sources on every run (not copied), so a
// tldraw upgrade that adds a colliding default key is caught too.

import { readFileSync } from 'node:fs'
import type { Editor, TLUiActionsContextType, TLUiOverrideHelpers, TLUiToolsContextType } from 'tldraw'
import { describe, expect, it } from 'vitest'
import { chordsOf, findKbdConflicts, type KbdItem } from './canvas-ux/shortcuts.ts'
import { mergeFeatureProps } from './FeatureHost.tsx'
import { BOARD_FEATURES } from './registry.ts'

const TLDRAW_UI = new URL('../../node_modules/tldraw/src/lib/ui/', import.meta.url)

/** `id: '…'` … `kbd: '…'` pairs from one tldraw source file (the kbd belongs to the nearest id above). */
function parseDefaults(file: string): Record<string, string> {
  const out: Record<string, string> = {}
  let id: string | null = null
  for (const line of readFileSync(new URL(file, TLDRAW_UI), 'utf8').split(/\r?\n/)) {
    const idMatch = /^\s*id: '([^']+)',?\s*$/.exec(line)
    if (idMatch) id = idMatch[1] ?? null
    if (/^\s*id: geo,\s*$/.test(line)) id = 'geo'
    const kbd = /^\s*kbd: '([^']*)',?\s*$/.exec(line)
    if (kbd && id) out[id] = kbd[1] ?? ''
    // useTools: `kbd: geo === 'rectangle' ? 'r' : geo === 'ellipse' ? 'o' : undefined`
    if (id === 'geo' && /^\s*kbd: geo === 'rectangle' \? 'r' : geo === 'ellipse' \? 'o'/.test(line)) {
      out.rectangle = 'r'
      out.ellipse = 'o'
    }
  }
  return out
}

const TLDRAW_ACTION_KBDS = parseDefaults('context/actions.tsx')
const TLDRAW_TOOL_KBDS = parseDefaults('hooks/useTools.tsx')

// useKeyboardShortcuts registers neither of these: clipboard keys come from native events, 'asset'
// shares Ctrl/Cmd+U with insert-media, and a tool named 'comment' only gets its key when tldraw's
// licensed commenting is on (comments binds C through its own action instead).
const NEVER_REGISTERED = ['copy', 'cut', 'paste', 'asset', 'comment']

/** An editor stand-in: overrides only capture it in onSelect closures (and lazy computeds). */
const editorStub = new Proxy(
  {},
  {
    get: (_t, prop) => (prop === 'then' ? undefined : () => undefined),
  },
) as unknown as Editor
const helpersStub = new Proxy({}, { get: () => () => undefined }) as unknown as TLUiOverrideHelpers

type Item = KbdItem & { readonlyOk?: boolean; onSelect(): void }
const seed = (m: Record<string, string>) =>
  Object.fromEntries(Object.entries(m).map(([id, kbd]) => [id, { id, kbd, onSelect() {} } satisfies Item]))

function mergedMap() {
  let actions = seed(TLDRAW_ACTION_KBDS) as unknown as TLUiActionsContextType
  let tools = seed(TLDRAW_TOOL_KBDS) as unknown as TLUiToolsContextType
  const owner = new Map<string, string>()
  for (const f of BOARD_FEATURES) {
    const before = new Map(
      [...Object.values(actions), ...Object.values(tools)].map((i) => [i.id, i.kbd] as const),
    )
    if (f.overrides?.actions) actions = f.overrides.actions(editorStub, { ...actions }, helpersStub)
    if (f.overrides?.tools) tools = f.overrides.tools(editorStub, { ...tools }, helpersStub)
    for (const i of [...Object.values(actions), ...Object.values(tools)])
      if (before.get(i.id) !== i.kbd) owner.set(i.id, f.id)
  }
  const all = [...Object.values(actions), ...Object.values(tools)] as Item[]
  return { actions, tools, all, owner }
}

const registered = (readonly: boolean) =>
  mergedMap().all.filter((i) => i.kbd && !NEVER_REGISTERED.includes(i.id) && (!readonly || i.readonlyOk))

const idsFor = (chord: string, readonly = false) =>
  registered(readonly)
    .filter((i) => chordsOf(i.kbd).includes(chord))
    .map((i) => i.id)

describe('tldraw 5.4.2 default key table (parsed from node_modules)', () => {
  it('was found', () => {
    // Sanity: a parser that silently found nothing would make every check below vacuous.
    expect(Object.keys(TLDRAW_ACTION_KBDS).length).toBeGreaterThanOrEqual(55)
    expect(TLDRAW_ACTION_KBDS['toggle-lock']).toBe('shift+l')
    expect(TLDRAW_ACTION_KBDS['copy-as-png']).toBe('cmd+shift+c,ctrl+shift+c')
    expect(TLDRAW_TOOL_KBDS).toMatchObject({ select: 'v', arrow: 'a', line: 'l', rectangle: 'r', note: 'n' })
  })
})

describe('keyboard map after every feature override (registry order)', () => {
  it('binds no chord to two actions or tools (editable board)', () => {
    expect(registered(false).length).toBeGreaterThan(70)
    expect([...findKbdConflicts(registered(false), [])]).toEqual([])
    // The detector itself works on this merged list: a planted duplicate of M is reported.
    const planted = [...registered(false), { id: 'x-planted', kbd: 'm', onSelect() {} }]
    expect(findKbdConflicts(planted, []).get('m')).toEqual(['dr-toggle-minimap', 'x-planted'])
  })

  it('binds no chord to two actions or tools (read-only board: viewers, commenters)', () => {
    expect([...findKbdConflicts(registered(true), [])]).toEqual([])
  })

  it('lists exactly the bindings features add or change (update docs/FEATURES-M2-CONTRACTS.md with it)', () => {
    const { all, owner } = mergedMap()
    const changed = Object.fromEntries(
      all
        .filter((i) => owner.has(i.id))
        .map((i) => [i.id, `${owner.get(i.id)}: ${i.kbd ?? '(none)'}`])
        .sort(([a], [b]) => String(a).localeCompare(String(b))),
    )
    expect(changed).toEqual({
      arrow: 'canvas-ux: l,a',
      'bring-forward': 'canvas-ux: shift+[[PgUp]],shift+pageup,alt+]',
      'bring-to-front': 'canvas-ux: [[PgUp]],pageup,]',
      comment: 'comments: c',
      'dr-arrange-grid': 'canvas-ux: alt+shift+g',
      'dr-board-search': 'canvas-ux: cmd+f,ctrl+f',
      'dr-comments-select-tool': 'comments: c',
      'dr-comments-toggle-pins': 'comments: shift+c',
      'dr-present': 'present-export: cmd+alt+[[Enter]],cmd+alt+enter,ctrl+alt+enter',
      'dr-toggle-minimap': 'canvas-ux: m',
      draw: 'canvas-ux: p,d,b,x',
      line: 'canvas-ux: (none)',
      'send-backward': 'canvas-ux: shift+[[PgDn]],shift+pagedown,alt+[',
      'send-to-back': 'canvas-ux: [[PgDn]],pagedown,[',
      'toggle-lock': 'canvas-ux: cmd+shift+l,ctrl+shift+l',
      'zoom-to-100': 'canvas-ux: cmd+0,ctrl+0,shift+0',
      'zoom-to-fit': 'canvas-ux: alt+1,shift+1',
      'zoom-to-selection': 'canvas-ux: alt+2,shift+2',
    })
  })

  it('routes each Miro key to the owning feature', () => {
    expect(idsFor('c')).toEqual(['dr-comments-select-tool'])
    expect(idsFor('c', true)).toEqual(['dr-comments-select-tool']) // commenters on a read-only canvas
    expect(idsFor('shift+c', true)).toEqual(['dr-comments-toggle-pins'])
    expect(idsFor('ctrl+alt+enter', true)).toEqual(['dr-present'])
    expect(idsFor('meta+alt+enter', true)).toEqual(['dr-present'])
    expect(idsFor('ctrl+shift+c')).toEqual(['copy-as-png']) // present-export reroutes its onSelect
    expect(idsFor('ctrl+p')).toEqual(['print']) // present-export: opens the PDF export
    expect(idsFor('ctrl+f', true)).toEqual(['dr-board-search'])
    expect(idsFor('m', true)).toEqual(['dr-toggle-minimap'])
    expect(idsFor('l')).toEqual(['arrow'])
    expect(idsFor('p')).toEqual(['draw'])
    expect(idsFor('ctrl+shift+l')).toEqual(['toggle-lock'])
    expect(idsFor('shift+l')).toEqual([])
    // Plain Enter variants stay tldraw's.
    expect(idsFor('ctrl+enter')).toEqual(['adjust-shape-styles'])
    // MAK-18: arrange as grid, editable boards only (a viewer's Alt+Shift+G does nothing).
    expect(idsFor('alt+shift+g')).toEqual(['dr-arrange-grid'])
    expect(idsFor('alt+shift+g', true)).toEqual([])
  })

  it('the second-wave canvas-ux actions exist; only arrange-as-grid has a key; edits are editor-only', () => {
    const { actions } = mergedMap()
    const pick = (id: string) => (actions as Record<string, Item | undefined>)[id]
    for (const id of [
      'dr-arrange-grid',
      'dr-go-to-start-view',
      'dr-set-start-view',
      'dr-set-frame-start-view',
      'dr-clear-start-view',
      'dr-toggle-note-authors',
    ]) {
      expect(pick(id)?.id).toBe(id)
    }
    for (const id of [
      'dr-go-to-start-view',
      'dr-set-start-view',
      'dr-clear-start-view',
      'dr-toggle-note-authors',
    ])
      expect(pick(id)?.kbd).toBeUndefined()
    expect(pick('dr-go-to-start-view')?.readonlyOk).toBe(true)
    for (const id of [
      'dr-arrange-grid',
      'dr-set-start-view',
      'dr-clear-start-view',
      'dr-toggle-note-authors',
    ])
      expect(pick(id)?.readonlyOk).toBe(false)
  })
})

describe('tldraw component slots and options', () => {
  it('no two features replace the same component, and none replaces the board page base slots', () => {
    const claims = new Map<string, string[]>()
    for (const f of BOARD_FEATURES)
      for (const key of Object.keys(f.components ?? {})) claims.set(key, [...(claims.get(key) ?? []), f.id])
    for (const base of ['SharePanel', 'InFrontOfTheCanvas'])
      claims.set(base, ['board-page', ...(claims.get(base) ?? [])])
    expect([...claims].filter(([, owners]) => owners.length > 1)).toEqual([])
    expect(Object.fromEntries(claims)).toEqual({
      CollaboratorCursor: ['present-export'],
      ContextMenu: ['canvas-ux'],
      InFrontOfTheCanvas: ['board-page'],
      KeyboardShortcutsDialog: ['canvas-ux'],
      MainMenu: ['canvas-ux'],
      NavigationPanel: ['canvas-ux'],
      // Wave 4 tags: chips inside each note / file card, and the "Show only" filter's attribute.
      ShapeWrapper: ['tags'],
      SharePanel: ['board-page'],
      StylePanel: ['canvas-ux'],
      Toolbar: ['canvas-ux'],
    })
  })

  it('no two features set the same option; the shape cap is raised above tldraw 4,000', () => {
    const seen = new Map<string, string[]>()
    for (const f of BOARD_FEATURES)
      for (const key of Object.keys(f.options ?? {})) seen.set(key, [...(seen.get(key) ?? []), f.id])
    expect([...seen].filter(([, owners]) => owners.length > 1)).toEqual([])
    const merged = mergeFeatureProps(BOARD_FEATURES, { overrides: {}, components: {} })
    expect(merged.options.maxShapesPerPage).toBeGreaterThanOrEqual(10_000)
  })

  it('lists exactly the tldraw options features set, with their owners', () => {
    const owners = Object.fromEntries(
      BOARD_FEATURES.flatMap((f) => Object.keys(f.options ?? {}).map((key) => [key, f.id])).sort(([a], [b]) =>
        String(a).localeCompare(String(b)),
      ),
    )
    expect(owners).toEqual({
      cameraMovingTimeoutMs: 'canvas-ux',
      createTextOnCanvasDoubleClick: 'canvas-ux',
      maxShapesPerPage: 'canvas-ux',
    })
    const { options } = mergeFeatureProps(BOARD_FEATURES, { overrides: {}, components: {} })
    // PERF-04: one slow frame (tldraw's default window is 64 ms) no longer flips the camera to idle
    // mid-gesture.
    expect(options.cameraMovingTimeoutMs).toBeGreaterThanOrEqual(250)
    expect(options.cameraMovingTimeoutMs).toBeLessThanOrEqual(300)
    // RETRO-21b (COL-09): double-click on empty canvas makes a note (canvas-ux), not a text box.
    expect(options.createTextOnCanvasDoubleClick).toBe(false)
  })

  it('dock panel ids are unique across features', () => {
    const ids = BOARD_FEATURES.flatMap((f) => (f.panels ?? []).map((p) => p.id))
    expect(new Set(ids).size).toBe(ids.length)
    expect(ids.sort()).toEqual([
      'comments',
      'frames',
      'history',
      'private-notes', // workshops: private brainstorming (wave 3)
      'search',
      'tags', // tags: the board's tags, "Show only", create / rename / colour / delete (wave 4)
      'templates',
      'voting',
    ])
  })
})
