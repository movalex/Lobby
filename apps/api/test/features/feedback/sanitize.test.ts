// What the api keeps of feedback (apps/api/src/features/feedback/sanitize.ts): plain text only.
import { describe, expect, it } from 'vitest'
import {
  cleanContext,
  cleanLine,
  cleanPath,
  cleanText,
  codePoints,
  STRIPPED_RANGES,
  truncate,
} from '../../../src/features/feedback/sanitize.ts'

const ch = (...codePoints: number[]) => String.fromCodePoint(...codePoints)
const AT = '2030-01-01T00:00:00.000Z'

describe('cleanText', () => {
  it('removes every control and bidi character in the table, one by one, and nothing around them', () => {
    for (const [from, to] of STRIPPED_RANGES)
      for (let cp = from; cp <= to; cp++) {
        if (cp === 0x09 || cp === 0x0a) continue
        // carriage return and NEL are line breaks before they are controls
        if (cp === 0x0d || cp === 0x85) continue
        expect(cleanText(`a${ch(cp)}b`), `U+${cp.toString(16)}`).toBe('ab')
      }
  })

  it('removes the bidi overrides, embeddings and isolates that make text read backwards', () => {
    for (const cp of [
      0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2066, 0x2067, 0x2068, 0x2069, 0x200e, 0x200f, 0x061c,
    ])
      expect(cleanText(`pay${ch(cp)}ment`), `U+${cp.toString(16)}`).toBe('payment')
  })

  it('removes lone surrogates, keeps pairs', () => {
    expect(cleanText(`a${ch(0xd800)}b${ch(0xdfff)}c`)).toBe('abc')
    expect(cleanText(`a${ch(0x1f600)}b`)).toBe(`a${ch(0x1f600)}b`)
    // a pair split by the stripper's own ranges would become two lone halves: it never is
    expect(codePoints(cleanText(ch(0x1f600).repeat(10)))).toBe(10)
  })

  it('keeps tabs, newlines, emoji joiners and ordinary punctuation', () => {
    expect(cleanText('a\tb\nc')).toBe('a\tb\nc')
    const family = ch(0x1f468, 0x200d, 0x1f469, 0x200d, 0x1f467)
    expect(cleanText(family)).toBe(family)
    expect(cleanText('“quotes” — dashes… <b>not html</b> & more')).toBe(
      '“quotes” — dashes… <b>not html</b> & more',
    )
  })

  it('normalises line breaks and caps blank runs', () => {
    expect(cleanText('a\r\nb\rc\u0085d')).toBe('a\nb\nc\nd')
    expect(cleanText(`a${ch(0x2028)}b${ch(0x2029)}c`)).toBe('a\nb\nc')
    expect(cleanText('a\n\n\n\n\n\nb')).toBe('a\n\n\nb')
    expect(cleanText('  \n lead and trail \t \n  ')).toBe('lead and trail')
    expect(cleanText('trailing   \nspaces\t\nhere')).toBe('trailing\nspaces\nhere')
  })

  it('leaves nothing when there was nothing', () => {
    expect(cleanText('')).toBe('')
    expect(cleanText(` \n\t${ch(0x202e)}${ch(0)}${ch(0x200b)} `)).toBe('')
  })
})

describe('cleanLine, truncate, codePoints', () => {
  it('a line is one line: runs of whitespace and breaks become one space', () => {
    expect(cleanLine('  Q4 \n\t plan\r\n(final)  ')).toBe('Q4 plan (final)')
    expect(cleanLine(`Plan${ch(0x202e)}2`)).toBe('Plan2')
    expect(cleanLine(`a${ch(0x2028)}b`)).toBe('a b')
  })

  it('counts and cuts by characters, never through a surrogate pair', () => {
    const s = ch(0x1f600).repeat(5)
    expect(codePoints(s)).toBe(5)
    expect(s.length).toBe(10)
    expect(truncate(s, 3)).toBe(ch(0x1f600).repeat(3))
    expect(truncate('abcdef', 3)).toBe('abc')
    expect(truncate('ab', 3)).toBe('ab')
    // the cut string is valid UTF-16
    expect(/\p{Cs}/u.test(truncate(`${'a'.repeat(299)}${ch(0x1f600)}`, 300))).toBe(false)
  })
})

