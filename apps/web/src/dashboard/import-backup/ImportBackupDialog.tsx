// OWNER: WS4 (wave R). The dashboard's "Lobby backup (.lobby)…" (docs/WAVE-R-CONTRACTS.md §5, §7): pick a `.lobby`
// file (an <input type=file>, never the File System Access picker), optionally a title and a project, and restore it
// as a NEW private board of yours. The upload is the restore request itself; the api checks the file at once (a
// broken or hostile one is refused here, with the reason) and answers with an import job, which this dialog follows
// (dashboard/imports/client.ts getImportJob, every IMPORT_POLL_MS) to "Open board". Creators only: the dashboard
// offers the Import control only with `canCreate`, and the api refuses everyone else.
//
// The lead wires it (DashboardPage's Import line, lead-only): `const backup = useImportBackup({...})`, then
// `<ImportMenu … onBackup={backup.open} />` and `{backup.dialog}`, and the `backup` switch of IMPORT_MENU_FLAGS.
import {
  BACKUP_FILE_EXTENSION,
  BACKUP_MIME_TYPE,
  IMPORT_POLL_MS,
  type ImportJobView,
  type Project,
} from '@draftroom/contracts'
import { type FormEvent, type ReactNode, useCallback, useEffect, useId, useRef, useState } from 'react'
import { Dialog } from '../../ui/Dialog.tsx'
import { getImportJob, ImportRequestError } from '../imports/client.ts'
import { backupErrorText, restoreBackup } from './client.ts'

/** What the dialog says about a job (pure: the tests read it). */
export function restoreStatusText(view: ImportJobView | null): {
  text: string
  done: boolean
  failed: boolean
} {
  const board = view?.boards[0]
  if (!view || !board)
    return {
      text: 'Restoring… The board appears on your dashboard when it is ready. You can close this.',
      done: false,
      failed: false,
    }
  if (board.status === 'done' && board.boardId) return { text: 'Restored.', done: true, failed: false }
  if (board.status === 'failed' || board.status === 'cancelled')
    return { text: backupErrorText(board.errorCode ?? 'INTERNAL'), done: false, failed: true }
  const f = board.progress.files
  const n = (v: number) => v.toLocaleString('en-US')
  const files = f.total ? ` Files ${n(f.done)} of ${n(f.total)}.` : ''
  const phase =
    board.progress.phase === 'files'
      ? 'Restoring the files…'
      : board.progress.phase === 'converting' || board.progress.phase === 'activating'
        ? 'Building the board…'
        : 'Checking the backup…'
  return { text: `${phase}${files}`, done: false, failed: false }
}

/** Whether a picked file looks like a backup (the api decides; this only catches the wrong file early). */
export const looksLikeBackup = (file: { name: string; type: string }) =>
  file.name.toLowerCase().endsWith(BACKUP_FILE_EXTENSION) || file.type === BACKUP_MIME_TYPE

