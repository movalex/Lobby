// L8-1 and L8-2: the sort popover. One small dialog over the canvas with three views: the ways to sort (colour,
// author, tag, votes; and, with AI, by a lens and onto a 2x2), the lens to group by, and the two axes of a 2x2.
// It opens from the selection bar's "Sort" button, the context menu's "Sort by" and the palette's commands, and
// points at the selection. Escape closes it and gives the keyboard back to what had it; arrows move along the
// ways to sort; it never takes a click meant for the board (a press outside closes it).
import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import type { CanvasFeatureContext } from '../../canvas/api/index.ts'
import { useValue } from '../../lib/signals.ts'
import { placeOnMatrix, sortByLens, validAxes } from './ai.ts'
import { plural } from './copy.ts'
import { MatrixIcon, SortIcon } from './icons.tsx'
import { SORT_KEYS, type SortKey } from './keys.ts'
import { detectMatrix } from './matrix.ts'
import { targetNotes } from './model.ts'
import { sortBy, sortDisabledReason } from './run.ts'
import { ScoresLegend } from './Scores.tsx'
import { closeSortMenu, openSortMenu, type SortMenuState, type SortView, sortMenu } from './state.ts'
import './sort.css'

/** The popover's width, px. */
const WIDTH = 304
/** Kept clear of the canvas' edges, px. */
const EDGE = 12
const GAP = 8
/** Kept clear along the bottom of the canvas: the board's tool bar sits there, px. */
const BOTTOM_CLEAR = 96

/** What each way to sort says under its name. */
const HINTS: Record<SortKey, string> = {
  colour: 'A column for each note colour',
  author: 'A column for each person',
  tag: 'By each note’s first tag',
  votes: 'By the last vote revealed',
}
const LABELS: Record<SortKey, string> = {
  colour: 'By colour',
  author: 'By author',
  tag: 'By tag',
  votes: 'By votes',
}

const LENS_EXAMPLES = ['Customer journey stage', 'Effort', 'Who needs to act', 'Feeling'] as const

const AXIS_PRESETS = [
  { label: 'Impact × Effort', across: ['Effort', 'Low', 'High'], up: ['Impact', 'Low', 'High'] },
  { label: 'Value × Risk', across: ['Risk', 'Low', 'High'], up: ['Value', 'Low', 'High'] },
  { label: 'Urgent × Important', across: ['Urgency', 'Low', 'High'], up: ['Importance', 'Low', 'High'] },
] as const

type AxisFields = readonly [string, string, string]

/** Runs `fn` once the popover has closed and the board has the keyboard again. */
const later = (fn: () => void) => void setTimeout(fn, 0)

export function SortOverlay({ ctx }: { ctx: CanvasFeatureContext }) {
  const { canvas } = ctx
  const state = useValue('lobby-sort-menu-state', () => sortMenu(canvas).get(), [canvas])
  return (
    <div className="dr-sort-overlay">
      <ScoresLegend ctx={ctx} />
      {state && <SortPopover ctx={ctx} state={state} />}
    </div>
  )
}

