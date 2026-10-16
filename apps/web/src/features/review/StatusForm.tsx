// OWNER: WS1 (wave S). The status buttons, the note and the history of one review item: in the badge's popover, the
// review panel and the review viewer's header (`ws1.status`). Who may press them is the server's decision; the
// buttons show for whoever GET /api/boards/:bid/review says `can.setStatus` (a viewer link sees the status and its
// history, no buttons). "Request changes" asks for a note (an 'everyone' comment thread made with the status). A
// status someone changed meanwhile asks first ("Ana (guest) just requested changes. Approve anyway?"); a file's
// status is about the version its element shows (any version the board serves: "Make current" back to v1 and approving
// it is "Approved v1"). The pill says when the status is about another version than the card shows ("Approved v2 · v3
// is newer"), and a card that now shows another file reads "File replaced: review again" (a status set then is about
// the new file: the api re-points the item).

import {
  REVIEW_CODES,
  REVIEW_STATUS_LABELS,
  type ReviewEvent,
  type ReviewItem,
  type ReviewStatus,
  reviewActorLabel,
} from '@draftroom/contracts'
import { useEffect, useId, useState } from 'react'
import type { CanvasFeatureContext } from '../../canvas/api/index.ts'
import { factsOf } from '../../file-card/ported/model.ts'
import { useValue } from '../../lib/signals.ts'
import { versionNumber, versionStoreOf } from '../review-viewer/versions/store.ts'
import type { Review } from './bridge.ts'
import { listReviewEvents, ReviewRequestError } from './client.ts'
import {
  eventLine,
  type FileStanding,
  fileStanding,
  pillLine,
  pillStatus,
  SAME,
  type ShownFile,
  shownVersionOf,
} from './model.ts'

const VERB: Record<ReviewStatus, string> = {
  approved: 'approved it',
  changes_requested: 'requested changes',
  pending: 'set it back to Awaiting review',
}

const BUTTON: Record<ReviewStatus, string> = {
  approved: 'Approve',
  changes_requested: 'Request changes',
  pending: 'Awaiting review',
}

const ORDER: readonly ReviewStatus[] = ['approved', 'changes_requested', 'pending']

interface Ask {
  readonly text: string
  readonly retry?: { readonly status: ReviewStatus; readonly fromSeq: number }
}

export function StatusIcon({ status }: { status: ReviewStatus }) {
  const d =
    status === 'approved'
      ? 'M3 8.5l3 3 7-7'
      : status === 'changes_requested'
        ? 'M8 3v6M8 12.5v.5'
        : 'M8 2.5a5.5 5.5 0 1 0 0 11a5.5 5.5 0 1 0 0-11M8 5v3.2l2 1.3'
  return (
    <svg
      viewBox="0 0 16 16"
      width={14}
      height={14}
      aria-hidden="true"
      focusable="false"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d={d} />
    </svg>
  )
}

/**
 * How a file item stands against what its card shows now (model.ts fileStanding), with the version numbers of this
 * board's list (WS2's store: asked only when the status is about another version). A frame: always the same.
 */
export function useStanding(ctx: CanvasFeatureContext, item: ReviewItem): FileStanding {
  const shownKey = useValue('review.shown-file', () => {
    if (item.kind !== 'file') return null
    const el = ctx.canvas.get(item.elementId)
    const f = el && !(el as { isDeleted?: boolean }).isDeleted ? factsOf(el) : null
    return f ? `${f.assetId} ${f.versionId}` : null
  }, [ctx, item.kind, item.elementId])
  const shown: ShownFile | null = shownKey
    ? { assetId: shownKey.split(' ')[0] as string, versionId: shownKey.split(' ')[1] as string }
    : null
  const plain = fileStanding(item, shown)
  const assetId = plain.kind === 'other' ? item.assetId : null
  const list = useValue(
    'review.standing-list',
    () => (assetId ? versionStoreOf(ctx).list(assetId).get() : null),
    [ctx, assetId],
  )
  if (plain.kind !== 'other') return plain
  return fileStanding(item, shown, (id) => versionNumber(list, id))
}

/** "Approved · Ana (guest) · 2 h ago" with its icon (words and shape, never colour alone). */
export function StatusPill({
  item,
  standing = SAME,
  testId,
}: {
  item: ReviewItem
  standing?: FileStanding
  testId?: string
}) {
  const shown = pillStatus(item, standing)
  return (
    <span
      className="dr-review-pill"
      data-status={shown}
      data-standing={standing.kind === 'same' ? undefined : standing.kind}
      data-testid={testId}
    >
      <StatusIcon status={shown} />
      <span className="dr-review-pill__text">{pillLine(item, new Date(), standing)}</span>
    </span>
  )
}

/** The pill of an item on this board page: against what its card shows now. */
export function ReviewPill({ r, item, testId }: { r: Review; item: ReviewItem; testId?: string }) {
  const standing = useStanding(r.ctx, item)
  return <StatusPill item={item} standing={standing} testId={testId} />
}

