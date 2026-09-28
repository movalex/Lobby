import { describe, expect, it } from 'vitest'
import { chordOf, classifyKey, type KeyContext, type KeyLike, type KeyVerdict } from './keymap.ts'

// Pins the allowlist of docs/EXCALIDRAW-MIGRATION.md §2.3.3 (the plan's keyboard-map test).

const EDITOR: KeyContext = {
  role: 'editor',
  editor: 'none',
  inTextEditor: false,
  singleTextTarget: false,
  singleNote: false,
}
const READONLY: KeyContext = { ...EDITOR, role: 'readonly' }

/** 'mod+shift+s', 'alt+ArrowLeft', 'Enter', 'g' … -> a KeyLike (mod = Ctrl). */
function k(spec: string, opts: Partial<KeyLike> = {}): KeyLike {
  const parts = spec.split('+')
  const key = parts.pop() ?? ''
  const mods = new Set(parts)
  let code: string
  if (/^[a-z]$/i.test(key)) code = `Key${key.toUpperCase()}`
  else if (/^[0-9]$/.test(key)) code = `Digit${key}`
  else if (key === '[') code = 'BracketLeft'
  else if (key === ']') code = 'BracketRight'
  else if (key === '=') code = 'Equal'
  else if (key === '-') code = 'Minus'
  else if (key === '/') code = 'Slash'
  else if (key === '?') code = 'Slash'
  else if (key === ' ') code = 'Space'
  else code = key
  const shiftKey = mods.has('shift') || key === '?'
  const printed = /^[a-z]$/i.test(key) ? (shiftKey ? key.toUpperCase() : key.toLowerCase()) : key
  return {
    key: printed,
    code,
    ctrlKey: mods.has('mod') || mods.has('ctrl'),
    metaKey: mods.has('meta'),
    altKey: mods.has('alt'),
    shiftKey,
    ...opts,
  }
}

const kind = (v: KeyVerdict) => (v.kind === 'lobby' ? `lobby:${v.action}` : v.kind)

