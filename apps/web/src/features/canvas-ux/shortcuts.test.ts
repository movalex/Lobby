import { describe, expect, it } from 'vitest'
import {
  ACTION_KBD_OVERRIDES,
  applyKbdOverrides,
  chordsOf,
  findKbdConflicts,
  type KbdItem,
  kbdLabel,
  NEW_ACTION_KBDS,
  RESERVED_FOR_OTHER_FEATURES,
  splitKbd,
  TOOL_KBD_OVERRIDES,
} from './shortcuts.ts'

// Every `kbd` tldraw 5.4.2 registers by default, copied from tldraw/src/lib/ui/context/actions.tsx and
// ui/hooks/useTools.tsx (extracted with awk; re-extract when upgrading tldraw).
const TLDRAW_ACTIONS: Record<string, string> = {
  'insert-embed': 'cmd+i,ctrl+i',
  'open-kbd-shortcuts': 'cmd+alt+/,ctrl+alt+/',
  'insert-media': 'cmd+u,ctrl+u',
  undo: 'cmd+z,ctrl+z',
  redo: 'cmd+shift+z,ctrl+shift+z',
  'copy-as-png': 'cmd+shift+c,ctrl+shift+c',
  'select-zoom-tool': 'z, !z',
  duplicate: 'cmd+d,ctrl+d',
  ungroup: 'cmd+shift+g,ctrl+shift+g',
  group: 'cmd+g,ctrl+g',
  'frame-selection': 'cmd+alt+g,ctrl+alt+g',
  'align-left': 'alt+A',
  'align-center-horizontal': 'alt+H',
  'align-right': 'alt+D',
  'align-center-vertical': 'alt+V',
  'align-top': 'alt+W',
  'align-bottom': 'alt+S',
  'distribute-horizontal': 'alt+shift+h',
  'distribute-vertical': 'alt+shift+V',
  'flip-horizontal': 'shift+h',
  'flip-vertical': 'shift+v',
  'bring-to-front': ']',
  'bring-forward': 'alt+]',
  'send-backward': 'alt+[',
  'send-to-back': '[',
  cut: 'cmd+x,ctrl+x',
  copy: 'cmd+c,ctrl+c',
  paste: 'cmd+v,ctrl+v',
  'paste-at-cursor': '$?v',
  'paste-plain-text-at-cursor': '$!?v',
  'select-all': 'cmd+a,ctrl+a',
  delete: '⌫,del',
  'rotate-cw': 'shift+.,shift+alt+.',
  'rotate-ccw': 'shift+,,shift+alt+,',
  'zoom-in': 'cmd+=,ctrl+=,=',
  'zoom-in-on-cursor': 'shift+cmd+=,shift+ctrl+=,shift+=',
  'zoom-out': 'cmd+-,ctrl+-,-',
  'zoom-out-on-cursor': 'shift+cmd+-,shift+ctrl+-,shift+-',
  'zoom-to-100': 'shift+0',
  'zoom-to-fit': 'shift+1',
  'zoom-to-selection': 'shift+2',
  'toggle-dark-mode': 'cmd+/,ctrl+/',
  'toggle-tool-lock': 'q',
  'toggle-focus-mode': 'cmd+.,ctrl+.',
  'toggle-grid': "cmd+',ctrl+'",
  print: 'cmd+p,ctrl+p',
  'toggle-lock': 'shift+l',
  'select-white-color': 'alt+t',
  'select-fill-fill': 'alt+f',
  'select-fill-lined-fill': 'alt+shift+f',
  'flatten-to-image': 'shift+f',
  'select-geo-tool': 'g',
  'change-page-prev': 'alt+left,alt+up',
  'change-page-next': 'alt+right,alt+down',
  'adjust-shape-styles': 'cmd+Enter,ctrl+Enter',
  'a11y-open-context-menu': 'cmd+shift+Enter,ctrl+shift+Enter',
  'enlarge-shapes': 'cmd+alt+shift+=,ctrl+alt+shift+=',
  'shrink-shapes': 'cmd+alt+shift+-,ctrl+alt+shift+-',
  'a11y-repeat-shape-announce': 'alt+r',
  'copy-hovered-styles': 'shift+q',
  'open-cursor-chat': '/',
}
const TLDRAW_TOOLS: Record<string, string> = {
  select: 'v',
  hand: 'h',
  eraser: 'e',
  draw: 'd,b,x',
  rectangle: 'r',
  ellipse: 'o',
  arrow: 'a',
  line: 'l',
  frame: 'f',
  text: 't',
  asset: 'cmd+u,ctrl+u',
  note: 'n',
  laser: 'k',
  highlight: 'shift+d',
}

