/**
 * Key chords for the key and command registries (docs/EXCALIDRAW-CONTRACTS.md §3): one readable
 * notation instead of tldraw's `kbd` strings (`$!f`). Frozen at wave 1.
 *
 *   'n', 'mod+f', 'mod+shift+z', 'alt+1', 'shift+f10', 'enter', 'escape', 'pagedown', 'space', 'f6'
 *
 * `mod` is Cmd on macOS and Ctrl elsewhere; `ctrl` and `meta` are literal. Letters and digits match on
 * `KeyboardEvent.code` (so Alt+1 on a Mac, whose `key` is '¡', and non-Latin layouts still match);
 * every other key matches on `key`, lowercased. A chord matches only its exact modifier set. Pure.
 */
import type { KeyEventLike } from '../registries.ts'

export type { KeyEventLike }

export type KeyChord = string

export interface ParsedChord {
  /** the key without modifiers, lowercased ('f', '1', 'enter', 'f10', 'arrowup', ' ') */
  readonly key: string
  readonly mod: boolean
  readonly ctrl: boolean
  readonly meta: boolean
  readonly alt: boolean
  readonly shift: boolean
}

export type Platform = 'mac' | 'other'

const ALIASES: Record<string, string> = {
  esc: 'escape',
  del: 'delete',
  space: ' ',
  up: 'arrowup',
  down: 'arrowdown',
  left: 'arrowleft',
  right: 'arrowright',
  return: 'enter',
  plus: '+',
}

/** Parses a chord. Throws on an empty key, an unknown modifier or a repeated one (a registry bug). */
export function parseChord(chord: KeyChord): ParsedChord {
  const s = chord.toLowerCase()
  // the '+' key itself: '+', 'mod++' (or 'mod+plus')
  let parts: string[]
  let rawKey: string
  if (s === '+') {
    parts = []
    rawKey = '+'
  } else if (s.endsWith('++')) {
    parts = s.slice(0, -2).split('+')
    rawKey = '+'
  } else {
    parts = s.split('+')
    rawKey = parts.pop() ?? ''
  }
  const key = ALIASES[rawKey] ?? rawKey
  if (!key) throw new Error(`key chord "${chord}": no key`)
  const flags = { mod: false, ctrl: false, meta: false, alt: false, shift: false }
  for (const p of parts) {
    const m = p === 'cmd' ? 'meta' : p === 'option' ? 'alt' : p
    if (!(m in flags)) throw new Error(`key chord "${chord}": unknown modifier "${p}"`)
    if (flags[m as keyof typeof flags]) throw new Error(`key chord "${chord}": "${p}" twice`)
    flags[m as keyof typeof flags] = true
  }
  return { key, ...flags }
}

function eventKey(e: KeyEventLike): string {
  const letter = /^Key([A-Z])$/.exec(e.code)
  if (letter) return (letter[1] as string).toLowerCase()
  const digit = /^(?:Digit|Numpad)([0-9])$/.exec(e.code)
  if (digit) return digit[1] as string
  return e.key.toLowerCase()
}

/** Whether the event is exactly this chord on `platform`. */
export function matchChord(chord: KeyChord | ParsedChord, e: KeyEventLike, platform: Platform): boolean {
  const c = typeof chord === 'string' ? parseChord(chord) : chord
  const wantCtrl = c.ctrl || (c.mod && platform === 'other')
  const wantMeta = c.meta || (c.mod && platform === 'mac')
  if (e.ctrlKey !== wantCtrl || e.metaKey !== wantMeta || e.altKey !== c.alt || e.shiftKey !== c.shift) {
    return false
  }
  return eventKey(e) === c.key
}

const NAMES: Record<string, string> = {
  ' ': 'Space',
  escape: 'Esc',
  arrowup: '↑',
  arrowdown: '↓',
  arrowleft: '←',
  arrowright: '→',
  pageup: 'PgUp',
  pagedown: 'PgDn',
  delete: 'Del',
  backspace: 'Backspace',
  enter: 'Enter',
  tab: 'Tab',
}

/** A label for menus and the shortcuts dialog: 'Ctrl+Shift+F' (Windows, Linux) or '⌘⇧F' (macOS). */
export function formatChord(chord: KeyChord | ParsedChord, platform: Platform): string {
  const c = typeof chord === 'string' ? parseChord(chord) : chord
  const key = NAMES[c.key] ?? (c.key.length === 1 ? c.key.toUpperCase() : c.key.toUpperCase())
  if (platform === 'mac') {
    return `${c.ctrl ? '⌃' : ''}${c.alt ? '⌥' : ''}${c.shift ? '⇧' : ''}${c.mod || c.meta ? '⌘' : ''}${key}`
  }
  const mods = [
    c.ctrl || c.mod ? 'Ctrl' : '',
    c.meta ? 'Win' : '',
    c.alt ? 'Alt' : '',
    c.shift ? 'Shift' : '',
  ]
  return [...mods.filter(Boolean), key].join('+')
}

/** The platform of this browser (Node: 'other'). */
export function currentPlatform(): Platform {
  const nav = (globalThis as { navigator?: { platform?: string; userAgent?: string } }).navigator
  const p = nav?.platform ?? nav?.userAgent ?? ''
  return /Mac|iPhone|iPad|iPod/.test(p) ? 'mac' : 'other'
}
