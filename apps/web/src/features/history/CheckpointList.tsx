// The checkpoints of a board in the History panel (docs/WAVE4-CONTRACTS.md checkpoints-2): named
// (manual) checkpoints, then the automatic ones under their own disclosure. Each row can be previewed
// and restored as a new board; the board's owners can delete one after confirming. Test ids: manual
// rows keep `checkpoint-row` (M2); automatic rows are `checkpoint-auto-row`; both carry
// `data-snapshot-id`.

import type { BoardCheckpoint } from '@draftroom/contracts'
import { type KeyboardEvent, useEffect, useRef, useState } from 'react'
import {
  AUTOMATIC_EXPLAINED,
  AUTOMATIC_NONE_YET,
  automaticSummary,
  type CheckpointPermissions,
  checkpointAccessHint,
  checkpointMeta,
  checkpointTitle,
  newCanvasNote,
  splitCheckpoints,
} from './checkpoints-model.ts'

const AUTO_OPEN_KEY = 'dr-history-automatic-open'

function readAutoOpen(): boolean {
  try {
    return localStorage.getItem(AUTO_OPEN_KEY) === '1'
  } catch {
    return false
  }
}

function writeAutoOpen(open: boolean) {
  try {
    localStorage.setItem(AUTO_OPEN_KEY, open ? '1' : '0')
  } catch {
    // private mode or blocked storage: the disclosure just starts closed next time
  }
}

export interface CheckpointActions {
  busy: string | null
  onPreview(c: BoardCheckpoint): void
  onRestore(c: BoardCheckpoint): void
  onDelete(c: BoardCheckpoint): void
}

export function CheckpointList({
  checkpoints,
  perms,
  canRestore,
  restoreOff = false,
  now,
  actions,
}: {
  checkpoints: readonly BoardCheckpoint[] | null
  perms: CheckpointPermissions
  /** Restore as a new board (workspace members; history's own rule). */
  canRestore: boolean
  /** Shown but disabled: the board owner turned exporting off (the panel shows why). */
  restoreOff?: boolean
  now: Date
  actions: CheckpointActions
}) {
  const [autoOpen, setAutoOpen] = useState(readAutoOpen)
  if (checkpoints === null) return <p className="dr-history__empty">Loading…</p>
  const { manual, automatic } = splitCheckpoints(checkpoints)
  const rowProps = { perms, canRestore, restoreOff, now, actions }
  const hint = checkpoints.length > 0 ? checkpointAccessHint(perms, canRestore) : null
  return (
    <>
      {hint && (
        <p className="dr-history__hint" data-testid="checkpoint-guest-hint">
          {hint}
        </p>
      )}
      {manual.length === 0 ? (
        <p className="dr-history__empty">No named checkpoints yet.</p>
      ) : (
        <ul className="dr-history__list" aria-label="Named checkpoints">
          {manual.map((c) => (
            <CheckpointRow key={c.id} checkpoint={c} testId="checkpoint-row" {...rowProps} />
          ))}
        </ul>
      )}
      <details
        className="dr-history__auto"
        data-testid="checkpoint-auto"
        open={autoOpen}
        onToggle={(e) => {
          const open = (e.currentTarget as HTMLDetailsElement).open
          setAutoOpen(open)
          writeAutoOpen(open)
        }}
      >
        <summary data-testid="checkpoint-auto-toggle">
          <span className="dr-history__auto-title">{automaticSummary(automatic.length)}</span>
        </summary>
        <p className="dr-history__hint">{AUTOMATIC_EXPLAINED}</p>
        {automatic.length === 0 ? (
          <p className="dr-history__empty">{AUTOMATIC_NONE_YET}</p>
        ) : (
          <ul className="dr-history__list" aria-label="Automatic checkpoints">
            {automatic.map((c) => (
              <CheckpointRow key={c.id} checkpoint={c} testId="checkpoint-auto-row" {...rowProps} />
            ))}
          </ul>
        )}
      </details>
    </>
  )
}

