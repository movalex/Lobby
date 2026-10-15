// OWNER: WS3 (wave Q). Library management in the Elements panel, for what the caller may change (the api's `canEdit`
// on each item and folder; the api decides again): an item's details (name, tags, folder: PATCH with the revision it
// read, so a change made meanwhile is never overwritten), and a folder's name (new or renamed). Deleting is in the
// panel (a notice with Undo).
import {
  LIBRARY_CODES,
  LIBRARY_LIMITS,
  type LibraryFolder,
  type LibraryItemSummary,
  type LibraryScope,
} from '@draftroom/contracts'
import { type FormEvent, useId, useState } from 'react'
import { Dialog } from '../../ui/Dialog.tsx'
import { createLibraryFolder, LibraryRequestError, patchLibraryFolder, patchLibraryItem } from './client.ts'
import { folderNameOrNull, itemNameOrNull, parseTags } from './model.ts'

/** Words for a refused library write (the api's code). */
export function libraryErrorText(e: unknown): string {
  const code = e instanceof LibraryRequestError ? e.code : 'unavailable'
  switch (code) {
    case 'unavailable':
      return 'The library isn’t available right now. Try again in a moment.'
    case 'CREATOR_REQUIRED':
      return 'Saving to the workspace library needs a work address. Save it to your own library instead.'
    case LIBRARY_CODES.staleRevision:
      return 'Someone changed this item meanwhile. Close this and open it again to see their changes.'
    case LIBRARY_CODES.full:
      return 'This library is full. Delete something you no longer need first.'
    case LIBRARY_CODES.folderExists:
      return 'There is a folder of that name already.'
    case LIBRARY_CODES.tooLarge: {
      const { itemElements, itemImages } = LIBRARY_LIMITS
      return `That is too big for the library (at most ${itemElements} objects and ${itemImages} images).`
    }
    case LIBRARY_CODES.invalidElements:
      return 'Something in the selection can’t go into the library.'
    case LIBRARY_CODES.fileNotServable:
      return 'An image in the selection can’t be saved from this board.'
    case LIBRARY_CODES.exportRefused:
      return 'This board doesn’t allow copying its content out.'
    case 'RATE_LIMITED':
      return 'That was a lot at once. Wait a moment and try again.'
    case 'NOT_FOUND':
      return 'That is gone, or you can no longer change it.'
    default:
      return 'That didn’t work. Try again.'
  }
}

export function FolderSelect({
  id,
  folders,
  value,
  onChange,
  testId,
}: {
  id: string
  folders: readonly LibraryFolder[]
  value: string | null
  onChange(v: string | null): void
  testId?: string
}) {
  return (
    <select
      id={id}
      className="dr-input dr-input--block dr-select"
      value={value ?? ''}
      data-testid={testId}
      onChange={(e) => onChange(e.target.value || null)}
    >
      <option value="">No folder</option>
      {folders.map((f) => (
        <option key={f.id} value={f.id}>
          {f.name}
        </option>
      ))}
    </select>
  )
}

export function ItemDialog({
  workspaceId,
  item,
  folders,
  onClose,
  onSaved,
}: {
  workspaceId: string
  item: LibraryItemSummary
  folders: readonly LibraryFolder[]
  onClose(): void
  onSaved(item: LibraryItemSummary): void
}) {
  const nameId = useId()
  const tagsId = useId()
  const folderId = useId()
  const errorId = useId()
  const [name, setName] = useState(item.name)
  const [tags, setTags] = useState(item.tags.join(', '))
  const [folder, setFolder] = useState<string | null>(item.folderId)
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    const clean = itemNameOrNull(name)
    if (!clean) return setError(`Give it a name of at most ${LIBRARY_LIMITS.nameChars} characters.`)
    const parsed = parseTags(tags)
    if (parsed.problem) return setError(parsed.problem)
    setPending(true)
    setError(null)
    try {
      const saved = await patchLibraryItem(workspaceId, item.id, {
        revision: item.revision,
        name: clean,
        tags: parsed.tags,
        folderId: folder,
      })
      onSaved(saved)
    } catch (err) {
      setPending(false)
      setError(libraryErrorText(err))
    }
  }

  return (
    <Dialog
      title="Edit library item"
      description="Changes apply to the library only: copies already on boards stay as they are."
      onClose={onClose}
      testId="element-item-dialog"
    >
      <form className="dr-form" onSubmit={(e) => void submit(e)} noValidate>
        <div>
          <label htmlFor={nameId}>Name</label>
          <input
            id={nameId}
            className="dr-input dr-input--block"
            data-testid="element-item-name"
            value={name}
            maxLength={LIBRARY_LIMITS.nameChars}
            autoComplete="off"
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? errorId : undefined}
            onChange={(e) => {
              setName(e.target.value)
              setError(null)
            }}
          />
        </div>
        <div>
          <label htmlFor={tagsId}>Tags</label>
          <input
            id={tagsId}
            className="dr-input dr-input--block"
            data-testid="element-item-tags"
            value={tags}
            placeholder="Separate tags with commas"
            autoComplete="off"
            onChange={(e) => {
              setTags(e.target.value)
              setError(null)
            }}
          />
        </div>
        <div>
          <label htmlFor={folderId}>Folder</label>
          <FolderSelect id={folderId} folders={folders} value={folder} onChange={setFolder} />
        </div>
        {error && (
          <p id={errorId} className="dr-field-error" role="alert" data-testid="element-item-error">
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
            data-testid="element-item-submit"
            disabled={pending}
            aria-busy={pending || undefined}
          >
            {pending ? 'Saving…' : 'Save'}
          </button>
        </div>
      </form>
    </Dialog>
  )
}

export function FolderDialog({
  workspaceId,
  scope,
  folder,
  onClose,
  onSaved,
}: {
  workspaceId: string
  scope: LibraryScope
  /** the folder to rename; null: a new folder */
  folder: LibraryFolder | null
  onClose(): void
  onSaved(folder: LibraryFolder): void
}) {
  const nameId = useId()
  const errorId = useId()
  const [name, setName] = useState(folder?.name ?? '')
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    const clean = folderNameOrNull(name)
    if (!clean)
      return setError(`Give the folder a name of at most ${LIBRARY_LIMITS.folderNameChars} characters.`)
    setPending(true)
    setError(null)
    try {
      const saved = folder
        ? await patchLibraryFolder(workspaceId, folder.id, { name: clean })
        : await createLibraryFolder(workspaceId, { scope, name: clean })
      onSaved(saved)
    } catch (err) {
      setPending(false)
      setError(libraryErrorText(err))
    }
  }

  return (
    <Dialog title={folder ? 'Rename folder' : 'New folder'} onClose={onClose} testId="element-folder-dialog">
      <form className="dr-form" onSubmit={(e) => void submit(e)} noValidate>
        <div>
          <label htmlFor={nameId}>Folder name</label>
          <input
            id={nameId}
            className="dr-input dr-input--block"
            data-testid="element-folder-name"
            value={name}
            maxLength={LIBRARY_LIMITS.folderNameChars}
            autoComplete="off"
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? errorId : undefined}
            onChange={(e) => {
              setName(e.target.value)
              setError(null)
            }}
          />
        </div>
        {error && (
          <p id={errorId} className="dr-field-error" role="alert" data-testid="element-folder-error">
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
            data-testid="element-folder-submit"
            disabled={pending}
            aria-busy={pending || undefined}
          >
            {pending ? 'Saving…' : folder ? 'Rename' : 'Create folder'}
          </button>
        </div>
      </form>
    </Dialog>
  )
}
