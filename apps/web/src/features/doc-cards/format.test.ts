import { describe, expect, it } from 'vitest'
import {
  applyFormat,
  continueList,
  formatKey,
  insertLink,
  type TextEdit,
  toggleInline,
  toggleLines,
} from './format.ts'

const at = (value: string, start: number, end = start): TextEdit => ({ value, start, end })
const sel = (e: TextEdit) => e.value.slice(e.start, e.end)

describe('the inline marks', () => {
  it('wraps the selection, and unwraps it again', () => {
    const b = toggleInline(at('a word b', 2, 6), 'bold')
    expect(b.value).toBe('a **word** b')
    expect(sel(b)).toBe('word')
    expect(toggleInline(b, 'bold').value).toBe('a word b')
    expect(toggleInline(at('x **y** z', 2, 7), 'bold').value).toBe('x y z')
  })

  it('with no selection inserts a placeholder to type over', () => {
    const e = toggleInline(at('ab', 1), 'italic')
    expect(e.value).toBe('a_italic text_b')
    expect(sel(e)).toBe('italic text')
    expect(toggleInline(at('', 0), 'code').value).toBe('`code`')
  })

  it('a link keeps the words and selects the address', () => {
    const e = insertLink(at('see docs', 4, 8))
    expect(e.value).toBe('see [docs](https://)')
    expect(sel(e)).toBe('https://')
  })
})

describe('the line marks', () => {
  it('adds a mark to every touched line, replacing another; takes it off when all have it', () => {
    const e = toggleLines(at('one\ntwo\nthree', 1, 6), 'bullet')
    expect(e.value).toBe('- one\n- two\nthree')
    expect(toggleLines(at(e.value, 0, e.value.indexOf('\nthree')), 'bullet').value).toBe('one\ntwo\nthree')
    expect(toggleLines(at('- a\n- b', 0, 7), 'check').value).toBe('- [ ] a\n- [ ] b')
    expect(toggleLines(at('a\nb\nc', 0, 5), 'number').value).toBe('1. a\n2. b\n3. c')
    expect(toggleLines(at('## Old', 3), 'h1').value).toBe('# Old')
    expect(toggleLines(at('# Title', 3), 'h1').value).toBe('Title')
    expect(toggleLines(at('  - nested', 5), 'quote').value).toBe('  > nested')
  })

  it('keeps a collapsed caret on its words', () => {
    const e = toggleLines(at('hello', 3), 'h2')
    expect(e.value).toBe('## hello')
    expect(e.start).toBe(6)
  })

  it('a rule goes on its own line', () => {
    expect(applyFormat(at('ab', 1), 'rule').value).toBe('a\n---\nb')
    expect(applyFormat(at('a\n', 2), 'rule').value).toBe('a\n---\n')
  })
})

describe('Enter in a list', () => {
  it('continues bullets, checklists (unticked), numbers and quotes', () => {
    expect(continueList(at('- one', 5))?.value).toBe('- one\n- ')
    expect(continueList(at('- [x] done', 10))?.value).toBe('- [x] done\n- [ ] ')
    expect(continueList(at('  9. nine', 9))?.value).toBe('  9. nine\n  10. ')
    expect(continueList(at('> q', 3))?.value).toBe('> q\n> ')
  })

  it('an empty item ends the list; plain lines and mid-line carets are ordinary Enters', () => {
    expect(continueList(at('- a\n- ', 6))?.value).toBe('- a\n')
    expect(continueList(at('plain', 5))).toBeNull()
    expect(continueList(at('- one', 2))).toBeNull()
    expect(continueList(at('- one', 1, 3))).toBeNull()
  })
})

describe('the format keys', () => {
  const k = (o: Partial<Parameters<typeof formatKey>[0]>) =>
    formatKey({
      key: '',
      code: '',
      ctrlKey: false,
      metaKey: false,
      altKey: false,
      shiftKey: false,
      mac: false,
      ...o,
    })
  it('Ctrl (Cmd on a Mac) chords only', () => {
    expect(k({ key: 'b', ctrlKey: true })).toBe('bold')
    expect(k({ key: 'B', metaKey: true, mac: true })).toBe('bold')
    expect(k({ key: 'b', metaKey: true })).toBeNull()
    expect(k({ key: 'i', ctrlKey: true })).toBe('italic')
    expect(k({ key: 'k', ctrlKey: true })).toBe('link')
    expect(k({ code: 'Digit2', key: '2', ctrlKey: true, altKey: true })).toBe('h2')
    expect(k({ code: 'Digit8', key: '*', ctrlKey: true, shiftKey: true })).toBe('bullet')
    // AltGr (Ctrl+Alt on Windows) typing a character is typing, not a mark
    expect(k({ key: '@', code: 'KeyQ', ctrlKey: true, altKey: true })).toBeNull()
    expect(k({ key: 'b' })).toBeNull()
  })
})
