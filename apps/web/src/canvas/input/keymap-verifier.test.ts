import { describe, expect, it } from 'vitest'
import {
  chordOf,
  classifyKey,
  delegatedChord,
  engineKeyActions,
  isKeptTextEditorChord,
  type KeyContext,
  type KeyLike,
  textareaKeyAction,
} from './keymap.ts'

// Spike B: the keys verifier's K2-K5 (docs/research/excalidraw/spike-b/OPEN-FROM-SPIKE-A.md), pinned.
// Each named case failed before the fix (the verdict was 'delegate', and Excalidraw's own code-based test
// then ran zoom, outdent, submit, copyAsPng, flip or font size) and passes after it. K1 (keyups from
// outside the board) is pinned in keyupGate.test.ts.

const EDITOR: KeyContext = {
  role: 'editor',
  editor: 'none',
  inTextEditor: false,
  singleTextTarget: false,
  singleNote: false,
}
const READONLY: KeyContext = { ...EDITOR, role: 'readonly' }
const GRANTED: KeyContext = { ...EDITOR, editor: 'granted', inTextEditor: true }

const raw = (key: string, code: string, m: Partial<KeyLike> = {}): KeyLike => ({
  key,
  code,
  ctrlKey: false,
  metaKey: false,
  altKey: false,
  shiftKey: false,
  ...m,
})