function CheckpointRow({
  checkpoint: c,
  testId,
  perms,
  canRestore,
  restoreOff = false,
  now,
  actions,
}: {
  checkpoint: BoardCheckpoint
  testId: 'checkpoint-row' | 'checkpoint-auto-row'
  perms: CheckpointPermissions
  canRestore: boolean
  restoreOff?: boolean
  now: Date
  actions: CheckpointActions
}) {
  const [confirming, setConfirming] = useState(false)
  // Cancelling puts focus back on the delete button (the confirmation that had it is gone).
  const deleteRef = useRef<HTMLButtonElement>(null)
  const refocus = useRef(false)
  useEffect(() => {
    if (confirming || !refocus.current) return
    refocus.current = false
    deleteRef.current?.focus()
  }, [confirming])
  const cancel = () => {
    refocus.current = true
    setConfirming(false)
  }
  /** Escape on either button of the confirmation cancels it. */
  const escapeCancels = (e: KeyboardEvent<HTMLButtonElement>) => {
    if (e.key !== 'Escape') return
    e.preventDefault()
    e.stopPropagation()
    cancel()
  }
  const title = checkpointTitle(c)
  const { busy } = actions
  // Bridge release R0: made on the new canvas: listed, with a line that says when it can be previewed and
  // restored (once Lobby is back on the new canvas), instead of Preview and Restore.
  const newCanvas = newCanvasNote(c)
  const canPreview = perms.canPreview && !newCanvas
  const canRestoreThis = canRestore && !newCanvas
  const hasActions = canPreview || canRestoreThis || perms.canDelete
  return (
    <li
      className="dr-history__row dr-history__row--checkpoint"
      data-testid={testId}
      data-snapshot-id={c.id}
      data-kind={c.kind}
      data-reason={c.reason ?? ''}
      data-new-canvas={newCanvas ? '1' : undefined}
    >
      <div className="dr-history__row-text">
        <span className="dr-history__row-title">{title}</span>
        <span className="dr-history__row-meta">{checkpointMeta(c, now)}</span>
        {newCanvas && (
          <span className="dr-history__row-meta" data-testid="checkpoint-new-canvas">
            {newCanvas}
          </span>
        )}
      </div>
      {hasActions && !confirming && (
        <div className="dr-history__row-actions">
          {canPreview && (
            <button
              type="button"
              className="dr-btn"
              data-testid="checkpoint-preview"
              disabled={busy !== null}
              aria-label={`Preview “${title}”`}
              onClick={() => actions.onPreview(c)}
            >
              Preview
            </button>
          )}
          {canRestoreThis && (
            <button
              type="button"
              className="dr-btn"
              data-testid="checkpoint-restore"
              disabled={busy !== null || restoreOff}
              aria-describedby={restoreOff ? 'dr-history-restore-off' : undefined}
              aria-busy={busy === `restore:${c.id}`}
              aria-label={`Restore “${title}” as a new board`}
              onClick={() => actions.onRestore(c)}
            >
              {busy === `restore:${c.id}` ? 'Restoring…' : 'Restore as new board'}
            </button>
          )}
          {perms.canDelete && (
            <button
              ref={deleteRef}
              type="button"
              className="dr-iconbtn dr-history__delete"
              data-testid="checkpoint-delete"
              disabled={busy !== null}
              aria-label={`Delete “${title}”`}
              title="Delete"
              onClick={() => setConfirming(true)}
            >
              <svg
                viewBox="0 0 24 24"
                width="16"
                height="16"
                aria-hidden="true"
                fill="none"
                stroke="currentColor"
              >
                <path
                  d="M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V4h6v3"
                  strokeWidth="1.8"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </button>
          )}
        </div>
      )}
      {confirming && (
        <div className="dr-history__confirm">
          <p id={`dr-cp-confirm-${c.id}`}>Delete this checkpoint for everyone? This can’t be undone.</p>
          <div className="dr-history__confirm-actions">
            <button
              type="button"
              className="dr-btn dr-history__danger"
              data-testid="checkpoint-delete-confirm"
              disabled={busy !== null}
              aria-busy={busy === `delete:${c.id}`}
              aria-label={`Delete “${title}”`}
              aria-describedby={`dr-cp-confirm-${c.id}`}
              onClick={() => actions.onDelete(c)}
              onKeyDown={escapeCancels}
            >
              {busy === `delete:${c.id}` ? 'Deleting…' : 'Delete'}
            </button>
            <button
              type="button"
              className="dr-btn dr-btn--ghost"
              data-testid="checkpoint-delete-cancel"
              // biome-ignore lint/a11y/noAutofocus: the confirmation replaces the button just pressed; Cancel is the safe place for focus
              autoFocus
              onClick={cancel}
              onKeyDown={escapeCancels}
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </li>
  )
}
