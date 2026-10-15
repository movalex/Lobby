// OWNER: WS3 (wave Q). "Save to library": the selection (with its containers' labels and its frames' children) made
// into a library item on the web first (board-ops serializeLibraryItem: portable, item-local ids, checked as the room
// checks, held to the item limits), then POST …/library/items (./client.ts), which checks it all again. The dialog asks
// for a name (the selection's first words by default), tags, a folder, and Workspace or Personal: the workspace
// library is offered to creators only (an outsider sees why and saves to their own). A selection with images says the
// images go to the library too. docs/WAVE-Q-CONTRACTS.md §5.
import {
  type LibraryItemProblem,
  type LibraryItemResult,
  serializeLibraryItem,
} from '@draftroom/board-ops/elements'
import { LIBRARY_LIMITS, type LibraryScope } from '@draftroom/contracts'
import { type FormEvent, useId, useMemo, useState } from 'react'
import type { CanvasFeatureContext } from '../../canvas/api/index.ts'
import { countUsage } from '../../lib/usage.ts'
import { Dialog } from '../../ui/Dialog.tsx'
import type { ElementsAccess } from './access.ts'
import { saveLibraryItem } from './client.ts'
import { useFolders } from './hooks.ts'
import { FolderSelect, libraryErrorText } from './LibraryDialogs.tsx'
import { itemNameOrNull, parseTags } from './model.ts'
import { ItemPreview, type ItemPreviewEl } from './Previews.tsx'
import { elementsState } from './state.ts'

/** The selection as an item (or why it cannot be one). */
export function serializeSelection(
  canvas: Pick<CanvasFeatureContext['canvas'], 'get' | 'items'>,
  ids: readonly string[],
): LibraryItemResult {
  const selected = ids.map((id) => canvas.get(id)).filter((e) => !!e)
  return serializeLibraryItem(selected, {
    scene: canvas.items(),
    limits: {
      maxElements: LIBRARY_LIMITS.itemElements,
      maxBytes: LIBRARY_LIMITS.itemBytes,
      maxImages: LIBRARY_LIMITS.itemImages,
      maxNameChars: LIBRARY_LIMITS.nameChars,
    },
  })
}

export function problemText(problem: LibraryItemProblem): string {
  switch (problem) {
    case 'empty':
      return 'Select something on the board to save it.'
    case 'refused-type':
      return 'Embedded pages can’t go into the library. Leave them out of the selection.'
    case 'inline-data':
      return 'Something in the selection holds an image that isn’t uploaded to Lobby. Leave it out.'
    case 'too-many-elements':
      return `That is too many objects for one library item (at most ${LIBRARY_LIMITS.itemElements}).`
    case 'too-large':
      return 'That selection is too big for one library item.'
    case 'too-many-images':
      return `That is too many images for one library item (at most ${LIBRARY_LIMITS.itemImages}).`
    default:
      return 'Something in the selection can’t go into the library.'
  }
}

const DESCRIPTION =
  'A copy of the selection goes into the library, to add to any board of this workspace. The board is unchanged.'

