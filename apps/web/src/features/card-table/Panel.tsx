// OWNER: WS4 (wave T; docs/WAVE-T-CONTRACTS.md §1). The card table: a dock panel listing the board's cards (or the
// selection's), with search, filters (status, assignee with "Assigned to me", overdue), sort by any column, inline
// edits of the status, the assignee and the dates (each one undo step; a Kanban card moves with its status), "Show on
// board" (the card's popover), CSV out under the board's export policy and CSV in (./Import.tsx). The title is
// read-only here: it is the card's label, edited on the canvas under the text lease (the popover's "Edit title").
import { CARD_STATUS_LABELS, CARD_STATUSES, type CardStatus } from '@draftroom/canvas-schema/planning'
import { useEffect, useMemo, useState } from 'react'
import type { CanvasFeatureContext } from '../../canvas/api/index.ts'
import { computed, useValue } from '../../lib/signals.ts'
import { exportAllowed, guardExport } from '../canvas-ux/ported/export-gate.ts'
import { cardsOf } from '../cards/bridge.ts'
import { StatusIcon } from '../cards/icons.tsx'
import { dateWords, isCard, PLANNING_DATE_MAX, PLANNING_DATE_MIN, todayLocal } from '../cards/model.ts'
import { isGuest } from '../cards/people.ts'
import { cardsWritable, cardWritable, setDate, setStatus, setWho } from '../cards/write.ts'
import { openCardPopover } from '../planning/index.ts'
import { downloadBlob } from '../present-export/download.ts'
import { exportFilename } from '../present-export/filename.ts'
import { csvBlob } from '../present-export/ported/csv.ts'
import { ImportForm } from './Import.tsx'
import {
  filterRows,
  NO_FILTER,
  type SortKey,
  sortRows,
  type TableFilter,
  type TableRow,
  type TableSort,
  tableCsv,
} from './model.ts'
import { tableRows } from './rows.ts'
import './card-table.css'

export const CARD_TABLE_PANEL_ID = 'card-table'

const COLUMNS: readonly { key: SortKey; label: string }[] = [
  { key: 'title', label: 'Card' },
  { key: 'status', label: 'Status' },
  { key: 'who', label: 'Assignee' },
  { key: 'start', label: 'Start' },
  { key: 'due', label: 'Due' },
]

const sameRows = (a: readonly TableRow[], b: readonly TableRow[]) =>
  a === b || (a.length === b.length && a.every((r, i) => JSON.stringify(r) === JSON.stringify(b[i])))

/** Downloads `rows` as the card table's CSV; returns the words the caller shows. */
export function downloadTableCsv(boardTitle: string, rows: readonly TableRow[]): string {
  downloadBlob(csvBlob(tableCsv(rows)), exportFilename(boardTitle || 'Board', 'csv', 'Cards'))
  return rows.length === 1 ? 'Downloaded 1 card as CSV.' : `Downloaded ${rows.length} cards as CSV.`
}

