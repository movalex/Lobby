import { describe, expect, it } from 'vitest'
import type { CanvasElement } from '../../canvas/api/index.ts'
import {
  dateProblem,
  dueWords,
  initialsOf,
  isCard,
  isCardable,
  longDateWords,
  makeCardLobby,
  todayLocal,
  unmakeCardLobby,
} from './model.ts'

const el = (type: string, lobby: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) =>
  ({ id: 'e1', type, isDeleted: false, customData: { lobby }, ...extra }) as unknown as CanvasElement

describe('what is a card', () => {
  it('a live rectangle or sticky note with a valid status', () => {
    expect(isCardable(el('rectangle'))).toBe(true)
    expect(isCardable(el('stickynote'))).toBe(true)
    expect(isCardable(el('ellipse'))).toBe(false)
    expect(isCardable(el('rectangle', {}, { isDeleted: true }))).toBe(false)
    expect(isCard(el('stickynote', { 'card:status': 'doing' }))).toBe(true)
    expect(isCard(el('stickynote', { 'card:status': 'later' }))).toBe(false)
    expect(isCard(el('frame', { 'card:status': 'doing' }))).toBe(false)
  })

  it('make writes the status only; unmake removes every card key in the same op', () => {
    expect(makeCardLobby()).toEqual({ 'card:status': 'todo' })
    expect(
      unmakeCardLobby(
        el('stickynote', { 'card:status': 'done', 'card:who': 'u1', 'card:due': '2026-10-20', 'tag:x': {} }),
      ),
    ).toEqual({ 'card:status': null, 'card:who': null, 'card:due': null })
  })
})

describe('dates', () => {
  const card = { status: 'todo' as const, who: null, start: '2026-10-10', due: '2026-10-20' }
  it('a real date from 2000 to 2100, the start never after the due date', () => {
    expect(dateProblem(card, 'due', '2026-10-25')).toBeNull()
    expect(dateProblem(card, 'due', '2026-10-01')).toBe('The due date is before the start.')
    expect(dateProblem(card, 'start', '2026-10-21')).toBe('The start is after the due date.')
    expect(dateProblem(card, 'start', '2026-02-30')).toBe('Pick a date between 2000 and 2100.')
    expect(dateProblem(card, 'start', '1999-12-31')).toBe('Pick a date between 2000 and 2100.')
    expect(dateProblem(card, 'due', null)).toBeNull()
  })

  it('today in the person’s own time zone', () => {
    expect(todayLocal(new Date(2026, 9, 6, 23, 30))).toBe('2026-10-06')
  })

  it('due words against today: soon, this week, later, overdue (never colour alone), done', () => {
    const today = '2026-10-16' // a Friday
    const w = (due: string, status: 'todo' | 'done' = 'todo') => dueWords({ due, status }, today)
    expect(w('2026-10-16')).toMatchObject({ text: 'Due today', soon: true, overdue: false })
    expect(w('2026-10-17')?.text).toBe('Due tomorrow')
    expect(w('2026-10-21')?.text).toBe('Due Wed')
    expect(w('2026-11-02')?.text).toBe('Due 2 Nov')
    expect(w('2027-01-02')?.text).toBe('Due 2 Jan 2027')
    expect(w('2026-10-12')).toMatchObject({ text: 'Overdue · 12 Oct', overdue: true })
    expect(w('2026-10-12')?.label).toBe('Due Monday 12 October 2026, overdue')
    expect(w('2026-10-12', 'done')).toMatchObject({ text: 'Due 12 Oct', overdue: false })
    expect(dueWords({ due: null, status: 'todo' }, today)).toBeNull()
    expect(longDateWords('2026-10-16')).toBe('Friday 16 October 2026')
  })
})

describe('initials', () => {
  it('first and last word', () => {
    expect(initialsOf('Ada Lovelace')).toBe('AL')
    expect(initialsOf('ada king lovelace')).toBe('AL')
    expect(initialsOf('chase')).toBe('C')
    expect(initialsOf('  ')).toBe('?')
    expect(initialsOf('Émile Zola')).toBe('ÉZ')
  })
})
