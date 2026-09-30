// A thread's comments with replies, edit/delete of your own comments (owners may delete any),
// resolve/reopen, and the reply composer. Shown in the popover next to a marker.

import type { CommentThread, ThreadComment } from '@draftroom/contracts'
import { useState } from 'react'
import { ownName } from '../../invite/model.ts'
import { formatDateTime, formatRelativeTime } from '../../lib/format.ts'
import { initialsFor, safeColor } from '../../lib/identity.ts'
import { Composer } from './Composer.tsx'
import { CheckIcon, CloseIcon } from './icons.tsx'
import { bodySegments, draftFromBody } from './mentions.ts'
import type { CommentsStore } from './store.ts'

export function CommentBody({ comment, meId }: { comment: ThreadComment; meId: string }) {
  return (
    <p className="dr-ccomment__body">
      {bodySegments(comment.body, comment.mentions, meId).map((s, i) =>
        s.kind === 'text' ? (
          <span key={i}>{s.text}</span>
        ) : (
          <span key={i} className={`dr-cmention${s.me ? ' dr-cmention--me' : ''}`} data-user-id={s.userId}>
            @{s.name}
          </span>
        ),
      )}
    </p>
  )
}

export function Avatar({
  name,
  color,
  id,
  size = 26,
}: {
  name: string
  color: string
  id: string
  size?: number
}) {
  return (
    <span
      className="dr-cavatar"
      style={{ background: safeColor(color, id), width: size, height: size, fontSize: size * 0.4 }}
      aria-hidden="true"
    >
      {initialsFor(name)}
    </span>
  )
}

function CommentItem({
  store,
  comment,
  canComment,
  isOwner,
}: {
  store: CommentsStore
  comment: ThreadComment
  canComment: boolean
  isOwner: boolean
}) {
  const [editing, setEditing] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const mine = comment.author.id === store.meId
  const canEdit = canComment && mine
  const canDelete = canComment && (mine || isOwner)
  return (
    <li className="dr-ccomment" data-testid="comment-item" data-comment-id={comment.id}>
      <Avatar name={comment.author.name} color={comment.author.color} id={comment.author.id} />
      <div className="dr-ccomment__main">
        <div className="dr-ccomment__head">
          <span className="dr-ccomment__author">
            {mine ? ownName(comment.author.name) : comment.author.name}
          </span>
          <time
            className="dr-ccomment__time"
            dateTime={comment.createdAt}
            title={formatDateTime(comment.createdAt)}
          >
            {formatRelativeTime(comment.createdAt)}
          </time>
          {comment.editedAt && (
            <span className="dr-ccomment__edited" title={`Edited ${formatDateTime(comment.editedAt)}`}>
              (edited)
            </span>
          )}
        </div>
        {editing ? (
          <Composer
            store={store}
            initial={draftFromBody(comment.body, comment.mentions)}
            label="Edit comment"
            placeholder="Edit your comment"
            submitLabel="Save"
            autoFocus
            compact
            onSubmit={async (draft) => {
              const ok = await store.edit(comment.id, draft)
              if (ok) setEditing(false)
              return ok
            }}
            onCancel={() => setEditing(false)}
          />
        ) : (
          <CommentBody comment={comment} meId={store.meId} />
        )}
        {!editing && (canEdit || canDelete) && (
          <div className="dr-ccomment__actions">
            {confirming ? (
              <>
                <span>Delete this comment?</span>
                <button
                  type="button"
                  className="dr-linkbtn dr-linkbtn--danger"
                  data-testid="comment-delete-confirm"
                  onClick={() =>
                    void store.remove(comment.threadId, comment.id).then(() => setConfirming(false))
                  }
                >
                  Delete
                </button>
                <button type="button" className="dr-linkbtn" onClick={() => setConfirming(false)}>
                  Cancel
                </button>
              </>
            ) : (
              <>
                {canEdit && (
                  <button
                    type="button"
                    className="dr-linkbtn"
                    data-testid="comment-edit"
                    aria-label={`Edit your comment from ${formatRelativeTime(comment.createdAt)}`}
                    onClick={() => setEditing(true)}
                  >
                    Edit
                  </button>
                )}
                {canDelete && (
                  <button
                    type="button"
                    className="dr-linkbtn"
                    data-testid="comment-delete"
                    aria-label={mine ? 'Delete your comment' : `Delete ${comment.author.name}’s comment`}
                    onClick={() => setConfirming(true)}
                  >
                    Delete
                  </button>
                )}
              </>
            )}
          </div>
        )}
      </div>
    </li>
  )
}

