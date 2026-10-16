// OWNER: WS1 (wave S; docs/WAVE-S-CONTRACTS.md §2). The Review dock panel: the board's items in review order (the
// editor's position, else presentation order, else reading order), the filter chips (the roadmap's "show only awaiting
// review"), "Show on board", the open round with "Close round", "Start round", and "Mark for review" for the selected
// frame or file. Who may do what is the server's decision: the managing buttons show for `can.manage`, the status
// buttons (in the item's popover) for `can.setStatus`.

import { REVIEW_STATUS_LABELS, reviewCounts } from '@draftroom/contracts'
import { useState } from 'react'
import type { CanvasFeatureContext } from '../../canvas/api/index.ts'
import { useValue } from '../../lib/signals.ts'
import { type Review, reviewOf } from './bridge.ts'
import { ReviewRequestError } from './client.ts'
import {
  filterRows,
  markableOf,
  orderItems,
  progressText,
  REVIEW_FILTERS,
  type ReviewFilter,
} from './model.ts'
import { StatusPill } from './StatusForm.tsx'

export const REVIEW_PANEL_ID = 'review'

export function ReviewPanel({ ctx }: { ctx: CanvasFeatureContext; close(): void }) {
  const r = useValue('review.bridge', () => reviewOf(ctx.canvas), [ctx.canvas])
  return r ? <Panel r={r} /> : null
}

/** The selected element when it alone is selected and may be marked, else null. */
export function selectedMarkable(ctx: CanvasFeatureContext) {
  const sel = ctx.canvas.selection
  if (sel.length !== 1) return null
  const id = sel[0] as string
  return markableOf(ctx.canvas.get(id))
}

/** Marks the selected frame or file for review (notices say what happened). */
export async function markSelection(r: Review): Promise<void> {
  const m = selectedMarkable(r.ctx)
  if (!m) return
  try {
    await r.store.mark({
      elementId: m.elementId,
      kind: m.kind,
      label: m.label,
      ...(m.kind === 'file' && m.assetId ? { assetId: m.assetId } : {}),
    })
    r.ctx.notify({ key: 'review:mark', text: `In review: ${m.label}`, testId: 'review-marked' })
  } catch (e) {
    const code = e instanceof ReviewRequestError ? e.code : ''
    r.ctx.notify({
      key: 'review:mark',
      tone: 'error',
      text:
        code === 'ALREADY_IN_REVIEW'
          ? 'This is already in review.'
          : code === 'REVIEW_FULL'
            ? 'This board has as many items in review as it can hold.'
            : e instanceof ReviewRequestError && e.detail
              ? e.detail
              : "Couldn't mark it for review. Try again.",
    })
  }
}

/** Zooms to the item's element, selects it and opens its popover. */
export function showOnBoard(r: Review, itemId: string, elementId: string): void {
  const canvas = r.ctx.canvas
  const b = canvas.bounds(elementId)
  if (b) canvas.viewport.ensureVisible([elementId], { margin: 80 })
  canvas.select([elementId])
  r.store.popover.set({ itemId, from: 'panel' })
}