export function ImportBackupDialog({
  workspaceId,
  workspaceName,
  projects,
  defaultProjectId,
  onClose,
  onStarted,
  pollMs = IMPORT_POLL_MS,
}: {
  workspaceId: string
  workspaceName: string
  projects: readonly Project[]
  defaultProjectId: string | null
  onClose(): void
  /** the job started (the dashboard may refresh its list when the board is done) */
  onStarted?: (importId: string) => void
  pollMs?: number
}) {
  const fileId = useId()
  const titleId = useId()
  const projectId = useId()
  const [file, setFile] = useState<File | null>(null)
  const [title, setTitle] = useState('')
  const [project, setProject] = useState(defaultProjectId ?? '')
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)
  const [importId, setImportId] = useState<string | null>(null)
  const [view, setView] = useState<ImportJobView | null>(null)

  useEffect(() => {
    if (!importId) return
    let stopped = false
    let timer: ReturnType<typeof setTimeout> | null = null
    const poll = async () => {
      const next = await getImportJob(importId)
      if (stopped) return
      if (next) setView(next)
      const finished = next && ['done', 'failed', 'cancelled'].includes(next.status)
      if (!finished) timer = setTimeout(poll, pollMs)
    }
    void poll()
    return () => {
      stopped = true
      if (timer) clearTimeout(timer)
    }
  }, [importId, pollMs])

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    if (!file) {
      setError('Choose a .lobby backup file.')
      return
    }
    if (!looksLikeBackup(file)) {
      setError(
        'This is not a .lobby backup file. Board exports (.json) are imported with “Lobby board (.json)…”.',
      )
      return
    }
    setPending(true)
    setError(null)
    try {
      const started = await restoreBackup(workspaceId, file, {
        ...(title.trim() ? { title: title.trim() } : {}),
        ...(project ? { projectId: project } : {}),
      })
      setImportId(started.importId)
      onStarted?.(started.importId)
    } catch (err) {
      setError(backupErrorText(err instanceof ImportRequestError ? err.code : 'unavailable'))
      setPending(false)
    }
  }

  const status = importId ? restoreStatusText(view) : null
  const newBoard = status?.done ? view?.boards[0]?.boardId : null

  return (
    <Dialog
      title="Restore a backup"
      description={
        <>
          Into <strong>{workspaceName}</strong>, as a new private board of yours. The backup’s board and its
          files come back (the version of each file the board shows); comments and history are not part of a
          backup, nor are older versions of a file or review status.
        </>
      }
      onClose={onClose}
      testId="import-backup-dialog"
    >
      {status ? (
        <div className="dr-form" data-testid="import-backup-status">
          <p role="status" aria-live="polite" data-testid="import-backup-progress">
            {status.text}
          </p>
          <div className="dr-dialog__actions">
            {newBoard && (
              <a
                className="dr-btn dr-btn--primary"
                href={`/b/${encodeURIComponent(newBoard)}`}
                data-testid="import-backup-open"
              >
                Open board
              </a>
            )}
            <button type="button" className="dr-btn" onClick={onClose} data-testid="import-backup-close">
              Close
            </button>
          </div>
        </div>
      ) : (
        <form className="dr-form" onSubmit={submit} noValidate>
          <div>
            <label htmlFor={fileId}>Backup file (.lobby)</label>
            <input
              id={fileId}
              type="file"
              className="dr-input dr-input--block"
              data-testid="import-backup-file"
              accept={`${BACKUP_FILE_EXTENSION},${BACKUP_MIME_TYPE}`}
              onChange={(e) => {
                setFile(e.target.files?.[0] ?? null)
                setError(null)
              }}
            />
          </div>
          <div>
            <label htmlFor={titleId}>
              Title <span className="dr-optional">(optional: the backup’s own)</span>
            </label>
            <input
              id={titleId}
              className="dr-input dr-input--block"
              data-testid="import-backup-title"
              value={title}
              maxLength={120}
              autoComplete="off"
              onChange={(e) => setTitle(e.target.value)}
            />
          </div>
          <div>
            <label htmlFor={projectId}>
              Project <span className="dr-optional">(optional)</span>
            </label>
            <select
              id={projectId}
              className="dr-input dr-input--block dr-select"
              data-testid="import-backup-project"
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
          {error && (
            <p className="dr-field-error" role="alert" data-testid="import-backup-error">
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
              data-testid="import-backup-submit"
              disabled={pending}
            >
              {pending ? 'Uploading…' : 'Restore'}
            </button>
          </div>
        </form>
      )}
    </Dialog>
  )
}

/** The dialog and its opener, for the dashboard's Import control (see the top of this file). */
export function useImportBackup(props: {
  workspaceId: string | null
  workspaceName: string
  projects: readonly Project[]
  defaultProjectId: string | null
  onStarted?: (importId: string) => void
}): { open(): void; dialog: ReactNode } {
  const [isOpen, setOpen] = useState(false)
  const props$ = useRef(props)
  props$.current = props
  const open = useCallback(() => setOpen(true), [])
  const close = useCallback(() => setOpen(false), [])
  const { workspaceId } = props
  const dialog =
    isOpen && workspaceId ? (
      <ImportBackupDialog
        workspaceId={workspaceId}
        workspaceName={props.workspaceName}
        projects={props.projects}
        defaultProjectId={props.defaultProjectId}
        onClose={close}
        onStarted={(id) => props$.current.onStarted?.(id)}
      />
    ) : null
  return { open, dialog }
}