function SortPopover({ ctx, state }: { ctx: CanvasFeatureContext; state: SortMenuState }) {
  const { canvas } = ctx
  const ref = useRef<HTMLDivElement>(null)
  const titleId = useId()
  const [pos, setPos] = useState<{ left: number; top: number; max: number } | null>(null)
  const count = targetNotes(canvas, state.ids).length

  // placed under the anchor when it fits, else over it, inside the canvas
  useLayoutEffect(() => {
    const pop = ref.current
    const box = canvas.container()?.getBoundingClientRect()
    if (!pop || !box) return
    // the content's own height (a max-height from an earlier view does not clip the measure)
    const h = pop.scrollHeight + 2
    const left = Math.max(EDGE, Math.min(state.at.x - WIDTH / 2, box.width - WIDTH - EDGE))
    // clear of the board's tool bar along the bottom
    const limit = box.height - BOTTOM_CLEAR
    const under = state.at.bottom + GAP
    const spaceBelow = limit - under
    const spaceAbove = state.at.top - GAP - EDGE
    const below = h <= spaceBelow || spaceBelow >= spaceAbove
    const top = below ? under : Math.max(EDGE, state.at.top - GAP - Math.min(h, spaceAbove))
    setPos({ left, top, max: Math.max(160, below ? spaceBelow : spaceAbove) })
  }, [canvas, state.at, state.view])

  // focus goes in when it opens (and when its view changes); a press outside closes it
  // (a popover that is not placed yet is not shown, and a hidden element takes no focus)
  const placed = pos !== null
  useEffect(() => {
    if (!placed) return
    const first = ref.current?.querySelector<HTMLElement>('[data-autofocus], [role="menuitem"]')
    first?.focus({ preventScroll: true })
  }, [state.view, placed])
  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node | null
      if (t && (ref.current?.contains(t) || state.opener?.contains(t))) return
      closeSortMenu(canvas, false)
    }
    document.addEventListener('pointerdown', onDown, true)
    return () => document.removeEventListener('pointerdown', onDown, true)
  }, [canvas, state.opener])

  const close = (giveBack = true) => closeSortMenu(canvas, giveBack)
  const run = (fn: () => void) => {
    close()
    later(fn)
  }
  const go = (view: SortView) => openSortMenu(ctx, view, state.at, state.ids, state.opener)

  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      close()
      return
    }
    if (state.view !== 'menu') return
    const items = [...(ref.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])]
    const at = items.indexOf(document.activeElement as HTMLElement)
    const move = (to: number) => {
      e.preventDefault()
      items[(to + items.length) % items.length]?.focus({ preventScroll: true })
    }
    if (e.key === 'ArrowDown') move(at + 1)
    else if (e.key === 'ArrowUp') move(at < 0 ? -1 : at - 1)
    else if (e.key === 'Home') move(0)
    else if (e.key === 'End') move(items.length - 1)
  }

  // keys are handled on the popover itself (a listener, not a prop: the popover is a dialog, not a control)
  const keys = useRef(onKey)
  keys.current = onKey
  useEffect(() => {
    const el = ref.current
    const h = (e: KeyboardEvent) => keys.current(e)
    el?.addEventListener('keydown', h)
    return () => el?.removeEventListener('keydown', h)
  }, [])

  return (
    <div
      ref={ref}
      className="dr-sort-pop"
      role="dialog"
      aria-labelledby={titleId}
      data-testid="sort-menu"
      data-view={state.view}
      style={{
        width: WIDTH,
        left: pos?.left ?? 0,
        top: pos?.top ?? 0,
        maxHeight: pos?.max,
        visibility: pos ? 'visible' : 'hidden',
      }}
    >
      <div className="dr-sort-pop__head">
        <span className="dr-sort-pop__badge">{state.view === 'axes' ? <MatrixIcon /> : <SortIcon />}</span>
        <h2 className="dr-sort-pop__title" id={titleId}>
          {state.view === 'menu' ? 'Sort' : state.view === 'lens' ? 'Sort by a lens' : 'Place on a 2x2'}
          <span className="dr-sort-pop__about"> · {plural(count, 'note')}</span>
        </h2>
      </div>
      {state.view === 'menu' && <MenuView ctx={ctx} ids={state.ids} run={run} go={go} />}
      {state.view === 'lens' && <LensView ctx={ctx} ids={state.ids} run={run} back={() => go('menu')} />}
      {state.view === 'axes' && <AxesView ctx={ctx} ids={state.ids} run={run} back={() => go('menu')} />}
    </div>
  )
}

function MenuView({
  ctx,
  ids,
  run,
  go,
}: {
  ctx: CanvasFeatureContext
  ids: readonly string[]
  run(fn: () => void): void
  go(view: SortView): void
}) {
  const notes = targetNotes(ctx.canvas, ids).length >= 2
  return (
    <div className="dr-sort-pop__items" role="menu" aria-label="Ways to sort">
      {SORT_KEYS.map((key) => {
        const why = sortDisabledReason(ctx, key, ids)
        return (
          <button
            key={key}
            type="button"
            role="menuitem"
            className="dr-sort-item"
            aria-disabled={why !== null}
            data-testid={`sort-by-${key}`}
            title={why ?? undefined}
            onClick={() => {
              if (why === null) run(() => void sortBy(ctx, key, ids))
            }}
          >
            <span className="dr-sort-item__text">
              <span className="dr-sort-item__label">{LABELS[key]}</span>
              <span className="dr-sort-item__hint">{why ?? HINTS[key]}</span>
            </span>
          </button>
        )
      })}
      <hr className="dr-sort-pop__sep" />
      <button
        type="button"
        role="menuitem"
        className="dr-sort-item"
        aria-disabled={!notes}
        data-testid="sort-by-lens"
        onClick={() => notes && go('lens')}
      >
        <span className="dr-sort-item__text">
          <span className="dr-sort-item__label">By a lens…</span>
          <span className="dr-sort-item__hint">Say how to group them</span>
        </span>
      </button>
      <button
        type="button"
        role="menuitem"
        className="dr-sort-item"
        aria-disabled={!notes}
        data-testid="sort-place"
        onClick={() => {
          if (!notes) return
          // a 2x2 on the board names its own axes; otherwise the person does
          const found = detectMatrix(ctx.canvas, targetNotes(ctx.canvas, ids))
          if (found) run(() => void placeOnMatrix(ctx, { ids }))
          else go('axes')
        }}
      >
        <span className="dr-sort-item__text">
          <span className="dr-sort-item__label">Place on a 2x2…</span>
          <span className="dr-sort-item__hint">Score notes on two axes</span>
        </span>
      </button>
    </div>
  )
}

