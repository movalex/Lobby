// "New board" (PRE-01): the template picker (Blank board first and selected) with a title, a project
// and "Don't show templates on new boards". Creating from a template opens /b/<id>?template=<id>; the
// canvas-ux feature inserts the template once on that first open.

import type { Board, Project } from '@draftroom/contracts'
import { type FormEvent, useId, useState } from 'react'
import { api, isApiError } from '../api/client.ts'
import { Dialog } from '../ui/Dialog.tsx'
import { readPickerHidden, writePickerHidden } from './prefs.ts'
import { type TemplateChoice, TemplateGallery } from './TemplateGallery.tsx'
import type { CatalogEntry, TemplateId } from './template-catalog.ts'
import './dashboard.css'

export function CreateBoardDialog({
  workspaceId,
  workspaceName,
  userId,
  projects,
  defaultProjectId,
  onClose,
  onCreated,
}: {
  workspaceId: string
  workspaceName: string
  userId: string
  projects: readonly Project[]
  defaultProjectId: string | null
  onClose(): void
  onCreated(board: Board, templateId: TemplateId | null): void
}) {
  const titleId = useId()
  const projectId = useId()
  const errorId = useId()
  const formId = useId()
  const [title, setTitle] = useState('')
  const [project, setProject] = useState(defaultProjectId ?? '')
  const [choice, setChoice] = useState<TemplateChoice>('blank')
  const [entry, setEntry] = useState<CatalogEntry | null>(null)
  const [hidePicker, setHidePicker] = useState(() => readPickerHidden(userId))
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)

  const create = async (pick: TemplateChoice, picked: CatalogEntry | null) => {
    const t = title.trim() || picked?.name || 'Untitled board'
    if (t.length > 120) {
      setError('Titles can be at most 120 characters.')
      return
    }
    setPending(true)
    setError(null)
    try {
      const board = await api.createBoard(workspaceId, { title: t, projectId: project || null })
      onCreated(board, pick === 'blank' ? null : pick)
    } catch (err) {
      setError(isApiError(err) ? err.message : 'The board could not be created.')
      setPending(false)
    }
  }

  const submit = (e: FormEvent) => {
    e.preventDefault()
    void create(choice, entry)
  }

  return (
    <Dialog
      title="New board"
      description={
        <>
          In <strong>{workspaceName}</strong>. New boards are private: only you can open them until you share
          them. Templates are ordinary shapes you can edit or delete.
        </>
      }
      onClose={onClose}
      testId="create-board-dialog"
      size="lg"
    >
      <div className="dr-newboard">
        <TemplateGallery
          selected={choice}
          onSelect={(c, e) => {
            setChoice(c)
            setEntry(e)
            setError(null)
          }}
          onChoose={(c, e) => {
            setChoice(c)
            setEntry(e)
            if (!pending) void create(c, e)
          }}
        />
        <form id={formId} className="dr-form dr-newboard__form" onSubmit={submit} noValidate>
          {entry && (
            <p className="dr-newboard__sections" data-testid="template-sections">
              <strong>{entry.name}:</strong> {entry.sections.join(' · ')}
            </p>
          )}
          <div className="dr-newboard__fields">
            <div>
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
                placeholder={entry?.name ?? 'Untitled board'}
                maxLength={120}
                autoComplete="off"
                autoFocus
                aria-invalid={error ? true : undefined}
                aria-describedby={error ? errorId : undefined}
              />
            </div>
            <div>
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
            </div>
          </div>
          {error && (
            <p id={errorId} className="dr-field-error" role="alert">
              {error}
            </p>
          )}
          <label className="dr-check dr-newboard__dontshow">
            <input
              type="checkbox"
              data-testid="template-dont-show"
              checked={hidePicker}
              onChange={(e) => {
                setHidePicker(e.target.checked)
                writePickerHidden(userId, e.target.checked)
              }}
            />
            Don’t show templates on new boards
          </label>
        </form>
        {/* F1: the gallery is taller than a laptop screen (and a phone's), so Cancel / Create stay pinned
            to the bottom of the dialog while it scrolls; the button submits the form above. */}
        <div className="dr-newboard__footer" data-testid="create-board-footer">
          <span className="dr-newboard__picked" data-testid="create-board-picked">
            {entry && choice !== 'blank' ? entry.name : 'Blank board'}
          </span>
          <button type="button" className="dr-btn" onClick={onClose}>
            Cancel
          </button>
          <button
            type="submit"
            form={formId}
            className="dr-btn dr-btn--primary"
            data-testid="create-board-submit"
            disabled={pending}
          >
            {pending
              ? 'Creating…'
              : entry && choice !== 'blank'
                ? `Create from ${entry.name}`
                : 'Create board'}
          </button>
        </div>
      </div>
    </Dialog>
  )
}
