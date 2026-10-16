import { describe, expect, it } from 'vitest'
import {
  dateFromCell,
  detectMapping,
  detectSeparator,
  filterRows,
  gridPlacements,
  guessDateOrder,
  importPlan,
  MAX_IMPORT_ROWS,
  NO_FILTER,
  parseDelimited,
  sortRows,
  statusFromWords,
  type TableRow,
  tableCsv,
} from './model.ts'

const row = (
  id: string,
  over: Omit<Partial<TableRow>, 'card'> & { card?: Partial<TableRow['card']> } = {},
): TableRow => ({
  id,
  title: id,
  who: '',
  tags: [],
  link: '',
  place: '',
  overdue: false,
  ...over,
  card: { status: 'todo', who: null, start: null, due: null, ...(over.card ?? {}) },
})

const PEOPLE = [
  { uid: 'u-ada', name: 'Ada Lovelace', handle: 'ada' },
  { uid: 'u-bob', name: 'Bob Builder', handle: null },
]
const opts = {
  people: PEOPLE,
  order: 'dmy' as const,
  mayAssign: true,
  linkAllowed: (l: string) => /^https:\/\//.test(l),
}

describe('the table: filters and sort', () => {
  const rows = [
    row('b', { title: 'Beta', card: { status: 'done', due: '2026-10-01' } }),
    row('a', { title: 'alpha', who: 'Ada Lovelace', card: { who: 'u-ada', due: '2026-10-20' } }),
    row('c', { title: 'Gamma', overdue: true, card: { status: 'blocked', due: '2026-10-02', who: 'me' } }),
    row('d', { title: 'Delta', card: { status: 'doing' } }),
  ]
  it('status, "Assigned to me", unassigned, a person, overdue and the search', () => {
    const ids = (f: Partial<typeof NO_FILTER>) =>
      filterRows(rows, { ...NO_FILTER, ...f }, 'me').map((r) => r.id)
    expect(ids({ status: 'done' })).toEqual(['b'])
    expect(ids({ who: 'me' })).toEqual(['c'])
    expect(ids({ who: 'none' })).toEqual(['b', 'd'])
    expect(ids({ who: 'u-ada' })).toEqual(['a'])
    expect(ids({ overdue: true })).toEqual(['c'])
    expect(ids({ q: 'LOVE' })).toEqual(['a'])
  })
  it('sorts by any column; empty dates go last both ways', () => {
    expect(sortRows(rows, { key: 'title', dir: 'asc' }).map((r) => r.id)).toEqual(['a', 'b', 'd', 'c'])
    expect(sortRows(rows, { key: 'due', dir: 'asc' }).map((r) => r.id)).toEqual(['b', 'c', 'a', 'd'])
    expect(sortRows(rows, { key: 'due', dir: 'desc' }).map((r) => r.id)).toEqual(['a', 'c', 'b', 'd'])
    expect(sortRows(rows, { key: 'status', dir: 'asc' }).map((r) => r.id)).toEqual(['a', 'd', 'c', 'b'])
  })
})

describe('CSV out', () => {
  it('a header, CRLF rows, formula-safe text, the status in words', () => {
    const csv = tableCsv([
      row('x', {
        title: '=HYPERLINK("http://evil")',
        who: '@ada',
        tags: ['Urgent', 'Client'],
        link: 'https://example.com/a,b',
        card: { status: 'doing', start: '2026-10-01', due: '2026-10-09' },
      }),
      row('y', { title: 'Two\nlines, "quoted"' }),
    ])
    expect(csv).toBe(
      'title,status,assignee,start,due,tags,link\r\n' +
        `"'=HYPERLINK(""http://evil"")",In progress,'@ada,2026-10-01,2026-10-09,Urgent; Client,"https://example.com/a,b"\r\n` +
        '"Two\nlines, ""quoted""",To do,,,,,\r\n',
    )
  })

  it('round trip: what the table writes, the paste reads back the same (formula guard taken off)', () => {
    const rows = [
      row('x', {
        title: '+1 Build the set',
        who: 'Ada Lovelace',
        link: 'https://example.com/brief',
        card: { status: 'review', who: 'u-ada', start: '2026-10-05', due: '2026-10-09' },
      }),
      row('y', { title: 'Shoot day, "B" unit', card: { status: 'blocked', due: '2026-11-30' } }),
      row('z', { title: 'Wrap', who: 'Bob Builder', card: { status: 'done', who: 'u-bob' } }),
    ]
    const parsed = parseDelimited(tableCsv(rows))
    const mapping = detectMapping(parsed)
    expect(mapping.header).toBe(true)
    const plan = importPlan(parsed, mapping, opts)
    expect(plan.notes).toEqual([])
    expect(plan.cards).toEqual([
      {
        title: '+1 Build the set',
        status: 'review',
        who: 'u-ada',
        start: '2026-10-05',
        due: '2026-10-09',
        link: 'https://example.com/brief',
      },
      {
        title: 'Shoot day, "B" unit',
        status: 'blocked',
        who: null,
        start: null,
        due: '2026-11-30',
        link: null,
      },
      { title: 'Wrap', status: 'done', who: 'u-bob', start: null, due: null, link: null },
    ])
  })
})

