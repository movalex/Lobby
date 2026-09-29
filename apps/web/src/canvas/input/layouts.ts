// Keyboard layouts for the A6 layout sweep (keymap.test.ts and e2e/spike/tests/host-a6-layouts.spec.ts).
// Pure data, no imports. For each physical key (KeyboardEvent.code) the character the layout types
// without and with Shift, which is what Chromium reports as `key` while Ctrl or Cmd is held (a dead key
// reports 'Dead'). Only the main block: the codes Excalidraw's handlers or Lobby's delegated chords read.
// Neo 2 and Bone on German ISO hardware (layers 1 and 2; Mod3/Mod4 characters need extra modifiers and
// are left out). AZERTY is French (France).

export type Layout = Readonly<Record<string, readonly [string, string]>>

const D = 'Dead'

const US_BASE: Record<string, readonly [string, string]> = {
  Backquote: ['`', '~'],
  Digit1: ['1', '!'],
  Digit2: ['2', '@'],
  Digit3: ['3', '#'],
  Digit4: ['4', '$'],
  Digit5: ['5', '%'],
  Digit6: ['6', '^'],
  Digit7: ['7', '&'],
  Digit8: ['8', '*'],
  Digit9: ['9', '('],
  Digit0: ['0', ')'],
  Minus: ['-', '_'],
  Equal: ['=', '+'],
  BracketLeft: ['[', '{'],
  BracketRight: [']', '}'],
  Backslash: ['\\', '|'],
  Semicolon: [';', ':'],
  Quote: ["'", '"'],
  Comma: [',', '<'],
  Period: ['.', '>'],
  Slash: ['/', '?'],
}

/** Letters: `rows` gives the lowercase letter on each letter code, in QWERTY order. */
function letters(rows: string): Record<string, readonly [string, string]> {
  const codes = 'QWERTYUIOPASDFGHJKLZXCVBNM'.split('').map((c) => `Key${c}`)
  const out: Record<string, readonly [string, string]> = {}
  codes.forEach((code, i) => {
    const ch = rows[i] ?? ''
    out[code] = [ch, ch.toUpperCase()]
  })
  return out
}

const QWERTY: Layout = { ...US_BASE, ...letters('qwertyuiopasdfghjklzxcvbnm') }

const QWERTZ: Layout = {
  ...letters('qwertzuiopasdfghjklyxcvbnm'),
  Backquote: [D, '°'],
  Digit1: ['1', '!'],
  Digit2: ['2', '"'],
  Digit3: ['3', '§'],
  Digit4: ['4', '$'],
  Digit5: ['5', '%'],
  Digit6: ['6', '&'],
  Digit7: ['7', '/'],
  Digit8: ['8', '('],
  Digit9: ['9', ')'],
  Digit0: ['0', '='],
  Minus: ['ß', '?'],
  Equal: [D, D],
  BracketLeft: ['ü', 'Ü'],
  BracketRight: ['+', '*'],
  Backslash: ['#', "'"],
  Semicolon: ['ö', 'Ö'],
  Quote: ['ä', 'Ä'],
  IntlBackslash: ['<', '>'],
  Comma: [',', ';'],
  Period: ['.', ':'],
  Slash: ['-', '_'],
}

const AZERTY: Layout = {
  ...letters('azertyuiopqsdfghjklwxcvbn,'),
  KeyM: [',', '?'],
  Backquote: ['²', '²'],
  Digit1: ['&', '1'],
  Digit2: ['é', '2'],
  Digit3: ['"', '3'],
  Digit4: ["'", '4'],
  Digit5: ['(', '5'],
  Digit6: ['-', '6'],
  Digit7: ['è', '7'],
  Digit8: ['_', '8'],
  Digit9: ['ç', '9'],
  Digit0: ['à', '0'],
  Minus: [')', '°'],
  Equal: ['=', '+'],
  BracketLeft: [D, D],
  BracketRight: ['$', '£'],
  Backslash: ['*', 'µ'],
  Semicolon: ['m', 'M'],
  Quote: ['ù', '%'],
  IntlBackslash: ['<', '>'],
  Comma: [';', '.'],
  Period: [':', '/'],
  Slash: ['!', '§'],
}

const DVORAK: Layout = {
  ...US_BASE,
  ...letters("',.pyfgcrlaoeuidhtn;qjkxbm"),
  KeyQ: ["'", '"'],
  KeyW: [',', '<'],
  KeyE: ['.', '>'],
  KeyZ: [';', ':'],
  Minus: ['[', '{'],
  Equal: [']', '}'],
  BracketLeft: ['/', '?'],
  BracketRight: ['=', '+'],
  Semicolon: ['s', 'S'],
  Quote: ['-', '_'],
  Comma: ['w', 'W'],
  Period: ['v', 'V'],
  Slash: ['z', 'Z'],
}