export function ThreadView({
  store,
  thread,
  isOwner,
  locationLabel,
  onClose,
  autoFocusReply,
}: {
  store: CommentsStore
  thread: CommentThread
  isOwner: boolean
  locationLabel: string
  onClose(): void
  autoFocusReply: boolean
}) {
  const canComment = store.signals.useValue(store.canComment)
  const privacy = store.signals.useValue(store.privacy)
  const resolved = thread.status === 'resolved'
  const replies = thread.comments.length - 1
  const teamOnly = thread.visibility === 'team'
  // F10: outside the team, only the person who started a thread resolves or reopens it.
  const canResolve = canComment && (privacy.teamOnly || thread.createdBy.id === store.meId)
  return (
    <>
      <header className="dr-cthread__head">
        <div className="dr-cthread__title">
          <strong>
            {resolved ? 'Resolved comment' : 'Comment'}
            {teamOnly && (
              <span
                className="dr-cteam"
                data-testid="thread-team-only"
                title="Only your team sees this thread"
              >
                Team only
              </span>
            )}
          </strong>
          <span className="dr-cthread__where">
            {locationLabel}
            {replies > 0 ? ` · ${replies} ${replies === 1 ? 'reply' : 'replies'}` : ''}
          </span>
        </div>
        {canResolve &&
          (resolved ? (
            <button
              type="button"
              className="dr-btn dr-btn--sm"
              data-testid="thread-reopen"
              onClick={() => void store.setStatus(thread.id, 'reopen')}
            >
              Reopen
            </button>
          ) : (
            <button
              type="button"
              className="dr-btn dr-btn--sm dr-cthread__resolve"
              data-testid="thread-resolve"
              title="Resolve: takes the marker off the board (find it under Resolved in the Comments panel)"
              onClick={() => void store.setStatus(thread.id, 'resolve')}
            >
              <CheckIcon /> Resolve
            </button>
          ))}
        <button
          type="button"
          className="dr-iconbtn dr-iconbtn--sm"
          aria-label="Close thread"
          onClick={onClose}
        >
          <CloseIcon />
        </button>
      </header>
      {canComment && privacy.teamOnly && (teamOnly || privacy.teamOnlyDefault) && (
        <p className="dr-cthread__privacy" data-testid="thread-privacy">
          {teamOnly
            ? 'Guests and client links can’t see this thread.'
            : 'Guests and client links can see this.'}{' '}
          <button
            type="button"
            className="dr-linkbtn"
            data-testid="thread-visibility"
            onClick={() => void store.setVisibility(thread.id, teamOnly ? 'everyone' : 'team')}
          >
            {teamOnly ? 'Show to everyone' : 'Make team only'}
          </button>
        </p>
      )}
      {resolved && thread.resolvedBy && (
        <p className="dr-cthread__resolved" role="status">
          <CheckIcon /> Resolved by {thread.resolvedBy.id === store.meId ? 'you' : thread.resolvedBy.name}{' '}
          {formatRelativeTime(thread.resolvedAt)}
        </p>
      )}
      <ol className="dr-cthread__list" aria-label="Comments">
        {thread.comments.map((c) => (
          <CommentItem key={c.id} store={store} comment={c} canComment={canComment} isOwner={isOwner} />
        ))}
      </ol>
      {canComment ? (
        <div className="dr-cthread__reply">
          <Composer
            key={thread.id}
            store={store}
            draftKey={thread.id}
            label="Reply"
            placeholder={resolved ? 'Reply (reopens the thread)…' : 'Reply…'}
            submitLabel="Reply"
            autoFocus={autoFocusReply}
            compact
            onSubmit={(draft) => store.reply(thread.id, draft)}
            onCancel={onClose}
          />
        </div>
      ) : (
        <p className="dr-cthread__readonly">
          You can read comments here. Ask an owner for comment access to reply.
        </p>
      )}
    </>
  )
}