describe('classifyKey: editors, no text editor open (§2.3.3)', () => {
  it.each([
    'ArrowLeft',
    'shift+ArrowUp',
    'Delete',
    'Backspace',
    'Escape',
    'mod+d',
    'mod+g',
    'mod+shift+g',
    'mod+shift+l',
    'mod+[',
    'mod+]',
    'mod+shift+[',
    'mod+shift+]',
    ' ',
    'mod+=',
    'mod+-',
    'Shift',
    'Alt',
    'Control',
  ])('delegates %s to Excalidraw', (spec) => {
    expect(classifyKey(k(spec), EDITOR)).toEqual({ kind: 'delegate' })
  })

  // The plan's "Everything else" row, plus every other Excalidraw shortcut that is not delegated.
  it.each([
    'mod+s',
    'mod+shift+s',
    'mod+o',
    'alt+shift+c',
    'mod+shift+e',
    'mod+/',
    'mod+p',
    'mod+Backspace',
    'mod+ArrowLeft',
    'mod+ArrowRight',
    'mod+ArrowUp',
    'mod+ArrowDown',
    'g',
    's',
    'i',
    'shift+f',
    'shift+s',
    'shift+g',
    '?',
    '0',
    '1',
    '2',
    '3',
    '4',
    '5',
    '6',
    '7',
    '8',
    '9',
    'd',
    'a',
    'x',
    'b',
    'q',
    'shift+x',
    'mod+shift+p',
    'alt+shift+d',
    'mod+alt+c',
    'mod+alt+v',
    'mod+shift+ArrowUp',
    'alt+h',
    'alt+v',
    'shift+h',
    'shift+v',
    'mod+x',
    "mod+'",
    'alt+z',
    'alt+s',
    'alt+/',
    'mod+k',
    'alt+r',
    'shift+1',
    'shift+2',
    'shift+3',
    'shift+0',
    'shift+=',
    'mod+shift+,',
    'mod+shift+.',
    'Enter',
  ])('blocks %s (nobody acts)', (spec) => {
    const v = classifyKey(k(spec), EDITOR)
    expect(v.kind).toBe('block')
  })

  it('prevents the browser default of blocked chords (Save page, Print, Open, Back) but not reload/tabs', () => {
    for (const spec of ['mod+s', 'mod+shift+s', 'mod+o', 'mod+p', 'alt+ArrowLeft', 'mod+shift+e']) {
      const v = classifyKey(k(spec), EDITOR)
      expect(v.kind === 'block' ? v.preventDefault : v.kind === 'lobby', spec).toBe(true)
    }
    for (const spec of ['mod+r', 'mod+shift+r', 'mod+t', 'mod+w', 'mod+l', 'mod+shift+i']) {
      expect(classifyKey(k(spec), EDITOR), spec).toEqual({ kind: 'block', preventDefault: false })
    }
    expect(classifyKey(k('F5'), EDITOR)).toEqual({ kind: 'block', preventDefault: false })
  })

  it.each([
    ['n', 'lobby:tool:note'],
    ['l', 'lobby:tool:arrow'],
    ['p', 'lobby:tool:freedraw'],
    ['t', 'lobby:tool:text'],
    ['r', 'lobby:tool:rectangle'],
    ['o', 'lobby:tool:ellipse'],
    ['f', 'lobby:tool:frame'],
    ['h', 'lobby:tool:hand'],
    ['c', 'lobby:tool:comment'],
    ['v', 'lobby:tool:select'],
    ['e', 'lobby:tool:eraser'],
    ['k', 'lobby:tool:laser'],
    ['m', 'lobby:m'],
    ['mod+f', 'lobby:search'],
    ['mod+a', 'lobby:selectAll'],
    ['alt+1', 'lobby:zoomToFit'],
    ['alt+2', 'lobby:zoomToSelection'],
    ['mod+0', 'lobby:zoomReset'],
    ['mod+z', 'lobby:undo'],
    ['mod+y', 'lobby:redo'],
    ['mod+shift+z', 'lobby:redo'],
    ['PageUp', 'lobby:page'],
    ['PageDown', 'lobby:page'],
    ['mod+alt+Enter', 'lobby:ctrlAltEnter'],
    ['shift+F10', 'lobby:contextMenu'],
    ['ContextMenu', 'lobby:contextMenu'],
    ['F6', 'lobby:a11yTraverse'],
    ['alt+ArrowLeft', 'lobby:a11yTraverse'],
  ])('%s is Lobby-owned (%s)', (spec, want) => {
    expect(kind(classifyKey(k(spec), EDITOR))).toBe(want)
  })

  it('Cmd works like Ctrl for Lobby and delegated chords', () => {
    expect(kind(classifyKey(k('meta+z'), EDITOR))).toBe('lobby:undo')
    expect(kind(classifyKey(k('meta+d'), EDITOR))).toBe('delegate')
    expect(classifyKey(k('meta+s'), EDITOR)).toEqual({ kind: 'block', preventDefault: true })
  })

  it('Tab outside a mind map goes to the browser (focus leaves the canvas); Excalidraw never converts', () => {
    expect(classifyKey(k('Tab'), EDITOR)).toEqual({ kind: 'browser' })
    expect(classifyKey(k('shift+Tab'), EDITOR)).toEqual({ kind: 'browser' })
    expect(kind(classifyKey(k('Tab'), { ...EDITOR, inMindMap: true }))).toBe('lobby:mindmap')
  })

  it('Enter on one selected text or text container is the lease flow (P1); on anything else blocked', () => {
    expect(kind(classifyKey(k('Enter'), { ...EDITOR, singleTextTarget: true }))).toBe('lobby:editText')
    expect(classifyKey(k('Enter'), EDITOR).kind).toBe('block')
    expect(classifyKey(k('mod+Enter'), { ...EDITOR, singleTextTarget: true }).kind).toBe('block')
  })

  it('a printable key on the one selected note is type-to-edit (P2), before tool letters', () => {
    const note = { ...EDITOR, singleTextTarget: true, singleNote: true }
    for (const spec of ['n', 'a', 'shift+a', '1', '?', 'é']) {
      expect(kind(classifyKey(k(spec), note)), spec).toBe('lobby:typeToEdit')
    }
    // Excluded so their shortcuts keep working (COL-04): Space, [ and ].
    expect(kind(classifyKey(k(' '), note))).toBe('delegate')
    expect(kind(classifyKey(k('mod+d'), note))).toBe('delegate')
  })
})

