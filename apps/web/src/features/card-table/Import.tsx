// OWNER: WS4 (wave T). CSV in: rows pasted from a spreadsheet (or a .csv file's text) become cards, at most 200 at a
// time, in ONE undo step. The header row is recognised (title, status, assignee, start, due, link) and each column's
// meaning can be changed; slash dates read as day/month/year or month/day/year (guessed, and a choice); assignees are
// matched by name or handle among the board's members (a guest's are left out). The cards go into the selected
// Kanban's columns, or as a grid in the middle of the view. Nothing is read from the clipboard without the person's
// own paste.
import { isAllowedLink } from '@draftroom/canvas-schema/limits'
import { kanbanOf, type PlanningElement } from '@draftroom/canvas-schema/planning'
import { useId, useMemo, useState } from 'react'
import type { CanvasFeatureContext } from '../../canvas/api/index.ts'
import { useValue } from '../../lib/signals.ts'
import { cardsOf } from '../cards/bridge.ts'
import { isGuest } from '../cards/people.ts'
import {
  type DateOrder,
  detectMapping,
  guessDateOrder,
  IMPORT_FIELDS,
  type ImportField,
  importPlan,
  MAX_IMPORT_ROWS,
  parseDelimited,
} from './model.ts'
import { createCards } from './rows.ts'

/** The Kanban the selection is (or is in), for "into this Kanban". */
function selectedKanban(ctx: CanvasFeatureContext): { id: string; name: string } | null {
  for (const id of ctx.canvas.selection) {
    const el = ctx.canvas.get(id)
    const frame = el?.type === 'frame' ? el : el?.frameId ? ctx.canvas.get(el.frameId) : undefined
    if (frame && kanbanOf(frame as PlanningElement))
      return { id: frame.id, name: ((frame as { name?: string | null }).name ?? '') || 'Kanban' }
  }
  return null
}

