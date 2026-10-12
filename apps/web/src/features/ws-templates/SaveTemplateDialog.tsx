// OWNER: W8 (wave M, M8-4). "Save as workspace template": a name and a category, then POST
// /api/workspaces/:wid/templates (./client.ts). It reads the workspace's list first, so a board that already is a
// template shows its name and category, and can be removed from the templates. An api without templates (a 404)
// says so once and the command hides for the tab.
import type { WorkspaceTemplate, WsTemplateCategory } from '@draftroom/contracts'
import { type FormEvent, useEffect, useId, useState } from 'react'
import { isApiError } from '../../api/client.ts'
import type { CanvasFeatureContext } from '../../canvas/api/index.ts'
import { countUsage } from '../../lib/usage.ts'
import { Dialog } from '../../ui/Dialog.tsx'
import { listWsTemplates, removeWsTemplate, saveWsTemplate, WsTemplatesUnavailableError } from './client.ts'
import { defaultTemplateName, savedTemplateNotice, templateNameOrNull, WS_CATEGORY_OPTIONS } from './model.ts'

type Load =
  | { kind: 'loading' }
  | { kind: 'ready'; existing: WorkspaceTemplate | null }
  | { kind: 'unavailable' }

const NOTICE_KEY = 'ws-templates'
const UNAVAILABLE = 'Workspace templates aren’t available on this Lobby server yet.'

export function SaveTemplateDialog({ ctx, onClose }: { ctx: CanvasFeatureContext; onClose(): void }) {
  const nameId = useId()
  const categoryId = useId()
  const errorId = useId()
  const workspaceId = ctx.workspace.id
  const boardId = ctx.board.id
  const [load, setLoad] = useState<Load>({ kind: 'loading' })
  const [name, setName] = useState(() => defaultTemplateName(ctx.board.title))
  const [category, setCategory] = useState<WsTemplateCategory>('other')
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)

  useEffect(() => {
    const abort = new AbortController()
    listWsTemplates(workspaceId, { api: ctx.api, signal: abort.signal }).then(
      (templates) => {
        const existing = templates.find((t) => t.boardId === boardId) ?? null
        if (existing) {
          setName(existing.name)
          setCategory(existing.category)
        }
        setLoad({ kind: 'ready', existing })
      },
      (e: unknown) => {
        if (abort.signal.aborted) return
        if (e instanceof WsTemplatesUnavailableError) setLoad({ kind: 'unavailable' })
        // The list only prefills: the save can still be tried.
        else setLoad({ kind: 'ready', existing: null })
      },
    )
    return () => abort.abort()
  }, [ctx.api, workspaceId, boardId])

  const done = (text: string) => {
    ctx.notify({ key: NOTICE_KEY, text, testId: 'ws-template-saved', timeoutMs: 6000 })
    onClose()
  }

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    const clean = templateNameOrNull(name)
    if (!clean) {
      setError('Give the template a name of at most 80 characters.')
      return
    }
    setPending(true)
    setError(null)
    try {
      await saveWsTemplate(workspaceId, { boardId, name: clean, category }, { api: ctx.api })
      countUsage('template.save')
      done(
        load.kind === 'ready' && load.existing
          ? `Workspace template “${clean}” updated.`
          : savedTemplateNotice(ctx.workspace.name),
      )
    } catch (err) {
      setPending(false)
      setError(isApiError(err) ? err.message : 'The template could not be saved. Try again.')
    }
  }

  const remove = async () => {
    setPending(true)
    setError(null)
    try {
      await removeWsTemplate(workspaceId, boardId, { api: ctx.api })
      done('Removed from the workspace templates. The board itself is unchanged.')
    } catch (err) {
      setPending(false)
      setError(isApiError(err) ? err.message : 'The template could not be removed. Try again.')
    }
  }

  if (load.kind === 'unavailable')
    return (
      <Dialog title="Save as workspace template" onClose={onClose} testId="ws-template-dialog">
        <p className="dr-muted" data-testid="ws-template-unavailable">
          {UNAVAILABLE}
        </p>
        <div className="dr-dialog__actions">
          <button type="button" className="dr-btn" onClick={onClose}>
            Close
          </button>
        </div>
      </Dialog>
    )

  const existing = load.kind === 'ready' ? load.existing : null
  return (
    <Dialog
      title="Save as workspace template"
      description={
        <>
          Members of <strong>{ctx.workspace.name}</strong> who can make boards can start a new board from a
          copy of this board. The copy gets this board’s content only, none of its sharing.
        </>
      }
      onClose={onClose}
      testId="ws-template-dialog"
    >
      <form className="dr-form" onSubmit={(e) => void submit(e)} noValidate>
        {existing && (
          <p className="dr-muted" data-testid="ws-template-existing">
            This board is already a workspace template. Saving updates its name and category.
          </p>
        )}
        <div>
          <label htmlFor={nameId}>Template name</label>
          <input
            id={nameId}
            className="dr-input dr-input--block"
            data-testid="ws-template-name"
            value={name}
            maxLength={80}
            autoComplete="off"
            onChange={(e) => {
              setName(e.target.value)
              setError(null)
            }}
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? errorId : undefined}
          />
        </div>
        <div>
          <label htmlFor={categoryId}>Category</label>
          <select
            id={categoryId}
            className="dr-input dr-input--block dr-select"
            data-testid="ws-template-category"
            value={category}
            onChange={(e) => setCategory(e.target.value as WsTemplateCategory)}
          >
            {WS_CATEGORY_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </div>
        {error && (
          <p id={errorId} className="dr-field-error" role="alert" data-testid="ws-template-error">
            {error}
          </p>
        )}
        <div className="dr-dialog__actions">
          {existing && (
            <button
              type="button"
              className="dr-btn"
              data-testid="ws-template-remove"
              disabled={pending}
              onClick={() => void remove()}
            >
              Remove from templates
            </button>
          )}
          <button type="button" className="dr-btn" onClick={onClose}>
            Cancel
          </button>
          <button
            type="submit"
            className="dr-btn dr-btn--primary"
            data-testid="ws-template-submit"
            disabled={pending || load.kind === 'loading'}
            aria-busy={pending || undefined}
          >
            {pending ? 'Saving…' : existing ? 'Update template' : 'Save template'}
          </button>
        </div>
      </form>
    </Dialog>
  )
}
