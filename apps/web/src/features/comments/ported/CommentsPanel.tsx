// OWNER: 3c. Dock panel `comments` on the Excalidraw board page (the tldraw page's ../CommentsPanel.tsx):
// every thread on the board with filters (open, mine, mentioning me, resolved, all); clicking one moves the
// camera to it and opens it. Orphans (their element was deleted) are listed as "On a deleted object" and
// re-attach when the element comes back (undo, Recently deleted).

import type { CommentThread } from '@draftroom/contracts'
import { useEffect, useId, useMemo } from 'react'
import { type CanvasFeatureContext, SINGLE_PAGE_ID } from '../../../canvas/api/index.ts'
import { formatRelativeTime } from '../../../lib/format.ts'
import { useValue } from '../../../lib/signals.ts'
import { ExternalTag } from '../../people/ExternalTag.tsx'
import {
  anchorLabel,
  isThreadFilter,
  matchesFilter,
  pinState,
  snippet,
  sortThreads,
  THREAD_FILTERS,
} from '../model.ts'
import { Avatar } from '../ThreadView.tsx'
import { controllerFor, openThreadFromPanel } from './controller.ts'
import { anchorContext, placeOnBoard } from './geometry.ts'

export function CommentsPanel({ ctx }: { ctx: CanvasFeatureContext; close(): void }) {
  const { canvas } = ctx
  const { store } = controllerFor(ctx)
  const filterId = useId()
  const filter = useValue('dr-comments.filter', () => store.filter.get(), [store])
  const status = useValue('dr-comments.status', () => store.status.get(), [store])
  const hidden = useValue('dr-comments.pins-hidden', () => store.pinsHidden.get(), [store])
  const showResolved = useValue('dr-comments.show-resolved', () => store.showResolved.get(), [store])
  const canComment = useValue('dr-comments.can-comment', () => store.canComment.get(), [store])
  const openId = useValue('dr-comments.open', () => store.openThreadId.get(), [store])
  const threads = useValue('dr-comments.threads', () => store.threads.get(), [store])
  const reads = useValue('dr-comments.reads', () => store.reads.get(), [store])
  // Placement depends on the elements (orphans, frames); recomputed when the document changes.
  const labels = useValue('dr-comments.panel-labels', () => {
    const out: Record<string, { label: string; orphan: boolean }> = {}
    for (const t of Object.values(store.threads.get())) {
      const placement = placeOnBoard(canvas, t.anchor)
      out[t.id] = {
        label: anchorLabel(t.anchor, placement, SINGLE_PAGE_ID, anchorContext(canvas, t.anchor, placement)),
        orphan: placement.kind === 'orphan',
      }
    }
    return out
  }, [canvas, store])

  useEffect(() => {
    void store.ensureMentionables()
  }, [store])

  const list = useMemo(
    () =>
      sortThreads(
        Object.values(threads).filter((t) => matchesFilter(t, filter, store.meId)),
        store.meId,
        reads,
      ),
    [threads, reads, filter, store.meId],
  )
  const counts = useMemo(() => {
    const all = Object.values(threads)
    return {
      open: all.filter((t) => t.status === 'open').length,
      resolved: all.filter((t) => t.status === 'resolved').length,
    }
  }, [threads])

  return (
    <div className="dr-cpanel" data-testid="comments-panel">
      <div className="dr-cpanel__controls">
        <label className="dr-cpanel__filter" htmlFor={filterId}>
          <span>Show</span>
          <select
            id={filterId}
            className="dr-input"
            data-testid="comments-filter"
            value={filter}
            onChange={(e) => {
              if (isThreadFilter(e.target.value)) store.filter.set(e.target.value)
            }}
          >
            {THREAD_FILTERS.map((f) => (
              <option key={f.id} value={f.id}>
                {f.label}
                {f.id === 'open' ? ` (${counts.open})` : f.id === 'resolved' ? ` (${counts.resolved})` : ''}
              </option>
            ))}
          </select>
        </label>
        <label className="dr-cpanel__check">
          <input
            type="checkbox"
            data-testid="comments-show-resolved"
            checked={showResolved}
            onChange={(e) => store.setShowResolved(e.target.checked)}
          />
          Show resolved on the board
        </label>
        <label className="dr-cpanel__check">
          <input
            type="checkbox"
            data-testid="comments-hide-pins"
            checked={hidden}
            onChange={(e) => store.setPinsHidden(e.target.checked)}
          />
          Hide comments on the board <kbd>Shift+C</kbd>
        </label>
      </div>

      {status === 'loading' && <p className="dr-cpanel__empty">Loading comments…</p>}
      {status === 'error' && (
        <p className="dr-cpanel__empty">
          Comments could not be loaded.{' '}
          <button type="button" className="dr-linkbtn" onClick={() => void store.load()}>
            Try again
          </button>
        </p>
      )}
      {status === 'ready' && list.length === 0 && (
        <p className="dr-cpanel__empty" data-testid="comments-empty">
          {Object.keys(threads).length === 0
            ? canComment
              ? 'No comments yet. Press C, then click an object or the board to add one.'
              : 'No comments yet.'
            : 'No comments match this filter.'}
        </p>
      )}

      <ul className="dr-cpanel__list" aria-label="Comment threads">
        {list.map((t) => (
          <ThreadRow
            key={t.id}
            thread={t}
            meId={store.meId}
            readAt={reads[t.id]}
            label={labels[t.id]?.label ?? ''}
            orphan={labels[t.id]?.orphan ?? false}
            open={openId === t.id}
            onOpen={() => {
              openThreadFromPanel(ctx, t.id)
            }}
          />
        ))}
      </ul>
      <p className="dr-cpanel__note">
        Notifications are in-app only (the bell in the top bar); email notifications aren’t available yet.
      </p>
    </div>
  )
}