function LensView({
  ctx,
  ids,
  run,
  back,
}: {
  ctx: CanvasFeatureContext
  ids: readonly string[]
  run(fn: () => void): void
  back(): void
}) {
  const [lens, setLens] = useState('')
  const inputId = useId()
  const ok = lens.trim().length > 0
  const submit = () => ok && run(() => void sortByLens(ctx, lens, ids))
  return (
    <form
      className="dr-sort-form"
      onSubmit={(e) => {
        e.preventDefault()
        submit()
      }}
    >
      <label className="dr-sort-field" htmlFor={inputId}>
        <span>How should they be grouped?</span>
        <input
          id={inputId}
          data-autofocus
          data-testid="sort-lens-input"
          className="dr-input dr-input--block"
          value={lens}
          maxLength={80}
          placeholder="For example, customer journey stage"
          onChange={(e) => setLens(e.target.value)}
        />
      </label>
      <fieldset className="dr-sort-chips">
        <legend className="dr-sr-only">Examples</legend>
        {LENS_EXAMPLES.map((x) => (
          <button key={x} type="button" className="dr-sort-chip" onClick={() => setLens(x)}>
            {x}
          </button>
        ))}
      </fieldset>
      <p className="dr-sort-note">The AI names the groups; Lobby lays the notes out in columns.</p>
      <div className="dr-sort-actions">
        <button type="button" className="dr-btn" onClick={back} data-testid="sort-back">
          Back
        </button>
        <button type="submit" className="dr-btn dr-btn--primary" disabled={!ok} data-testid="sort-lens-go">
          Sort
        </button>
      </div>
    </form>
  )
}

function AxesView({
  ctx,
  ids,
  run,
  back,
}: {
  ctx: CanvasFeatureContext
  ids: readonly string[]
  run(fn: () => void): void
  back(): void
}) {
  const [across, setAcross] = useState<AxisFields>(AXIS_PRESETS[0].across)
  const [up, setUp] = useState<AxisFields>(AXIS_PRESETS[0].up)
  const axes = [
    { name: across[0].trim(), low: across[1].trim(), high: across[2].trim() },
    { name: up[0].trim(), low: up[1].trim(), high: up[2].trim() },
  ] as const
  const ok = validAxes([axes[0], axes[1]])
  const submit = () => ok && run(() => void placeOnMatrix(ctx, { ids, axes: [axes[0], axes[1]] }))
  return (
    <form
      className="dr-sort-form"
      onSubmit={(e) => {
        e.preventDefault()
        submit()
      }}
    >
      <fieldset className="dr-sort-chips">
        <legend className="dr-sr-only">Common axes</legend>
        {AXIS_PRESETS.map((p) => (
          <button
            key={p.label}
            type="button"
            className="dr-sort-chip"
            onClick={() => {
              setAcross(p.across)
              setUp(p.up)
            }}
          >
            {p.label}
          </button>
        ))}
      </fieldset>
      <AxisFieldset legend="Across" testId="across" value={across} onChange={setAcross} autoFocus />
      <AxisFieldset legend="Up" testId="up" value={up} onChange={setUp} />
      <p className="dr-sort-note">
        The AI scores each note on both; Lobby puts it in its square and makes the 2x2.
      </p>
      <div className="dr-sort-actions">
        <button type="button" className="dr-btn" onClick={back} data-testid="sort-back">
          Back
        </button>
        <button type="submit" className="dr-btn dr-btn--primary" disabled={!ok} data-testid="sort-axes-go">
          Place notes
        </button>
      </div>
    </form>
  )
}

function AxisFieldset({
  legend,
  testId,
  value,
  onChange,
  autoFocus,
}: {
  legend: string
  testId: string
  value: AxisFields
  onChange(v: AxisFields): void
  autoFocus?: boolean
}) {
  const set = (i: 0 | 1 | 2, v: string) => {
    const next: [string, string, string] = [value[0], value[1], value[2]]
    next[i] = v
    onChange(next)
  }
  return (
    <fieldset className="dr-sort-axis">
      <legend>{legend}</legend>
      <label>
        <span className="dr-sr-only">{legend}: axis name</span>
        <input
          className="dr-input"
          value={value[0]}
          maxLength={24}
          placeholder="Name"
          data-testid={`sort-axis-${testId}-name`}
          {...(autoFocus ? { 'data-autofocus': true } : {})}
          onChange={(e) => set(0, e.target.value)}
        />
      </label>
      <label>
        <span className="dr-sr-only">{legend}: low end</span>
        <input
          className="dr-input"
          value={value[1]}
          maxLength={16}
          placeholder="Low"
          data-testid={`sort-axis-${testId}-low`}
          onChange={(e) => set(1, e.target.value)}
        />
      </label>
      <label>
        <span className="dr-sr-only">{legend}: high end</span>
        <input
          className="dr-input"
          value={value[2]}
          maxLength={16}
          placeholder="High"
          data-testid={`sort-axis-${testId}-high`}
          onChange={(e) => set(2, e.target.value)}
        />
      </label>
    </fieldset>
  )
}