export function ImportForm({ ctx, onDone }: { ctx: CanvasFeatureContext; onDone(): void }) {
  const uid = useId()
  const [text, setText] = useState('')
  const rows = useMemo(() => parseDelimited(text), [text])
  const detected = useMemo(() => detectMapping(rows), [rows])
  const [fields, setFields] = useState<ImportField[] | null>(null)
  const [header, setHeader] = useState<boolean | null>(null)
  const mapping = { header: header ?? detected.header, fields: fields ?? detected.fields }
  const dateCells = rows.flatMap((r) =>
    mapping.fields.flatMap((f, i) => (f === 'start' || f === 'due' ? [r[i] ?? ''] : [])),
  )
  const localeOrder: DateOrder = /^en-(US|PH)$/.test(globalThis.navigator?.language ?? '') ? 'mdy' : 'dmy'
  const [order, setOrder] = useState<DateOrder | null>(null)
  const dateOrder = order ?? guessDateOrder(dateCells, localeOrder)
  const kanban = useValue('card-table.import-kanban', () => selectedKanban(ctx), [ctx])
  const [into, setInto] = useState<'kanban' | 'grid'>('kanban')
  const people = useValue('card-table.import-people', () => cardsOf(ctx.canvas)?.people.list.get() ?? [], [
    ctx,
  ])
  const guest = isGuest(ctx)
  const plan = importPlan(rows, mapping, {
    people,
    order: dateOrder,
    mayAssign: !guest,
    linkAllowed: (l) => isAllowedLink(l, { guest }),
  })
  const width = mapping.fields.length

  const create = () => {
    const ids = createCards(ctx.canvas, plan.cards, kanban && into === 'kanban' ? kanban.id : null)
    if (!ids.length) return
    ctx.notify({
      key: 'card-table:import',
      text: `Made ${ids.length} ${ids.length === 1 ? 'card' : 'cards'}.${plan.cut ? ` ${plan.cut} rows past ${MAX_IMPORT_ROWS} were left out.` : ''}`,
      testId: 'card-table-imported',
    })
    onDone()
  }

  return (
    <section className="dr-ct-import" aria-labelledby={`${uid}-h`} data-testid="card-table-import">
      <h3 id={`${uid}-h`} className="dr-ct-import__title">
        Paste rows
      </h3>
      <label className="dr-ct-import__label" htmlFor={`${uid}-text`}>
        Copy rows from a spreadsheet (or a CSV file) and paste them here. One card per row, up to{' '}
        {MAX_IMPORT_ROWS}.
      </label>
      <textarea
        id={`${uid}-text`}
        className="dr-card-input dr-ct-import__text"
        data-testid="card-table-import-text"
        rows={5}
        spellCheck={false}
        placeholder={'title\tstatus\tassignee\tdue\nStoryboard v2\tIn progress\tAda Lovelace\t2026-10-30'}
        value={text}
        onChange={(e) => {
          setText(e.target.value)
          setFields(null)
          setHeader(null)
        }}
      />
      {rows.length > 0 && (
        <>
          <label className="dr-ct-check">
            <input
              type="checkbox"
              checked={mapping.header}
              data-testid="card-table-import-header"
              onChange={(e) => setHeader(e.target.checked)}
            />
            The first row names the columns
          </label>
          <fieldset className="dr-ct-import__map">
            <legend className="dr-sr-only">What each column holds</legend>
            {Array.from({ length: width }, (_, i) => (
              <label key={`${i}:${mapping.fields[i]}`} className="dr-ct-import__col">
                <span className="dr-ct-import__sample">
                  {rows[0]?.[i]?.slice(0, 24) || `Column ${i + 1}`}
                </span>
                <select
                  className="dr-ct-select"
                  data-testid="card-table-import-field"
                  value={mapping.fields[i]}
                  onChange={(e) => {
                    const next = [...mapping.fields]
                    const f = e.target.value as ImportField
                    // one column per field: the one that held it before is left out
                    if (f !== 'ignore')
                      for (let j = 0; j < next.length; j++) if (next[j] === f) next[j] = 'ignore'
                    next[i] = f
                    setFields(next)
                  }}
                >
                  {IMPORT_FIELDS.map((f) => (
                    <option key={f.id} value={f.id}>
                      {f.label}
                    </option>
                  ))}
                </select>
              </label>
            ))}
          </fieldset>
          {dateCells.some((c) => /\d[/.-]\d/.test(c) && !/^\d{4}-/.test(c.trim())) && (
            <label className="dr-ct-check">
              Dates are
              <select
                className="dr-ct-select"
                data-testid="card-table-import-order"
                value={dateOrder}
                onChange={(e) => setOrder(e.target.value as DateOrder)}
              >
                <option value="dmy">day / month / year</option>
                <option value="mdy">month / day / year</option>
              </select>
            </label>
          )}
          {kanban && (
            <fieldset className="dr-ct-import__into">
              <legend className="dr-sr-only">Where the cards go</legend>
              <label className="dr-ct-check">
                <input type="radio" checked={into === 'kanban'} onChange={() => setInto('kanban')} />
                Into “{kanban.name}”, by status
              </label>
              <label className="dr-ct-check">
                <input type="radio" checked={into === 'grid'} onChange={() => setInto('grid')} />
                As a grid in view
              </label>
            </fieldset>
          )}
          {!mapping.fields.includes('title') && (
            <p className="dr-card-problem">Choose the column that holds each card’s title.</p>
          )}
          {plan.notes.map((n) => (
            <p key={n} className="dr-card-muted dr-ct-import__note">
              {n}
            </p>
          ))}
        </>
      )}
      <div className="dr-ct-foot">
        <button
          type="button"
          className="dr-card-btn dr-ct-primary"
          data-testid="card-table-import-create"
          disabled={!plan.cards.length}
          onClick={create}
        >
          {plan.cards.length
            ? `Make ${plan.cards.length} ${plan.cards.length === 1 ? 'card' : 'cards'}`
            : 'Make cards'}
        </button>
        <button type="button" className="dr-card-btn" onClick={onDone}>
          Cancel
        </button>
      </div>
    </section>
  )
}
