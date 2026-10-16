// OWNER: WS4 (wave T). A Kanban column's menu, in the Kanban `screen` layer under the column's "⋯" button: Rename,
// Hide column (one column at least stays), the WIP limit; or, from "+N hidden", the hidden columns with Show. Each
// change is one undo step (the frame's whole `kanban` value). Keys and pointers inside never reach the canvas.
import {
  CARD_STATUS_LABELS,
  type CardStatus,
  type KanbanValue,
  kanbanColumns,
  kanbanOf,
  type PlanningElement,
} from '@draftroom/canvas-schema/planning'
import { useEffect, useId, useState } from 'react'
import type { CanvasFeatureContext } from '../../canvas/api/index.ts'
import { useValue } from '../../lib/signals.ts'
import { tryFocus } from '../../ui/focus.ts'
import { useIsolated } from '../tags/isolate.ts'
import { type ColumnMenuRequest, type KanbanState, kanbanStateOf } from './bridge.ts'
import { withHidden, withWip } from './layout.ts'
import { kanbanFrameWritable, writeKanban } from './write.ts'

export function KanbanMenuLayer({ ctx }: { ctx: CanvasFeatureContext }) {
  const s = useValue('kanban.bridge', () => kanbanStateOf(ctx.canvas), [ctx.canvas])
  return s ? <MenuHost s={s} /> : null
}

function MenuHost({ s }: { s: KanbanState }) {
  const req = useValue('kanban.menu', () => s.menu.get(), [s])
  const value = useValue('kanban.menu-value', () => {
    if (!req) return null
    const el = s.ctx.canvas.get(req.frameId)
    return el && kanbanFrameWritable(s.ctx.canvas, req.frameId) ? kanbanOf(el as PlanningElement) : null
  }, [s, req])
  useEffect(() => {
    if (req && !value) s.menu.set(null)
  }, [s, req, value])
  if (!req || !value) return null
  return <Menu key={`${req.frameId}:${req.status}`} s={s} req={req} value={value} />
}

function Menu({ s, req, value }: { s: KanbanState; req: ColumnMenuRequest; value: KanbanValue }) {
  const canvas = s.ctx.canvas
  const uid = useId()
  const close = () => s.menu.set(null)
  const ref = useIsolated<HTMLDivElement>((e) => {
    if (e.key === 'Escape') {
      e.preventDefault()
      close()
      canvas.focus({ preventScroll: true })
    }
  })
  const screen = canvas.viewport.screenRect()
  const left = Math.max(8, Math.min(req.anchor.x - screen.x, screen.width - 248))
  const top = Math.max(8, Math.min(req.anchor.y - screen.y + 4, screen.height - 160))
  const status = req.status
  const cols = kanbanColumns(value)
  const wipNow = status ? (value.wip?.[status] ?? null) : null
  const [wip, setWip] = useState(wipNow === null ? '' : String(wipNow))

  useEffect(() => {
    tryFocus(ref.current?.querySelector<HTMLElement>('button, input'))
    const node = ref.current
    const doc = node?.ownerDocument
    if (!doc) return
    const onDown = (e: PointerEvent) => {
      const t = e.target as HTMLElement | null
      if (
        node?.contains(t) ||
        t?.closest?.('[data-testid="kanban-column-menu"], [data-testid="kanban-hidden-columns"]')
      )
        return
      s.menu.set(null)
    }
    doc.addEventListener('pointerdown', onDown, true)
    return () => doc.removeEventListener('pointerdown', onDown, true)
  }, [ref, s])

  const write = (next: KanbanValue | null, label: string) => {
    if (next) writeKanban(canvas, req.frameId, next, label)
    close()
  }

  if (!status) {
    return (
      <div
        ref={ref}
        className="dr-kanban-popover"
        role="dialog"
        aria-label="Hidden columns"
        style={{ left, top }}
      >
        <p className="dr-kanban-popover__title">Hidden columns</p>
        <ul className="dr-kanban-popover__list">
          {(value.hidden ?? []).map((st) => (
            <li key={st}>
              <span>{value.labels?.[st] ?? CARD_STATUS_LABELS[st]}</span>
              <button
                type="button"
                className="dr-card-btn"
                data-testid="kanban-show-column"
                data-status={st}
                onClick={() => write(withHidden(value, st, false), 'show column')}
              >
                Show
              </button>
            </li>
          ))}
        </ul>
      </div>
    )
  }
  const label = cols.find((c) => c.status === status)?.label ?? CARD_STATUS_LABELS[status as CardStatus]
  const wipNumber = wip.trim() === '' ? null : Number(wip)
  return (
    <div
      ref={ref}
      className="dr-kanban-popover"
      role="dialog"
      aria-label={`${label} column`}
      data-testid="kanban-column-popover"
      style={{ left, top }}
    >
      <p className="dr-kanban-popover__title">{label}</p>
      <button
        type="button"
        className="dr-kanban-popover__item"
        data-testid="kanban-rename"
        onClick={() => {
          close()
          s.renaming.set({ frameId: req.frameId, status })
        }}
      >
        Rename
      </button>
      <button
        type="button"
        className="dr-kanban-popover__item"
        data-testid="kanban-hide-column"
        disabled={cols.length <= 1}
        title={cols.length <= 1 ? 'A Kanban keeps one column at least' : undefined}
        onClick={() => write(withHidden(value, status, true), 'hide column')}
      >
        Hide column
      </button>
      <form
        className="dr-kanban-popover__wip"
        onSubmit={(e) => {
          e.preventDefault()
          write(withWip(value, status, wipNumber), 'wip limit')
        }}
      >
        <label htmlFor={`${uid}-wip`}>Card limit</label>
        <input
          id={`${uid}-wip`}
          className="dr-card-input"
          type="number"
          min={1}
          max={99}
          inputMode="numeric"
          placeholder="None"
          data-testid="kanban-wip"
          value={wip}
          onChange={(e) => setWip(e.target.value)}
        />
        <button type="submit" className="dr-card-btn" data-testid="kanban-wip-save">
          {wipNumber === null && wipNow !== null ? 'Remove' : 'Set'}
        </button>
      </form>
    </div>
  )
}