describe('classifyKey: the text editor', () => {
  const granted: KeyContext = { ...EDITOR, editor: 'granted', inTextEditor: true }
  it('delegates every key to the textarea once the lease is granted, Ctrl+Z / Ctrl+Y / Ctrl+A included', () => {
    for (const spec of [
      'a',
      'Enter',
      'Backspace',
      'mod+z',
      'mod+y',
      'mod+shift+z',
      'mod+a',
      'Tab',
      'Escape',
    ]) {
      expect(classifyKey(k(spec), granted), spec).toEqual({ kind: 'delegate' })
    }
  })

  it('blocks Ctrl+S, Cmd+S and Ctrl+Shift+S inside the editor (open item 1), with preventDefault', () => {
    for (const spec of ['mod+s', 'meta+s', 'mod+shift+s', 'meta+shift+s']) {
      expect(classifyKey(k(spec), granted), spec).toEqual({ kind: 'block', preventDefault: true })
    }
  })

  it('buffers printable keys, Enter, Backspace and Delete while the lease is pending; Escape cancels', () => {
    const pending: KeyContext = { ...EDITOR, editor: 'pending', inTextEditor: true }
    for (const spec of ['a', 'shift+a', ' ', '1', 'Enter', 'shift+Enter', 'Backspace', 'Delete']) {
      expect(classifyKey(k(spec), pending), spec).toEqual({ kind: 'buffer' })
    }
    expect(classifyKey(k('Escape'), pending)).toEqual({ kind: 'cancel' })
    for (const spec of ['mod+z', 'mod+s', 'ArrowLeft', 'Tab']) {
      expect(classifyKey(k(spec), pending).kind, spec).toBe('block')
    }
    // Modifiers alone are neither buffered nor prevented (Shift must still shift the next key).
    expect(classifyKey(k('Shift'), pending)).toEqual({ kind: 'block', preventDefault: false })
    // Pending with the focus still on the canvas (the editor is opening) buffers the same way.
    expect(classifyKey(k('x'), { ...EDITOR, editor: 'pending' })).toEqual({ kind: 'buffer' })
  })

  it('AltGr characters still type (Windows reports AltGr as Ctrl+Alt)', () => {
    const pending: KeyContext = { ...EDITOR, editor: 'pending', inTextEditor: true }
    expect(classifyKey(k('mod+alt+q', { key: '@', altGraph: true }), pending)).toEqual({ kind: 'buffer' })
  })
})

describe('classifyKey: read-only roles', () => {
  it('delegates only the canvas zoom keys; every editing key is blocked', () => {
    expect(classifyKey(k('mod+='), READONLY)).toEqual({ kind: 'delegate' })
    expect(classifyKey(k('mod+-'), READONLY)).toEqual({ kind: 'delegate' })
    for (const spec of [
      'Delete',
      'Backspace',
      'ArrowLeft',
      'mod+d',
      'mod+g',
      'n',
      't',
      'Enter',
      'mod+s',
      'mod+shift+s',
    ]) {
      expect(classifyKey(k(spec), READONLY).kind, spec).toBe('block')
    }
    expect(kind(classifyKey(k('mod+z'), READONLY))).toBe('block')
    expect(kind(classifyKey(k('mod+f'), READONLY))).toBe('lobby:search')
    expect(kind(classifyKey(k('c'), READONLY))).toBe('lobby:tool:comment')
  })
})

describe('chordOf', () => {
  it('names chords by code for letters and digits, with mod for Ctrl or Cmd', () => {
    expect(chordOf(k('mod+shift+s'))).toBe('mod+shift+s')
    expect(chordOf(k('meta+s'))).toBe('mod+s')
    expect(chordOf(k('alt+1'))).toBe('alt+1')
    expect(chordOf(k('F5'))).toBe('f5')
  })
})
