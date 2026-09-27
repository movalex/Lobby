// Small dashboard dialogs for the card menu (DSH-02): move to project, duplicate, details.

import type { BoardMember, BoardWithRole, Project } from '@draftroom/contracts'
import { type FormEvent, useCallback, useId, useState } from 'react'
import { api, isApiError } from '../api/client.ts'
import { formatDateTime } from '../lib/format.ts'
import { can } from '../lib/permissions.ts'
import { useResource } from '../lib/useResource.ts'
import { Dialog } from '../ui/Dialog.tsx'
import { ROLE_LABEL } from './model.ts'

export function MoveBoardDialog({
  board,
  projects,
  onClose,
  onMove,
}: {
  board: BoardWithRole
  projects: readonly Project[]
  onClose(): void
  onMove(projectId: string | null): Promise<void>
}) {
  const selectId = useId()
  const [value, setValue] = useState(board.projectId ?? '')
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const submit = async (e: FormEvent) => {
    e.preventDefault()
    setPending(true)
    setError(null)
    try {
      await onMove(value || null)
    } catch (err) {
      setError(isApiError(err) ? err.message : 'The board was not moved. Try again.')
      setPending(false)
    }
  }
  const active = projects.filter((p) => !p.archivedAt)
  return (
    <Dialog
      title={<>Move “{board.title}”</>}
      description="Projects group related boards (for example by client or campaign). Moving does not change who can open the board."
      onClose={onClose}
      testId="move-dialog"
    >
      <form className="dr-form" onSubmit={(e) => void submit(e)}>
        <label htmlFor={selectId}>Project</label>
        <select
          id={selectId}
          className="dr-input dr-input--block dr-select"
          data-testid="move-project"
          value={value}
          onChange={(e) => setValue(e.target.value)}
        >
          <option value="">No project</option>
          {active.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
        {error && (
          <p className="dr-field-error" role="alert">
            {error}
          </p>
        )}
        <div className="dr-dialog__actions">
          <button type="button" className="dr-btn" onClick={onClose}>
            Cancel
          </button>
          <button
            type="submit"
            className="dr-btn dr-btn--primary"
            data-testid="move-submit"
            disabled={pending || value === (board.projectId ?? '')}
          >
            {pending ? 'Moving…' : 'Move'}
          </button>
        </div>
      </form>
    </Dialog>
  )
}

export function DuplicateBoardDialog({
  board,
  defaultTitle,
  onClose,
  onDuplicate,
}: {
  board: BoardWithRole
  defaultTitle: string
  onClose(): void
  onDuplicate(input: { title: string; keepSharing: boolean }): Promise<void>
}) {
  const titleId = useId()
  const [title, setTitle] = useState(defaultTitle)
  const [keepSharing, setKeepSharing] = useState(false)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const canKeep = can(board.role, 'manage_access', board.status)
  const submit = async (e: FormEvent) => {
    e.preventDefault()
    const t = title.trim() || defaultTitle
    setPending(true)
    setError(null)
    try {
      await onDuplicate({ title: t.slice(0, 120), keepSharing: canKeep && keepSharing })
    } catch (err) {
      setError(
        isApiError(err) && err.kind === 'not-found'
          ? 'This board could not be duplicated. Duplicating may not be available on this server yet.'
          : isApiError(err)
            ? err.message
            : 'The board was not duplicated. Try again.',
      )
      setPending(false)
    }
  }
  return (
    <Dialog
      title={<>Duplicate “{board.title}”</>}
      description="The copy has the board’s content and files. It is private to you unless you keep the sharing settings."
      onClose={onClose}
      testId="duplicate-dialog"
    >
      <form className="dr-form" onSubmit={(e) => void submit(e)} noValidate>
        <label htmlFor={titleId}>Name of the copy</label>
        <input
          id={titleId}
          className="dr-input dr-input--block"
          data-testid="duplicate-title"
          value={title}
          maxLength={120}
          autoComplete="off"
          onChange={(e) => setTitle(e.target.value)}
        />
        {canKeep && (
          <label className="dr-check">
            <input
              type="checkbox"
              data-testid="duplicate-keep-sharing"
              checked={keepSharing}
              onChange={(e) => setKeepSharing(e.target.checked)}
            />
            Keep sharing settings (workspace access and people; links are never copied)
          </label>
        )}
        {error && (
          <p className="dr-field-error" role="alert">
            {error}
          </p>
        )}
        <div className="dr-dialog__actions">
          <button type="button" className="dr-btn" onClick={onClose}>
            Cancel
          </button>
          <button
            type="submit"
            className="dr-btn dr-btn--primary"
            data-testid="duplicate-submit"
            disabled={pending}
          >
            {pending ? 'Duplicating…' : 'Duplicate'}
          </button>
        </div>
      </form>
    </Dialog>
  )
}

const VISIBILITY_LABEL: Record<BoardWithRole['visibility'], string> = {
  private: 'Private (only people who were added)',
  workspace_view: 'Everyone in the workspace can view',
  workspace_edit: 'Everyone in the workspace can edit',
}

export function BoardDetailsDialog({
  board,
  workspaceName,
  projectName,
  onClose,
}: {
  board: BoardWithRole
  workspaceName: string
  projectName: string | null
  onClose(): void
}) {
  const load = useCallback((signal: AbortSignal) => api.listMembers(board.id, signal), [board.id])
  const members = useResource<BoardMember[]>(load)
  const owners = (members.data ?? []).filter((m) => m.role === 'owner' && m.source === 'grant')
  const creator = (members.data ?? []).find((m) => m.user.id === board.createdBy)
  return (
    <Dialog title={board.title} description="Board details" onClose={onClose} testId="board-details">
      <dl className="dr-details">
        <div>
          <dt>Location</dt>
          <dd>
            {workspaceName}
            {projectName ? ` / ${projectName}` : ''}
          </dd>
        </div>
        <div>
          <dt>Owners</dt>
          <dd data-testid="board-details-owners">
            {members.status === 'loading'
              ? 'Loading…'
              : owners.length
                ? owners.map((o) => o.user.name).join(', ')
                : `${workspaceName} admins`}
          </dd>
        </div>
        <div>
          <dt>Created</dt>
          <dd>
            {formatDateTime(board.createdAt)}
            {creator ? ` by ${creator.user.name}` : ''}
          </dd>
        </div>
        <div>
          <dt>Last edited</dt>
          <dd>{formatDateTime(board.updatedAt)}</dd>
        </div>
        <div>
          <dt>Last opened</dt>
          <dd>{board.lastOpenedAt ? formatDateTime(board.lastOpenedAt) : 'Never'}</dd>
        </div>
        <div>
          <dt>Access</dt>
          <dd>{VISIBILITY_LABEL[board.visibility]}</dd>
        </div>
        <div>
          <dt>Your role</dt>
          <dd>{ROLE_LABEL[board.role]}</dd>
        </div>
        <div>
          <dt>Status</dt>
          <dd>
            {board.status === 'active'
              ? 'Active'
              : board.status === 'archived'
                ? 'Archived (read-only)'
                : 'In trash'}
          </dd>
        </div>
      </dl>
      <div className="dr-dialog__actions">
        <button type="button" className="dr-btn dr-btn--primary" onClick={onClose}>
          Close
        </button>
      </div>
    </Dialog>
  )
}