describe('CSV in', () => {
  it('a spreadsheet paste is tab separated; a European CSV uses semicolons', () => {
    expect(detectSeparator('a\tb\nc\td')).toBe('\t')
    expect(detectSeparator('a;b;c\n1;2;3')).toBe(';')
    expect(detectSeparator('a,b')).toBe(',')
    expect(parseDelimited('Task\tOwner\r\nOne\tAda\r\n\r\nTwo\t\n')).toEqual([
      ['Task', 'Owner'],
      ['One', 'Ada'],
      ['Two', ''],
    ])
    expect(parseDelimited('﻿"a ""b""",c\n"line\none",d')).toEqual([
      ['a "b"', 'c'],
      ['line\none', 'd'],
    ])
  })

  it('a header row is recognised in any order; without one the first column is the title', () => {
    expect(detectMapping([['Owner', 'Task', 'Deadline', 'Notes']])).toEqual({
      header: true,
      fields: ['who', 'title', 'due', 'ignore'],
    })
    expect(
      detectMapping([
        ['Write the brief', 'Ada'],
        ['Shoot', 'Bob', 'x'],
      ]),
    ).toEqual({
      header: false,
      fields: ['title', 'ignore', 'ignore'],
    })
  })

  it('statuses by their words, dates in ISO or the chosen order', () => {
    expect(statusFromWords('In Progress')).toBe('doing')
    expect(statusFromWords('backlog')).toBe('todo')
    expect(statusFromWords('Shipped')).toBe('done')
    expect(statusFromWords('later')).toBeNull()
    expect(dateFromCell('2026-1-5', 'dmy')).toBe('2026-01-05')
    expect(dateFromCell('05/01/2026', 'dmy')).toBe('2026-01-05')
    expect(dateFromCell('05/01/2026', 'mdy')).toBe('2026-05-01')
    expect(dateFromCell('31.12.26', 'dmy')).toBe('2026-12-31')
    expect(dateFromCell('31/02/2026', 'dmy')).toBeNull()
    expect(dateFromCell('soon', 'dmy')).toBeNull()
    expect(guessDateOrder(['3/4/2026', '25/4/2026'], 'mdy')).toBe('dmy')
    expect(guessDateOrder(['4/25/2026'], 'dmy')).toBe('mdy')
  })

  it('assignees by name or handle among the members; a guest assigns nobody; a bad row says so', () => {
    const rows = [
      ['title', 'assignee', 'status', 'start', 'due', 'link'],
      ['One', '@ada', 'doing', '', '', 'javascript:alert(1)'],
      ['Two', 'Carol', 'nope', '10/10/2026', '01/10/2026', ''],
      ['', 'Ada Lovelace', '', '', '', ''],
    ]
    const m = detectMapping(rows)
    const plan = importPlan(rows, m, opts)
    expect(plan.cards).toEqual([
      { title: 'One', status: 'doing', who: 'u-ada', start: null, due: null, link: null },
      { title: 'Two', status: 'todo', who: null, start: null, due: '2026-10-01', link: null },
    ])
    expect(plan.notes).toEqual([
      '1 status was not one Lobby knows: that card is To do.',
      '1 assignee is not on this board: that card is unassigned.',
      '1 date could not be read and was left out.',
      '1 link was not a web address and was left out.',
    ])
    const guest = importPlan(rows, m, { ...opts, mayAssign: false })
    expect(guest.cards.every((c) => c.who === null)).toBe(true)
    expect(guest.notes).toContain('Guests cannot assign people: the assignees were left out.')
  })

  it(`at most ${MAX_IMPORT_ROWS} rows; the rest is counted, not made`, () => {
    const rows = [['title'], ...Array.from({ length: 230 }, (_, i) => [`Card ${i + 1}`])]
    const plan = importPlan(rows, detectMapping(rows), opts)
    expect(plan.cards).toHaveLength(MAX_IMPORT_ROWS)
    expect(plan.cut).toBe(30)
    expect(plan.cards.at(-1)?.title).toBe('Card 200')
  })

  it('a grid of at most 10 per row, centred', () => {
    const g = gridPlacements(4, { x: 0, y: 0 })
    expect(g).toEqual([
      { x: -212, y: -212 },
      { x: 12, y: -212 },
      { x: -212, y: 12 },
      { x: 12, y: 12 },
    ])
    expect(new Set(gridPlacements(200, { x: 0, y: 0 }).map((p) => p.x)).size).toBe(10)
  })
})
