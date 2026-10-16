// OWNER: WS4 (wave S, the client review page). One item's status controls: Approve (with a confirm step), Request
// changes (with a note), Back to awaiting review. Writes go through WS1's status route (client.ts setReviewStatus); the
// answers are the api's: a status somebody else set a moment ago (409 STATUS_CHANGED) asks before it overwrites, a newer
// version of a file (409 NEWER_VERSION) asks for a reload (a status is always about the version the person saw).
import {
  type CommentThread,
  REVIEW_CODES,
  REVIEW_STATUS_LABELS,
  type ReviewCan,
  type ReviewItem,
  type ReviewStatus,
  reviewActorLabel,
} from '@draftroom/contracts'
import { useEffect, useId, useRef, useState } from 'react'
import { ReviewRequestError, setReviewStatus } from './client.ts'
import { type PageEntry, REVIEW_NOTE_PLACEHOLDER, statusButtons } from './model.ts'

type Mode =
  | { kind: 'idle' }
  | { kind: 'confirm' }
  | { kind: 'note' }
  | { kind: 'conflict'; status: ReviewStatus; note: string; item: ReviewItem }

/** The words for a failed status write (never the api's internals). */
export function statusErrorText(e: unknown): string {
  if (!(e instanceof ReviewRequestError)) return 'Your answer could not be saved. Try again.'
  switch (e.code) {
    case REVIEW_CODES.newerVersion:
      return 'A newer version of this file was just added. Reload the page to review the latest version.'
    case REVIEW_CODES.rateLimited:
      return 'You are answering very fast. Wait a moment and try again.'
    case 'FORBIDDEN':
    case 'READ_ONLY':
      return 'You can see this review but not answer it.'
    default:
      return 'Your answer could not be saved. Try again.'
  }
}

/** "Ana (guest) just set this to Changes requested." */
export function conflictText(item: ReviewItem): string {
  const who = item.statusBy ? reviewActorLabel(item.statusBy) : 'Someone'
  return `${who} just set this to ${REVIEW_STATUS_LABELS[item.status]}.`
}

