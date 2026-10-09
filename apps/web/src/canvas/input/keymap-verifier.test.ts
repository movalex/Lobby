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
  WAVE_L_CONTEXTUAL_KEYS,
  WAVE_L_KEY_CLAIMS,
  waveLKeyClaimOf,
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

describe('spike B R3: the clipboard chords go to the browser (plan §2.3.3 "Clipboard")', () => {
  const kind = (e: KeyLike, ctx: KeyContext) => classifyKey(e, ctx)
  it("an editor's Ctrl+C, Ctrl+V and Ctrl+Shift+V are the browser's (stopped, not prevented): copy/paste events carry them", () => {
    for (const e of [
      raw('c', 'KeyC', { ctrlKey: true }),
      raw('v', 'KeyV', { ctrlKey: true }),
      raw('V', 'KeyV', { ctrlKey: true, shiftKey: true }),
    ])
      expect(kind(e, EDITOR)).toEqual({ kind: 'browser' })
    // macOS: Cmd, not Ctrl
    expect(kind(raw('c', 'KeyC', { metaKey: true }), { ...EDITOR, mac: true })).toEqual({ kind: 'browser' })
    expect(kind(raw('c', 'KeyC', { ctrlKey: true }), { ...EDITOR, mac: true }).kind).toBe('block')
  })
  it('Ctrl+X (Excalidraw keydown actionCut), Ctrl+Shift+C, Ctrl+Alt+C and AltGr stay blocked; read-only roles are unchanged', () => {
    expect(kind(raw('x', 'KeyX', { ctrlKey: true }), EDITOR)).toMatchObject({
      kind: 'block',
      preventDefault: true,
    })
    expect(kind(raw('C', 'KeyC', { ctrlKey: true, shiftKey: true }), EDITOR).kind).not.toBe('browser')
    expect(kind(raw('c', 'KeyC', { ctrlKey: true, altKey: true }), EDITOR).kind).not.toBe('browser')
    expect(kind(raw('c', 'KeyC', { ctrlKey: true, altKey: true, altGraph: true }), EDITOR).kind).not.toBe(
      'browser',
    )
    for (const e of [raw('c', 'KeyC', { ctrlKey: true }), raw('v', 'KeyV', { ctrlKey: true })])
      expect(kind(e, READONLY)).toMatchObject({ kind: 'block', preventDefault: true })
  })
})