const asItems = (m: Record<string, string>) =>
  Object.fromEntries(Object.entries(m).map(([id, kbd]) => [id, { id, kbd } as KbdItem]))

function merged() {
  const actions = applyKbdOverrides(asItems(TLDRAW_ACTIONS), ACTION_KBD_OVERRIDES)
  const tools = applyKbdOverrides(asItems(TLDRAW_TOOLS), TOOL_KBD_OVERRIDES)
  const added = Object.entries(NEW_ACTION_KBDS).map(([id, kbd]) => ({ id, kbd }))
  return {
    actions,
    tools,
    all: [...Object.values(actions.items), ...Object.values(tools.items), ...added],
  }
}

const idsFor = (chord: string) =>
  merged()
    .all.filter((i) => chordsOf(i.kbd).includes(chord))
    .map((i) => i.id)

describe('chordsOf (tldraw kbd syntax)', () => {
  it('normalizes modifiers and aliases', () => {
    expect(chordsOf('cmd+shift+l,ctrl+shift+l')).toEqual(['meta+shift+l', 'ctrl+shift+l'])
    expect(chordsOf('⌫,del')).toEqual(['backspace', 'delete'])
    expect(chordsOf('alt+A')).toEqual(['alt+a'])
  })
  it('expands legacy $ ? ! symbols', () => {
    expect(chordsOf('$?v')).toEqual(['meta+alt+v', 'ctrl+alt+v'])
    expect(chordsOf('z, !z')).toEqual(['z', 'shift+z'])
  })
  it('keeps a literal comma key', () => {
    expect(splitKbd('shift+,,shift+alt+,')).toEqual(['shift+,', 'shift+alt+,'])
    expect(chordsOf('shift+,,shift+alt+,')).toEqual(['shift+,', 'alt+shift+,'])
  })
  it('drops display-only [[…]] alternatives', () => {
    expect(chordsOf('[[PgUp]],pageup,]')).toEqual(['pageup', ']'])
    expect(chordsOf('shift+[[PgUp]],shift+pageup,alt+]')).toEqual(['shift+pageup', 'alt+]'])
  })
})

