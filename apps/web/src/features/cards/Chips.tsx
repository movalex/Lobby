// OWNER: WS4 (wave T). A card's chips on the canvas: a `scene` layer of the overlay root (never elements: nothing is
// written to draw them), one container moved and scaled with the camera by one transform, one box per card at its
// scene rectangle (rotated with it), the chips along its bottom edge inside: the status (icon and words), the due date
// ("Due Fri"; overdue in the danger colour with an alert icon, never colour alone) and the assignee's initials. Below
// 100 % the chips grow so their words stay readable on screen; zoomed far out they hide. Each chip row is a button that
// opens the card's popover. Hidden elements (a collapsed mind-map branch) show none; focus mode hides the layer.
import { type CardFields, cardOf, type PlanningElement } from '@draftroom/canvas-schema/planning'
import { type CSSProperties, memo, useMemo } from 'react'
import type { CanvasFeatureContext, LobbyCanvas } from '../../canvas/api/index.ts'
import { computed, type Signal, useValue } from '../../lib/signals.ts'
import { type CardsState, cardsOf } from './bridge.ts'
import { AlertIcon, CalendarIcon, StatusIcon } from './icons.tsx'
import { dueWords, initialsOf, statusWords, todayLocal } from './model.ts'
import { personView } from './people.ts'
import './cards.css'

/** Below this zoom the chips are not drawn (the card's own colour and words still show). */
export const CHIPS_OFF_BELOW = 0.3
/** The chips' text never reads smaller than this on screen (px; 11 px at 100 % and up). */
const MIN_TEXT_PX = 11
const TEXT_PX = 11

/** The factor chips are drawn at in scene units: 1 from 100 % up, larger below so the words keep their size. */
export const chipScale = (zoom: number): number =>
  zoom > 0 ? Math.max(1, Math.round((MIN_TEXT_PX / (TEXT_PX * zoom)) * 100) / 100) : 1

export interface CardBoxView {
  readonly id: string
  readonly x: number
  readonly y: number
  readonly w: number
  readonly h: number
  readonly angle: number
  readonly card: CardFields
}

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0)

function boxesOf(canvas: LobbyCanvas): CardBoxView[] {
  const out: CardBoxView[] = []
  for (const el of canvas.index.withLobbyKey('card:status')) {
    const card = cardOf(el as PlanningElement)
    if (!card || canvas.isHidden(el.id)) continue
    out.push({
      id: el.id,
      x: num(el.x),
      y: num(el.y),
      w: Math.abs(num(el.width)),
      h: Math.abs(num(el.height)),
      angle: num(el.angle),
      card,
    })
  }
  return out
}

const sameCard = (a: CardFields, b: CardFields) =>
  a.status === b.status && a.who === b.who && a.start === b.start && a.due === b.due
const sameBoxes = (a: readonly CardBoxView[], b: readonly CardBoxView[]) =>
  a === b ||
  (a.length === b.length &&
    a.every((x, i) => {
      const o = b[i] as CardBoxView
      return (
        x.id === o.id &&
        x.x === o.x &&
        x.y === o.y &&
        x.w === o.w &&
        x.h === o.h &&
        x.angle === o.angle &&
        sameCard(x.card, o.card)
      )
    }))

export function CardChipsLayer({ ctx }: { ctx: CanvasFeatureContext }) {
  const s = useValue('cards.bridge', () => cardsOf(ctx.canvas), [ctx.canvas])
  return s ? <ChipScene s={s} /> : null
}

function useBoxes(canvas: LobbyCanvas): Signal<CardBoxView[]> {
  return useMemo(() => computed('cards.boxes', () => boxesOf(canvas), { isEqual: sameBoxes }), [canvas])
}

function ChipScene({ s }: { s: CardsState }) {
  const canvas = s.ctx.canvas
  const boxes = useValue(useBoxes(canvas))
  const v = useValue('cards.viewport', () => canvas.viewport.get(), [canvas])
  const open = useValue('cards.popover-open', () => s.popover.get()?.id ?? null, [s])
  // the day changes at midnight: read once per render (a re-render follows every camera move)
  const today = todayLocal()
  if (v.zoom < CHIPS_OFF_BELOW) return null
  return (
    <div
      className="dr-card-scene"
      data-testid="card-chips-layer"
      style={
        {
          transform: `scale(${v.zoom}) translate(${-v.x}px, ${-v.y}px)`,
          '--dr-card-s': chipScale(v.zoom),
        } as CSSProperties
      }
    >
      {boxes.map((b) => (
        <ChipBox key={b.id} s={s} box={b} today={today} open={open === b.id} />
      ))}
    </div>
  )
}

const ChipBox = memo(function ChipBox({
  s,
  box,
  today,
  open,
}: {
  s: CardsState
  box: CardBoxView
  today: string
  open: boolean
}) {
  const who = useValue(
    'cards.chip-who',
    () => (box.card.who ? personView(s.ctx, s.people, box.card.who) : null),
    [s, box.card.who],
  )
  const due = dueWords(box.card, today)
  const label = [
    `Card: ${statusWords(box.card.status)}`,
    due?.label,
    who ? `assigned to ${who.name}` : 'unassigned',
  ]
    .filter(Boolean)
    .join(', ')
  return (
    <div
      className="dr-card-box"
      data-testid="card-box"
      data-element-id={box.id}
      style={{
        left: box.x,
        top: box.y,
        width: box.w,
        height: box.h,
        transform: box.angle ? `rotate(${box.angle}rad)` : undefined,
      }}
    >
      <button
        type="button"
        className="dr-card-chips"
        data-testid="card-chips"
        data-element-id={box.id}
        data-status={box.card.status}
        data-card-keep-popover=""
        aria-label={`${label}. Open card details`}
        aria-haspopup="dialog"
        aria-expanded={open}
        onPointerDown={(e) => e.stopPropagation()}
        onClick={() => {
          s.ctx.canvas.select([box.id])
          s.popover.set(open ? null : { id: box.id })
        }}
      >
        <span
          className="dr-card-chip dr-card-status"
          data-status={box.card.status}
          data-testid="card-chip-status"
        >
          <StatusIcon status={box.card.status} size={12} />
          <span className="dr-card-chip__text">{statusWords(box.card.status)}</span>
        </span>
        {due && (
          <span
            className="dr-card-chip dr-card-due"
            data-testid="card-chip-due"
            data-overdue={due.overdue || undefined}
            data-soon={due.soon || undefined}
          >
            {due.overdue ? <AlertIcon size={12} /> : <CalendarIcon size={12} />}
            <span className="dr-card-chip__text">{due.text}</span>
          </span>
        )}
        {who && (
          <span
            className="dr-card-avatar"
            data-testid="card-chip-who"
            data-uid={box.card.who ?? undefined}
            data-gone={who.gone || undefined}
            title={who.gone ? `${who.name} (no longer on this board)` : who.name}
            style={who.color ? ({ '--dr-card-avatar': who.color } as CSSProperties) : undefined}
          >
            {initialsOf(who.name)}
          </span>
        )}
      </button>
    </div>
  )
})