function ThreadRow({
  thread,
  meId,
  readAt,
  label,
  orphan,
  open,
  onOpen,
}: {
  thread: CommentThread
  meId: string
  readAt: string | undefined
  label: string
  orphan: boolean
  open: boolean
  onOpen(): void
}) {
  const state = pinState(thread, meId, readAt)
  const first = thread.comments[0]
  const last = thread.comments[thread.comments.length - 1]
  const replies = thread.comments.length - 1
  return (
    <li>
      <button
        type="button"
        className="dr-cpanel__row"
        data-testid="comment-row"
        data-thread-id={thread.id}
        data-state={state}
        data-orphan={orphan ? 'true' : 'false'}
        aria-current={open ? 'true' : undefined}
        onClick={onOpen}
      >
        <Avatar
          name={thread.createdBy.name}
          color={thread.createdBy.color}
          id={thread.createdBy.id}
          size={24}
        />
        <span className="dr-cpanel__rowmain">
          <span className="dr-cpanel__rowhead">
            <strong>{thread.createdBy.name}</strong>
            {thread.createdBy.external && <ExternalTag compact />}
            <time dateTime={last?.createdAt}>{formatRelativeTime(last?.createdAt)}</time>
            {(state === 'unread' || state === 'mentioned') && (
              <span className={`dr-cpanel__badge dr-cpanel__badge--${state}`}>
                {state === 'mentioned' ? '@ you' : 'New'}
              </span>
            )}
            {state === 'resolved' && <span className="dr-cpanel__badge">Resolved</span>}
            {thread.visibility === 'team' && (
              <span className="dr-cteam" data-testid="comment-row-team-only">
                Team only
              </span>
            )}
          </span>
          <span className="dr-cpanel__snippet">{first ? snippet(first.body, 140) : ''}</span>
          <span className={`dr-cpanel__where${orphan ? ' dr-cpanel__where--orphan' : ''}`}>
            {label}
            {replies > 0 ? ` · ${replies} ${replies === 1 ? 'reply' : 'replies'}` : ''}
          </span>
        </span>
      </button>
    </li>
  )
}
