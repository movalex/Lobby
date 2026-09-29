import { describe, expect, it } from 'vitest'
import { formatChord, type KeyEventLike, matchChord, parseChord } from './keys.ts'

const ev = (key: string, code: string, m: Partial<KeyEventLike> = {}): KeyEventLike => ({
  key,
  code,
  ctrlKey: false,
  metaKey: false,
  altKey: false,
  shiftKey: false,
  ...m,
})

describe('key chords', () => {
  it('parses modifiers, aliases and the plus key', () => {
    expect(parseChord('mod+shift+Z')).toEqual({
      key: 'z',
      mod: true,
      ctrl: false,
      meta: false,
      alt: false,
      shift: true,
    })
    expect(parseChord('esc').key).toBe('escape')
    expect(parseChord('space').key).toBe(' ')
    expect(parseChord('mod++').key).toBe('+')
    expect(parseChord('mod+plus').key).toBe('+')
    expect(() => parseChord('hyper+x')).toThrow(/unknown modifier/)
    expect(() => parseChord('shift+shift+x')).toThrow(/twice/)
  })

  it('mod is Ctrl on Windows and Cmd on macOS; modifier sets are exact', () => {
    const ctrlF = ev('f', 'KeyF', { ctrlKey: true })
    const cmdF = ev('f', 'KeyF', { metaKey: true })
    expect(matchChord('mod+f', ctrlF, 'other')).toBe(true)
    expect(matchChord('mod+f', cmdF, 'other')).toBe(false)
    expect(matchChord('mod+f', cmdF, 'mac')).toBe(true)
    expect(matchChord('mod+f', ev('F', 'KeyF', { ctrlKey: true, shiftKey: true }), 'other')).toBe(false)
    expect(matchChord('f', ev('f', 'KeyF'), 'other')).toBe(true)
  })

  it('letters and digits match on code (Alt+1 on a Mac, non-Latin layouts)', () => {
    expect(matchChord('alt+1', ev('¡', 'Digit1', { altKey: true }), 'mac')).toBe(true)
    expect(matchChord('n', ev('т', 'KeyN'), 'other')).toBe(true)
    expect(matchChord('shift+f10', ev('F10', 'F10', { shiftKey: true }), 'other')).toBe(true)
    expect(matchChord('pagedown', ev('PageDown', 'PageDown'), 'other')).toBe(true)
  })

  it('formats per platform', () => {
    expect(formatChord('mod+shift+f', 'other')).toBe('Ctrl+Shift+F')
    expect(formatChord('mod+shift+f', 'mac')).toBe('⇧⌘F')
    expect(formatChord('alt+1', 'other')).toBe('Alt+1')
    expect(formatChord('pagedown', 'other')).toBe('PgDn')
  })
})