export function StatusForm({ r, item, compact = false }: { r: Review; item: ReviewItem; compact?: boolean }) {
  const can = useValue('review.can', () => r.store.state.get().can, [r])
  const live = useValue('review.form-item', () => r.store.item(item.id) ?? item, [r, item])
  const standing = useStanding(r.ctx, live)
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [ask, setAsk] = useState<Ask | null>(null)
  const noteId = useId()

  async function submit(status: ReviewStatus, fromSeq: number) {
    if (busy) return
    if (status === 'changes_requested' && note.trim() === '') {
      setAsk({ text: 'Say what should change: the note goes to the board as a comment.' })
      return
    }
    setBusy(true)
    setAsk(null)
    const el = r.ctx.canvas.get(live.elementId)
    const versionId = live.kind === 'file' ? shownVersionOf(el) : null
    try {
      await r.store.setStatus(live.id, {
        status,
        fromSeq,
        ...(versionId ? { versionId } : {}),
        ...(note.trim() ? { note: note.trim() } : {}),
      })
      setNote('')
      r.ctx.notify({
        key: 'review:status',
        text: `${REVIEW_STATUS_LABELS[status]}: ${live.label}`,
        testId: 'review-status-saved',
      })
    } catch (e) {
      setAsk(askFor(e, status, r))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="dr-review-form" data-testid="review-status-form">
      {standing.kind === 'replaced' && (
        <p className="dr-review-muted" data-testid="review-replaced">
          This card shows another file now. Nobody has reviewed it yet
          {can.setStatus ? ': a status you set is about the new file.' : '.'}
        </p>
      )}
      {can.setStatus ? (
        <>
          <fieldset className="dr-review-form__buttons">
            <legend className="dr-sr-only">Set the review status</legend>
            {ORDER.map((s) => (
              <button
                key={s}
                type="button"
                className="dr-review-btn"
                data-status={s}
                data-testid={`review-set-${s}`}
                aria-pressed={standing.kind !== 'replaced' && live.status === s}
                disabled={busy}
                onClick={() => void submit(s, live.statusSeq)}
              >
                <StatusIcon status={s} />
                {BUTTON[s]}
              </button>
            ))}
          </fieldset>
          <label className="dr-review-form__label" htmlFor={noteId}>
            Note {live.status === 'changes_requested' || compact ? '' : '(asked for with Request changes)'}
          </label>
          <textarea
            id={noteId}
            className="dr-review-form__note"
            data-testid="review-note"
            rows={compact ? 2 : 3}
            maxLength={5000}
            value={note}
            placeholder="What should change? Everyone on the board sees it as a comment."
            onChange={(e) => setNote(e.target.value)}
          />
        </>
      ) : (
        <p className="dr-review-muted" data-testid="review-readonly">
          You can see this review. Only people who can comment set a status.
        </p>
      )}
      {ask && (
        <div className="dr-review-ask" role="alert" data-testid="review-ask">
          <span>{ask.text}</span>
          {ask.retry && (
            <button
              type="button"
              className="dr-review-btn"
              data-testid="review-ask-retry"
              onClick={() => ask.retry && void submit(ask.retry.status, ask.retry.fromSeq)}
            >
              {BUTTON[ask.retry.status]} anyway
            </button>
          )}
        </div>
      )}
    </div>
  )
}

function askFor(e: unknown, status: ReviewStatus, r: Review): Ask {
  if (!(e instanceof ReviewRequestError)) return { text: "Couldn't save the status. Try again." }
  if (e.code === REVIEW_CODES.statusChanged && e.item) {
    r.store.applyItem(e.item)
    const who = e.item.statusBy ? reviewActorLabel(e.item.statusBy) : 'Someone'
    return {
      text: `${who} just ${VERB[e.item.status]}. ${BUTTON[status]} anyway?`,
      retry: { status, fromSeq: e.item.statusSeq },
    }
  }
  if (e.code === REVIEW_CODES.newerVersion)
    return { text: 'A newer version of this file is on the board. Look at it first, then set the status.' }
  if (e.code === 'unavailable') return { text: "Couldn't reach Lobby. Check the connection and try again." }
  return { text: e.detail ?? "Couldn't save the status. Try again." }
}

/** The item's history, newest first (10 at a time). */
export function History({ r, item }: { r: Review; item: ReviewItem }) {
  const [events, setEvents] = useState<ReviewEvent[] | null>(null)
  const [next, setNext] = useState<number | null>(null)
  const seq = item.statusSeq
  useEffect(() => {
    let live = true
    void listReviewEvents(r.store.boardId, item.id).then((page) => {
      if (!live) return
      setEvents(page.events)
      setNext(page.nextBefore)
    })
    return () => {
      live = false
    }
  }, [r, item.id, seq])
  const [shown, setShown] = useState(10)
  if (events === null) return <p className="dr-review-muted">Loading the history…</p>
  if (events.length === 0) return null
  const more = async () => {
    if (shown < events.length) return setShown(shown + 10)
    if (next === null) return
    const page = await listReviewEvents(r.store.boardId, item.id, next)
    setEvents([...events, ...page.events])
    setNext(page.nextBefore)
    setShown(shown + 10)
  }
  return (
    <div className="dr-review-history">
      <h3 className="dr-review-history__title">History</h3>
      <ol className="dr-review-history__list" data-testid="review-history">
        {events.slice(0, shown).map((e) => (
          <li key={e.id}>
            <span>{eventLine(e)}</span>{' '}
            <time dateTime={e.createdAt} className="dr-review-muted">
              {new Date(e.createdAt).toLocaleString()}
            </time>
          </li>
        ))}
      </ol>
      {(shown < events.length || next !== null) && (
        <button type="button" className="dr-linkbtn" onClick={() => void more()}>
          Show earlier
        </button>
      )}
    </div>
  )
}