export function CardTablePanel({ ctx }: { ctx: CanvasFeatureContext; close(): void }) {
  const canvas = ctx.canvas
  const [filter, setFilter] = useState<TableFilter>(NO_FILTER)
  const [sort, setSort] = useState<TableSort>({ key: 'due', dir: 'asc' })
  const [scope, setScope] = useState<'board' | 'selection'>('board')
  const [importing, setImporting] = useState(false)
  const today = todayLocal()
  // the people on the board now (someone may have been added since the board opened)
  useEffect(() => void cardsOf(canvas)?.people.refresh(), [canvas])
  const selectionKey = useValue('card-table.selection', () => canvas.selection.join(' '), [canvas])
  const rowsSignal = useMemo(
    () =>
      computed(
        'card-table.rows',
        () =>
          tableRows(
            ctx,
            cardsOf(canvas),
            today,
            scope === 'selection' ? new Set(canvas.selection) : undefined,
          ),
        { isEqual: sameRows },
      ),
    [ctx, canvas, today, scope],
  )
  const rows = useValue(rowsSignal)
  const people = useValue('card-table.people', () => cardsOf(canvas)?.people.list.get() ?? [], [canvas])
  const writable = useValue('card-table.writable', () => cardsWritable(canvas), [canvas])
  const guest = useValue('card-table.guest', () => isGuest(ctx), [ctx])
  const mayExport = useValue('card-table.export', () => exportAllowed(ctx), [ctx])
  const shown = sortRows(filterRows(rows, filter, ctx.me.user.id), sort)
  const overdue = rows.filter((r) => r.overdue).length
  const anySelectedCard = selectionKey.split(' ').some((id) => id && isCard(canvas.get(id)))

  const toggleSort = (key: SortKey) =>
    setSort((s) => (s.key === key ? { key, dir: s.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: 'asc' }))

  const problem = (r: { ok: true } | { ok: false; problem: string }) => {
    if (!r.ok) ctx.notify({ key: 'card-table:edit', tone: 'error', text: r.problem })
  }

  return (
    <div className="dr-ct" data-testid="card-table">
      <div className="dr-ct-tools">
        <input
          type="search"
          className="dr-card-input dr-ct-search"
          placeholder="Find cards"
          aria-label="Find cards"
          data-testid="card-table-search"
          value={filter.q}
          onChange={(e) => setFilter({ ...filter, q: e.target.value })}
        />
        <select
          className="dr-ct-select"
          aria-label="Status"
          data-testid="card-table-filter-status"
          value={filter.status}
          onChange={(e) => setFilter({ ...filter, status: e.target.value as CardStatus | 'all' })}
        >
          <option value="all">Every status</option>
          {CARD_STATUSES.map((s) => (
            <option key={s} value={s}>
              {CARD_STATUS_LABELS[s]}
            </option>
          ))}
        </select>
        <select
          className="dr-ct-select"
          aria-label="Assignee"
          data-testid="card-table-filter-who"
          value={filter.who}
          onChange={(e) => setFilter({ ...filter, who: e.target.value })}
        >
          <option value="all">Everyone</option>
          <option value="me">Assigned to me</option>
          <option value="none">Unassigned</option>
          {people.map((p) => (
            <option key={p.uid} value={p.uid}>
              {p.name}
            </option>
          ))}
        </select>
        <label className="dr-ct-check">
          <input
            type="checkbox"
            checked={filter.overdue}
            data-testid="card-table-filter-overdue"
            onChange={(e) => setFilter({ ...filter, overdue: e.target.checked })}
          />
          Overdue{overdue ? ` (${overdue})` : ''}
        </label>
        <fieldset className="dr-ct-scope">
          <legend className="dr-sr-only">Which cards</legend>
          {(['board', 'selection'] as const).map((s) => (
            <label key={s} className="dr-ct-check">
              <input
                type="radio"
                name="dr-ct-scope"
                checked={scope === s}
                disabled={s === 'selection' && !anySelectedCard && scope !== 'selection'}
                data-testid={`card-table-scope-${s}`}
                onChange={() => setScope(s)}
              />
              {s === 'board' ? 'Whole board' : 'Selection'}
            </label>
          ))}
        </fieldset>
      </div>

      <p className="dr-ct-summary" aria-live="polite" data-testid="card-table-summary">
        {rows.length === 0
          ? 'No cards yet.'
          : shown.length === rows.length
            ? `${rows.length} ${rows.length === 1 ? 'card' : 'cards'}${overdue ? ` · ${overdue} overdue` : ''}`
            : `${shown.length} of ${rows.length} cards`}
      </p>

      {rows.length === 0 ? (
        <p className="dr-card-muted dr-ct-empty" data-testid="card-table-empty">
          {writable
            ? 'Select sticky notes or rectangles and choose Make a card, or paste rows from a spreadsheet below.'
            : 'This board has no cards.'}
        </p>
      ) : (
        <div className="dr-ct-scroll">
          <table className="dr-ct-table" aria-label="Cards">
            <thead>
              <tr>
                {COLUMNS.map((c) => (
                  <th
                    key={c.key}
                    scope="col"
                    aria-sort={
                      sort.key === c.key ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none'
                    }
                  >
                    <button
                      type="button"
                      className="dr-ct-sort"
                      data-testid={`card-table-sort-${c.key}`}
                      onClick={() => toggleSort(c.key)}
                    >
                      {c.label}
                      <span aria-hidden="true" className="dr-ct-sort__arrow">
                        {sort.key === c.key ? (sort.dir === 'asc' ? '▲' : '▼') : ''}
                      </span>
                    </button>
                  </th>
                ))}
                <th scope="col">Tags</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((r) => (
                <Row
                  key={r.id}
                  ctx={ctx}
                  r={r}
                  today={today}
                  people={people}
                  guest={guest}
                  onProblem={problem}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="dr-ct-foot">
        <button
          type="button"
          className="dr-card-btn"
          data-testid="card-table-export"
          disabled={!shown.length}
          title={mayExport ? undefined : 'Exports are turned off for this board'}
          onClick={() => {
            if (!guardExport(ctx)) return
            ctx.notify({ key: 'card-table:csv', text: downloadTableCsv(ctx.board.title, shown) })
          }}
        >
          Download CSV
        </button>
        {writable && (
          <button
            type="button"
            className="dr-card-btn"
            data-testid="card-table-import-open"
            aria-expanded={importing}
            onClick={() => setImporting((v) => !v)}
          >
            Paste rows…
          </button>
        )}
      </div>
      {importing && writable && <ImportForm ctx={ctx} onDone={() => setImporting(false)} />}
    </div>
  )
}

function Row({
  ctx,
  r,
  today,
  people,
  guest,
  onProblem,
}: {
  ctx: CanvasFeatureContext
  r: TableRow
  today: string
  people: readonly { uid: string; name: string }[]
  guest: boolean
  onProblem(r: { ok: true } | { ok: false; problem: string }): void
}) {
  const canvas = ctx.canvas
  const can = useValue('card-table.row-writable', () => cardWritable(canvas, r.id), [canvas, r.id])
  const known = r.card.who === null || people.some((p) => p.uid === r.card.who)
  const show = (focus?: 'status' | 'who' | 'start' | 'due') => {
    canvas.select([r.id])
    canvas.viewport.ensureVisible([r.id], { margin: 80 })
    openCardPopover(ctx, { id: r.id, ...(focus ? { focus } : {}) })
  }
  return (
    <tr
      data-testid="card-table-row"
      data-element-id={r.id}
      data-status={r.card.status}
      data-overdue={r.overdue || undefined}
    >
      <th scope="row" className="dr-ct-title">
        <button
          type="button"
          className="dr-ct-titlebtn"
          data-testid="card-table-show"
          title="Show on board"
          onClick={() => show()}
        >
          {r.title || <span className="dr-card-muted">Untitled card</span>}
        </button>
        {r.place && <span className="dr-ct-place">{r.place}</span>}
      </th>
      <td>
        <span className="dr-ct-status dr-card-status" data-status={r.card.status}>
          <StatusIcon status={r.card.status} size={13} />
          <select
            className="dr-ct-cell"
            aria-label={`Status of ${r.title || 'the card'}`}
            data-testid="card-table-status"
            value={r.card.status}
            disabled={!can}
            onChange={(e) => setStatus(canvas, [r.id], e.target.value as CardStatus)}
          >
            {CARD_STATUSES.map((s) => (
              <option key={s} value={s}>
                {CARD_STATUS_LABELS[s]}
              </option>
            ))}
          </select>
        </span>
      </td>
      <td>
        <select
          className="dr-ct-cell"
          aria-label={`Assignee of ${r.title || 'the card'}`}
          data-testid="card-table-who"
          value={r.card.who ?? ''}
          disabled={!can || guest}
          title={guest ? "Guests can't assign people" : undefined}
          onChange={(e) => onProblem(setWho(canvas, r.id, e.target.value || null))}
        >
          <option value="">Unassigned</option>
          {!known && r.card.who && <option value={r.card.who}>{r.who} (no longer on this board)</option>}
          {people.map((p) => (
            <option key={p.uid} value={p.uid}>
              {p.name}
            </option>
          ))}
        </select>
      </td>
      <td>
        <DateCell
          label={`Start of ${r.title || 'the card'}`}
          value={r.card.start}
          max={r.card.due ?? PLANNING_DATE_MAX}
          disabled={!can}
          testId="card-table-start"
          onChange={(v) => onProblem(setDate(canvas, r.id, 'start', v))}
        />
      </td>
      <td>
        <DateCell
          label={`Due date of ${r.title || 'the card'}`}
          value={r.card.due}
          min={r.card.start ?? PLANNING_DATE_MIN}
          disabled={!can}
          testId="card-table-due"
          overdue={r.overdue}
          words={r.card.due ? dateWords(r.card.due, today) : null}
          onChange={(v) => onProblem(setDate(canvas, r.id, 'due', v))}
        />
      </td>
      <td className="dr-ct-tags">{r.tags.join(', ')}</td>
    </tr>
  )
}

function DateCell({
  label,
  value,
  min,
  max,
  disabled,
  testId,
  overdue,
  words,
  onChange,
}: {
  label: string
  value: string | null
  min?: string
  max?: string
  disabled: boolean
  testId: string
  overdue?: boolean
  words?: string | null
  onChange(v: string | null): void
}) {
  if (disabled)
    return (
      <span className="dr-ct-date" data-overdue={overdue || undefined} data-testid={testId}>
        {words ?? value ?? '—'}
      </span>
    )
  return (
    <input
      type="date"
      className="dr-ct-cell dr-ct-dateinput"
      aria-label={label}
      data-testid={testId}
      data-overdue={overdue || undefined}
      value={value ?? ''}
      min={min ?? PLANNING_DATE_MIN}
      max={max ?? PLANNING_DATE_MAX}
      onChange={(e) => onChange(e.target.value || null)}
    />
  )
}
