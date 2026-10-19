// OWNER: WS5 (wave V, the session summary; docs/WAVE-V-CONTRACTS.md §5). "Session results (CSV)": every live activity
// of the board (polls, scales, word clouds; GET /api/boards/:bid/activities, at most the api's 50 most recent) as one
// spreadsheet, oldest first, one row per option, value or word of a revealed activity and one row for an activity
// whose results are not out (open, closed, cancelled). Pure.
//
// Aggregates only: the list route carries counts, never who answered what (an anonymous activity's answers are gone
// once it is revealed; a named one's stay in the api behind GET …/answers, which this export never calls), so no
// person's name or id can reach the file.
//
// Formula-safe: every text cell (the question, an option, a scale label, a word: user-controlled) goes through
// board-ops' csvTextCell, the board CSV's own rule: a cell a spreadsheet could evaluate (its first character `=`, `+`,
// `-`, `@` or their fullwidth forms, also after leading whitespace, or a leading tab or CR) gets a leading `'`; a
// comma, quote or line break is quoted. Numbers are written by this module, never parsed from text.
import { csvTextCell } from '@draftroom/board-ops/elements'
import {
  ACTIVITY_KIND_LABELS,
  type ActivitySummary,
  type LiveActivity,
  rankActivityResults,
} from '@draftroom/contracts'

export const SESSION_CSV_HEADER = [
  'activity',
  'kind',
  'question',
  'status',
  'started',
  'anonymous',
  'answered',
  'rank',
  'result',
  'count',
  'share',
  'mean',
  'median',
] as const

const STATUS_WORDS: Readonly<Record<LiveActivity['status'], string>> = {
  open: 'Open',
  closed: 'Closed',
  revealed: 'Revealed',
  cancelled: 'Cancelled',
}

/** A number cell: rounded to 2 decimals, never -0, never NaN or Infinity (empty instead). */
export function numberCell(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return ''
  const r = Math.round(n * 100) / 100
  return Object.is(r, -0) ? '0' : String(r)
}

/** `count` of `answered` as a percentage (1 decimal), '' with nobody answering. */
const share = (count: number, answered: number) =>
  answered > 0 ? numberCell(Math.round((count / answered) * 1000) / 10) : ''

/** A scale value with its end label, "1 (Not at all)". */
function scaleValue(a: Extract<LiveActivity, { kind: 'scale' }>, v: number): string {
  const label = v === a.config.min ? a.config.minLabel : v === a.config.max ? a.config.maxLabel : null
  return label ? `${v} (${label})` : String(v)
}

/** The activity's status as of `now` (an open activity past its end time is closed, as the api reports it). */
function statusOf(a: LiveActivity, now: number): LiveActivity['status'] {
  if (a.status === 'open' && a.endsAt !== null && Date.parse(a.endsAt) <= now) return 'closed'
  return a.status
}

/** The rows' cells (without the header), one activity after the other, oldest first. */
export function sessionCsvRows(list: readonly ActivitySummary[], now: number = Date.now()): string[][] {
  const ordered = [...list].sort(
    (x, y) =>
      Date.parse(x.activity.createdAt) - Date.parse(y.activity.createdAt) ||
      (x.activity.id < y.activity.id ? -1 : x.activity.id > y.activity.id ? 1 : 0),
  )
  const rows: string[][] = []
  ordered.forEach((s, i) => {
    const a = s.activity
    const status = statusOf(a, now)
    const head = [
      String(i + 1),
      csvTextCell(ACTIVITY_KIND_LABELS[a.kind]),
      csvTextCell(a.prompt),
      csvTextCell(STATUS_WORDS[status]),
      csvTextCell(a.createdAt),
      a.anonymous ? 'yes' : 'no',
      numberCell(s.results?.answered ?? s.answered),
    ]
    const r = s.results
    // results only once revealed (the list route sends none before, and none for a cancelled activity)
    if (!r || status !== 'revealed' || r.kind !== a.kind) {
      rows.push([
        ...head,
        '',
        csvTextCell(status === 'cancelled' ? 'Cancelled' : 'Not revealed'),
        '',
        '',
        '',
        '',
      ])
      return
    }
    if (r.kind === 'poll' && a.kind === 'poll') {
      for (const t of rankActivityResults(r.counts))
        rows.push([
          ...head,
          String(t.rank),
          csvTextCell(a.config.options[t.option] ?? `Option ${t.option + 1}`),
          numberCell(t.count),
          share(t.count, r.answered),
          '',
          '',
        ])
    } else if (r.kind === 'scale' && a.kind === 'scale') {
      r.counts.forEach((count, k) => {
        rows.push([
          ...head,
          '',
          csvTextCell(scaleValue(a, a.config.min + k)),
          numberCell(count),
          share(count, r.answered),
          numberCell(r.mean),
          numberCell(r.median),
        ])
      })
    } else if (r.kind === 'words') {
      if (!r.words.length) rows.push([...head, '', csvTextCell('No words'), '', '', '', ''])
      let rank = 0
      r.words.forEach((w, k) => {
        if (k === 0 || (r.words[k - 1]?.count ?? 0) !== w.count) rank = k + 1
        rows.push([
          ...head,
          String(rank),
          csvTextCell(w.text),
          numberCell(w.count),
          share(w.count, r.answered),
          '',
          '',
        ])
      })
    }
  })
  return rows
}

/** The CSV text: the header and the rows, CRLF-separated, ending with CRLF (as the board CSV). */
export function sessionCsv(list: readonly ActivitySummary[], now: number = Date.now()): string {
  const lines = [SESSION_CSV_HEADER.join(','), ...sessionCsvRows(list, now).map((r) => r.join(','))]
  return `${lines.join('\r\n')}\r\n`
}