export function SaveDialog({
  ctx,
  ids,
  access,
  onClose,
}: {
  ctx: CanvasFeatureContext
  ids: readonly string[]
  access: ElementsAccess
  onClose(): void
}) {
  const nameId = useId()
  const tagsId = useId()
  const folderId = useId()
  const errorId = useId()
  const scopeName = useId()
  const workspaceId = ctx.workspace.id
  const result = useMemo(() => serializeSelection(ctx.canvas, ids), [ctx.canvas, ids])
  const payload = result.ok ? result.item : null
  const [name, setName] = useState(() => payload?.suggestedName ?? 'Untitled')
  const [tags, setTags] = useState('')
  const [scope, setScope] = useState<LibraryScope>(access.workspaceSave ? 'workspace' : 'personal')
  const [folder, setFolder] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)
  const folders = useFolders(workspaceId, scope, access.library, 0)

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    if (!payload) return
    const clean = itemNameOrNull(name)
    if (!clean) return setError(`Give it a name of at most ${LIBRARY_LIMITS.nameChars} characters.`)
    const parsed = parseTags(tags)
    if (parsed.problem) return setError(parsed.problem)
    setPending(true)
    setError(null)
    try {
      await saveLibraryItem(workspaceId, {
        scope,
        name: clean,
        tags: parsed.tags,
        folderId: folder,
        sourceBoardId: ctx.board.id,
        elements: payload.elements as unknown as Record<string, unknown>[],
      })
      countUsage('elements.save')
      const page = elementsState(ctx.canvas)
      page.libraryVersion.update((v) => v + 1)
      ctx.notify({
        key: 'elements-save',
        text: `Saved “${clean}” to ${scope === 'workspace' ? 'the workspace library' : 'your library'}.`,
        testId: 'element-saved',
        timeoutMs: 6000,
        action: {
          label: 'Show',
          testId: 'element-saved-show',
          onClick: () => {
            page.requestedTab.set('library')
            ctx.openPanel('elements')
          },
        },
      })
      onClose()
    } catch (err) {
      setPending(false)
      setError(libraryErrorText(err))
    }
  }

  return (
    <Dialog title="Save to library" description={DESCRIPTION} onClose={onClose} testId="element-save-dialog">
      {!payload ? (
        <>
          <p className="dr-field-error" role="alert" data-testid="element-save-problem">
            {problemText(result.ok ? 'empty' : result.problem)}
          </p>
          <div className="dr-dialog__actions">
            <button type="button" className="dr-btn" onClick={onClose}>
              Close
            </button>
          </div>
        </>
      ) : (
        <form className="dr-form" onSubmit={(e) => void submit(e)} noValidate>
          <div className="dr-el-save__preview">
            <ItemPreview
              id="new"
              elements={payload.elements as unknown as ItemPreviewEl[]}
              width={payload.width}
              height={payload.height}
              thumb={() => null}
            />
            <span className="dr-el-save__count">
              {payload.elementCount === 1 ? '1 object' : `${payload.elementCount} objects`}
            </span>
          </div>
          <div>
            <label htmlFor={nameId}>Name</label>
            <input
              id={nameId}
              className="dr-input dr-input--block"
              data-testid="element-save-name"
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
              data-testid="element-save-tags"
              value={tags}
              placeholder="Separate tags with commas"
              autoComplete="off"
              onChange={(e) => {
                setTags(e.target.value)
                setError(null)
              }}
            />
          </div>
          <fieldset className="dr-el-save__scope">
            <legend>Save to</legend>
            <label className="dr-el-save__radio">
              <input
                type="radio"
                name={scopeName}
                value="workspace"
                checked={scope === 'workspace'}
                disabled={!access.workspaceSave}
                data-testid="element-save-scope-workspace"
                onChange={() => {
                  setScope('workspace')
                  setFolder(null)
                }}
              />
              <span className="dr-el-save__radio-text">
                <span className="dr-el-save__radio-name">The workspace library</span>
                <span className="dr-el-save__hint">Everyone in {ctx.workspace.name} can use it.</span>
              </span>
            </label>
            {access.workspaceSaveReason && (
              <p className="dr-el-save__hint" data-testid="element-save-workspace-reason">
                {access.workspaceSaveReason}
              </p>
            )}
            <label className="dr-el-save__radio">
              <input
                type="radio"
                name={scopeName}
                value="personal"
                checked={scope === 'personal'}
                data-testid="element-save-scope-personal"
                onChange={() => {
                  setScope('personal')
                  setFolder(null)
                }}
              />
              <span className="dr-el-save__radio-text">
                <span className="dr-el-save__radio-name">My library</span>
                <span className="dr-el-save__hint">Only you see it.</span>
              </span>
            </label>
          </fieldset>
          <div>
            <label htmlFor={folderId}>Folder</label>
            <FolderSelect
              id={folderId}
              folders={folders}
              value={folder}
              onChange={setFolder}
              testId="element-save-folder"
            />
          </div>
          {payload.imageCount > 0 && (
            <p className="dr-el-save__hint" data-testid="element-save-images">
              {payload.imageCount === 1 ? 'The image' : `The ${payload.imageCount} images`} in the selection
              go into the library too.
            </p>
          )}
          {error && (
            <p id={errorId} className="dr-field-error" role="alert" data-testid="element-save-error">
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
              data-testid="element-save-submit"
              disabled={pending}
              aria-busy={pending || undefined}
            >
              {pending ? 'Saving…' : 'Save'}
            </button>
          </div>
        </form>
      )}
    </Dialog>
  )
}
