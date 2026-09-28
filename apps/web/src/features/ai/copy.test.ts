import { describe, expect, it } from 'vitest'
import { actionItemText, budgetLine, ideasHeading, plural, themesDone } from './copy.ts'

describe('AI copy', () => {
  it('plural', () => {
    expect(plural(1, 'note')).toBe('1 note')
    expect(plural(3, 'note')).toBe('3 notes')
    expect(plural(2, 'person', 'people')).toBe('2 people')
  })

  it('the ideas heading echoes the prompt, collapsed and cut', () => {
    expect(ideasHeading('  names   for the\nlaunch party ')).toBe('Ideas: names for the launch party')
    expect(ideasHeading('')).toBe('Ideas')
    expect(ideasHeading(undefined)).toBe('Ideas')
    const long = ideasHeading('x'.repeat(200))
    expect(Array.from(long)).toHaveLength('Ideas: '.length + 60)
    expect(long.endsWith('…')).toBe(true)
  })

  it('action items carry their owner on a second line', () => {
    expect(actionItemText({ text: 'Book the studio', owner: 'Sam' })).toBe('Book the studio\nOwner: Sam')
    expect(actionItemText({ text: 'Write the brief', owner: null })).toBe('Write the brief')
  })

  it('the owner’s budget line is the contract’s wording ("AI budget used today: N%")', () => {
    expect(budgetLine(0)).toBe('AI budget used today: 0%')
    expect(budgetLine(37)).toBe('AI budget used today: 37%')
    expect(budgetLine(100)).toBe('AI budget used today: 100%')
  })

  it('what "Group into themes" says afterwards', () => {
    expect(themesDone({ moved: 8, themes: 3, grew: false, skipped: 0 })).toBe(
      'Grouped 8 notes into 3 themes.',
    )
    expect(themesDone({ moved: 1, themes: 1, grew: true, skipped: 2 })).toBe(
      'Grouped 1 note into 1 theme. The frame grew to fit. 2 notes stayed where they were.',
    )
  })
})
