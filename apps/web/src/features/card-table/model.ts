// OWNER: WS4 (wave T; docs/WAVE-T-CONTRACTS.md §1). The card table, pure: the rows (every card on the board, or the
// selection's), their filters and sort, the CSV out (formula-safe: a cell a spreadsheet could run gets a leading `'`;
// RFC 4180 quoting) and in (pasted from a spreadsheet or a file: tab, comma or semicolon separated; a header row is
// recognised; statuses by their words, people by name or handle among the board's members, dates in ISO or the
// person's d/m/y or m/d/y), at most 200 rows per paste, laid out as a grid or into a Kanban's columns.
import { csvTextCell } from '@draftroom/board-ops/elements'
import {
  CARD_STATUS_LABELS,
  CARD_STATUSES,
  type CardFields,
  type CardStatus,
  isPlanningDate,
} from '@draftroom/canvas-schema/planning'

export const MAX_IMPORT_ROWS = 200
/** The longest title a pasted row makes (the rest is cut). */
export const MAX_TITLE_CHARS = 1000

export interface TableRow {
  readonly id: string
  readonly title: string
  readonly card: CardFields
  /** the assignee's name ("" when unassigned) */
  readonly who: string
  readonly tags: readonly string[]
  readonly link: string
  /** the frame it sits in (a Kanban's or a frame's name), "" on the board */
  readonly place: string
  readonly overdue: boolean
}

// ---- filter and sort ----------------------------------------------------------------------------------------------

export type SortKey = 'title' | 'status' | 'who' | 'start' | 'due'
export interface TableSort {
  readonly key: SortKey
  readonly dir: 'asc' | 'desc'
}
export interface TableFilter {
  readonly q: string
  readonly status: CardStatus | 'all'
  /** 'all', 'me' (assigned to me), 'none' (unassigned) or a uid */
  readonly who: string
  readonly overdue: boolean
}
export const NO_FILTER: TableFilter = { q: '', status: 'all', who: 'all', overdue: false }

const collator = new Intl.Collator(undefined, { sensitivity: 'base', numeric: true })

export function filterRows(rows: readonly TableRow[], f: TableFilter, me: string): TableRow[] {
  const q = f.q.trim().toLocaleLowerCase()
  return rows.filter((r) => {
    if (f.status !== 'all' && r.card.status !== f.status) return false
    if (f.who === 'me' && r.card.who !== me) return false
    if (f.who === 'none' && r.card.who !== null) return false
    if (f.who !== 'all' && f.who !== 'me' && f.who !== 'none' && r.card.who !== f.who) return false
    if (f.overdue && !r.overdue) return false
    if (q && !`${r.title}\n${r.who}\n${r.tags.join(' ')}\n${r.place}`.toLocaleLowerCase().includes(q))
      return false
    return true
  })
}

const statusRank = (s: CardStatus) => CARD_STATUSES.indexOf(s)

/** Sorted rows (a stable sort: ties keep the board's order); empty dates and names go last either way. */
export function sortRows(rows: readonly TableRow[], s: TableSort): TableRow[] {
  const dir = s.dir === 'asc' ? 1 : -1
  const empty = (v: string | null) => v === null || v === ''
  const by = (a: TableRow, b: TableRow): number => {
    switch (s.key) {
      case 'title':
        return collator.compare(a.title, b.title) * dir
      case 'status':
        return (statusRank(a.card.status) - statusRank(b.card.status)) * dir
      case 'who': {
        if (empty(a.who) !== empty(b.who)) return empty(a.who) ? 1 : -1
        return collator.compare(a.who, b.who) * dir
      }
      default: {
        const av = a.card[s.key]
        const bv = b.card[s.key]
        if (empty(av) !== empty(bv)) return empty(av) ? 1 : -1
        return av === bv ? 0 : (av ?? '') < (bv ?? '') ? -dir : dir
      }
    }
  }
  return rows
    .map((r, i) => ({ r, i }))
    .sort((a, b) => by(a.r, b.r) || a.i - b.i)
    .map((x) => x.r)
}

