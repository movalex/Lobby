import { describe, expect, it } from 'vitest'
import { hostOf, LINK_CARD_KIND, labelOf, linkOf, titleOf } from './link-cards.tsx'

const card = (link: unknown, kind: unknown = LINK_CARD_KIND, type = 'rectangle') =>
  ({ type, link, customData: { lobby: { kind } } }) as never

describe('D2: link cards', () => {
  it('a link card is a rectangle of kind link-card with an http(s) link (the converter’s too)', () => {
    expect(linkOf(card('https://example.com/a'))).toBe('https://example.com/a')
    expect(linkOf(card('http://example.com'))).toBe('http://example.com/')
    expect(linkOf(card('javascript:alert(1)'))).toBeNull()
    expect(linkOf(card('/b/board_1'))).toBeNull()
    expect(linkOf(card('https://example.com', 'highlight'))).toBeNull()
    expect(linkOf(card('https://example.com', LINK_CARD_KIND, 'ellipse'))).toBeNull()
    expect(linkOf({ type: 'rectangle', link: 'https://example.com' } as never)).toBeNull()
  })

  it('the label says the title, then the site; with no title, the site alone', () => {
    const url = 'https://www.example.com/brief'
    expect(hostOf(url)).toBe('example.com')
    expect(labelOf({ title: 'Q3 brief', siteName: 'Example', icon: null }, url)).toBe(
      'Q3 brief\nExample · example.com',
    )
    expect(labelOf({ title: 'Q3 brief', siteName: 'example.com', icon: null }, url)).toBe(
      'Q3 brief\nexample.com',
    )
    expect(labelOf({ title: null, siteName: null, icon: null }, url)).toBe('example.com')
    expect(titleOf('Q3 brief\nexample.com', url)).toBe('Q3 brief')
    expect(titleOf('', url)).toBe('example.com')
  })
})
