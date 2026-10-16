import { describe, expect, it } from 'vitest'
import { chipFit, chipScale } from './Chips.tsx'

describe('the card chips', () => {
  it('keep their words readable below 100 % (they grow in scene units)', () => {
    expect(chipScale(1)).toBe(1)
    expect(chipScale(2)).toBe(1)
    expect(chipScale(0.5)).toBe(2)
  })

  it('show the fullest row that fits: words first, then a short date, then icons; never a cut word', () => {
    const due = { text: 'Due tomorrow', short: '17 Oct' }
    expect(chipFit(400, 1, 'In progress', due, true)).toEqual({ statusText: true, due: 'text' })
    expect(chipFit(250, 1, 'In progress', due, true)).toEqual({ statusText: true, due: 'short' })
    expect(chipFit(200, 1, 'In progress', due, true)).toEqual({ statusText: false, due: 'text' })
    expect(chipFit(210, 1.5, 'In progress', due, true)).toEqual({ statusText: false, due: 'short' })
    expect(chipFit(100, 2, 'In progress', due, true)).toEqual({ statusText: false, due: 'icon' })
    expect(chipFit(200, 1, 'To do', null, false)).toEqual({ statusText: true, due: 'text' })
  })
})