describe('Miro shortcut map', () => {
  it('only overrides ids tldraw 5.4.2 actually has', () => {
    const { actions, tools } = merged()
    expect(actions.missing).toEqual([])
    expect(tools.missing).toEqual([])
  })

  it('binds the Miro keys to the intended actions and tools', () => {
    expect(idsFor('l')).toEqual(['arrow'])
    expect(idsFor('a')).toEqual(['arrow'])
    expect(idsFor('p')).toEqual(['draw'])
    expect(idsFor('alt+1')).toEqual(['zoom-to-fit'])
    expect(idsFor('alt+2')).toEqual(['zoom-to-selection'])
    expect(idsFor('ctrl+0')).toEqual(['zoom-to-100'])
    expect(idsFor('meta+0')).toEqual(['zoom-to-100'])
    expect(idsFor('ctrl+shift+l')).toEqual(['toggle-lock'])
    expect(idsFor('meta+shift+l')).toEqual(['toggle-lock'])
    expect(idsFor('pageup')).toEqual(['bring-to-front'])
    expect(idsFor('pagedown')).toEqual(['send-to-back'])
    expect(idsFor('shift+pageup')).toEqual(['bring-forward'])
    expect(idsFor('shift+pagedown')).toEqual(['send-backward'])
    expect(idsFor('m')).toEqual(['dr-toggle-minimap'])
    expect(idsFor('ctrl+f')).toEqual(['dr-board-search'])
    expect(idsFor('meta+f')).toEqual(['dr-board-search'])
    // MAK-18 (no Miro default): next to tldraw's Alt+Shift+H / Alt+Shift+V distribute keys.
    expect(idsFor('alt+shift+g')).toEqual(['dr-arrange-grid'])
    expect(idsFor('alt+shift+h')).toEqual(['distribute-horizontal'])
  })

  it("keeps tldraw's own keys where they do not collide", () => {
    expect(idsFor(']')).toEqual(['bring-to-front'])
    expect(idsFor('[')).toEqual(['send-to-back'])
    expect(idsFor('alt+]')).toEqual(['bring-forward'])
    expect(idsFor('shift+1')).toEqual(['zoom-to-fit'])
    expect(idsFor('shift+2')).toEqual(['zoom-to-selection'])
    expect(idsFor('shift+0')).toEqual(['zoom-to-100'])
    expect(idsFor('d')).toEqual(['draw'])
  })

  it('removes the keys it takes away (line tool, bare Shift+L)', () => {
    const { tools, actions } = merged()
    expect(tools.items.line?.kbd).toBeUndefined()
    expect(idsFor('shift+l')).toEqual([])
    expect(chordsOf(actions.items['toggle-lock']?.kbd)).toEqual(['meta+shift+l', 'ctrl+shift+l'])
  })

  it('leaves no key bound to two actions or tools', () => {
    expect([...findKbdConflicts(merged().all)]).toEqual([])
  })

  it('the conflict detector does catch a collision', () => {
    const clash = [...merged().all, { id: 'x-test', kbd: 'm' }]
    expect(findKbdConflicts(clash).get('m')).toEqual(['dr-toggle-minimap', 'x-test'])
  })

  it('never binds the keys reserved for comments (C, Shift+C)', () => {
    for (const chord of RESERVED_FOR_OTHER_FEATURES) expect(idsFor(chord)).toEqual([])
  })

  it('shows the Miro key first in menus and the shortcuts dialog', () => {
    const { actions, tools } = merged()
    const first = (kbd: string | undefined) => splitKbd(kbd ?? '')[0]
    expect(first(actions.items['zoom-to-fit']?.kbd)).toBe('alt+1')
    expect(first(actions.items['zoom-to-100']?.kbd)).toBe('cmd+0')
    expect(first(actions.items['bring-to-front']?.kbd)).toBe('[[PgUp]]')
    expect(first(tools.items.arrow?.kbd)).toBe('l')
    expect(first(tools.items.draw?.kbd)).toBe('p')
  })

  it('A11Y2-07: "?" and Ctrl/Cmd+/ open the shortcuts; no key flips the theme', () => {
    const { actions } = merged()
    expect(idsFor('shift+/')).toEqual(['open-kbd-shortcuts'])
    expect(idsFor('ctrl+/')).toEqual(['open-kbd-shortcuts'])
    expect(idsFor('meta+/')).toEqual(['open-kbd-shortcuts'])
    expect(idsFor('ctrl+alt+/')).toEqual(['open-kbd-shortcuts'])
    expect(splitKbd(actions.items['open-kbd-shortcuts']?.kbd ?? '')[0]).toBe('[[?]]')
    expect(actions.items['toggle-dark-mode']?.kbd).toBeUndefined()
    expect(actions.items['toggle-dark-mode']).toBeDefined() // the menu item stays
  })
})

describe('kbdLabel', () => {
  it('formats per platform', () => {
    expect(kbdLabel('cmd+f,ctrl+f', false)).toBe('Ctrl+F')
    expect(kbdLabel('cmd+f,ctrl+f', true)).toBe('⌘F')
    expect(kbdLabel('shift+[[PgUp]],shift+pageup', false)).toBe('Shift+PgUp')
    expect(kbdLabel('m', false)).toBe('M')
  })
})
