import { describe, expect, it } from 'vitest'
import {
  chordOf,
  classifyKey,
  isKeptTextEditorChord,
  type KeyContext,
  type KeyLike,
  type KeyVerdict,
  keyLikeOf,
} from './keymap.ts'

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

  it('blocks every save chord inside the editor (open item 1), Alt included, with preventDefault', () => {
    for (const spec of [
      'mod+s',
      'meta+s',
      'mod+shift+s',
      'meta+shift+s',
      // The verifier's finding: Excalidraw's save key test ignores Alt (index.js:11606).
      'mod+alt+s',
      'meta+alt+s',
      'mod+alt+shift+s',
      'meta+alt+shift+s',
      'mod+meta+s',
      'mod+meta+alt+s',
    ]) {
      expect(classifyKey(k(spec), granted), spec).toEqual({ kind: 'block', preventDefault: true })
      expect(classifyKey(k(spec), { ...granted, mac: true }), `mac ${spec}`).toEqual({
        kind: 'block',
        preventDefault: true,
      })
    }
  })

  it("blocks the textarea's other actions: zoom, font size, Ctrl+Enter submit, Ctrl+[ ] indent, Ctrl+P", () => {
    for (const spec of [
      'mod+=',
      'mod+-',
      'mod+0',
      'mod+shift+,',
      'mod+shift+.',
      'mod+Enter',
      'mod+[',
      'mod+]',
      'mod+p',
    ]) {
      expect(classifyKey(k(spec), granted).kind, spec).toBe('block')
    }
    // Tab with a modifier would indent too (the textarea's Tab test ignores modifiers).
    expect(classifyKey(k('mod+Tab'), granted).kind).toBe('block')
    expect(classifyKey(k('alt+Tab'), granted).kind).toBe('block')
  })

  it('keeps the text-editing chords: caret moves, word deletes, undo/redo, select all, clipboard', () => {
    for (const spec of [
      'mod+ArrowLeft',
      'mod+shift+ArrowRight',
      'shift+ArrowUp',
      'mod+Home',
      'mod+shift+End',
      'mod+Backspace',
      'mod+Delete',
      'alt+Backspace',
      'meta+Backspace',
      'mod+z',
      'meta+z',
      'mod+shift+z',
      'mod+y',
      'mod+a',
      'meta+a',
      'mod+c',
      'mod+x',
      'mod+v',
      'mod+shift+v',
      'mod+Insert',
      'shift+Insert',
      'shift+Delete',
    ]) {
      expect(classifyKey(k(spec), granted), spec).toEqual({ kind: 'delegate' })
    }
    // Not kept: Cmd+Y is not a text shortcut; Ctrl+Shift+A/C/X; Ctrl+Alt+Z.
    for (const spec of ['meta+y', 'mod+shift+a', 'mod+shift+c', 'mod+shift+x', 'mod+alt+z', 'mod+meta+z']) {
      expect(classifyKey(k(spec), granted).kind, spec).toBe('block')
    }
  })

  it('Alt+Arrow / Alt+Home: word moves on macOS; Back / Forward / Home page elsewhere, so blocked', () => {
    for (const spec of ['alt+ArrowLeft', 'alt+ArrowRight', 'alt+shift+ArrowLeft', 'alt+Home']) {
      expect(classifyKey(k(spec), { ...granted, mac: true }), spec).toEqual({ kind: 'delegate' })
      expect(classifyKey(k(spec), granted), spec).toEqual({ kind: 'block', preventDefault: true })
    }
  })

  it('AltGr and macOS Option characters type through the browser; their keydown never reaches Excalidraw', () => {
    expect(classifyKey(k('mod+alt+q', { key: '@', altGraph: true }), granted)).toEqual({ kind: 'browser' })
    // AltGr+S on a layout with no AltGr character reports 's': still stopped (it would be a save chord).
    expect(classifyKey(k('mod+alt+s', { altGraph: true }), granted)).toEqual({ kind: 'browser' })
    expect(classifyKey(k('alt+s', { key: 'ß' }), { ...granted, mac: true })).toEqual({ kind: 'browser' })
    expect(classifyKey(k('alt+e', { key: 'Dead' }), { ...granted, mac: true })).toEqual({ kind: 'browser' })
    // Off macOS, Alt+letter types nothing: a blocked chord.
    expect(classifyKey(k('alt+s'), granted)).toEqual({ kind: 'block', preventDefault: true })
    // An IME composing (keyCode 229): the browser's.
    expect(classifyKey(k('mod+a', { key: 'Process', keyCode: 229 }), granted)).toEqual({ kind: 'browser' })
  })

  it('a key aimed at a text editor the session does not own (foreign) acts nowhere', () => {
    const foreign: KeyContext = { ...EDITOR, editor: 'foreign', inTextEditor: true }
    for (const spec of ['a', 'Enter', 'Escape', 'mod+z', 'mod+s', 'mod+alt+s']) {
      expect(classifyKey(k(spec), foreign).kind, spec).toBe('block')
    }
    expect(classifyKey(k('Shift'), foreign)).toEqual({ kind: 'block', preventDefault: false })
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

/**
 * A mirror of Excalidraw 0.18.0-1118751's text editor keydown handler (dist/dev/index.js:25367-25409) and
 * of what its container's onKeyDown still does for a textarea target (:43983-44011). CTRL_OR_CMD is
 * metaKey on macOS, ctrlKey elsewhere (common :2391).
 */
function excalidrawTextareaAction(e: KeyLike, mac: boolean): string | null {
  const cmd = mac ? e.metaKey : e.ctrlKey
  const code = e.code ?? ''
  if (!e.shiftKey && (code === 'Equal' || code === 'NumpadAdd') && (cmd || e.shiftKey)) return 'zoomIn'
  if (!e.shiftKey && (code === 'Minus' || code === 'NumpadSubtract') && (cmd || e.shiftKey)) return 'zoomOut'
  if (!e.shiftKey && (code === 'Digit0' || code === 'Numpad0') && (cmd || e.shiftKey)) return 'resetZoom'
  if (cmd && e.shiftKey && (e.key === '<' || e.key === ',')) return 'decreaseFontSize'
  if (cmd && e.shiftKey && (e.key === '>' || e.key === '.')) return 'increaseFontSize'
  if (e.key === 'Escape') return 'submit'
  if (e.key === 's' && cmd && !e.shiftKey) return 'saveToActiveFile'
  if (e.key === 'Enter' && cmd) return 'submit'
  if (e.key === 'Tab' || (cmd && (code === 'BracketLeft' || code === 'BracketRight'))) return 'indent'
  // The container's onKeyDown, before it returns for a writable target:
  if (cmd && e.key === 'p' && !e.shiftKey && !e.altKey) return 'toast'
  return null
}

describe('the text editor allowlist against every action of the textarea handler', () => {
  const keys: { key: string; code: string; shifted?: string }[] = [
    ...'abcdefghijklmnopqrstuvwxyz'
      .split('')
      .map((c) => ({ key: c, code: `Key${c.toUpperCase()}`, shifted: c.toUpperCase() })),
    ...'0123456789'.split('').map((d, i) => ({ key: d, code: `Digit${d}`, shifted: ')!@#$%^&*('[i] })),
    { key: '`', code: 'Backquote', shifted: '~' },
    { key: '-', code: 'Minus', shifted: '_' },
    { key: '=', code: 'Equal', shifted: '+' },
    { key: '[', code: 'BracketLeft', shifted: '{' },
    { key: ']', code: 'BracketRight', shifted: '}' },
    { key: '\\', code: 'Backslash', shifted: '|' },
    { key: ';', code: 'Semicolon', shifted: ':' },
    { key: "'", code: 'Quote', shifted: '"' },
    { key: ',', code: 'Comma', shifted: '<' },
    { key: '.', code: 'Period', shifted: '>' },
    { key: '/', code: 'Slash', shifted: '?' },
    { key: '+', code: 'NumpadAdd' },
    { key: '-', code: 'NumpadSubtract' },
    { key: '0', code: 'Numpad0' },
    ...[
      'Enter',
      'Tab',
      'Escape',
      'Backspace',
      'Delete',
      'Insert',
      'Home',
      'End',
      'PageUp',
      'PageDown',
      ' ',
    ].map((key) => ({ key, code: key === ' ' ? 'Space' : key })),
    ...['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].map((key) => ({ key, code: key })),
    ...Array.from({ length: 12 }, (_, i) => ({ key: `F${i + 1}`, code: `F${i + 1}` })),
  ]
  const events: KeyLike[] = []
  for (const kk of keys) {
    for (let m = 0; m < 16; m++) {
      const shiftKey = (m & 8) !== 0
      events.push({
        key: shiftKey && kk.shifted ? kk.shifted : kk.key,
        code: kk.code,
        ctrlKey: (m & 1) !== 0,
        metaKey: (m & 2) !== 0,
        altKey: (m & 4) !== 0,
        shiftKey,
      })
    }
  }

  for (const mac of [false, true]) {
    it(`${mac ? 'macOS' : 'Windows'}: a delegated key never triggers a textarea action except Escape and Tab/Shift+Tab`, () => {
      const ctx: KeyContext = { ...EDITOR, editor: 'granted', inTextEditor: true, mac }
      const leaks: string[] = []
      let delegated = 0
      for (const e of events) {
        const v = classifyKey(e, ctx)
        const action = excalidrawTextareaAction(e, mac)
        if (v.kind !== 'delegate') continue
        delegated++
        const chord = e.ctrlKey || e.metaKey || e.altKey
        const kept =
          (action === 'submit' && e.key === 'Escape' && !chord) ||
          (action === 'indent' && e.key === 'Tab' && !chord)
        if (action && !kept) leaks.push(`${JSON.stringify(e)} -> ${action}`)
      }
      expect(leaks).toEqual([])
      expect(delegated).toBeGreaterThan(100)
    })

    it(`${mac ? 'macOS' : 'Windows'}: every chord with Ctrl, Cmd or Alt is stopped unless it is a kept chord`, () => {
      const ctx: KeyContext = { ...EDITOR, editor: 'granted', inTextEditor: true, mac }
      const delegatedChords = new Set<string>()
      for (const e of events) {
        if (!(e.ctrlKey || e.metaKey || e.altKey)) continue
        const v = classifyKey(e, ctx)
        if (v.kind === 'delegate') {
          expect(isKeptTextEditorChord(e, mac), JSON.stringify(e)).toBe(true)
          delegatedChords.add(chordOf(e))
        } else {
          expect(['block', 'browser'], JSON.stringify(e)).toContain(v.kind)
        }
      }
      // Of the 47 letter/digit/punctuation keys, only these kept chords are delegated.
      const letters = [...delegatedChords].filter((c) => /\+[a-z0-9`\-=[\]\\;',./]$/.test(c)).sort()
      expect(letters).toEqual([
        'mod+a',
        'mod+c',
        'mod+shift+v',
        'mod+shift+z',
        'mod+v',
        'mod+x',
        'mod+y',
        'mod+z',
      ])
    })
  }

  it('keyLikeOf reads AltGr from getModifierState (a KeyboardEvent has no altGraph field)', () => {
    const ev = {
      key: '@',
      code: 'KeyQ',
      ctrlKey: true,
      metaKey: false,
      altKey: true,
      shiftKey: false,
      isComposing: false,
      repeat: false,
      keyCode: 81,
      getModifierState: (m: string) => m === 'AltGraph',
    } as unknown as KeyboardEvent
    expect(keyLikeOf(ev)).toMatchObject({ key: '@', altGraph: true, keyCode: 81 })
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
