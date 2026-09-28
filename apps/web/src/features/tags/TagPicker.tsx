// The tag picker: a "Tags" button in canvas-ux's selection bar (under the selected notes or file cards)
// and its popover. Editors find a tag or create one by typing (Enter), and tick or untick board tags for
// the whole selection (one undo step each; a tick on a mixed selection adds it to the rest). People who
// cannot edit get the same button while the selection carries tags, and see them read-only (the chips
// on a note show at most three).
//
// The popover is rendered inside the selection bar, so it moves with the bar and needs no positioning
// per frame. The bar stops pointer and key events from reaching tldraw with native listeners, and so
// does the popover (it must: the bar's own handler keeps the canvas focused by cancelling mousedown,
// which would stop the text field from taking focus). React never sees those keydowns, so the keys are
// handled natively here too, the way canvas-ux's useIsland does it.

import { foldForSearch } from '@draftroom/board-ops'
import { MAX_TAGS_PER_SHAPE, normalizeTagName, type TagDef, tagKey } from '@draftroom/contracts'
import { memo, useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import { type Editor, type TLShape, useEditor, useValue } from 'tldraw'
import { fullNotice, READONLY_HINT, thingName } from './copy.ts'
import { TagIcon } from './icons.tsx'
import { useIsolated } from './isolate.ts'
import {
  type BoardTagRow,
  displayTags,
  isTaggable,
  type SelectionTagState,
  selectionTagState,
  shapeTags,
} from './model.ts'
import { PICKER_LIST_MAX, type PickerPlacement, placePicker, samePlacement } from './placement.ts'
import {
  addTypedTagToSelection,
  boardTagRowsOf,
  boardTags,
  getTagsCtx,
  selectedTaggable,
  setTagOnSelection,
  tagPickerOpen,
} from './runtime.ts'

export const TAGS_PANEL_ID = 'tags'

/** Identifies a selection, so a picker opened for one never shows up for the next. */
export const selectionKey = (editor: Editor) => editor.getSelectedShapeIds().join(',')

/** Opens the picker for the current selection (the context menu's "Tags…"). */
export function openTagPicker(editor: Editor) {
  tagPickerOpen(editor).set(selectionKey(editor))
}

interface BarState {
  /** Taggable shapes in the selection (locked ones included: their tags are still shown). */
  shapes: number
  anyTags: boolean
  readonly: boolean
}

/** The selection bar's "Tags" button (canvas-ux renders it) and, while open, the picker. */
export const TagsBarButton = memo(function TagsBarButton() {
  const editor = useEditor()
  const bar = useValue('dr-tags-bar', (): BarState | null => {
    const shapes = editor.getSelectedShapes().filter(isTaggable)
    if (!shapes.length) return null
    const readonly = editor.getIsReadonly()
    const anyTags = shapes.some((s) => shapeTags(s.meta).length > 0)
    if (readonly && !anyTags) return null
    if (!readonly && selectedTaggable(editor).length === 0 && !anyTags) return null
    return { shapes: shapes.length, anyTags, readonly }
  }, [editor])
  const open = useValue('dr-tag-picker-open', () => {
    const key = tagPickerOpen(editor).get()
    return key !== null && key === selectionKey(editor)
  }, [editor])
  const buttonRef = useRef<HTMLButtonElement>(null)
  if (!bar) return null
  const label = bar.readonly ? 'Show tags' : 'Tags'
  return (
    <span className="dr-tags-barslot">
      <span className="dr-cux-selbar__sep" aria-hidden="true" />
      <button
        ref={buttonRef}
        type="button"
        className="dr-cux-selbar__btn"
        aria-label={label}
        title={label}
        aria-haspopup="dialog"
        aria-expanded={open}
        data-testid="selection-tags"
        onClick={() => tagPickerOpen(editor).set(open ? null : selectionKey(editor))}
      >
        <TagIcon />
      </button>
      {open && (
        <TagPicker
          editor={editor}
          readonly={bar.readonly}
          onClose={(refocus) => {
            tagPickerOpen(editor).set(null)
            // Back to the board, like the bar's other buttons: Ctrl+Z, Delete and the arrows keep
            // working on the selection (the bar stops keys typed on its own buttons).
            if (refocus) editor.focus()
          }}
          toggle={buttonRef}
        />
      )}
    </span>
  )
})

interface PickerModel {
  rows: BoardTagRow[]
  selection: TLShape[]
  /** Tags on the selection, as displayed (read-only view). */
  onSelection: TagDef[]
  thing: { one: string; many: string }
}

function usePickerModel(editor: Editor, readonly: boolean): PickerModel {
  return useValue('dr-tag-picker-model', () => {
    const all = editor.getSelectedShapes().filter(isTaggable)
    const selection = readonly ? all : selectedTaggable(editor)
    const board = boardTags(editor).get()
    const seen = new Map<string, TagDef>()
    for (const s of all) for (const t of displayTags(s.meta, board)) if (!seen.has(t.key)) seen.set(t.key, t)
    const notes = selection.filter((s) => s.type === 'note').length
    return {
      rows: readonly ? [] : boardTagRowsOf(editor).get(),
      selection,
      onSelection: [...seen.values()],
      thing: thingName({ notes, cards: selection.length - notes }),
    }
  }, [editor, readonly])
}

/**
 * The part of the editor the picker may cover (viewport px): below tldraw's top row (menu, page and
 * style panels) and above its bottom toolbar rows, found the way canvas-ux's frames panel finds them.
 */
function usableArea(editor: Editor) {
  const container = editor.getContainer()
  const c = container.getBoundingClientRect()
  let top = c.top
  for (const el of container.querySelectorAll('.tlui-layout__top__left > *')) {
    const r = el.getBoundingClientRect()
    if (r.width > 0 && r.height > 0) top = Math.max(top, r.bottom)
  }
  let bottom = c.bottom
  for (const el of container.querySelectorAll('.tlui-layout__bottom__main > *')) {
    const r = el.getBoundingClientRect()
    if (r.width > 0 && r.height > 0) bottom = Math.min(bottom, r.top)
  }
  return { left: c.left, right: c.right, top, bottom }
}

/** How many selected shapes could still take `key` (not carrying it, fewer than 10 tags). */
function addableCount(selection: readonly TLShape[], key: string): number {
  let n = 0
  for (const s of selection) {
    const own = shapeTags(s.meta)
    if (!own.some((t) => t.key === key) && own.length < MAX_TAGS_PER_SHAPE) n++
  }
  return n
}

function TagPicker({
  editor,
  readonly,
  onClose,
  toggle,
}: {
  editor: Editor
  readonly: boolean
  onClose(refocus: boolean): void
  toggle: React.RefObject<HTMLButtonElement | null>
}) {
  const model = usePickerModel(editor, readonly)
  const [query, setQuery] = useState('')
  const [status, setStatus] = useState<string | null>(null)
  const rootRef = useIsolated<HTMLDivElement>((e) => onKey(e))
  const inputRef = useRef<HTMLInputElement>(null)
  const inputId = useId()
  const statusId = useId()
  const [place, setPlace] = useState<PickerPlacement>({ dx: 0, above: false, listMax: null })

  const name = normalizeTagName(query)
  const key = name ? tagKey(name) : ''
  const folded = foldForSearch(name)
  const visible = folded ? model.rows.filter((r) => foldForSearch(r.name).includes(folded)) : model.rows
  const exact = key ? model.rows.find((r) => r.key === key) : undefined
  const canCreate = !readonly && name !== '' && !exact

  const stateOf = (k: string): SelectionTagState => selectionTagState(model.selection, k)

  const toggleRow = (row: BoardTagRow) => {
    const on = stateOf(row.key) !== 'all'
    const res = setTagOnSelection(editor, row, on)
    setStatus(on ? fullNotice(res.full, model.thing) : null)
  }
  const submit = () => {
    if (!name) return
    if (exact && stateOf(exact.key) === 'all') {
      setStatus(`Every selected ${model.thing.one} already has “${exact.name}”.`)
      return
    }
    const res = addTypedTagToSelection(editor, query)
    if (!res.ok) {
      setStatus(res.error)
      return
    }
    setQuery('')
    const { tag, created, full } = res.value
    setStatus(fullNotice(full, model.thing) ?? (created ? `Created “${tag.name}”.` : null))
  }
  const manage = () => {
    onClose(false)
    getTagsCtx(editor)?.openPanel(TAGS_PANEL_ID)
  }

  // Focus the field (or, read-only, the popover itself) when it opens. Opened from the context menu,
  // wait until the menu has closed: its focus scope hands the focus back to the canvas as it goes, which
  // would otherwise take it straight out of the field.
  useEffect(() => {
    const focus = () => (readonly ? rootRef.current?.focus() : inputRef.current?.focus())
    const inside = () => rootRef.current?.contains(document.activeElement) === true
    let frame = 0
    let tries = 0
    const tick = () => {
      if (editor.menus.hasAnyOpenMenus() && tries++ < 60) {
        frame = requestAnimationFrame(tick)
        return
      }
      focus()
      frame = requestAnimationFrame(() => {
        if (!inside()) focus()
      })
    }
    focus()
    frame = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(frame)
  }, [editor, readonly])

  // Keys arrive natively (see the header and isolate.ts).
  function onKey(e: KeyboardEvent) {
    const target = e.target as HTMLElement | null
    if (e.key === 'Escape') {
      e.preventDefault()
      onClose(true)
      return
    }
    const boxes = [...(rootRef.current?.querySelectorAll<HTMLInputElement>('input[type="checkbox"]') ?? [])]
    const at = boxes.indexOf(target as HTMLInputElement)
    if (target === inputRef.current) {
      if (e.key === 'Enter') {
        e.preventDefault()
        submit()
      } else if (e.key === 'ArrowDown' && boxes[0]) {
        e.preventDefault()
        boxes[0].focus()
      }
      return
    }
    if (at >= 0) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault()
        const next = at + (e.key === 'ArrowDown' ? 1 : -1)
        if (next < 0) inputRef.current?.focus()
        else boxes[Math.min(next, boxes.length - 1)]?.focus()
      } else if (e.key === 'Enter') {
        e.preventDefault()
        boxes[at]?.click()
      }
    }
  }

  // A press anywhere else closes it (the canvas deselecting closes it anyway).
  const closeRef = useRef(onClose)
  closeRef.current = onClose
  useEffect(() => {
    const doc = editor.getContainer().ownerDocument
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node | null
      if (!t || rootRef.current?.contains(t) || toggle.current?.contains(t)) return
      closeRef.current(false)
    }
    doc.addEventListener('pointerdown', onDown, true)
    return () => doc.removeEventListener('pointerdown', onDown, true)
  }, [editor, toggle])

  // Keep it inside the editor, clear of tldraw's top row and bottom toolbar (placement.ts). Measured
  // after each render: the natural size (the list uncapped) decides, so a cap never feeds back into it.
  useLayoutEffect(() => {
    const el = rootRef.current
    const anchor = el?.parentElement
    if (!el || !anchor) return
    const list = el.querySelector<HTMLElement>('.dr-tag-picker__list')
    const listNatural = list ? Math.min(list.scrollHeight, PICKER_LIST_MAX) : 0
    const r = el.getBoundingClientRect()
    const height = r.height - (list?.clientHeight ?? 0) + listNatural
    const next = placePicker(
      anchor.getBoundingClientRect(),
      { width: r.width, height, list: listNatural },
      usableArea(editor),
    )
    if (!samePlacement(next, place)) setPlace(next)
  })

  return (
    <div
      ref={rootRef}
      className="dr-tag-picker"
      role="dialog"
      aria-label={readonly ? 'Tags' : 'Tags for the selection'}
      data-testid="tag-picker"
      data-side={place.above ? 'above' : 'below'}
      tabIndex={-1}
      style={{
        ['--dr-tag-picker-dx' as string]: `${place.dx}px`,
        ...(place.listMax === null ? {} : { ['--dr-tag-picker-list' as string]: `${place.listMax}px` }),
      }}
    >
      {readonly ? (
        <>
          <p className="dr-tag-picker__title">Tags</p>
          <ul className="dr-tag-picker__tags" data-testid="tag-picker-readonly">
            {model.onSelection.map((t) => (
              <li key={t.key} className="dr-tag-pill" data-dr-tag-color={t.color} data-tag-key={t.key}>
                {t.name}
              </li>
            ))}
          </ul>
          <p className="dr-tag-picker__hint">{READONLY_HINT}</p>
        </>
      ) : (
        <>
          <label className="dr-sr-only" htmlFor={inputId}>
            Find or create a tag
          </label>
          <input
            id={inputId}
            ref={inputRef}
            type="text"
            className="dr-input dr-input--block dr-tag-picker__input"
            placeholder="Find or create a tag"
            autoComplete="off"
            spellCheck={false}
            maxLength={64}
            value={query}
            aria-describedby={statusId}
            data-testid="tag-picker-input"
            onChange={(e) => {
              setQuery(e.target.value)
              setStatus(null)
            }}
          />
          {visible.length > 0 && (
            <ul className="dr-tag-picker__list" aria-label="Tags on this board">
              {visible.map((row, i) => {
                const boxId = `${inputId}-tag-${i}`
                const state = stateOf(row.key)
                const blocked = state !== 'all' && addableCount(model.selection, row.key) === 0
                return (
                  <li key={row.key}>
                    <label
                      htmlFor={boxId}
                      className="dr-tag-option"
                      data-testid="tag-option"
                      data-tag-key={row.key}
                      data-state={state}
                      data-exact={row.key === key || undefined}
                      title={
                        blocked
                          ? `Each selected ${model.thing.one} already has ${MAX_TAGS_PER_SHAPE} tags`
                          : undefined
                      }
                    >
                      <TriStateBox
                        id={boxId}
                        state={state}
                        disabled={blocked}
                        onChange={() => toggleRow(row)}
                        label={row.name}
                      />
                      <span className="dr-tag-dot" data-dr-tag-color={row.color} aria-hidden="true" />
                      <span className="dr-tag-option__name">{row.name}</span>
                    </label>
                  </li>
                )
              })}
            </ul>
          )}
          {canCreate && (
            <button type="button" className="dr-tag-picker__create" data-testid="tag-create" onClick={submit}>
              <span aria-hidden="true">+</span> Create “{name}”
            </button>
          )}
          {!canCreate && visible.length === 0 && (
            <p className="dr-tag-picker__hint">
              {model.rows.length === 0
                ? 'No tags on this board yet. Type a name to create one.'
                : 'No tags match.'}
            </p>
          )}
          <p id={statusId} className="dr-tag-picker__status" role="status" data-testid="tag-picker-status">
            {status ?? ''}
          </p>
          <div className="dr-tag-picker__foot">
            <button type="button" className="dr-tag-picker__manage" data-testid="tag-manage" onClick={manage}>
              Manage tags
            </button>
          </div>
        </>
      )}
    </div>
  )
}

/** A checkbox with a mixed state (some of the selection carries the tag). */
function TriStateBox({
  id,
  state,
  disabled,
  onChange,
  label,
}: {
  id: string
  state: SelectionTagState
  disabled: boolean
  onChange(): void
  label: string
}) {
  const ref = useRef<HTMLInputElement>(null)
  useLayoutEffect(() => {
    if (ref.current) ref.current.indeterminate = state === 'some'
  }, [state])
  return (
    <input
      ref={ref}
      id={id}
      type="checkbox"
      className="dr-tag-option__box"
      checked={state === 'all'}
      aria-checked={state === 'some' ? 'mixed' : state === 'all'}
      title={state === 'some' ? `Some of the selection has “${label}”` : undefined}
      disabled={disabled}
      data-testid="tag-option-box"
      onChange={onChange}
    />
  )
}