describe('wave L key claims (L3-1): mod+k, mod+Arrow, mod+Shift+Arrow, Alt+Arrow never reach the engine', () => {
  const ARROW_KEYS = ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'] as const
  const PENDING: KeyContext = { ...EDITOR, editor: 'pending' }
  const k = (m: Partial<KeyLike>) => raw('k', 'KeyK', m)
  const arrow = (key: string, m: Partial<KeyLike>) => raw(key, key, m)
  const contexts = [
    ['editor', EDITOR],
    ['read-only', READONLY],
    ['editor on macOS', { ...EDITOR, mac: true }],
    ['read-only on macOS', { ...READONLY, mac: true }],
  ] as const

  it('the table names each claim once, with its chords and who may take them', () => {
    expect(WAVE_L_KEY_CLAIMS.map((c) => c.claim)).toEqual([
      'palette',
      'flow-next',
      'flow-repeat',
      'flow-walk',
    ])
    const chords = WAVE_L_KEY_CLAIMS.flatMap((c) => c.chords)
    expect(new Set(chords).size).toBe(chords.length)
    expect(chords).toHaveLength(13)
    for (const c of WAVE_L_KEY_CLAIMS) expect(c.takenBy.length, c.claim).toBeGreaterThan(0)
    expect([...WAVE_L_CONTEXTUAL_KEYS]).toEqual(['flow.repeat'])
  })

  it('reads each press as its claim (Ctrl or Cmd; never with AltGr or while composing; the letter by layout)', () => {
    expect(waveLKeyClaimOf(k({ ctrlKey: true }))).toBe('palette')
    expect(waveLKeyClaimOf(k({ metaKey: true }))).toBe('palette')
    expect(waveLKeyClaimOf(raw('л', 'KeyK', { ctrlKey: true }))).toBe('palette') // Russian layout, K key
    expect(waveLKeyClaimOf(raw('k', 'KeyV', { ctrlKey: true }))).toBe('palette') // Dvorak: the character decides
    expect(waveLKeyClaimOf(raw('v', 'KeyK', { ctrlKey: true }))).toBeNull()
    expect(waveLKeyClaimOf(k({ ctrlKey: true, shiftKey: true }))).toBeNull()
    expect(waveLKeyClaimOf(k({ ctrlKey: true, altKey: true, altGraph: true }))).toBeNull()
    expect(waveLKeyClaimOf(k({}))).toBeNull()
    for (const a of ARROW_KEYS) {
      expect(waveLKeyClaimOf(arrow(a, { ctrlKey: true })), a).toBe('flow-next')
      expect(waveLKeyClaimOf(arrow(a, { metaKey: true, shiftKey: true })), a).toBe('flow-repeat')
      expect(waveLKeyClaimOf(arrow(a, { altKey: true })), a).toBe('flow-walk')
      expect(waveLKeyClaimOf(arrow(a, {})), a).toBeNull()
      expect(waveLKeyClaimOf(arrow(a, { shiftKey: true })), a).toBeNull()
      expect(waveLKeyClaimOf(arrow(a, { ctrlKey: true, altKey: true })), a).toBeNull()
      expect(waveLKeyClaimOf(arrow(a, { ctrlKey: true, isComposing: true })), a).toBeNull()
    }
  })

  it('Excalidraw would act on them (hyperlink, flowchart, align): the allowlist never delegates one, for any role', () => {
    for (const mac of [false, true]) {
      const mod = mac ? { metaKey: true } : { ctrlKey: true }
      expect(engineKeyActions(k(mod), mac)).toContain('hyperlink')
      for (const a of ARROW_KEYS) {
        expect(engineKeyActions(arrow(a, mod), mac)).toContain('flowchart')
        expect(engineKeyActions(arrow(a, { altKey: true }), mac)).toContain('flowchart')
        expect(
          engineKeyActions(arrow(a, { ...mod, shiftKey: true }), mac).some((x) => x.startsWith('align')),
        ).toBe(true)
      }
    }
    for (const [name, ctx] of contexts) {
      const mod = ctx.mac ? { metaKey: true } : { ctrlKey: true }
      const presses = [
        k(mod),
        ...ARROW_KEYS.flatMap((a) => [arrow(a, mod), arrow(a, { ...mod, shiftKey: true })]),
      ]
      for (const e of presses) {
        const v = classifyKey(e, ctx)
        expect(v, `${name}: ${chordOf(e)}`).toEqual({ kind: 'block', preventDefault: true })
        expect(delegatedChord(e, ctx.mac === true), `${name}: ${chordOf(e)}`).toBeNull()
      }
      // Alt+Arrow stays Lobby's reading-order walk (a11y), never the engine's
      for (const a of ARROW_KEYS)
        expect(classifyKey(arrow(a, { altKey: true }), ctx), `${name}: alt+${a}`).toEqual({
          kind: 'lobby',
          action: 'a11yTraverse',
        })
    }
  })

  it('a pending editor neither buffers nor delegates them', () => {
    expect(classifyKey(k({ ctrlKey: true }), PENDING)).toEqual({ kind: 'block', preventDefault: true })
    for (const a of ARROW_KEYS) expect(classifyKey(arrow(a, { ctrlKey: true }), PENDING).kind).toBe('block')
  })

  it('inside the granted text editor: mod+k is blocked; the arrows stay the caret and selection moves; AltGr types', () => {
    for (const mac of [false, true]) {
      const ctx = { ...GRANTED, mac }
      const mod = mac ? { metaKey: true } : { ctrlKey: true }
      expect(classifyKey(k(mod), ctx)).toEqual({ kind: 'block', preventDefault: true })
      for (const a of ARROW_KEYS) {
        // a word / line move and its selection (the textarea's handler has no action for them)
        expect(textareaKeyAction(arrow(a, mod), mac)).toBeNull()
        expect(classifyKey(arrow(a, mod), ctx), `${mac} mod+${a}`).toEqual({ kind: 'delegate' })
        expect(classifyKey(arrow(a, { ...mod, shiftKey: true }), ctx)).toEqual({ kind: 'delegate' })
        // Alt+Arrow: the caret by word on macOS; elsewhere it would be the browser's Back/Forward
        expect(classifyKey(arrow(a, { altKey: true }), ctx).kind).toBe(mac ? 'delegate' : 'block')
      }
    }
    // AltGr (Windows: Ctrl+Alt) still types its character, here on the K key (Polish: none; a test layout: ĸ)
    expect(classifyKey(raw('ĸ', 'KeyK', { ctrlKey: true, altKey: true, altGraph: true }), GRANTED)).toEqual({
      kind: 'browser',
    })
    // macOS Option characters too
    expect(classifyKey(raw('˚', 'KeyK', { altKey: true }), { ...GRANTED, mac: true })).toEqual({
      kind: 'browser',
    })
  })
})
