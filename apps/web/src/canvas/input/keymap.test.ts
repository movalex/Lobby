import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  chordOf,
  classifyKey,
  delegatedChord,
  ENGINE_KEY_TEST_LINES,
  engineChordAction,
  engineKeyOf,
  isKeptTextEditorChord,
  type KeyContext,
  type KeyLike,
  type KeyVerdict,
  keyLikeOf,
} from './keymap.ts'
import { LAYOUTS, layoutPresses } from './layouts.ts'

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

  it("Cmd works like Ctrl for Lobby's chords; delegated chords follow Excalidraw's CTRL_OR_CMD", () => {
    expect(kind(classifyKey(k('meta+z'), EDITOR))).toBe('lobby:undo')
    // Excalidraw's CTRL_OR_CMD is metaKey on macOS and ctrlKey elsewhere (common index.js:2391).
    expect(kind(classifyKey(k('meta+d'), { ...EDITOR, mac: true }))).toBe('delegate')
    expect(kind(classifyKey(k('meta+d'), EDITOR))).toBe('block')
    expect(kind(classifyKey(k('ctrl+d'), { ...EDITOR, mac: true }))).toBe('block')
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

describe('classifyKey: ending a crop with Enter (CR-W5-3G-4)', () => {
  it('Enter reaches Excalidraw while its crop editor is open: it ends the crop, as Escape does', () => {
    expect(classifyKey(k('Enter'), { ...EDITOR, cropping: true })).toEqual({ kind: 'delegate' })
    expect(classifyKey(k('Escape'), { ...EDITOR, cropping: true })).toEqual({ kind: 'delegate' })
    // even with a text target selected: a crop is on an image, but the key is the crop's while it is open
    expect(classifyKey(k('Enter'), { ...EDITOR, cropping: true, singleTextTarget: true })).toEqual({
      kind: 'delegate',
    })
  })

  it('with no crop open Enter on a selected image stays blocked: Excalidraw would start its own crop', () => {
    expect(classifyKey(k('Enter'), EDITOR).kind).toBe('block')
    expect(classifyKey(k('Enter'), { ...EDITOR, cropping: false }).kind).toBe('block')
  })

  it('only a plain Enter: modified Enter, a read-only role and a composing Enter never end a crop', () => {
    const open = { ...EDITOR, cropping: true }
    expect(classifyKey(k('shift+Enter'), open).kind).toBe('block')
    expect(classifyKey(k('mod+Enter'), open).kind).toBe('block')
    expect(classifyKey(k('Enter', { isComposing: true }), open).kind).toBe('block')
    expect(classifyKey(k('Enter'), { ...READONLY, cropping: true }).kind).toBe('block')
  })
})

describe('classifyKey: type-to-edit for a feature’s element (CR-3D-3)', () => {
  const topic = { ...EDITOR, typeToEdit: true }
  it('a printable key on the one selected element a feature takes is type-to-edit, before tool letters', () => {
    for (const spec of ['a', 'shift+a', 'r', 'n', '1', '?', 'é'])
      expect(kind(classifyKey(k(spec), topic)), spec).toBe('lobby:typeToEdit')
  })

  it('leaves Space, brackets, chords and every other key as they were', () => {
    expect(kind(classifyKey(k(' '), topic))).toBe('delegate')
    expect(kind(classifyKey(k('mod+d'), topic))).toBe('delegate')
    expect(kind(classifyKey(k('ArrowRight'), topic))).toBe('delegate')
    expect(classifyKey(k('Enter'), topic).kind).toBe('block')
  })

  it('without the feature’s rule a tool letter picks its tool; a read-only role never types into anything', () => {
    expect(kind(classifyKey(k('r'), EDITOR))).toBe('lobby:tool:rectangle')
    expect(classifyKey(k('a'), { ...READONLY, typeToEdit: true }).kind).toBe('block')
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

  it('K picks the laser (wave L, L6-1: viewers point for everyone); Shift+K, Ctrl/Cmd+K and Alt+K do not', () => {
    expect(kind(classifyKey(k('k'), READONLY))).toBe('lobby:tool:laser')
    expect(kind(classifyKey(k('shift+k'), READONLY))).not.toBe('lobby:tool:laser')
    expect(kind(classifyKey(k('alt+k'), READONLY))).not.toBe('lobby:tool:laser')
    expect(kind(classifyKey(k('mod+k'), READONLY))).not.toBe('lobby:tool:laser')
  })
})

describe('classifyKey: read-only roles copy where the export policy lets them (CR-3A-4)', () => {
  const MAY_COPY: KeyContext = { ...READONLY, canCopy: true }

  it('Ctrl/Cmd+C reaches the browser (stopped before Excalidraw, never prevented) only with canCopy', () => {
    expect(classifyKey(k('mod+c'), MAY_COPY)).toEqual({ kind: 'browser' })
    expect(classifyKey(k('meta+c'), { ...MAY_COPY, mac: true })).toEqual({ kind: 'browser' })
    // the policy says no (or has not answered): blocked and prevented, as before
    expect(classifyKey(k('mod+c'), READONLY)).toEqual({ kind: 'block', preventDefault: true })
    expect(classifyKey(k('mod+c'), { ...READONLY, canCopy: false })).toEqual({
      kind: 'block',
      preventDefault: true,
    })
  })

  it('nothing else opens up: not cut, paste, Shift+C, Alt chords or the editing keys', () => {
    for (const spec of [
      'mod+x',
      'mod+v',
      'mod+shift+v',
      'mod+shift+c',
      'mod+alt+c',
      'Delete',
      'mod+d',
      'mod+z',
    ])
      expect(classifyKey(k(spec), MAY_COPY).kind, spec).toBe('block')
    // the other platform's command key is not the copy chord
    expect(classifyKey(k('meta+c'), MAY_COPY).kind).toBe('block')
    expect(classifyKey(k('mod+c', { altGraph: true }), MAY_COPY).kind).toBe('block')
  })

  it('an editor’s Ctrl/Cmd+C is the browser’s either way (the export gate answers at the copy event)', () => {
    expect(classifyKey(k('mod+c'), { ...EDITOR, canCopy: false })).toEqual({ kind: 'browser' })
    expect(classifyKey(k('mod+c'), EDITOR)).toEqual({ kind: 'browser' })
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

// --- Delegation outside the text editor (second verifier, A6 defects 3 and 4) -----------------------
//
// Lobby used to delegate Ctrl+D / G / Shift+L / = / - / [ ] by physical code while Excalidraw's handlers
// test `key`: Bone Ctrl+Shift+S on the physical L key ran saveFileToDisk, and a '?' key opened the help
// dialog. The rule now (keymap.ts delegatedChord): Excalidraw's own key tests decide, and only a unique
// delegated action is delegated.

const DELEGATED = new Set([
  'duplicateSelection',
  'group',
  'ungroup',
  'toggleElementLock',
  'sendBackward',
  'bringForward',
  'sendToBack',
  'bringToFront',
  'zoomIn',
  'zoomOut',
])

/** A layout press as Chromium reports it: the layout's character as `key`, the physical key as `code`. */
function press(
  code: string,
  key: string,
  mods: { shift?: boolean; alt?: boolean; mac?: boolean; otherMod?: boolean } = {},
): KeyLike {
  const mac = mods.mac === true
  const other = mods.otherMod === true
  // Excalidraw's CTRL_OR_CMD: Cmd on macOS, Ctrl elsewhere; `otherMod` presses the other one instead.
  const cmd = mac ? !other : false
  const ctrl = mac ? other : !other
  return {
    key,
    code,
    ctrlKey: ctrl,
    metaKey: cmd || (!mac && other),
    altKey: mods.alt === true,
    shiftKey: mods.shift === true,
  }
}

describe("classifyKey: delegated chords outside the text editor follow Excalidraw's key tests", () => {
  for (const mac of [false, true]) {
    const ctx: KeyContext = { ...EDITOR, mac }
    const os = mac ? 'macOS' : 'Windows'
    const verdict = (code: string, key: string, shift = false, alt = false) =>
      classifyKey(press(code, key, { shift, alt, mac }), ctx)

    it(`${os}: the verifier's layout cases are blocked and prevented`, () => {
      const cases: [string, string, string, boolean][] = [
        ['Bone Ctrl+Shift+S on KeyL (was: lock chord, then saveFileToDisk)', 'KeyL', 'S', true],
        ['Colemak Ctrl+S on KeyD (was: duplicate chord)', 'KeyD', 's', false],
        ['Neo 2 Ctrl+O on KeyG (was: group chord)', 'KeyG', 'o', false],
        ['QWERTZ Ctrl+Shift+ss on Minus, key ? (was: zoom, then help)', 'Minus', '?', true],
        ['Dvorak Ctrl+Shift+[ on BracketLeft, key ? (was: z-order, then help)', 'BracketLeft', '?', true],
      ]
      for (const [name, code, key, shift] of cases) {
        expect(verdict(code, key, shift), name).toEqual({ kind: 'block', preventDefault: true })
        expect(delegatedChord(press(code, key, { shift, mac }), mac), name).toBeNull()
      }
    })

    it(`${os}: the plan's delegated chords on QWERTY are delegated`, () => {
      const want: [string, string, boolean, boolean, string][] = [
        ['KeyD', 'd', false, false, 'duplicateSelection'],
        ['KeyG', 'g', false, false, 'group'],
        ['KeyG', 'G', true, false, 'ungroup'],
        ['KeyL', 'L', true, false, 'toggleElementLock'],
        ['BracketLeft', '[', false, false, 'sendBackward'],
        ['BracketRight', ']', false, false, 'bringForward'],
        ['Equal', '=', false, false, 'zoomIn'],
        ['Equal', '+', true, false, 'zoomIn'],
        ['Minus', '-', false, false, 'zoomOut'],
        ['NumpadAdd', '+', false, false, 'zoomIn'],
        ['NumpadSubtract', '-', false, false, 'zoomOut'],
      ]
      // To back / to front: Ctrl+Shift+[ ] on Windows (index.js:3588, 3613).
      if (!mac) {
        want.push(
          ['BracketLeft', '{', true, false, 'sendToBack'],
          ['BracketRight', '}', true, false, 'bringToFront'],
        )
      }
      for (const [code, key, shift, alt, action] of want) {
        expect(delegatedChord(press(code, key, { shift, alt, mac }), mac), `${code}/${key}`).toBe(action)
        expect(verdict(code, key, shift, alt), `${code}/${key}`).toEqual({ kind: 'delegate' })
      }
      if (mac) {
        // Excalidraw's macOS to back / to front is Cmd+Option+[ ], but sendBackward's keyTest ignores Alt,
        // so TWO actions match and handleKeyDown gives up (index.js:23064-23069): Excalidraw does nothing,
        // and Lobby blocks it. (An Excalidraw bug; recorded in A6.md.)
        expect(engineChordAction(press('BracketLeft', '“', { alt: true, mac }), mac)).toBe('ambiguous')
        expect(delegatedChord(press('BracketLeft', '“', { alt: true, mac }), mac)).toBeNull()
        expect(delegatedChord(press('BracketRight', '‘', { alt: true, mac }), mac)).toBeNull()
        // Cmd+Shift+[ ] matches nothing on macOS.
        expect(engineChordAction(press('BracketLeft', '{', { shift: true, mac }), mac)).toBeNull()
      }
    })

    it(`${os}: layouts where Excalidraw's own test still picks a delegated action`, () => {
      // Key-tested actions follow the character: Colemak's D and G are on the physical G and T keys.
      expect(delegatedChord(press('KeyG', 'd', { mac }), mac)).toBe('duplicateSelection')
      expect(delegatedChord(press('KeyT', 'g', { mac }), mac)).toBe('group')
      expect(delegatedChord(press('KeyU', 'L', { shift: true, mac }), mac)).toBe('toggleElementLock')
      // Code-tested actions follow the physical key, as Excalidraw's keyTests read `code`:
      expect(delegatedChord(press('BracketLeft', 'ü', { mac }), mac)).toBe('sendBackward') // QWERTZ Ctrl+Ü
      expect(delegatedChord(press('BracketRight', '+', { mac }), mac)).toBe('bringForward') // QWERTZ Ctrl++
      expect(delegatedChord(press('Equal', 'Dead', { mac }), mac)).toBe('zoomIn') // QWERTZ dead acute
      expect(delegatedChord(press('Minus', '[', { mac }), mac)).toBe('zoomOut') // Dvorak's Minus key
      expect(delegatedChord(press('BracketLeft', 'ß', { mac }), mac)).toBe('sendBackward') // Neo 2 / Bone
    })

    it(`${os}: layouts where Excalidraw would do nothing, or something else, are blocked`, () => {
      const blocked: [string, string, boolean][] = [
        ['KeyD', 'в', false], // Russian Ctrl+В: Excalidraw tests key 'd', so nothing
        ['KeyD', 'Unidentified', false], // key unusable: duplicate tests key, no code fallback
        ['KeyG', 'Dead', false],
        ['Digit6', '-', false], // AZERTY Ctrl+-: zoomOut tests code Minus, so nothing
        ['Slash', '-', false], // QWERTZ Ctrl+-: the same
        ['KeyG', 'i', false], // Dvorak Ctrl+I on the physical G
        ['KeyL', 'O', true], // Workman Ctrl+Shift+O on the physical L
        ['KeyD', 'a', false], // Neo 2 Ctrl+A on the physical D: Lobby's select-all, not duplicate
        ['Digit0', '=', true], // QWERTZ Ctrl+Shift+0 types '=': resetZoom (code Digit0), not zoom in
        ['KeyE', 'E', true], // Ctrl+Shift+E: image export
        ['Quote', '-', false], // Dvorak Ctrl+- (on the physical Quote key): gridMode tests code Quote
      ]
      for (const [code, key, shift] of blocked) {
        expect(delegatedChord(press(code, key, { shift, mac }), mac), `${code}/${key}`).toBeNull()
        expect(verdict(code, key, shift).kind, `${code}/${key}`).not.toBe('delegate')
      }
      // Excalidraw's CTRL_OR_CMD only: on macOS Ctrl+G opens its background popup (index.js:44193-44205).
      expect(delegatedChord(press('KeyG', 'g', { mac, otherMod: true }), mac)).toBeNull()
      expect(verdict('KeyG', 'g').kind).toBe('delegate')
      // Alt: Excalidraw's delegated keyTests ignore it, so the same action runs (sendBackward on Windows;
      // on macOS Cmd+Option+[ also matches sendToBack: two matches, nothing). AltGr is never delegated.
      expect(delegatedChord(press('BracketLeft', '[', { alt: true, mac }), mac)).toBe(
        mac ? null : 'sendBackward',
      )
      expect(delegatedChord(press('KeyD', 'd', { alt: true, mac }), mac)).toBe('duplicateSelection')
      expect(delegatedChord({ ...press('KeyD', 'd', { mac }), altGraph: true }, mac)).toBeNull()
    })

    it(`${os}: sweep over 7 layouts: delegated only where Excalidraw's own tests pick exactly that delegated action`, () => {
      const presses = layoutPresses()
      expect(presses.length).toBeGreaterThan(60)
      let delegated = 0
      for (const p of presses) {
        if (p.alt && !mac) continue // Cmd+Option chords are macOS's
        const e = press(p.code, p.key, { shift: p.shift, alt: p.alt, mac })
        const v = classifyKey(e, ctx)
        const action = engineChordAction(e, mac)
        const k = engineKeyOf(e)
        const label = `${p.layout} ${p.chord}: ${p.code}/${p.key}${p.shift ? '+shift' : ''} -> ${action}`
        if (v.kind === 'delegate') {
          delegated++
          expect(k, label).not.toBe('?')
          expect(DELEGATED.has(action ?? ''), label).toBe(true)
          expect(delegatedChord(e, mac), label).toBe(action)
          // A key that names a non-delegated Excalidraw key action (save, open, export, cut, link,
          // search, select all, font size, help) is never delegated.
          expect(/^[aoskxfpe?<>,.]$/i.test(k), label).toBe(false)
        } else {
          expect(['block', 'lobby'], label).toContain(v.kind)
          // Not prevented only for a browser chord (reload, tabs, windows, devtools: Dvorak Ctrl+Shift+I on the physical G).
          if (v.kind === 'block' && !v.preventDefault) {
            expect(chordOf(e), label).toMatch(/^mod\+(shift\+)?[rltwn]$|^mod\+shift\+[ijc]$/)
          }
          // Never blocked where Excalidraw would run exactly one delegated action.
          expect(!!action && DELEGATED.has(action), label).toBe(false)
        }
      }
      expect(delegated).toBeGreaterThan(20)
    })
  }

  it('pins every transcribed keyTest against the pinned bundle (name and line)', () => {
    const src = readFileSync(
      fileURLToPath(
        new URL('../../../node_modules/@excalidraw/excalidraw/dist/dev/index.js', import.meta.url),
      ),
      'utf8',
    ).split('\n')
    const withTest = src.filter((l) => /^\s*keyTest: /.test(l) && !/keyTest: void 0/.test(l)).length
    expect(ENGINE_KEY_TEST_LINES).toHaveLength(withTest)
    for (const { name, line } of ENGINE_KEY_TEST_LINES) {
      expect(src[line - 1], `${name} @${line}`).toMatch(/^\s*keyTest: /)
      const before = src.slice(Math.max(0, line - 400), line).join('\n')
      const names = [...before.matchAll(/name: "([A-Za-z]+)"/g)].map((m) => m[1])
      expect(names.at(-1), `${name} @${line}`).toBe(name)
    }
  })

  it("every layout table has 26 letters, and the sweep covers the verifier's five cases", () => {
    for (const [name, map] of Object.entries(LAYOUTS)) {
      const letters = Object.values(map)
        .map(([lo]) => lo)
        .filter((c) => /^\p{Ll}$/u.test(c))
      expect(new Set(letters).size, name).toBeGreaterThanOrEqual(26)
    }
    const presses = layoutPresses()
    const has = (code: string, key: string, shift: boolean) =>
      presses.some((p) => p.code === code && p.key === key && p.shift === shift)
    expect(has('KeyL', 'S', true)).toBe(true) // Bone
    expect(has('KeyD', 's', false)).toBe(true) // Colemak
    expect(has('KeyG', 'o', false)).toBe(true) // Neo 2
    expect(has('Minus', '?', true)).toBe(true) // QWERTZ
    expect(has('BracketLeft', '?', true)).toBe(true) // Dvorak
  })
})