function Panel({ r }: { r: Review }) {
  const ctx = r.ctx
  const state = useValue('review.state', () => r.store.state.get(), [r])
  const loaded = useValue('review.loaded', () => r.store.loaded.get(), [r])
  const rows = useValue(
    'review.rows',
    () =>
      orderItems(r.store.state.get().items, {
        bounds: (id) => ctx.canvas.bounds(id),
        presentIndex: (id) => {
          const p = (ctx.canvas.get(id)?.customData?.lobby as { present?: { index?: unknown } } | undefined)
            ?.present
          return typeof p?.index === 'number' ? p.index : null
        },
        alive: (id) => {
          const el = ctx.canvas.get(id)
          return !!el && !(el as { isDeleted?: boolean }).isDeleted
        },
      }),
    [r],
  )
  const markable = useValue('review.markable', () => {
    const m = selectedMarkable(ctx)
    return m && !r.store.itemOf(m.elementId) ? m : null
  }, [r])
  const [filter, setFilter] = useState<ReviewFilter>('all')
  const [busy, setBusy] = useState(false)
  const [keepApproved, setKeepApproved] = useState(true)
  const open = state.rounds.find((x) => x.id === state.openRoundId) ?? null
  const counts = reviewCounts(state.items)
  const shown = filterRows(rows, filter)

  const run = async (what: () => Promise<unknown>, failed: string) => {
    if (busy) return
    setBusy(true)
    try {
      await what()
    } catch (e) {
      ctx.notify({
        key: 'review:panel',
        tone: 'error',
        text: e instanceof ReviewRequestError && e.detail ? e.detail : failed,
      })
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="dr-review-panel" data-testid="review-panel">
      <p className="dr-review-panel__progress" data-testid="review-progress" aria-live="polite">
        {state.items.length ? progressText(state.items) : loaded ? 'Nothing is in review yet.' : 'Loading…'}
      </p>
      {state.can.manage && (
        <section className="dr-review-panel__round" aria-label="Review round">
          {open ? (
            <>
              <p data-testid="review-round-open">
                <strong>{open.title}</strong> is open
                {open.checkpointId ? ' · a checkpoint was saved when it started' : ''}
              </p>
              <button
                type="button"
                className="dr-review-btn"
                data-testid="review-round-close"
                disabled={busy}
                onClick={() => void run(() => r.store.closeRound(open.id), "Couldn't close the round.")}
              >
                Close round
              </button>
            </>
          ) : (
            <>
              <label className="dr-review-check">
                <input
                  type="checkbox"
                  checked={keepApproved}
                  onChange={(e) => setKeepApproved(e.target.checked)}
                  data-testid="review-keep-approved"
                />
                Keep approved items approved
              </label>
              <button
                type="button"
                className="dr-review-btn"
                data-testid="review-round-start"
                disabled={busy || state.items.length === 0}
                onClick={() =>
                  void run(async () => {
                    const round = await r.store.startRound({ keepApproved })
                    ctx.notify({
                      key: 'review:round',
                      text: round.checkpointId
                        ? `${round.title} started. A checkpoint named “Review ${round.title.replace(/^Round /, 'round ')} sent” was saved.`
                        : `${round.title} started.`,
                      testId: 'review-round-started',
                    })
                  }, "Couldn't start the round.")
                }
              >
                Start round
              </button>
            </>
          )}
        </section>
      )}
      {state.can.manage && markable && (
        <button
          type="button"
          className="dr-review-btn dr-review-btn--primary"
          data-testid="review-mark-selection"
          disabled={busy}
          onClick={() => void run(() => markSelection(r), "Couldn't mark it for review.")}
        >
          Mark “{markable.label}” for review
        </button>
      )}
      <fieldset className="dr-review-filters">
        <legend className="dr-sr-only">Show</legend>
        {REVIEW_FILTERS.map((f) => (
          <button
            key={f.id}
            type="button"
            className="dr-review-chip"
            aria-pressed={filter === f.id}
            data-testid={`review-filter-${f.id}`}
            onClick={() => setFilter(f.id)}
          >
            {f.label}
            {f.id !== 'all' ? ` (${counts[f.id]})` : ''}
          </button>
        ))}
      </fieldset>
      {shown.length === 0 ? (
        <p className="dr-review-muted" data-testid="review-empty">
          {state.items.length === 0
            ? state.can.manage
              ? 'Select a frame or a file, then choose Mark for review.'
              : 'Nothing on this board is in review.'
            : `Nothing is ${REVIEW_STATUS_LABELS[filter as Exclude<ReviewFilter, 'all'>]?.toLowerCase() ?? 'here'}.`}
        </p>
      ) : (
        <ul className="dr-review-list" aria-label="Items in review">
          {shown.map(({ item, orphaned }) => (
            <li key={item.id} className="dr-review-row" data-testid="review-row" data-item-id={item.id}>
              <span className="dr-review-row__label">{item.label}</span>
              <StatusPill item={item} />
              {orphaned ? (
                <span className="dr-review-muted">On a deleted object</span>
              ) : (
                <button
                  type="button"
                  className="dr-linkbtn"
                  data-review-keep-popover=""
                  data-testid="review-row-show"
                  onClick={() => showOnBoard(r, item.id, item.elementId)}
                >
                  Show on board
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
