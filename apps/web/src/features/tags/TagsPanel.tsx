// The Tags dock panel: every tag on the board (listed, or carried by notes and cards) with how many
// items carry it. Everyone can "Show only" a tag (dims the rest of the canvas, for them alone). Editors
// also create tags, rename them, change their colour and delete them everywhere; each is one undo step.

import { TAG_NAME_MAX_CHARS, type TagColor } from '@draftroom/contracts'
import { type FormEvent, useId, useState } from 'react'
import { useValue } from 'tldraw'
import { NOTE_PALETTE } from '../canvas-ux/palette.ts'
import type { FeatureContext } from '../types.ts'
import { plural, READONLY_HINT, usageLabel } from './copy.ts'
import { useTagRows } from './hooks.ts'
import { FilterIcon, PencilIcon } from './icons.tsx'
import type { BoardTagRow } from './model.ts'
import { createBoardTag, deleteTagEverywhere, recolorTag, renameTag, tagFilter } from './runtime.ts'

export function TagsPanel({ ctx }: { ctx: FeatureContext; close(): void }) {
  const editor = ctx.editor
  const rows = useTagRows(editor)
  const readonly = useValue('dr-tags-panel-readonly', () => editor.getIsReadonly(), [editor])
  const filter = useValue('dr-tags-panel-filter', () => tagFilter(editor).get(), [editor])
  const [editing, setEditing] = useState<string | null>(null)

  return (
    <div className="dr-tags-panel" data-testid="tags-panel">
      {readonly ? (
        <p className="dr-tags-muted" data-testid="tags-readonly-hint">
          {READONLY_HINT}
        </p>
      ) : (
        <NewTagForm ctx={ctx} />
      )}
      {rows.length === 0 ? (
        <div className="dr-tags-empty" data-testid="tags-empty">
          <p>No tags on this board yet.</p>
          {!readonly && (
            <p className="dr-tags-muted">
              Select notes, images, files or mind-map topics, then choose <strong>Tags</strong> in the bar
              under them.
            </p>
          )}
        </div>
      ) : (
        <ul className="dr-tags-list" aria-label="Tags on this board">
          {rows.map((row) => (
            <TagRow
              key={row.key}
              ctx={ctx}
              row={row}
              readonly={readonly}
              filtered={filter === row.key}
              editing={editing === row.key}
              onEdit={(on) => setEditing(on ? row.key : null)}
            />
          ))}
        </ul>
      )}
    </div>
  )
}

function NewTagForm({ ctx }: { ctx: FeatureContext }) {
  const [name, setName] = useState('')
  const [error, setError] = useState<string | null>(null)
  const id = useId()
  const submit = (e: FormEvent) => {
    e.preventDefault()
    const res = createBoardTag(ctx.editor, name)
    if (!res.ok) {
      setError(res.error)
      return
    }
    setError(res.value.created ? null : `“${res.value.tag.name}” is already on this board.`)
    setName('')
  }
  return (
    <form className="dr-tags-new" onSubmit={submit} data-testid="tags-new">
      <label htmlFor={id} className="dr-tags-label">
        New tag
      </label>
      <div className="dr-tags-new__row">
        <input
          id={id}
          className="dr-input dr-input--block"
          value={name}
          maxLength={64}
          autoComplete="off"
          placeholder={`Up to ${TAG_NAME_MAX_CHARS} characters`}
          data-testid="tags-new-input"
          aria-describedby={error ? `${id}-err` : undefined}
          onChange={(e) => {
            setName(e.target.value)
            setError(null)
          }}
        />
        <button
          type="submit"
          className="dr-btn dr-btn--sm"
          data-testid="tags-new-add"
          disabled={!name.trim()}
        >
          Add
        </button>
      </div>
      {error && (
        <p id={`${id}-err`} className="dr-tags-error" role="alert" data-testid="tags-new-error">
          {error}
        </p>
      )}
    </form>
  )
}