describe('cleanPath', () => {
  it('keeps the path, never a query string or a fragment', () => {
    expect(cleanPath('/b/b-abc1234567')).toBe('/b/b-abc1234567')
    expect(cleanPath('/w/wsp_abcdefghij/all?q=secret&x=1')).toBe('/w/wsp_abcdefghij/all')
    expect(cleanPath('/b/b-abc1234567#comment=3')).toBe('/b/b-abc1234567')
    expect(cleanPath('/feedback?status=done#top')).toBe('/feedback')
    expect(cleanPath('/?returnTo=/b/x')).toBe('/')
  })

  it('replaces an invitation link’s token', () => {
    expect(cleanPath('/invite/AbCdEf0123456789secretTOKEN')).toBe('/invite/:token')
    expect(cleanPath('/invite/AbCdEf0123456789secretTOKEN?x=1')).toBe('/invite/:token')
    expect(cleanPath('/invite/TOKEN/extra')).toBe('/invite/:token/extra')
  })

  it('refuses what is not a path on this site', () => {
    for (const bad of ['', 'https://evil.example/x', '//evil.example/x', 'b/b-1', 12, null, undefined, {}])
      expect(cleanPath(bad), String(bad)).toBe('(unknown)')
    expect(cleanPath('\\\\evil.example\\x')).toBe('(unknown)')
  })

  it('is capped at 200 characters and carries no control characters', () => {
    expect(cleanPath(`/${'a'.repeat(500)}`)).toHaveLength(200)
    expect(cleanPath(`/b/${ch(0x1b)}x${ch(0x202e)}y`)).toBe('/b/xy')
  })
})

describe('cleanContext', () => {
  const full = {
    path: '/b/b-abc1234567?x=1',
    boardId: 'b-abc1234567',
    boardTitle: '  Q4\nplan  ',
    userAgent: 'Mozilla/5.0 (X11; Linux x86_64) Firefox/140.0',
    viewport: { width: 1280.4, height: 720.6 },
    build: 'abc1234',
    at: '2026-10-05T10:00:00Z',
  }

  it('keeps a valid context, tidied', () => {
    expect(cleanContext(full, AT)).toEqual({
      path: '/b/b-abc1234567',
      boardId: 'b-abc1234567',
      boardTitle: 'Q4 plan',
      userAgent: 'Mozilla/5.0 (X11; Linux x86_64) Firefox/140.0',
      viewport: { width: 1280, height: 721 },
      build: 'abc1234',
      at: '2026-10-05T10:00:00.000Z',
    })
  })

  it('defaults every field that is missing or not valid, whatever came in', () => {
    const empty = {
      path: '(unknown)',
      boardId: null,
      boardTitle: null,
      userAgent: '',
      viewport: { width: 0, height: 0 },
      build: 'unknown',
      at: AT,
    }
    for (const raw of [undefined, null, 'text', 42, [], [1, 2], {}, { path: 1, viewport: 'x', at: 5 }])
      expect(cleanContext(raw, AT), JSON.stringify(raw)).toEqual(empty)
  })

  it('caps sizes: a title at 120, an agent at 300, a viewport at 20,000', () => {
    const c = cleanContext(
      {
        ...full,
        boardTitle: 't'.repeat(500),
        userAgent: 'u'.repeat(900),
        viewport: { width: 1e9, height: -3 },
      },
      AT,
    )
    expect(c.boardTitle).toHaveLength(120)
    expect(c.userAgent).toHaveLength(300)
    expect(c.viewport).toEqual({ width: 20_000, height: 0 })
  })

  it('accepts a board id only in the board id format, and a build only as a plain version string', () => {
    for (const bad of ['B-UPPER', 'x', '../etc', 'b-1 2', `b-${'a'.repeat(80)}`])
      expect(cleanContext({ ...full, boardId: bad }, AT).boardId, bad).toBeNull()
    for (const bad of ['has space', 'x'.repeat(41), '<script>', ''])
      expect(cleanContext({ ...full, build: bad }, AT).build, bad).toBe('unknown')
    expect(cleanContext({ ...full, build: '1.2.3-rc.1+abc' }, AT).build).toBe('1.2.3-rc.1+abc')
  })

  it('takes the client time only as an ISO time, else the api’s own', () => {
    for (const bad of ['yesterday', '10/05/2026', '2026', 1_700_000_000_000, 'T'.repeat(80)])
      expect(cleanContext({ ...full, at: bad }, AT).at, String(bad)).toBe(AT)
    expect(cleanContext({ ...full, at: '2026-10-05T10:00:00+02:00' }, AT).at).toBe('2026-10-05T08:00:00.000Z')
  })

  it('never carries a key it does not know', () => {
    expect(
      Object.keys(cleanContext({ ...full, token: 'secret', cookies: 'x', __proto__: { a: 1 } }, AT)).sort(),
    ).toEqual(['at', 'boardId', 'boardTitle', 'build', 'path', 'userAgent', 'viewport'])
  })
})
