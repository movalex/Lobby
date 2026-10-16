// Miro's HTML content as plain text (packages/miro-import html.ts): blocks and breaks, entities, links and formatting
// reported, hostile markup (scripts, comments, bidi controls, unclosed tags) and a megabyte of it in linear time.
import { describe, expect, it } from 'vitest'
import { cleanText, htmlToText } from '../src/html.ts'

const cp = (n: number) => String.fromCodePoint(n)

describe('htmlToText', () => {
  it('paragraphs, breaks and list items are lines; tags are dropped; entities decoded', () => {
    expect(htmlToText('<p>One</p><p>Two<br>Three</p>', 100).text).toBe('One\nTwo\nThree')
    expect(htmlToText('<ul><li>a</li><li>b</li></ul>', 100).text).toBe('• a\n• b')
    expect(htmlToText('<p>Fish &amp; chips &lt;3 &#233;t&#xE9; &nbsp;x &bogus;</p>', 100).text).toBe(
      'Fish & chips <3 été x &bogus;',
    )
    expect(htmlToText('plain words', 100)).toEqual({
      text: 'plain words',
      formatted: false,
      truncated: false,
      links: [],
    })
    expect(htmlToText(undefined, 100).text).toBe('')
    expect(htmlToText(42, 100).text).toBe('')
  })

  it('reports formatting and collects links (the caller decides which may stay)', () => {
    const t = htmlToText(
      '<p><strong>Bold</strong> and <a href="https://example.com/a?x=1&amp;y=2">a link</a></p>',
      100,
    )
    expect(t.text).toBe('Bold and a link')
    expect(t.formatted).toBe(true)
    expect(t.links).toEqual(['https://example.com/a?x=1&y=2'])
    expect(htmlToText("<a href='javascript:alert(1)'>x</a>", 100).links).toEqual(['javascript:alert(1)'])
  })

  it('drops script, style and comment content, and every control or bidi character', () => {
    const t = htmlToText(
      `<p>safe</p><script>alert("x")</script><style>p{}</style><!-- secret --><p>a${cp(0x202e)}b${cp(0x200b)}c${cp(0x7)}d</p>`,
      100,
    )
    expect(t.text).toBe('safe\nabcd')
    expect(cleanText(`x${cp(0x2028)}y${cp(0xfeff)}`)).toBe('x\ny')
  })

  it('stray < and unclosed tags are text or dropped, never a loop', () => {
    expect(htmlToText('1 < 2 and <b', 100).text).toBe('1 < 2 and <b')
    expect(htmlToText('<p>x<', 100).text).toBe('x<')
  })

  it('caps the text (truncated) and a megabyte of hostile markup costs milliseconds', () => {
    const t = htmlToText(`<p>${'word '.repeat(10_000)}</p>`, 1000)
    expect(t.text.length).toBe(1000)
    expect(t.truncated).toBe(true)
    const hostile = '<a href="'.repeat(120_000) + '<p '.repeat(100_000)
    const started = performance.now()
    const h = htmlToText(hostile, 20_000)
    expect(performance.now() - started).toBeLessThan(2_000)
    expect(h.text.length).toBeLessThanOrEqual(20_000)
  })
})
