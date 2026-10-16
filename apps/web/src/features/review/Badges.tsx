// OWNER: WS1 (wave S; docs/WAVE-S-CONTRACTS.md §2). Review status on the canvas: a pill per live item, in a `scene`
// layer of the overlay root (never an element: nothing is written to the board), at a frame's top-left above its name
// and under a file's bottom-left corner, in screen pixels (readable at any zoom). The layer takes no clicks; each pill
// is a button that opens the item's popover (a `screen` layer): its status buttons, the note and the history. Items on
// a deleted element show no pill (the panel lists them). Focus mode (presenting) hides both layers.

import type { ReviewItem } from '@draftroom/contracts'
import { useEffect, useRef } from 'react'
import type { CanvasFeatureContext } from '../../canvas/api/index.ts'
import { useValue } from '../../lib/signals.ts'
import { type Review, reviewOf } from './bridge.ts'
import { badgeAnchor, pillLabel } from './model.ts'
import { History, StatusForm, StatusPill } from './StatusForm.tsx'
import './review.css'

interface PlacedPill {
  readonly item: ReviewItem
  readonly x: number
  readonly y: number
}

function placedPills(r: Review): PlacedPill[] {
  const canvas = r.ctx.canvas
  canvas.viewport.get() // the camera: pills move with it
  const out: PlacedPill[] = []
  for (const item of r.store.state.get().items) {
    if (item.removedAt !== null) continue
    const el = canvas.get(item.elementId)
    if (!el || (el as { isDeleted?: boolean }).isDeleted || canvas.isHidden(item.elementId)) continue
    const b = canvas.bounds(item.elementId)
    if (!b) continue
    const at = badgeAnchor(item.kind, b, (p) => canvas.sceneToOverlay(p))
    out.push({ item, x: Math.round(at.x), y: Math.round(at.y) })
  }
  return out
}

export function ReviewBadgesLayer({ ctx }: { ctx: CanvasFeatureContext }) {
  const r = useValue('review.bridge', () => reviewOf(ctx.canvas), [ctx.canvas])
  return r ? <Badges r={r} /> : null
}

function Badges({ r }: { r: Review }) {
  const pills = useValue('review.pills', () => placedPills(r), [r])
  const open = useValue('review.popover', () => r.store.popover.get(), [r])
  return (
    <div className="dr-review-badges" data-testid="review-badges">
      {pills.map((p) => (
        <button
          key={p.item.id}
          type="button"
          className="dr-review-badge"
          data-testid="review-badge"
          data-element-id={p.item.elementId}
          data-status={p.item.status}
          aria-label={pillLabel(p.item)}
          aria-haspopup="dialog"
          aria-expanded={open?.itemId === p.item.id}
          style={{ transform: `translate(${p.x}px, ${p.y}px)` }}
          onPointerDown={(e) => e.stopPropagation()}
          onClick={() =>
            r.store.popover.set(open?.itemId === p.item.id ? null : { itemId: p.item.id, from: 'badge' })
          }
        >
          <StatusPill item={p.item} />
        </button>
      ))}
    </div>
  )
}

/** The popover of the open item, in the review `screen` layer. */
export function ReviewPopoverLayer({ ctx }: { ctx: CanvasFeatureContext }) {
  const r = useValue('review.bridge', () => reviewOf(ctx.canvas), [ctx.canvas])
  return r ? <PopoverHost r={r} /> : null
}

function PopoverHost({ r }: { r: Review }) {
  const open = useValue('review.popover', () => r.store.popover.get(), [r])
  const item = useValue('review.popover-item', () => (open ? r.store.item(open.itemId) : null), [r, open])
  const where = useValue('review.popover-at', () => {
    if (!item) return null
    return placedPills(r).find((p) => p.item.id === item.id) ?? null
  }, [r, item])
  if (!open || !item) return null
  return <Popover r={r} item={item} at={where ? { x: where.x, y: where.y + 30 } : null} />
}

function Popover({ r, item, at }: { r: Review; item: ReviewItem; at: { x: number; y: number } | null }) {
  const ref = useRef<HTMLDivElement>(null)
  const can = useValue('review.can', () => r.store.state.get().can, [r])
  const close = () => r.store.popover.set(null)
  // Escape and a click outside close it; the focus moves into it when it opens
  useEffect(() => {
    const node = ref.current
    node?.querySelector<HTMLElement>('button, textarea')?.focus({ preventScroll: true })
    const doc = node?.ownerDocument
    if (!doc) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && node?.contains(e.target as Node)) {
        e.stopPropagation()
        r.store.popover.set(null)
      }
    }
    const onDown = (e: PointerEvent) => {
      const t = e.target as HTMLElement | null
      if (node?.contains(t)) return
      if (t?.closest?.('[data-testid="review-badge"], [data-review-keep-popover]')) return
      r.store.popover.set(null)
    }
    doc.addEventListener('keydown', onKey, true)
    doc.addEventListener('pointerdown', onDown, true)
    return () => {
      doc.removeEventListener('keydown', onKey, true)
      doc.removeEventListener('pointerdown', onDown, true)
    }
  }, [r])
  const style = at
    ? { left: `clamp(8px, ${at.x}px, calc(100% - 336px))`, top: `clamp(8px, ${at.y}px, calc(100% - 120px))` }
    : { left: '16px', top: '64px' }
  return (
    <div
      ref={ref}
      className="dr-review-popover"
      role="dialog"
      aria-label={`Review of ${item.label}`}
      data-testid="review-popover"
      data-item-id={item.id}
      style={style}
    >
      <header className="dr-review-popover__head">
        <strong className="dr-review-popover__label">{item.label}</strong>
        <button type="button" className="dr-review-close" aria-label="Close" onClick={close}>
          ×
        </button>
      </header>
      <StatusPill item={item} testId="review-popover-pill" />
      <StatusForm r={r} item={item} />
      <History r={r} item={item} />
      {can.manage && (
        <footer className="dr-review-popover__foot">
          <button
            type="button"
            className="dr-linkbtn"
            data-testid="review-remove"
            onClick={() => {
              void r.store
                .unmark(item.id)
                .catch(() =>
                  r.ctx.notify({ key: 'review:remove', text: "Couldn't remove it from review. Try again." }),
                )
            }}
          >
            Remove from review
          </button>
        </footer>
      )}
    </div>
  )
}