// ---- CSV out ------------------------------------------------------------------------------------------------------

export const TABLE_CSV_HEADER = ['title', 'status', 'assignee', 'start', 'due', 'tags', 'link'] as const
export const TAGS_SEPARATOR = '; '

/** The rows as CSV (CRLF, a header row, formula-safe text cells; the caller adds the BOM). */
export function tableCsv(rows: readonly TableRow[]): string {
  const lines = [TABLE_CSV_HEADER.join(',')]
  for (const r of rows)
    lines.push(
      [
        csvTextCell(r.title),
        csvTextCell(CARD_STATUS_LABELS[r.card.status]),
        csvTextCell(r.who),
        r.card.start ?? '',
        r.card.due ?? '',
        csvTextCell(r.tags.join(TAGS_SEPARATOR)),
        csvTextCell(r.link),
      ].join(','),
    )
  return `${lines.join('\r\n')}\r\n`
}

// ---- CSV in -------------------------------------------------------------------------------------------------------

/** The separator a pasted text uses: a tab (a spreadsheet's copy), else `;` when its first line has more, else `,`. */
export function detectSeparator(text: string): '\t' | ',' | ';' {
  const first = text.split(/\r?\n/, 1)[0] ?? ''
  if (first.includes('\t')) return '\t'
  const count = (c: string) => first.split(c).length - 1
  return count(';') > count(',') ? ';' : ','
}

/** RFC 4180 rows (quoted fields with doubled quotes, line breaks inside quotes); empty lines are dropped. */
export function parseDelimited(text: string, sep: string = detectSeparator(text)): string[][] {
  const src = text.replace(/^﻿/, '')
  const rows: string[][] = []
  let row: string[] = []
  let cell = ''
  let quoted = false
  let i = 0
  const endRow = () => {
    row.push(cell)
    if (row.some((c) => c.trim() !== '')) rows.push(row)
    row = []
    cell = ''
  }
  while (i < src.length) {
    const c = src[i] as string
    if (quoted) {
      if (c === '"') {
        if (src[i + 1] === '"') {
          cell += '"'
          i += 2
          continue
        }
        quoted = false
        i++
        continue
      }
      cell += c
      i++
      continue
    }
    if (c === '"' && cell === '') {
      quoted = true
      i++
    } else if (c === sep) {
      row.push(cell)
      cell = ''
      i++
    } else if (c === '\r' || c === '\n') {
      endRow()
      i += c === '\r' && src[i + 1] === '\n' ? 2 : 1
    } else {
      cell += c
      i++
    }
  }
  if (cell !== '' || row.length) endRow()
  return rows
}

export type ImportField = 'title' | 'status' | 'who' | 'start' | 'due' | 'link' | 'ignore'
export const IMPORT_FIELDS: readonly { id: ImportField; label: string }[] = [
  { id: 'title', label: 'Title' },
  { id: 'status', label: 'Status' },
  { id: 'who', label: 'Assignee' },
  { id: 'start', label: 'Start' },
  { id: 'due', label: 'Due' },
  { id: 'link', label: 'Link' },
  { id: 'ignore', label: 'Leave out' },
]

const HEADER_WORDS: readonly [ImportField, RegExp][] = [
  ['title', /^(title|name|task|card|summary|item|what)$/],
  ['status', /^(status|state|column|stage)$/],
  ['who', /^(assignee|assigned to|owner|who|person|responsible)$/],
  ['start', /^(start|start date|starts|begin|from)$/],
  ['due', /^(due|due date|deadline|end|end date|by|until)$/],
  ['link', /^(link|url|href|web address)$/],
]

/** What a header cell names (null: not a header word). */
export function headerField(cell: string): ImportField | null {
  const t = cell.trim().toLocaleLowerCase()
  for (const [f, re] of HEADER_WORDS) if (re.test(t)) return f
  return null
}