function TagRow({
  ctx,
  row,
  readonly,
  filtered,
  editing,
  onEdit,
}: {
  ctx: FeatureContext
  row: BoardTagRow
  readonly: boolean
  filtered: boolean
  editing: boolean
  onEdit(on: boolean): void
}) {
  const editor = ctx.editor
  const editorId = useId()
  return (
    <li
      className="dr-tags-row"
      data-testid="tag-row"
      data-tag-key={row.key}
      data-filtered={filtered || undefined}
    >
      <div className="dr-tags-row__main">
        <span className="dr-tag-dot" data-dr-tag-color={row.color} aria-hidden="true" />
        <span className="dr-tags-row__text">
          <span className="dr-tags-row__name" data-testid="tag-row-name">
            {row.name}
          </span>
          <span className="dr-tags-row__count" data-testid="tag-row-count" data-count={row.count}>
            {usageLabel(row.count)}
          </span>
        </span>
        <button
          type="button"
          className="dr-iconbtn dr-iconbtn--sm dr-tags-row__btn"
          aria-pressed={filtered}
          aria-label={
            filtered ? `Show everything (stop showing only “${row.name}”)` : `Show only “${row.name}”`
          }
          title={filtered ? 'Show everything' : 'Show only this tag'}
          data-testid="tag-filter"
          onClick={() => tagFilter(editor).set(filtered ? null : row.key)}
        >
          <FilterIcon size={16} />
        </button>
        {!readonly && (
          <button
            type="button"
            className="dr-iconbtn dr-iconbtn--sm dr-tags-row__btn"
            aria-expanded={editing}
            aria-controls={editorId}
            aria-label={`Edit “${row.name}”`}
            title="Rename, colour or delete"
            data-testid="tag-edit"
            onClick={() => onEdit(!editing)}
          >
            <PencilIcon size={16} />
          </button>
        )}
      </div>
      {editing && !readonly && <TagEditor id={editorId} ctx={ctx} row={row} onDone={() => onEdit(false)} />}
    </li>
  )
}

function TagEditor({
  id,
  ctx,
  row,
  onDone,
}: {
  id: string
  ctx: FeatureContext
  row: BoardTagRow
  onDone(): void
}) {
  const editor = ctx.editor
  const [name, setName] = useState(row.name)
  const [error, setError] = useState<string | null>(null)
  const [confirming, setConfirming] = useState(false)
  const nameId = useId()

  const rename = (e: FormEvent) => {
    e.preventDefault()
    if (name.trim() === row.name) return onDone()
    const res = renameTag(editor, row.key, name)
    if (!res.ok) return setError(res.error)
    ctx.notify({
      key: 'tags',
      text: `Renamed to “${res.value.name}”.`,
      testId: 'tags-notice',
      timeoutMs: 4000,
    })
    onDone()
  }
  const recolor = (color: TagColor) => {
    const res = recolorTag(editor, row.key, color)
    if (!res.ok) setError(res.error)
  }
  const remove = () => {
    const n = deleteTagEverywhere(editor, row.key)
    ctx.notify({
      key: 'tags',
      text: `Deleted “${row.name}”${n ? ` from ${plural(n, 'item')}` : ''}. Ctrl+Z brings it back.`,
      testId: 'tags-notice',
      timeoutMs: 7000,
    })
    onDone()
  }

  return (
    <div id={id} className="dr-tags-editor" data-testid="tag-editor">
      <form className="dr-tags-editor__rename" onSubmit={rename}>
        <label htmlFor={nameId} className="dr-tags-label">
          Name
        </label>
        <div className="dr-tags-new__row">
          <input
            id={nameId}
            className="dr-input dr-input--block"
            value={name}
            maxLength={64}
            autoComplete="off"
            data-testid="tag-rename-input"
            aria-describedby={error ? `${nameId}-err` : undefined}
            onChange={(e) => {
              setName(e.target.value)
              setError(null)
            }}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                e.stopPropagation()
                onDone()
              }
            }}
          />
          <button type="submit" className="dr-btn dr-btn--sm" data-testid="tag-rename-save">
            Save
          </button>
        </div>
        {error && (
          <p id={`${nameId}-err`} className="dr-tags-error" role="alert" data-testid="tag-editor-error">
            {error}
          </p>
        )}
      </form>
      <fieldset className="dr-tags-colors">
        <legend className="dr-tags-label">Colour</legend>
        <div className="dr-tags-colors__grid">
          {NOTE_PALETTE.map((sw) => (
            <button
              key={sw.name}
              type="button"
              className="dr-tags-swatch"
              data-dr-tag-color={sw.name}
              data-testid="tag-color"
              data-color={sw.name}
              aria-label={sw.label}
              title={sw.label}
              aria-pressed={row.color === sw.name}
              onClick={() => recolor(sw.name)}
            />
          ))}
        </div>
      </fieldset>
      <div className="dr-tags-editor__danger">
        {confirming ? (
          <div className="dr-tags-confirm">
            <p>
              Delete “{row.name}”{row.count ? ` from ${plural(row.count, 'item')}` : ''}? The notes and cards
              stay.
            </p>
            <div className="dr-tags-confirm__actions">
              <button
                type="button"
                className="dr-btn dr-btn--sm dr-tags-danger-btn"
                data-testid="tag-delete-confirm"
                onClick={remove}
              >
                Delete everywhere
              </button>
              <button type="button" className="dr-btn dr-btn--sm" onClick={() => setConfirming(false)}>
                Cancel
              </button>
            </div>
          </div>
        ) : (
          <button
            type="button"
            className="dr-btn dr-btn--sm dr-btn--ghost dr-tags-delete"
            data-testid="tag-delete"
            onClick={() => setConfirming(true)}
          >
            Delete everywhere…
          </button>
        )}
      </div>
    </div>
  )
}
