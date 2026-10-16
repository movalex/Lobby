// OWNER: WS4 (wave T; docs/WAVE-T-CONTRACTS.md §2). The Kanban's columns on the canvas: a `scene` layer (never elements:
// nothing is written to draw them), one container moved and scaled with the camera, one box per Kanban frame with its
// header band (each column's name, its card count, its WIP limit and an "over the limit" warning with an icon) and the
// lines between the columns. When cards stand in another column than their status's (someone moved them at the same
// time, or a tab of the previous build moved them without a status), the column says so with a Tidy button: the
// status is canonical, a reader never infers one from a position. A column's name is renamed in place, its menu
// (./Menu.tsx) hides it or sets its WIP limit. Read-only roles see the columns without controls.
import {
  type CardStatus,
  type KanbanValue,
  kanbanColumns,
  kanbanOf,
  type PlanningElement,
} from '@draftroom/canvas-schema/planning'
import { memo, useEffect, useMemo, useRef, useState } from 'react'
import type { CanvasFeatureContext, LobbyCanvas } from '../../canvas/api/index.ts'
import { computed, type Signal, useValue } from '../../lib/signals.ts'
import { AlertIcon } from '../cards/icons.tsx'
import { useIsolated } from '../tags/isolate.ts'
import { type KanbanState, kanbanStateOf } from './bridge.ts'
import { bandsOf, columnCounts, KANBAN_HEADER_H, mismatches, withLabel } from './layout.ts'
import { boxesIn, rectOf } from './scene.ts'
import { kanbanFrameWritable, tidyKanban, writeKanban } from './write.ts'
import './kanban.css'

/** Below this zoom the columns draw their lines and names only (no controls). */
const CONTROLS_FROM_ZOOM = 0.35

export interface ColumnView {
  readonly status: CardStatus
  readonly label: string
  readonly x: number
  readonly width: number
  readonly count: number
  readonly wip: number | null
  /** the cards standing in this column whose status is another's */
  readonly strays: number
}

export interface KanbanView {
  readonly id: string
  readonly x: number
  readonly y: number
  readonly w: number
  readonly h: number
  readonly value: KanbanValue
  readonly columns: readonly ColumnView[]
  readonly hidden: number
  readonly hiddenStatuses: readonly CardStatus[]
  readonly writable: boolean
}

export function kanbanViews(canvas: LobbyCanvas): KanbanView[] {
  const out: KanbanView[] = []
  for (const el of canvas.index.withLobbyKey('kanban')) {
    if ((el as { isDeleted?: boolean }).isDeleted || el.type !== 'frame' || canvas.isHidden(el.id)) continue
    const value = kanbanOf(el as PlanningElement)
    if (!value) continue
    const frame = rectOf(el)
    const cards = boxesIn(canvas, el.id)
    const bands = bandsOf(frame, value)
    const cols = kanbanColumns(value)
    const { counts, hidden } = columnCounts(value, cards)
    const strays = mismatches(frame, value, cards)
    out.push({
      id: el.id,
      x: el.x,
      y: el.y,
      w: el.width,
      h: el.height,
      value,
      columns: bands.map((b, i) => ({
        status: b.status,
        label: cols[i]?.label ?? b.status,
        x: b.x - el.x,
        width: b.width,
        count: counts.get(b.status) ?? 0,
        wip: cols[i]?.wip ?? null,
        strays: strays.get(b.status)?.length ?? 0,
      })),
      hidden,
      hiddenStatuses: value.hidden ?? [],
      writable: kanbanFrameWritable(canvas, el.id),
    })
  }
  return out
}

const sameViews = (a: readonly KanbanView[], b: readonly KanbanView[]) =>
  a === b || (a.length === b.length && a.every((v, i) => JSON.stringify(v) === JSON.stringify(b[i])))

export function KanbanColumnsLayer({ ctx }: { ctx: CanvasFeatureContext }) {
  const s = useValue('kanban.bridge', () => kanbanStateOf(ctx.canvas), [ctx.canvas])
  return s ? <Scene s={s} /> : null
}

function useViews(canvas: LobbyCanvas): Signal<KanbanView[]> {
  return useMemo(() => computed('kanban.views', () => kanbanViews(canvas), { isEqual: sameViews }), [canvas])
}

function Scene({ s }: { s: KanbanState }) {
  const canvas = s.ctx.canvas
  const views = useValue(useViews(canvas))
  const v = useValue('kanban.viewport', () => canvas.viewport.get(), [canvas])
  const controls = v.zoom >= CONTROLS_FROM_ZOOM
  if (!views.length) return null
  return (
    <div
      className="dr-kanban-scene"
      data-testid="kanban-layer"
      style={{ transform: `scale(${v.zoom}) translate(${-v.x}px, ${-v.y}px)` }}
    >
      {views.map((k) => (
        <Board key={k.id} s={s} k={k} controls={controls} />
      ))}
    </div>
  )
}

const Board = memo(function Board({ s, k, controls }: { s: KanbanState; k: KanbanView; controls: boolean }) {
  return (
    <div
      className="dr-kanban"
      data-testid="kanban"
      data-element-id={k.id}
      style={{ left: k.x, top: k.y, width: k.w, height: k.h }}
    >
      {k.columns.map((c, i) => (
        <div
          key={c.status}
          className="dr-kanban-col"
          data-testid="kanban-column"
          data-status={c.status}
          data-first={i === 0 || undefined}
          style={{ left: c.x, width: c.width }}
        >
          <ColumnHead s={s} k={k} c={c} controls={controls} last={i === k.columns.length - 1} />
        </div>
      ))}
    </div>
  )
})