/** The column mapping of pasted rows: from a header row when the first row names fields, else title first. */
export function detectMapping(rows: readonly (readonly string[])[]): {
  header: boolean
  fields: ImportField[]
} {
  const first = rows[0] ?? []
  const named = first.map(headerField)
  const width = Math.max(0, ...rows.map((r) => r.length))
  if (named.filter((f) => f !== null).length >= 1 && named[0] !== undefined) {
    const used = new Set<ImportField>()
    const fields = Array.from({ length: width }, (_, i) => {
      const f = named[i] ?? null
      if (!f || used.has(f)) return 'ignore' as const
      used.add(f)
      return f
    })
    if (fields.includes('title')) return { header: true, fields }
  }
  return { header: false, fields: Array.from({ length: width }, (_, i) => (i === 0 ? 'title' : 'ignore')) }
}

const STATUS_WORDS: readonly [CardStatus, RegExp][] = [
  ['todo', /^(to ?do|todo|backlog|not started|open|new|planned)$/],
  ['doing', /^(in progress|doing|progress|wip|started|active|working)$/],
  ['review', /^(in review|review|reviewing|qa|testing|approval)$/],
  ['blocked', /^(blocked|on hold|stuck|waiting)$/],
  ['done', /^(done|complete|completed|finished|closed|shipped)$/],
]

/** A status from its words (our labels and common ones); null when it names none. */
export function statusFromWords(cell: string): CardStatus | null {
  const t = cell.trim().toLocaleLowerCase()
  if (!t) return null
  for (const [s, re] of STATUS_WORDS) if (re.test(t)) return s
  return null
}

/** Our export's formula guard taken off again: `'=1+1` reads back as `=1+1`. */
export const unguard = (cell: string): string =>
  /^'\s*[=+\-@＝＋－＠\t\r]/u.test(cell) ? cell.slice(1) : cell

export type DateOrder = 'dmy' | 'mdy'

/** A date cell as `YYYY-MM-DD`: ISO, or day/month/year in `order` (`/`, `.` or `-`); null when it is none. */
export function dateFromCell(cell: string, order: DateOrder): string | null {
  const t = cell.trim()
  if (!t) return null
  const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(t)
  const p = (v: string | number) => String(v).padStart(2, '0')
  if (iso) {
    const d = `${iso[1]}-${p(iso[2] as string)}-${p(iso[3] as string)}`
    return isPlanningDate(d) ? d : null
  }
  const m = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2}|\d{4})$/.exec(t)
  if (!m) return null
  const a = Number(m[1])
  const b = Number(m[2])
  const y = (m[3] as string).length === 2 ? 2000 + Number(m[3]) : Number(m[3])
  const [day, month] = order === 'dmy' ? [a, b] : [b, a]
  const d = `${y}-${p(month)}-${p(day)}`
  return isPlanningDate(d) ? d : null
}

/** Whether the rows' slash dates read only one way (a first number above 12 means d/m/y): a guess for the chooser. */
export function guessDateOrder(cells: readonly string[], fallback: DateOrder): DateOrder {
  for (const c of cells) {
    const m = /^(\d{1,2})[/.-](\d{1,2})[/.-]\d{2,4}$/.exec(c.trim())
    if (!m) continue
    if (Number(m[1]) > 12) return 'dmy'
    if (Number(m[2]) > 12) return 'mdy'
  }
  return fallback
}

export interface ImportPerson {
  readonly uid: string
  readonly name: string
  readonly handle: string | null
}

export interface ImportCard {
  readonly title: string
  readonly status: CardStatus
  readonly who: string | null
  readonly start: string | null
  readonly due: string | null
  readonly link: string | null
}

export interface ImportPlan {
  readonly cards: readonly ImportCard[]
  /** rows past MAX_IMPORT_ROWS, left out */
  readonly cut: number
  /** what was read differently than written, in words ("3 assignees are not on this board") */
  readonly notes: readonly string[]
}

