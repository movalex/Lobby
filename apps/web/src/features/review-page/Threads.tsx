// OWNER: WS4 (wave S, the client review page). An item's open comments with a reply box, and "Add a comment". Reads and
// writes go through the board's comments store (features/comments/store.ts): the same threads, the same permissions
// (the api decides), the same board events. Threads are shown as the page's reader may see them (the page leaves the
// team-only ones out: a client page shows what a client sees). Replies and new comments are everyone's.

import { toShapeRef } from '@draftroom/canvas-schema/refs'
import { type CommentAnchor, type CommentThread, commentPlainText } from '@draftroom/contracts'
import { useEffect, useId, useRef, useState } from 'react'
import { formatRelativeTime } from '../../lib/format.ts'
import type { CommentsStore } from '../comments/store.ts'
import type { PageEntry } from './model.ts'

/** Where a new comment on an item is pinned: a frame at its top-right corner, a file to the file's current version. */
export function anchorForEntry(entry: Pick<PageEntry, 'item' | 'file'>): CommentAnchor {
  const shapeId = toShapeRef(entry.item.elementId)
  if (entry.file)
    return { kind: 'asset', shapeId, assetId: entry.file.assetId, versionId: entry.file.versionId }
  return { kind: 'shape', shapeId, u: 1, v: 0 }
}

function Reply({ store, thread, label }: { store: CommentsStore; thread: CommentThread; label: string }) {
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const id = useId()
  return (
    <form
      className="dr-rp__reply"
      onSubmit={(e) => {
        e.preventDefault()
        if (busy || !text.trim()) return
        setBusy(true)
        void store
          .reply(thread.id, { text, mentions: [] })
          .then((ok) => {
            if (ok) setText('')
          })
          .finally(() => setBusy(false))
      }}
    >
      <label htmlFor={id} className="dr-sr-only">
        Reply to this comment on {label}
      </label>
      <textarea
        id={id}
        data-testid="review-reply-input"
        className="dr-rp__textarea"
        rows={2}
        maxLength={5000}
        placeholder="Reply"
        value={text}
        onChange={(e) => setText(e.target.value)}
      />
      <button
        type="submit"
        className="dr-rp__btn"
        data-testid="review-reply-send"
        disabled={busy || !text.trim()}
      >
        {busy ? 'Sending…' : 'Reply'}
      </button>
    </form>
  )
}

export function Threads({
  store,
  entry,
  threads,
  canComment,
}: {
  store: CommentsStore
  entry: PageEntry
  threads: readonly CommentThread[]
  canComment: boolean
}) {
  const [adding, setAdding] = useState(false)
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const addId = useId()
  const addRef = useRef<HTMLTextAreaElement>(null)
  useEffect(() => {
    if (adding) addRef.current?.focus()
  }, [adding])
  const add = async () => {
    if (busy || !text.trim()) return
    setBusy(true)
    // a page for a client: this comment is for everyone, whatever the team's own default is
    store.teamOnlyChoice.set(false)
    const made = await store.createThread(anchorForEntry(entry), { text, mentions: [] })
    setBusy(false)
    if (made) {
      setText('')
      setAdding(false)
      store.openThreadId.set(null)
    }
  }
  return (
    <section className="dr-rp__threads" aria-label={`Comments on ${entry.label}`}>
      {threads.length > 0 && (
        <h3 className="dr-rp__subhead">
          {threads.length === 1 ? '1 open comment' : `${threads.length} open comments`}
        </h3>
      )}
      <ul className="dr-rp__thread-list">
        {threads.map((t) => (
          <li key={t.id} className="dr-rp__thread" data-testid="review-thread" data-thread-id={t.id}>
            <ul className="dr-rp__comments">
              {t.comments.map((c) => (
                <li key={c.id} className="dr-rp__comment" data-testid="review-comment">
                  <p className="dr-rp__comment-head">
                    <strong>{c.author.name}</strong>
                    {c.author.external ? <span className="dr-rp__tag">External</span> : null}
                    <time dateTime={c.createdAt}>{formatRelativeTime(c.createdAt)}</time>
                  </p>
                  <p className="dr-rp__comment-body">{commentPlainText(c.body)}</p>
                </li>
              ))}
            </ul>
            {canComment && <Reply store={store} thread={t} label={entry.label} />}
          </li>
        ))}
      </ul>
      {canComment &&
        (adding ? (
          <div className="dr-rp__add">
            <label htmlFor={addId} className="dr-rp__label">
              Add a comment
            </label>
            <textarea
              id={addId}
              data-testid="review-comment-input"
              className="dr-rp__textarea"
              rows={3}
              maxLength={5000}
              ref={addRef}
              value={text}
              onChange={(e) => setText(e.target.value)}
            />
            <div className="dr-rp__row">
              <button
                type="button"
                className="dr-rp__btn dr-rp__btn--primary"
                data-testid="review-comment-send"
                disabled={busy || !text.trim()}
                onClick={() => void add()}
              >
                {busy ? 'Sending…' : 'Comment'}
              </button>
              <button type="button" className="dr-rp__btn" onClick={() => setAdding(false)}>
                Cancel
              </button>
            </div>
          </div>
        ) : (
          <button
            type="button"
            className="dr-rp__btn dr-rp__btn--quiet"
            data-testid="review-comment-add"
            onClick={() => setAdding(true)}
          >
            Add a comment
          </button>
        ))}
    </section>
  )
}