/**
 * An independent transcription of Excalidraw 0.18.0-1118751's text editor keydown handler
 * (dist/dev/index.js:25367-25409) and of what its container's onKeyDown still does for a textarea target
 * (:43983-44011). CTRL_OR_CMD is metaKey on macOS, ctrlKey elsewhere (common :2391).
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
  if (cmd && e.key === 'p' && !e.shiftKey && !e.altKey) return 'toast'
  return null
}

describe('spike B K2-K5: key and code that disagree', () => {
  it('K2: Ctrl+Insert typed on the NumLock-off numpad (code Numpad0) never reaches the textarea (resetZoom)', () => {
    for (const mac of [false, true]) {
      const e = raw('Insert', 'Numpad0', mac ? { metaKey: true } : { ctrlKey: true })
      // the browser's own Ctrl+Insert (copy) still runs: stopped before Excalidraw, not prevented
      expect(classifyKey(e, { ...GRANTED, mac })).toEqual({ kind: 'browser' })
    }
    // the real Insert key is still a kept chord for the textarea
    expect(classifyKey(raw('Insert', 'Insert', { ctrlKey: true }), GRANTED)).toEqual({ kind: 'delegate' })
  })

  it("K3: BÉPO/KOY Ctrl+Z on the physical BracketLeft is the browser's native undo, never outdent", () => {
    for (const mac of [false, true]) {
      const mod = mac ? { metaKey: true } : { ctrlKey: true }
      expect(classifyKey(raw('z', 'BracketLeft', mod), { ...GRANTED, mac })).toEqual({ kind: 'browser' })
      expect(classifyKey(raw('Z', 'BracketLeft', { ...mod, shiftKey: true }), { ...GRANTED, mac })).toEqual({
        kind: 'browser',
      })
    }
    // QWERTY Ctrl+Z still reaches the textarea
    expect(classifyKey(raw('z', 'KeyZ', { ctrlKey: true }), GRANTED)).toEqual({ kind: 'delegate' })
  })

  it('K4: a named key on a letter code (Neo layer 4) is no letter chord: Ctrl+Enter, Ctrl+Escape, Ctrl+Tab stay blocked', () => {
    expect(classifyKey(raw('Enter', 'KeyV', { ctrlKey: true }), GRANTED)).toEqual({
      kind: 'block',
      preventDefault: true,
    })
    expect(classifyKey(raw('Enter', 'KeyV', { metaKey: true }), { ...GRANTED, mac: true }).kind).toBe('block')
    expect(classifyKey(raw('Escape', 'KeyZ', { ctrlKey: true }), GRANTED).kind).toBe('block')
    expect(classifyKey(raw('Tab', 'KeyX', { ctrlKey: true }), GRANTED).kind).toBe('block')
    expect(isKeptTextEditorChord(raw('Enter', 'KeyV', { ctrlKey: true }), false)).toBe(false)
    expect(isKeptTextEditorChord(raw('Dead', 'KeyZ', { ctrlKey: true }), false)).toBe(false)
    expect(isKeptTextEditorChord(raw('Unidentified', 'KeyC', { ctrlKey: true }), false)).toBe(false)
    // a non-Latin LETTER still names the physical letter (Ctrl+Я is Ctrl+Z to the browser)
    expect(isKeptTextEditorChord(raw('я', 'KeyZ', { ctrlKey: true }), false)).toBe(true)
    expect(chordOf(raw('я', 'KeyZ', { ctrlKey: true }))).toBe('mod+z')
  })

  it("K5: outside the editor, a plain key is delegated only when Excalidraw's code-based tests run nothing else", () => {
    // {key: 'Shift', code: 'KeyC'} with Alt: copyAsPng
    expect(classifyKey(raw('Shift', 'KeyC', { altKey: true, shiftKey: true }), EDITOR).kind).toBe('block')
    // {key: 'ArrowUp', code: 'KeyH'} with Shift: flipHorizontal
    expect(classifyKey(raw('ArrowUp', 'KeyH', { shiftKey: true }), EDITOR).kind).toBe('block')
    // Arrow + Shift on Equal / Digit0-3: zoom and fit
    for (const code of ['Equal', 'Digit0', 'Digit1', 'Digit2', 'Digit3'])
      expect(classifyKey(raw('ArrowLeft', code, { shiftKey: true }), EDITOR).kind, code).toBe('block')
    // Escape / Delete on a code another keyTest reads
    expect(classifyKey(raw('Escape', 'KeyH', { shiftKey: true }), EDITOR).kind).toBe('block')
    expect(classifyKey(raw('Delete', 'KeyV', { shiftKey: true }), EDITOR).kind).toBe('block')
    // read-only: {key: 'Shift', code: 'Digit0'} is resetZoom, Digit1 zoomToFit
    expect(classifyKey(raw('Shift', 'Digit0', { shiftKey: true }), READONLY).kind).toBe('block')
    expect(classifyKey(raw('Shift', 'Digit1', { shiftKey: true }), READONLY).kind).toBe('block')
    // the real keys are still delegated
    expect(classifyKey(raw('Shift', 'ShiftLeft', { shiftKey: true }), EDITOR)).toEqual({ kind: 'delegate' })
    expect(classifyKey(raw('Shift', 'ShiftLeft', { shiftKey: true }), READONLY)).toEqual({ kind: 'delegate' })
    expect(classifyKey(raw('Control', 'ControlLeft', { ctrlKey: true }), EDITOR)).toEqual({
      kind: 'delegate',
    })
    expect(classifyKey(raw('Alt', 'AltLeft', { altKey: true }), EDITOR)).toEqual({ kind: 'delegate' })
    expect(classifyKey(raw('ArrowUp', 'ArrowUp', { shiftKey: true }), EDITOR)).toEqual({ kind: 'delegate' })
    expect(classifyKey(raw('Escape', 'Escape'), EDITOR)).toEqual({ kind: 'delegate' })
    expect(classifyKey(raw('Delete', 'Delete'), EDITOR)).toEqual({ kind: 'delegate' })
    expect(classifyKey(raw(' ', 'Space'), EDITOR)).toEqual({ kind: 'delegate' })
  })

  it('K5: inside the editor, zoom by a modifier or caret key on Equal/Minus/Digit0, and font size on a letter code, never reach the textarea', () => {
    expect(classifyKey(raw('Control', 'Equal', { ctrlKey: true }), GRANTED).kind).not.toBe('delegate')
    expect(classifyKey(raw('ArrowLeft', 'Minus', { ctrlKey: true }), GRANTED).kind).not.toBe('delegate')
    expect(classifyKey(raw('Home', 'Digit0', { ctrlKey: true }), GRANTED).kind).not.toBe('delegate')
    expect(classifyKey(raw('<', 'KeyV', { ctrlKey: true, shiftKey: true }), GRANTED).kind).not.toBe(
      'delegate',
    )
    expect(classifyKey(raw('>', 'KeyZ', { ctrlKey: true, shiftKey: true }), GRANTED).kind).not.toBe(
      'delegate',
    )
    // the real modifier key still reaches the textarea
    expect(classifyKey(raw('Control', 'ControlLeft', { ctrlKey: true }), GRANTED)).toEqual({
      kind: 'delegate',
    })
  })

  // A crafted sweep (every key against every code, 16 modifier sets, both platforms), as the verifier's
  // VK_CRAFTED run did: whatever pairs a layout or a remap produces, a delegated key runs only its own action.
  const KEYS_X = [
    ...'azqvcxhsyp0123'.split(''),
    ...'<>,.?=-[]'.split(''),
    'я',
    'Enter',
    'Escape',
    'Tab',
    'Backspace',
    'Delete',
    'Insert',
    'Home',
    'End',
    ' ',
    'ArrowLeft',
    'ArrowUp',
    'Shift',
    'Control',
    'Alt',
    'Meta',
    'Dead',
    'Unidentified',
  ]
  const CODES_X = [
    'KeyA',
    'KeyC',
    'KeyH',
    'KeyV',
    'KeyZ',
    'KeyY',
    'KeyS',
    'KeyD',
    'KeyR',
    'KeyX',
    'KeyP',
    'Digit0',
    'Digit1',
    'Digit2',
    'Digit3',
    'Numpad0',
    'NumpadAdd',
    'NumpadSubtract',
    'Equal',
    'Minus',
    'BracketLeft',
    'BracketRight',
    'Quote',
    'Slash',
    'Enter',
    'Escape',
    'Insert',
    'ArrowUp',
    'ShiftLeft',
    'ControlLeft',
    'Space',
    '',
  ]
  const crafted: KeyLike[] = []
  for (const key of KEYS_X)
    for (const code of CODES_X)
      for (let m = 0; m < 16; m++)
        crafted.push(
          raw(key, code, {
            ctrlKey: (m & 1) !== 0,
            metaKey: (m & 2) !== 0,
            altKey: (m & 4) !== 0,
            shiftKey: (m & 8) !== 0,
          }),
        )

  for (const mac of [false, true]) {
    const os = mac ? 'macOS' : 'Windows'
    it(`${os}: crafted sweep inside the granted editor: a delegated key triggers no textarea action but unmodified Escape/Tab`, () => {
      const leaks: string[] = []
      let delegated = 0
      for (const e of crafted) {
        if (classifyKey(e, { ...GRANTED, mac }).kind !== 'delegate') continue
        delegated++
        const action = excalidrawTextareaAction(e, mac)
        const chord = e.ctrlKey || e.metaKey || e.altKey
        const kept =
          (action === 'submit' && e.key === 'Escape' && !chord) ||
          (action === 'indent' && e.key === 'Tab' && !chord)
        if (action && !kept) leaks.push(`${JSON.stringify(e)} -> ${action}`)
      }
      expect(leaks.slice(0, 10)).toEqual([])
      expect(delegated).toBeGreaterThan(1000)
    })

    it(`${os}: crafted sweep outside the editor: a delegated key runs only its own Excalidraw action`, () => {
      const leaks: string[] = []
      for (const role of [EDITOR, READONLY]) {
        for (const e of crafted) {
          if (classifyKey(e, { ...role, mac }).kind !== 'delegate') continue
          const chord = delegatedChord(e, mac)
          const allowed = chord
            ? [chord]
            : e.key === 'Escape'
              ? ['finalize', 'deselect']
              : e.key === 'Delete' || e.key === 'Backspace'
                ? ['deleteSelectedElements']
                : []
          const extra = engineKeyActions(e, mac).filter((a) => !allowed.includes(a))
          if (extra.length) leaks.push(`${role.role} ${JSON.stringify(e)} -> ${extra.join(',')}`)
        }
      }
      expect(leaks.slice(0, 10)).toEqual([])
    })
  }

  it("keymap's textareaKeyAction equals this independent transcription on every crafted event", () => {
    for (const e of crafted)
      for (const mac of [false, true])
        expect(textareaKeyAction(e, mac), JSON.stringify(e)).toBe(excalidrawTextareaAction(e, mac))
  })
})
