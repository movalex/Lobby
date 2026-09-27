import type { Board, Project } from '@draftroom/contracts'
import { type FormEvent, useId, useState } from 'react'
import { api, isApiError } from '../api/client.ts'
import { Dialog } from '../ui/Dialog.tsx'

export function CreateBoardDialog({
  workspaceId,
  workspaceName,
  projects,
  defaultProjectId,
  onClose,
  onCreated,
}: {
  workspaceId: string
  workspaceName: string
  projects: readonly Project[]
  defaultProjectId: string | null
  onClose(): void
  onCreated(board: Board): void
}) {
  const titleId = useId()
  const projectId = useId()
  const errorId = useId()
  const [title, setTitle] = useState('')
  const [project, setProject] = useState(defaultProjectId ?? '')
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    const t = title.trim() || 'Untitled board'
    if (t.length > 120) {
      setError('Titles can be at most 120 characters.')
      return
    }
    setPending(true)
    setError(null)
    try {
      const board = await api.createBoard(workspaceId, { title: t, projectId: project || null })
      onCreated(board)
    } catch (err) {
      setError(isApiError(err) ? err.message : 'The board could not be created.')
      setPending(false)
    }
  }

  return (
    <Dialog
      title="New board"
      description={
        <>
          In <strong>{workspaceName}</strong>. New boards are private: only you can open them until you share
          them.
        </>
      }
      onClose={onClose}
      testId="create-board-dialog"
    >
      <form className="dr-form" onSubmit={(e) => void submit(e)} noValidate>
        <label htmlFor={titleId}>Title</label>
        <input
          id={titleId}
          className="dr-input dr-input--block"
          data-testid="create-board-title"
          value={title}
          onChange={(e) => {
            setTitle(e.target.value)
            setError(null)
          }}
          placeholder="Untitled board"
          maxLength={120}
          autoComplete="off"
          autoFocus
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? errorId : undefined}
        />
        <label htmlFor={projectId}>
          Project <span className="dr-optional">(optional)</span>
        </label>
        <select
          id={projectId}
          className="dr-input dr-input--block dr-select"
          data-testid="create-board-project"
          value={project}
          onChange={(e) => setProject(e.target.value)}
        >
          <option value="">No project</option>
          {projects.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
        {error && (
          <p id={errorId} className="dr-field-error" role="alert">
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
            data-testid="create-board-submit"
            disabled={pending}
          >
            {pending ? 'Creating…' : 'Create board'}
          </button>
        </div>
      </form>
    </Dialog>
  )
}
