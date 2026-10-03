// The tag picker on the new canvas (the port of ../TagPicker.tsx; same copy, keys and test ids): a "Tags"
// button in the selection bar (3a's shell renders `selectionBar` items; `TagsBarButton`) and its popover.
// Editors find a tag or create one by typing (Enter) and tick or untick board tags for the whole
// selection (one undo step each; a tick on a mixed selection adds it to the rest). People who cannot edit
// get the same button while the selection carries tags, and see them read-only.
//
// tldraw rendered the popover inside the selection bar. Here it is rendered in the tags `screen` layer
// (`TagPickerHost`), placed under the bar's Tags button when the bar shows one, else under the selection
// itself (the context menu's "Tags…" and the command also open it), and kept inside the canvas clear of
// the toolbar slot (../placement.ts). It re-places itself when the selection or the camera moves.
// Keys and pointers inside it never reach the canvas (../isolate.ts: native listeners, so Excalidraw's
// document listeners and the board input never see them), and the keys are handled natively here.

import { foldForSearch } from '@draftroom/board-ops/elements'
import { MAX_TAGS_PER_SHAPE, normalizeTagName, type TagDef, tagKey } from '@draftroom/contracts'
import { memo, useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import {
  type CanvasElement,
  type CanvasFeatureContext,
  items as itemsApi,
} from '../../../canvas/api/index.ts'
import { useValue } from '../../../lib/signals.ts'
import { onFocusLeave, trapTab, tryFocus } from '../../../ui/focus.ts'
import { fullNotice, READONLY_HINT, thingName } from '../copy.ts'
import { TagIcon } from '../icons.tsx'
import { useIsolated } from '../isolate.ts'
import { type Box, PICKER_LIST_MAX, type PickerPlacement, placePicker, samePlacement } from '../placement.ts'
import { type Tags, tagsOf } from './bridge.ts'
import {
  type BoardTagRow,
  displayTags,
  elementTags,
  type SelectionTagState,
  selectionTagState,
} from './model.ts'
import type { TagsRuntime } from './runtime.ts'

export const TAGS_PANEL_ID = 'tags'

/**
 * Whether this person may create a tag here: whoever may edit the canvas. A workshop (editor) guest too since
 * CR-3D-5: the room takes an editor guest's `tagDef:` writes (up to its GUEST_TAG_DEF_CAP keys), so W5-29's
 * guest guard is gone. Pure.
 */
export function mayCreateTag(readonly: boolean): boolean {
  return !readonly
}
const TOGGLE = '[data-testid="selection-tags"]'

interface BarState {
  /** Taggable elements in the selection (locked ones included: their tags are still shown). */
  elements: number
  anyTags: boolean
  readonly: boolean
}

/** Whether the selection gets a Tags button (and the picker), and how. */
export function barState(rt: TagsRuntime): BarState | null {
  const els = rt.selectedElements()
  if (!els.length) return null
  const readonly = rt.canvas.readOnly()
  const anyTags = els.some((el) => elementTags(el).length > 0)
  if (readonly && !anyTags) return null
  if (!readonly && rt.selectedTaggable().length === 0 && !anyTags) return null
  return { elements: els.length, anyTags, readonly }
}

const sameBar = (a: BarState | null, b: BarState | null) =>
  a === b || (!!a && !!b && a.elements === b.elements && a.anyTags === b.anyTags && a.readonly === b.readonly)

/** Whether the picker is open for the current selection. */
const isOpenFor = (rt: TagsRuntime) => {
  const key = rt.pickerOpen.get()
  return key !== null && key === rt.selectionKey()
}

/** The selection bar's "Tags" button (3a's shell renders it). */
export const TagsBarButton = memo(function TagsBarButton({ ctx }: { ctx: CanvasFeatureContext }) {
  const t = useValue('tags.bridge', () => tagsOf(ctx.canvas), [ctx.canvas])
  return t ? <BarButton rt={t.rt} /> : null
})

function BarButton({ rt }: { rt: TagsRuntime }) {
  const bar = useValue('tags.bar', () => barState(rt), [rt])
  const open = useValue('tags.picker-open', () => isOpenFor(rt), [rt])
  if (!bar) return null
  const label = bar.readonly ? 'Show tags' : 'Tags'
  return (
    <span className="dr-tags-barslot">
      <span className="dr-cux-selbar__sep" aria-hidden="true" />
      <button
        type="button"
        className="dr-cux-selbar__btn"
        aria-label={label}
        title={label}
        aria-haspopup="dialog"
        aria-expanded={open}
        data-testid="selection-tags"
        onClick={() => rt.pickerOpen.set(open ? null : rt.selectionKey())}
      >
        <TagIcon />
      </button>
    </span>
  )
}

/** Hosts the picker in the tags screen layer while it is open for the current selection. */
export function TagPickerHost({ t }: { t: Tags }) {
  const { rt } = t
  const open = useValue('tags.picker-open', () => isOpenFor(rt), [rt])
  const bar = useValue('tags.bar', () => (open ? barState(rt) : null), [rt, open])
  const [last, setLast] = useState<BarState | null>(null)
  useEffect(() => setLast((p) => (sameBar(p, bar) ? p : bar)), [bar])
  if (!open || !bar) return null
  return (
    <TagPicker
      t={t}
      readonly={(last ?? bar).readonly}
      onClose={(refocus) => {
        rt.pickerOpen.set(null)
        // Back to the board, like the bar's other buttons: Ctrl+Z, Delete and the arrows keep working
        // on the selection.
        if (refocus) rt.canvas.focus({ preventScroll: true })
      }}
    />
  )
}

interface PickerModel {
  rows: BoardTagRow[]
  selection: CanvasElement[]
  /** Tags on the selection, as displayed (read-only view). */
  onSelection: TagDef[]
  thing: { one: string; many: string }
}

/** "note", "card", "image", "shape" or (a mix) "item" for the selection (../copy.ts thingName). */
export function thingOf(elements: readonly CanvasElement[]) {
  const out = { notes: 0, cards: 0, images: 0, shapes: 0 }
  for (const el of elements) {
    const kind = itemsApi.itemKindOf(el)
    if (kind === 'note') out.notes++
    else if (kind === 'file-card') out.cards++
    else if (kind === 'image') out.images++
    else out.shapes++
  }
  return thingName(out)
}

function samePickerModel(a: PickerModel, b: PickerModel): boolean {
  return (
    a.rows.length === b.rows.length &&
    a.rows.every((r, i) => {
      const o = b.rows[i]
      return !!o && o.key === r.key && o.name === r.name && o.color === r.color && o.count === r.count
    }) &&
    a.selection.length === b.selection.length &&
    a.selection.every((el, i) => el === b.selection[i]) &&
    a.onSelection.map((x) => `${x.key}:${x.name}:${x.color}`).join() ===
      b.onSelection.map((x) => `${x.key}:${x.name}:${x.color}`).join() &&
    a.thing.one === b.thing.one
  )
}

function usePickerModel(rt: TagsRuntime, readonly: boolean): PickerModel {
  const prev = useRef<PickerModel | null>(null)
  const next = useValue('tags.picker-model', () => {
    const all = rt.selectedElements()
    const selection = readonly ? all : rt.selectedTaggable()
    const board = rt.board.get()
    const seen = new Map<string, TagDef>()
    for (const el of all) for (const t of displayTags(el, board)) if (!seen.has(t.key)) seen.set(t.key, t)
    const model: PickerModel = {
      rows: readonly ? [] : rt.rows.get(),
      selection,
      onSelection: [...seen.values()],
      thing: thingOf(selection),
    }
    return model
  }, [rt, readonly])
  if (!prev.current || !samePickerModel(prev.current, next)) prev.current = next
  return prev.current
}

/** How many selected elements could still take `key` (not carrying it, fewer than 10 tags). */
function addableCount(selection: readonly CanvasElement[], key: string): number {
  let n = 0
  for (const el of selection) {
    const own = elementTags(el)
    if (!own.some((t) => t.key === key) && own.length < MAX_TAGS_PER_SHAPE) n++
  }
  return n
}

/** The screen box (viewport px) the picker opens under: the bar's Tags button, else the selection. */
function anchorBox(rt: TagsRuntime, layer: HTMLElement): Box | null {
  const doc = layer.ownerDocument
  const toggle = doc.querySelector<HTMLElement>(TOGGLE)
  if (toggle) {
    const r = toggle.getBoundingClientRect()
    if (r.width > 0 && r.height > 0) return { left: r.left, top: r.top, right: r.right, bottom: r.bottom }
  }
  const b = rt.canvas.boundsOf(rt.selectedElements().map((el) => el.id))
  if (!b) return null
  const origin = layer.getBoundingClientRect()
  const tl = rt.canvas.sceneToOverlay({ x: b.x, y: b.y })
  const br = rt.canvas.sceneToOverlay({ x: b.x + b.width, y: b.y + b.height })
  return {
    left: origin.left + tl.x,
    top: origin.top + tl.y,
    right: origin.left + br.x,
    bottom: origin.top + br.y,
  }
}

/** The part of the canvas the picker may cover (viewport px): above the toolbar slot. */
function usableArea(layer: HTMLElement): Box {
  const c = layer.getBoundingClientRect()
  let bottom = c.bottom
  const toolbar = layer.ownerDocument.querySelector('[data-lobby-slot="toolbar"]')
  if (toolbar) {
    const r = toolbar.getBoundingClientRect()
    if (r.width > 0 && r.height > 0 && r.top > c.top) bottom = Math.min(bottom, r.top)
  }
  return { left: c.left, right: c.right, top: c.top, bottom }
}

interface Placed extends PickerPlacement {
  left: number
  top: number
}
const GAP = 10

function TagPicker({
  t,
  readonly,
  onClose,
}: {
  t: Tags
  readonly: boolean
  onClose(refocus: boolean): void
}) {
  const { rt, ctx } = t
  const canvas = rt.canvas
  const model = usePickerModel(rt, readonly)
  const [query, setQuery] = useState('')
  const [status, setStatus] = useState<string | null>(null)
  const rootRef = useIsolated<HTMLDivElement>((e) => onKey(e))
  const inputRef = useRef<HTMLInputElement>(null)
  const inputId = useId()
  const statusId = useId()
  const [place, setPlace] = useState<Placed | null>(null)
  // A11Y-15: what had the keyboard as it opened (the Tags button from the keyboard; the board after a
  // click): closing from the keyboard gives the focus back there.
  const [opener] = useState(() => {
    const a = canvas.container()?.ownerDocument.activeElement ?? null
    return a instanceof HTMLElement && a !== a.ownerDocument.body ? a : null
  })
  const closeWithFocus = () => {
    onClose(false)
    if (tryFocus(opener)) return
    canvas.focus({ preventScroll: true })
  }
  /** The picker has placed its first focus (focus moving out before that is the context menu's). */
  const settled = useRef(false)
  // re-place when the selection or the camera moves
  const moveKey = useValue('tags.picker-anchor', () => {
    const v = canvas.viewport.get()
    const b = canvas.boundsOf(rt.selectedElements().map((el) => el.id))
    return b ? `${v.x},${v.y},${v.zoom},${b.x},${b.y},${b.width},${b.height}` : `${v.x},${v.y},${v.zoom}`
  }, [rt, canvas])

  const name = normalizeTagName(query)
  const key = name ? tagKey(name) : ''
  const folded = foldForSearch(name)
  const visible = folded ? model.rows.filter((r) => foldForSearch(r.name).includes(folded)) : model.rows
  const exact = key ? model.rows.find((r) => r.key === key) : undefined
  const canCreate = mayCreateTag(readonly) && name !== '' && !exact

  const stateOf = (k: string): SelectionTagState => selectionTagState(model.selection, k)

  const toggleRow = (row: BoardTagRow) => {
    const on = stateOf(row.key) !== 'all'
    const res = rt.setTagOnSelection(row, on)
    setStatus(on ? fullNotice(res.full, model.thing) : null)
  }
  const submit = () => {
    if (!name) return
    if (exact && stateOf(exact.key) === 'all') {
      setStatus(`Every selected ${model.thing.one} already has “${exact.name}”.`)
      return
    }
    const res = rt.addTypedTagToSelection(query)
    if (!res.ok) {
      setStatus(res.error)
      return
    }
    setQuery('')
    const { tag, created, full } = res.value
    setStatus(fullNotice(full, model.thing) ?? (created ? `Created “#${tag.name}”.` : null))
  }
  const manage = () => {
    onClose(false)
    ctx.openPanel(TAGS_PANEL_ID)
  }

  // Focus the field (or, read-only, the popover itself) when it opens. Opened from the context menu,
  // wait until the menu has closed: its focus scope hands the focus back to the canvas as it goes.
  useEffect(() => {
    const focus = () =>
      readonly
        ? rootRef.current?.focus({ preventScroll: true })
        : inputRef.current?.focus({ preventScroll: true })
    const inside = () => rootRef.current?.contains(rootRef.current.ownerDocument.activeElement) === true
    let frame = 0
    let tries = 0
    const tick = () => {
      if (ctx.registries.menusOpen.call() && tries++ < 60) {
        frame = requestAnimationFrame(tick)
        return
      }
      focus()
      frame = requestAnimationFrame(() => {
        if (!inside()) focus()
        settled.current = true
      })
    }
    focus()
    frame = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(frame)
  }, [ctx, readonly, rootRef])

  // Keys arrive natively (see the header and ../isolate.ts).
  function onKey(e: KeyboardEvent) {
    const target = e.target as HTMLElement | null
    if (e.key === 'Escape') {
      e.preventDefault()
      closeWithFocus()
      return
    }
    // A11Y-15: Tab stays inside while it is open (Escape is the way out).
    if (e.key === 'Tab') {
      if (rootRef.current) trapTab(e, rootRef.current)
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
    const doc = rootRef.current?.ownerDocument ?? document
    const onDown = (e: PointerEvent) => {
      const target = e.target as Element | null
      if (!target || rootRef.current?.contains(target) || target.closest?.(TOGGLE)) return
      closeRef.current(false)
    }
    doc.addEventListener('pointerdown', onDown, true)
    return () => doc.removeEventListener('pointerdown', onDown, true)
  }, [rootRef])
  // A11Y-15: so does the focus moving elsewhere; the Tags button that toggles it does not count.
  useEffect(() => {
    const root = rootRef.current
    if (!root) return
    return onFocusLeave(
      root,
      () => {
        if (settled.current) closeRef.current(false)
      },
      (el) => el.closest?.(TOGGLE) !== null,
    )
  }, [rootRef])

  // Under the anchor, inside the canvas and clear of the toolbar (../placement.ts). Measured after each
  // render: the natural size (the list uncapped) decides, so a cap never feeds back into it. The bar's own
  // position settles in the same frame, so the placement is checked again on the next one.
  const layout = () => {
    const el = rootRef.current
    const layer = el?.parentElement
    if (!el || !layer) return
    const anchor = anchorBox(rt, layer)
    if (!anchor) return
    const list = el.querySelector<HTMLElement>('.dr-tag-picker__list')
    const listNatural = list ? Math.min(list.scrollHeight, PICKER_LIST_MAX) : 0
    const r = el.getBoundingClientRect()
    const height = r.height - (list?.clientHeight ?? 0) + listNatural
    const p = placePicker(anchor, { width: r.width, height, list: listNatural }, usableArea(layer))
    const origin = layer.getBoundingClientRect()
    const cx = (anchor.left + anchor.right) / 2
    const shown = p.listMax === null ? height : height - listNatural + Math.min(listNatural, p.listMax)
    const next: Placed = {
      ...p,
      left: Math.round(cx - r.width / 2 + p.dx - origin.left),
      top: Math.round(p.above ? anchor.top - GAP - shown - origin.top : anchor.bottom + GAP - origin.top),
    }
    setPlace((prev) =>
      prev &&
      samePlacement(prev, next) &&
      Math.abs(prev.left - next.left) < 1 &&
      Math.abs(prev.top - next.top) < 1
        ? prev
        : next,
    )
  }
  const layoutRef = useRef(layout)
  layoutRef.current = layout
  useLayoutEffect(() => layoutRef.current())
  useEffect(() => {
    void moveKey
    const f = requestAnimationFrame(() => layoutRef.current())
    return () => cancelAnimationFrame(f)
  }, [moveKey])

  return (
    <div
      ref={rootRef}
      className="dr-tag-picker dr-tag-picker--floating"
      role="dialog"
      aria-label={readonly ? 'Tags' : 'Tags for the selection'}
      data-testid="tag-picker"
      data-side={place?.above ? 'above' : 'below'}
      tabIndex={-1}
      style={{
        left: place?.left ?? 0,
        top: place?.top ?? 0,
        visibility: place ? undefined : 'hidden',
        ...(place?.listMax == null ? {} : { ['--dr-tag-picker-list' as string]: `${place.listMax}px` }),
      }}
    >
      {readonly ? (
        <>
          <p className="dr-tag-picker__title">Tags</p>
          <ul className="dr-tag-picker__tags" data-testid="tag-picker-readonly">
            {model.onSelection.map((tg) => (
              <li key={tg.key} className="dr-tag-pill" data-dr-tag-color={tg.color} data-tag-key={tg.key}>
                {tg.name}
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
          {/* F15: tags read as #name. A typed leading "#" becomes this prefix instead of vanishing. */}
          <div className="dr-tag-picker__field">
            <span className="dr-tag-picker__hash" aria-hidden="true">
              #
            </span>
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
                setQuery(e.target.value.replace(/^\s*#+/, ''))
                setStatus(null)
              }}
            />
          </div>
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
                      <span className="dr-tag-option__name">
                        <span className="dr-tag-option__hash" aria-hidden="true">
                          #
                        </span>
                        {row.name}
                      </span>
                    </label>
                  </li>
                )
              })}
            </ul>
          )}
          {canCreate && (
            <button type="button" className="dr-tag-picker__create" data-testid="tag-create" onClick={submit}>
              <span aria-hidden="true">+</span> Create “#{name}”
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