function ColumnHead({
  s,
  k,
  c,
  controls,
  last,
}: {
  s: KanbanState
  k: KanbanView
  c: ColumnView
  controls: boolean
  last: boolean
}) {
  const canvas = s.ctx.canvas
  const renaming = useValue('kanban.renaming', () => {
    const r = s.renaming.get()
    return r?.frameId === k.id && r.status === c.status
  }, [s, k.id, c.status])
  const over = c.wip !== null && c.count > c.wip
  const can = k.writable && controls
  return (
    <div className="dr-kanban-head" data-over={over || undefined} style={{ height: KANBAN_HEADER_H }}>
      <div className="dr-kanban-head__row">
        {renaming ? (
          <RenameInput s={s} k={k} c={c} />
        ) : can ? (
          <button
            type="button"
            className="dr-kanban-name"
            data-testid="kanban-column-name"
            title="Rename this column"
            onPointerDown={(e) => e.stopPropagation()}
            onClick={() => s.renaming.set({ frameId: k.id, status: c.status })}
          >
            {c.label}
          </button>
        ) : (
          <span className="dr-kanban-name" data-testid="kanban-column-name">
            {c.label}
          </span>
        )}
        <span className="dr-kanban-count" data-testid="kanban-column-count" data-count={c.count}>
          <span aria-hidden="true" className="dr-kanban-count__n">
            {over && <AlertIcon size={12} />}
            {c.wip !== null ? `${c.count} / ${c.wip}` : c.count}
          </span>
          <span className="dr-sr-only">
            {c.wip !== null
              ? `${c.count} of ${c.wip} cards${over ? ', over the limit' : ''}`
              : `${c.count} ${c.count === 1 ? 'card' : 'cards'}`}
          </span>
        </span>
        {can && (
          <button
            type="button"
            className="dr-kanban-menu"
            data-testid="kanban-column-menu"
            aria-label={`${c.label} column options`}
            aria-haspopup="menu"
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => {
              const r = e.currentTarget.getBoundingClientRect()
              s.menu.set({
                frameId: k.id,
                status: c.status,
                anchor: { x: r.left, y: r.bottom, w: r.width, h: r.height },
              })
            }}
          >
            <span aria-hidden="true">⋯</span>
          </button>
        )}
        {last && k.hiddenStatuses.length > 0 && can && (
          <button
            type="button"
            className="dr-kanban-hidden"
            data-testid="kanban-hidden-columns"
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => {
              const r = e.currentTarget.getBoundingClientRect()
              s.menu.set({
                frameId: k.id,
                status: null,
                anchor: { x: r.left, y: r.bottom, w: r.width, h: r.height },
              })
            }}
          >
            +{k.hiddenStatuses.length} hidden
            {k.hidden ? ` · ${k.hidden} ${k.hidden === 1 ? 'card' : 'cards'}` : ''}
          </button>
        )}
      </div>
      {c.strays > 0 && (
        <div className="dr-kanban-strays" data-testid="kanban-mismatch" role="status">
          <AlertIcon size={12} />
          <span>
            {c.strays === 1 ? '1 card in the wrong column' : `${c.strays} cards in the wrong column`}
          </span>
          {can && (
            <button
              type="button"
              className="dr-kanban-tidy"
              data-testid="kanban-tidy"
              onPointerDown={(e) => e.stopPropagation()}
              onClick={() => {
                const n = tidyKanban(canvas, k.id)
                if (n)
                  s.ctx.notify({
                    key: 'kanban:tidy',
                    text: n === 1 ? 'Moved 1 card to its column.' : `Moved ${n} cards to their columns.`,
                  })
              }}
            >
              Tidy
            </button>
          )}
        </div>
      )}
    </div>
  )
}

function RenameInput({ s, k, c }: { s: KanbanState; k: KanbanView; c: ColumnView }) {
  const [text, setText] = useState(c.label)
  const done = useRef(false)
  const fallback = kanbanColumns({})?.find((x) => x.status === c.status)?.label ?? c.label
  const finish = (save: boolean) => {
    if (done.current) return
    done.current = true
    s.renaming.set(null)
    if (save && text.trim() !== c.label) {
      const value = withLabel(k.value, c.status, text, fallback)
      writeKanban(s.ctx.canvas, k.id, value, 'rename column')
    }
    s.ctx.canvas.focus({ preventScroll: true })
  }
  const ref = useIsolated<HTMLInputElement>((e) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      finish(true)
    } else if (e.key === 'Escape') {
      e.preventDefault()
      finish(false)
    }
  })
  useEffect(() => {
    ref.current?.focus()
    ref.current?.select()
  }, [ref])
  return (
    <input
      ref={ref}
      className="dr-kanban-rename"
      data-testid="kanban-column-rename"
      aria-label={`Name of the ${c.label} column`}
      maxLength={40}
      value={text}
      onChange={(e) => setText(e.target.value)}
      onBlur={() => finish(true)}
    />
  )
}