export function StatusControls({
  boardId,
  entry,
  can,
  onApplied,
  announce,
}: {
  boardId: string
  entry: PageEntry
  can: ReviewCan
  onApplied(item: ReviewItem, thread?: CommentThread): void
  announce(text: string): void
}) {
  const { item } = entry
  const buttons = statusButtons(can, item.status)
  const [mode, setMode] = useState<Mode>({ kind: 'idle' })
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const noteId = useId()
  // the person just chose "Request changes": the note is the next thing, so it takes the keyboard
  const noteRef = useRef<HTMLTextAreaElement>(null)
  const noting = mode.kind === 'note'
  useEffect(() => {
    if (noting) noteRef.current?.focus()
  }, [noting])
  if (buttons.length === 0) return null

  const send = async (status: ReviewStatus, text: string, force: boolean) => {
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      const trimmed = text.trim()
      const res = await setReviewStatus(boardId, item.id, {
        status,
        ...(force ? {} : { fromSeq: item.statusSeq }),
        ...(entry.file ? { versionId: entry.file.versionId } : {}),
        ...(trimmed ? { note: trimmed } : {}),
      })
      onApplied(res.item, res.thread)
      announce(`${entry.label}: ${REVIEW_STATUS_LABELS[res.item.status].toLowerCase()}`)
      setMode({ kind: 'idle' })
      setNote('')
    } catch (e) {
      if (e instanceof ReviewRequestError && e.code === REVIEW_CODES.statusChanged && e.item) {
        onApplied(e.item)
        setMode({ kind: 'conflict', status, note: text, item: e.item })
      } else {
        setError(statusErrorText(e))
      }
    } finally {
      setBusy(false)
    }
  }

  const label = (status: ReviewStatus) => buttons.find((b) => b.status === status)?.label ?? ''

  if (mode.kind === 'conflict') {
    return (
      <div className="dr-rp__controls" data-testid="review-conflict" role="alert">
        <p className="dr-rp__conflict">{conflictText(mode.item)}</p>
        <div className="dr-rp__row">
          <button
            type="button"
            className="dr-rp__btn dr-rp__btn--primary"
            data-testid="review-conflict-anyway"
            disabled={busy}
            onClick={() => void send(mode.status, mode.note, true)}
          >
            {mode.status === 'approved'
              ? 'Approve anyway'
              : mode.status === 'changes_requested'
                ? 'Request changes anyway'
                : 'Set it anyway'}
          </button>
          <button
            type="button"
            className="dr-rp__btn"
            data-testid="review-conflict-keep"
            onClick={() => setMode({ kind: 'idle' })}
          >
            Keep theirs
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="dr-rp__controls" data-testid="review-controls" data-busy={busy || undefined}>
      {mode.kind === 'note' && (
        <div className="dr-rp__note">
          <label htmlFor={noteId} className="dr-rp__label">
            What should change?
          </label>
          <textarea
            id={noteId}
            data-testid="review-note"
            className="dr-rp__textarea"
            rows={3}
            maxLength={5000}
            ref={noteRef}
            placeholder={REVIEW_NOTE_PLACEHOLDER}
            value={note}
            onChange={(e) => setNote(e.target.value)}
          />
          <div className="dr-rp__row">
            <button
              type="button"
              className="dr-rp__btn dr-rp__btn--primary"
              data-testid="review-note-send"
              disabled={busy}
              onClick={() => void send('changes_requested', note, false)}
            >
              {busy ? 'Sending…' : 'Send request'}
            </button>
            <button
              type="button"
              className="dr-rp__btn"
              data-testid="review-note-cancel"
              onClick={() => setMode({ kind: 'idle' })}
            >
              Cancel
            </button>
          </div>
        </div>
      )}
      {mode.kind === 'confirm' && (
        <div className="dr-rp__confirm" data-testid="review-confirm">
          <p className="dr-rp__confirm-text">Approve “{entry.label}”?</p>
          <div className="dr-rp__row">
            <button
              type="button"
              className="dr-rp__btn dr-rp__btn--approve"
              data-testid="review-approve-confirm"
              disabled={busy}
              onClick={() => void send('approved', '', false)}
            >
              {busy ? 'Approving…' : 'Confirm'}
            </button>
            <button
              type="button"
              className="dr-rp__btn"
              data-testid="review-approve-cancel"
              onClick={() => setMode({ kind: 'idle' })}
            >
              Cancel
            </button>
          </div>
        </div>
      )}
      {mode.kind === 'idle' && (
        <div className="dr-rp__row">
          {buttons
            .filter((b) => b.status !== 'pending')
            .map((b) => (
              <button
                key={b.status}
                type="button"
                className={`dr-rp__btn dr-rp__btn--${b.status === 'approved' ? 'approve' : 'changes'}`}
                data-testid={b.status === 'approved' ? 'review-approve' : 'review-request-changes'}
                disabled={busy}
                onClick={() => setMode(b.confirm ? { kind: 'confirm' } : { kind: 'note' })}
              >
                {b.label}
              </button>
            ))}
          {buttons.some((b) => b.status === 'pending') && (
            <button
              type="button"
              className="dr-rp__btn dr-rp__btn--quiet"
              data-testid="review-back"
              disabled={busy}
              onClick={() => void send('pending', '', false)}
            >
              {label('pending')}
            </button>
          )}
        </div>
      )}
      {error && (
        <p className="dr-rp__error" role="alert" data-testid="review-error">
          {error}
          {error.includes('Reload') && (
            <>
              {' '}
              <button type="button" className="dr-rp__link" onClick={() => location.reload()}>
                Reload
              </button>
            </>
          )}
        </p>
      )}
    </div>
  )
}