/** The cards pasted rows make with this mapping. */
export function importPlan(
  rows: readonly (readonly string[])[],
  mapping: { header: boolean; fields: readonly ImportField[] },
  opts: {
    readonly people: readonly ImportPerson[]
    readonly order: DateOrder
    /** a guest may not assign: their assignee cells are left out */
    readonly mayAssign: boolean
    readonly linkAllowed: (link: string) => boolean
  },
): ImportPlan {
  const body = mapping.header ? rows.slice(1) : rows
  const usable = body.slice(0, MAX_IMPORT_ROWS)
  const col = (f: ImportField) => mapping.fields.indexOf(f)
  const at = (r: readonly string[], f: ImportField) => {
    const i = col(f)
    return i >= 0 ? unguard((r[i] ?? '').trim()) : ''
  }
  const byName = new Map<string, string>()
  for (const p of opts.people) {
    byName.set(p.name.toLocaleLowerCase(), p.uid)
    if (p.handle) {
      byName.set(p.handle.toLocaleLowerCase(), p.uid)
      byName.set(`@${p.handle.toLocaleLowerCase()}`, p.uid)
    }
  }
  let unknownStatus = 0
  let unknownWho = 0
  let badDates = 0
  let badLinks = 0
  let noAssign = 0
  const cards: ImportCard[] = []
  for (const r of usable) {
    const title = [...at(r, 'title')].slice(0, MAX_TITLE_CHARS).join('')
    if (!title) continue
    const st = at(r, 'status')
    const status = statusFromWords(st)
    if (st && !status) unknownStatus++
    const w = at(r, 'who')
    let who: string | null = null
    if (w) {
      if (!opts.mayAssign) noAssign++
      else {
        who = byName.get(w.toLocaleLowerCase()) ?? null
        if (!who) unknownWho++
      }
    }
    let start = dateFromCell(at(r, 'start'), opts.order)
    const due = dateFromCell(at(r, 'due'), opts.order)
    if ((at(r, 'start') && !start) || (at(r, 'due') && !due)) badDates++
    // a start after the due date is left out (the due date is what a plan keeps)
    if (start && due && start > due) {
      badDates++
      start = null
    }
    const l = at(r, 'link')
    const link = l && opts.linkAllowed(l) ? l : null
    if (l && !link) badLinks++
    cards.push({ title, status: status ?? 'todo', who, start, due, link })
  }
  const notes: string[] = []
  const n = (k: number, one: string, many: string) =>
    k && notes.push(k === 1 ? one : many.replace('#', String(k)))
  n(
    unknownStatus,
    '1 status was not one Lobby knows: that card is To do.',
    '# statuses were not ones Lobby knows: those cards are To do.',
  )
  n(
    unknownWho,
    '1 assignee is not on this board: that card is unassigned.',
    '# assignees are not on this board: those cards are unassigned.',
  )
  n(
    noAssign,
    'Guests cannot assign people: the assignees were left out.',
    'Guests cannot assign people: the assignees were left out.',
  )
  n(badDates, '1 date could not be read and was left out.', '# dates could not be read and were left out.')
  n(
    badLinks,
    '1 link was not a web address and was left out.',
    '# links were not web addresses and were left out.',
  )
  return { cards, cut: Math.max(0, body.length - MAX_IMPORT_ROWS), notes }
}

// ---- where the new cards go ---------------------------------------------------------------------------------------

export const IMPORT_CARD = 200
export const IMPORT_GAP = 24

/** A grid of `n` cards around `center` (at most 10 per row). */
export function gridPlacements(n: number, center: { x: number; y: number }): { x: number; y: number }[] {
  const cols = Math.min(10, Math.max(1, Math.ceil(Math.sqrt(n))))
  const rows = Math.ceil(n / cols)
  const step = IMPORT_CARD + IMPORT_GAP
  const x0 = Math.round(center.x - (cols * step - IMPORT_GAP) / 2)
  const y0 = Math.round(center.y - (rows * step - IMPORT_GAP) / 2)
  return Array.from({ length: n }, (_, i) => ({
    x: x0 + (i % cols) * step,
    y: y0 + Math.floor(i / cols) * step,
  }))
}