const COLEMAK: Layout = {
  ...US_BASE,
  ...letters('qwfpgjluy;arstdhneizxcvbkm'),
  KeyP: [';', ':'],
  Semicolon: ['o', 'O'],
}

const NEO_BASE: Record<string, readonly [string, string]> = {
  Backquote: [D, D],
  Digit1: ['1', '°'],
  Digit2: ['2', '§'],
  Digit3: ['3', 'ℓ'],
  Digit4: ['4', '»'],
  Digit5: ['5', '«'],
  Digit6: ['6', '$'],
  Digit7: ['7', '€'],
  Digit8: ['8', '„'],
  Digit9: ['9', '“'],
  Digit0: ['0', '”'],
  Minus: ['-', '—'],
  Equal: [D, D],
  BracketRight: [D, D],
  Comma: [',', '–'],
  Period: ['.', '•'],
}

const NEO2: Layout = {
  ...NEO_BASE,
  ...letters('xvlcwkhgfquiaeosnrtüöäpzbm'),
  BracketLeft: ['ß', 'ẞ'],
  Semicolon: ['d', 'D'],
  Quote: ['y', 'Y'],
  Slash: ['j', 'J'],
}

const BONE: Layout = {
  ...NEO_BASE,
  ...letters('jduaxphlmwctieobnrsfvüäöyz'),
  BracketLeft: ['ß', 'ẞ'],
  Semicolon: ['g', 'G'],
  Quote: ['q', 'Q'],
  Slash: ['k', 'K'],
}

export const LAYOUTS: Readonly<Record<string, Layout>> = {
  QWERTY,
  QWERTZ,
  AZERTY,
  Dvorak: DVORAK,
  Colemak: COLEMAK,
  Neo2: NEO2,
  Bone: BONE,
}

/** A delegated chord as QWERTY names it: the physical key and Shift; Ctrl (or Cmd) is implied. */
export interface ChordSpec {
  name: string
  code: string
  shift: boolean
  /** macOS only: Cmd+Option (sendToBack / bringToFront). */
  alt?: boolean
}

/** The plan's delegated Ctrl/Cmd chords (§2.3.3), as a QWERTY keyboard types them. */
export const DELEGATED_CHORDS: readonly ChordSpec[] = [
  { name: 'Ctrl+D', code: 'KeyD', shift: false },
  { name: 'Ctrl+G', code: 'KeyG', shift: false },
  { name: 'Ctrl+Shift+G', code: 'KeyG', shift: true },
  { name: 'Ctrl+Shift+L', code: 'KeyL', shift: true },
  { name: 'Ctrl+[', code: 'BracketLeft', shift: false },
  { name: 'Ctrl+]', code: 'BracketRight', shift: false },
  { name: 'Ctrl+Shift+[', code: 'BracketLeft', shift: true },
  { name: 'Ctrl+Shift+]', code: 'BracketRight', shift: true },
  { name: 'Ctrl+=', code: 'Equal', shift: false },
  { name: 'Ctrl+Shift+= (Ctrl++)', code: 'Equal', shift: true },
  { name: 'Ctrl+-', code: 'Minus', shift: false },
  { name: 'Ctrl+Shift+- (Ctrl+_)', code: 'Minus', shift: true },
  { name: 'Cmd+Option+[ (macOS)', code: 'BracketLeft', shift: false, alt: true },
  { name: 'Cmd+Option+] (macOS)', code: 'BracketRight', shift: false, alt: true },
]

export interface LayoutPress {
  layout: string
  chord: string
  code: string
  key: string
  shift: boolean
  alt: boolean
}

/**
 * Every (code, key) pair the layouts produce for each delegated chord: the chord's physical key on every
 * layout, and every physical key that types the chord's character on every layout. Deduplicated by
 * (code, key, shift, alt); the first layout that produces a pair names it.
 */
export function layoutPresses(): LayoutPress[] {
  const out = new Map<string, LayoutPress>()
  const add = (p: LayoutPress) => {
    const id = `${p.code}|${p.key}|${p.shift}|${p.alt}`
    if (!out.has(id)) out.set(id, p)
  }
  const qwerty = LAYOUTS.QWERTY ?? {}
  for (const chord of DELEGATED_CHORDS) {
    const level = chord.shift ? 1 : 0
    const char = qwerty[chord.code]?.[level]
    for (const [layout, map] of Object.entries(LAYOUTS)) {
      const here = map[chord.code]?.[level]
      if (here !== undefined) {
        add({ layout, chord: chord.name, code: chord.code, key: here, shift: chord.shift, alt: !!chord.alt })
      }
      if (char === undefined) continue
      for (const [code, chars] of Object.entries(map)) {
        for (const lv of [0, 1] as const) {
          if (chars[lv] === char) {
            add({ layout, chord: chord.name, code, key: char, shift: lv === 1, alt: !!chord.alt })
          }
        }
      }
    }
  }
  return [...out.values()]
}
