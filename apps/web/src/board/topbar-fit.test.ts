import { describe, expect, it } from 'vitest'
import {
  COMPACT_STEPS,
  compactValue,
  firstFittingLevel,
  hasContent,
  MIN_TITLE_CHARS,
  mayLeaveMenu,
  titleFits,
  titleNeed,
} from './topbar-fit.ts'

describe('compactValue', () => {
  it('lists the first n steps, each level keeping the ones before it', () => {
    expect(compactValue(0)).toBe('')
    expect(compactValue(1)).toBe('link')
    expect(compactValue(2)).toBe('link status')
    expect(compactValue(COMPACT_STEPS.length)).toBe(COMPACT_STEPS.join(' '))
    expect(compactValue(-1)).toBe('')
  })

  it('drops the sharing badge words first and the Present label last', () => {
    expect(COMPACT_STEPS[0]).toBe('link')
    expect(COMPACT_STEPS[COMPACT_STEPS.length - 1]).toBe('present')
  })
})

describe('titleNeed / titleFits', () => {
  const eightPx = (text: string) => Array.from(text).length * 8

  it('a short title must show in full', () => {
    const need = titleNeed('Lobby tour', eightPx, 14)
    expect(need).toBe(Number.POSITIVE_INFINITY)
    expect(titleFits({ client: 94, scroll: 94, need })).toBe(true)
    expect(titleFits({ client: 60, scroll: 94, need })).toBe(false) // "Lobby t…"
  })

  it(`a long title needs ${MIN_TITLE_CHARS} characters and an ellipsis`, () => {
    const title = 'Launch trailer workshop, round two'
    const need = titleNeed(title, eightPx, 14)
    expect(need).toBe((MIN_TITLE_CHARS + 1) * 8 + 14)
    expect(titleFits({ client: need, scroll: 300, need })).toBe(true)
    expect(titleFits({ client: need - 10, scroll: 300, need })).toBe(false)
    expect(titleFits({ client: 300, scroll: 300, need })).toBe(true)
  })

  it('counts characters, not UTF-16 units', () => {
    const title = `${'é'.repeat(MIN_TITLE_CHARS)}🎬 extra`
    expect(titleNeed(title, eightPx, 0)).toBe((MIN_TITLE_CHARS + 1) * 8)
  })

  it('no title element (renaming) fits', () => {
    expect(titleFits(null)).toBe(true)
  })
})

describe('firstFittingLevel', () => {
  it('stops at the first level that fits and applies nothing past it', () => {
    const tried: number[] = []
    expect(
      firstFittingLevel((l) => {
        tried.push(l)
        return l >= 2
      }),
    ).toBe(2)
    expect(tried).toEqual([0, 1, 2])
  })

  it('is null when even the most compact bar is too full (the "⋯" menu)', () => {
    const tried: number[] = []
    expect(
      firstFittingLevel((l) => {
        tried.push(l)
        return false
      }),
    ).toBeNull()
    expect(tried).toEqual(Array.from({ length: COMPACT_STEPS.length + 1 }, (_, i) => i))
  })
})

describe('mayLeaveMenu', () => {
  it('waits for the bar to grow past the width that needed the menu', () => {
    expect(mayLeaveMenu(1000, 1000)).toBe(false)
    expect(mayLeaveMenu(1010, 1000)).toBe(false)
    expect(mayLeaveMenu(1017, 1000)).toBe(true)
  })
})

describe('hasContent (W5-50: the phone "⋯" menu draws no caption over nothing)', () => {
  it('nothing, undefined, false and an empty string draw nothing', () => {
    for (const none of [null, undefined, false, ''] as const) expect(hasContent(none)).toBe(false)
  })

  it('an element, text and a list of them draw something', () => {
    expect(hasContent({ type: 'ul', props: {} })).toBe(true)
    expect(hasContent('3 people')).toBe(true)
    expect(hasContent([{ type: 'li' }])).toBe(true)
    expect(hasContent(0)).toBe(true) // a rendered zero is text
  })
})
