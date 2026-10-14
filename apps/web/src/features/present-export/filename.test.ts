import { describe, expect, it } from 'vitest'
import {
  exportFilename,
  FALLBACK_FILENAME,
  frameFileQualifier,
  MAX_BASE_CHARS,
  MAX_NAME_BYTES,
  sanitizeFilename,
} from './filename.ts'

const bytes = (s: string) => new TextEncoder().encode(s).length

describe('sanitizeFilename', () => {
  it('keeps ordinary titles', () => {
    expect(sanitizeFilename('Spring campaign')).toBe('Spring campaign')
    expect(sanitizeFilename('Café crème – moodboard 😀')).toBe('Café crème – moodboard 😀')
  })

  it('turns path separators into dashes and drops characters Windows forbids', () => {
    expect(sanitizeFilename('Q3/Q4: launch*')).toBe('Q3-Q4 launch')
    expect(sanitizeFilename('..\\..\\etc/passwd')).toBe('etc-passwd')
    expect(sanitizeFilename('a<b>c"d?e|f')).toBe('abcde-f')
  })

  it('strips control, zero-width and bidi-override characters', () => {
    expect(sanitizeFilename('evil‮gnp.exe')).toBe('evilgnp.exe')
    expect(sanitizeFilename('tab\there\nnew\u0000line​')).toBe('tab here newline')
  })

  it('removes leading dots and trailing dots/spaces, collapses whitespace', () => {
    expect(sanitizeFilename('.hidden')).toBe('hidden')
    expect(sanitizeFilename('  name. . ')).toBe('name')
    expect(sanitizeFilename('a    b')).toBe('a b')
  })

  it('prefixes Windows device names', () => {
    expect(sanitizeFilename('CON')).toBe('_CON')
    expect(sanitizeFilename('nul.txt')).toBe('_nul.txt')
    expect(sanitizeFilename('com1')).toBe('_com1')
    expect(sanitizeFilename('console')).toBe('console')
  })

  it('falls back when nothing usable is left', () => {
    expect(sanitizeFilename('')).toBe(FALLBACK_FILENAME)
    expect(sanitizeFilename(' ... ')).toBe(FALLBACK_FILENAME)
    expect(sanitizeFilename('***')).toBe(FALLBACK_FILENAME)
    expect(sanitizeFilename(undefined as unknown as string)).toBe(FALLBACK_FILENAME)
  })

  it('caps the length by code points without splitting surrogate pairs', () => {
    const long = '😀'.repeat(300)
    const out = sanitizeFilename(long)
    expect(Array.from(out)).toHaveLength(MAX_BASE_CHARS)
    expect(out.endsWith('😀')).toBe(true)
    expect(/[\ud800-\udbff]$/.test(out)).toBe(false)
  })
})

describe('exportFilename', () => {
  it('joins the board title, an optional qualifier and the extension', () => {
    expect(exportFilename('Spring campaign', 'pdf')).toBe('Spring campaign.pdf')
    expect(exportFilename('Spring campaign', 'png', 'Mood / tone')).toBe('Spring campaign - Mood - tone.png')
    expect(exportFilename('', 'csv')).toBe(`${FALLBACK_FILENAME}.csv`)
    expect(exportFilename('Board', 'svg', '')).toBe('Board.svg')
  })

  it('F15: keeps a long board title whole', () => {
    const title =
      'Halden Coffee — Autumn campaign mood board for the Q4 launch, round 2 with client notes (final)'
    expect(exportFilename(title, 'svg')).toBe(`${title}.svg`)
    expect(exportFilename(title, 'png', '3 · Imagery')).toBe(`${title} - 3 · Imagery.png`)
  })

  it('F15: a title too long for the file system is cut on a whole word', () => {
    const title = `${'Autumn campaign '.repeat(20)}end`
    const name = exportFilename(title, 'pdf')
    expect(bytes(name)).toBeLessThanOrEqual(MAX_NAME_BYTES)
    expect(name).toMatch(/ (Autumn|campaign)\.pdf$/)
  })

  it('stays under the byte limit for long multi-byte titles', () => {
    const name = exportFilename('日本語のボード'.repeat(40), 'png', 'フレーム'.repeat(30))
    expect(bytes(name)).toBeLessThanOrEqual(MAX_NAME_BYTES)
    expect(name.endsWith('.png')).toBe(true)
  })
})

// P-026: a frame's file is named after the frame, not after its place in the deck ("Lobby tour - 1 · Welcome.png").
describe('frameFileQualifier', () => {
  it('drops the number a deck puts in front of a frame name', () => {
    expect(frameFileQualifier('1 · Welcome')).toBe('Welcome')
    expect(frameFileQualifier('12 · Mood board')).toBe('Mood board')
    expect(frameFileQualifier('3. Plan')).toBe('Plan')
    expect(frameFileQualifier('2 - Retro')).toBe('Retro')
    expect(exportFilename('Lobby tour', 'png', frameFileQualifier('1 · Welcome'))).toBe(
      'Lobby tour - Welcome.png',
    )
  })

  it('keeps a name that is only a number, a name without one, and what is not a prefix', () => {
    expect(frameFileQualifier('2024')).toBe('2024')
    expect(frameFileQualifier('Welcome')).toBe('Welcome')
    expect(frameFileQualifier('2024 plan')).toBe('2024 plan')
    expect(frameFileQualifier('1 · ')).toBe('1 ·')
    expect(frameFileQualifier('')).toBe('')
  })
})
