// Document-level keyboard hooks that tldraw's `kbd` system cannot express:
//  - type-to-edit a selected note (COL-04), except the note just left with Esc (RETRO-02; the decision
//    and exclusions are documented in keys.ts)
//  - Ctrl/Cmd+F opens board search even while a text field or note has focus (MAK-12)
//  - Space+drag pans even when a clicked button still has the focus (F3)
//  - Enter renames the one selected frame (RETRO-14)
//  - keys typed before a text field is ready are buffered and inserted in order: a note that type-to-edit
//    just opened, the new note Tab / Shift+Tab / Ctrl+Enter just made (RETRO-09), a frame heading being
//    renamed (RETRO-14, PRI-20c). They never reach tldraw's single-key shortcuts meanwhile.
// All listen in the capture phase on the editor's document, so they run before tldraw's own hotkeys
// (body, bubble) and before the editor's state machine (container, bubble).

import { type Editor, react, type TLEventInfo, type TLShape, type TLShapeId } from 'tldraw'
import {
  isBoardSearchKey,
  isPrintableKey,
  type KeyEventLike,
  shouldRedirectSpaceToBoard,
  shouldRenameFrame,
  shouldTypeToEdit,
  type TypeToEditState,
} from './keys.ts'

/** How long a frame rename keeps (re)focusing its heading input and buffering keys (RETRO-14). */
export const FRAME_FOCUS_MS = 500
/** How long a note's text editor may take to mount before buffered keys are dropped. */
const RTE_WAIT_MS = 2000

function isTextField(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null
  if (!el || typeof el.tagName !== 'string') return false
  if (el.isContentEditable) return true
  if (el.tagName === 'TEXTAREA' || el.tagName === 'SELECT') return true
  if (el.tagName === 'INPUT') {
    const type = (el as HTMLInputElement).type
    return !['checkbox', 'radio', 'range', 'button', 'file', 'reset', 'submit', 'color'].includes(type)
  }
  return false
}

function isButtonLike(el: Element | null): boolean {
  if (!el || typeof el.tagName !== 'string') return false
  return el.tagName === 'BUTTON' || el.getAttribute('role') === 'button'
}

/** Keys that move the focus between controls (Tab; arrows and Home/End in toolbars, menus, lists). */
const NAV_KEYS = new Set(['Tab', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End'])

function keyLike(e: KeyboardEvent): KeyEventLike {
  return {
    key: e.key,
    code: e.code,
    ctrlKey: e.ctrlKey,
    metaKey: e.metaKey,
    altKey: e.altKey,
    shiftKey: e.shiftKey,
    isComposing: e.isComposing,
    altGraph: typeof e.getModifierState === 'function' && e.getModifierState('AltGraph'),
  }
}

/** Keys typed while a text field is not ready yet, for one shape. */
interface Pending {
  shapeId: TLShapeId
  /** 'rte': a note's rich-text editor; 'frame': a frame's heading input. */
  kind: 'rte' | 'frame'
  text: string
  done: boolean
  started: number
  /** frame: the heading input had the focus at least once. */
  focusedOnce?: boolean
}

/** The current rich-text editor, when it belongs to `shapeId` (not the previous note's, mid-Tab). */
function rteFor(editor: Editor, shapeId: TLShapeId) {
  const rte = editor.getRichTextEditor()
  if (!rte || rte.isDestroyed) return null
  try {
    const owner = (rte.view.dom as HTMLElement).closest('[data-shape-id]')?.getAttribute('data-shape-id')
    if (owner && owner !== shapeId) return null
  } catch {
    return null
  }
  return rte
}

function frameInput(editor: Editor, shapeId: TLShapeId): HTMLInputElement | null {
  const el = editor
    .getContainer()
    .querySelector(`.tl-shape[data-shape-id="${CSS.escape(shapeId)}"] input.tl-frame-name-input`)
  return el instanceof HTMLInputElement && !el.disabled ? el : null
}

/** Types `text` into a React-controlled input over its selection (fires the input event React reads). */
export function insertIntoInput(input: HTMLInputElement, text: string) {
  const start = input.selectionStart ?? input.value.length
  const end = input.selectionEnd ?? start
  const next = input.value.slice(0, start) + text + input.value.slice(end)
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
  if (setter) setter.call(input, next)
  else input.value = next
  const caret = start + text.length
  input.setSelectionRange(caret, caret)
  input.dispatchEvent(new Event('input', { bubbles: true }))
}

/** Gives the keyboard back to the board (same as comments' focusBoard). */
function focusBoard(editor: Editor) {
  editor.focus()
  editor.getContainer().focus({ preventScroll: true })
}

export function installCanvasKeyboard(
  editor: Editor,
  opts: { onBoardSearch(): void; isModalOpen(): boolean },
): () => void {
  const doc = editor.getContainer().ownerDocument
  const win = doc.defaultView ?? window
  let disposed = false
  let pending: Pending | null = null
  /** RETRO-02: the note whose editing just ended (still the only selection). */
  let leftEditing: TLShapeId | null = null
  /** F3: we sent the editor a Space key_down it would not have seen; send the key_up too. */
  let spaceInjected = false
  /** F3: how the focus last moved: a pointer press (or a script) vs keyboard navigation. */
  let lastInput: 'pointer' | 'keyboard' = 'pointer'
  const focusOrigin = new WeakMap<EventTarget, 'pointer' | 'keyboard'>()
  const onPointerDown = () => {
    lastInput = 'pointer'
  }
  const onFocusIn = (e: FocusEvent) => {
    if (e.target) focusOrigin.set(e.target, lastInput)
  }

  // ---- pending buffers --------------------------------------------------------------------------

  /** Inserts what is buffered once the field exists. Returns true when this pending is finished. */
  const flush = (p: Pending): boolean => {
    if (p.done) return true
    if (editor.getEditingShapeId() !== p.shapeId) {
      p.done = true
      return true
    }
    const elapsed = Date.now() - p.started
    if (p.kind === 'rte') {
      const rte = rteFor(editor, p.shapeId)
      if (!rte) {
        if (elapsed > RTE_WAIT_MS) p.done = true
        return p.done
      }
      p.done = true
      const text = p.text
      p.text = ''
      if (text) rte.chain().focus('end').insertContent(text).run()
      return true
    }
    // frame heading: keep it focused for the whole window (a double-click's pointer up can take the
    // focus back to the canvas after tldraw focused the input), and type what was buffered into it.
    const input = frameInput(editor, p.shapeId)
    if (input) {
      if (doc.activeElement !== input) {
        input.focus({ preventScroll: true })
        // Renaming replaces the name, as tldraw's own focus does (select all), unless the user has
        // already been typing into it.
        if (!p.focusedOnce && doc.activeElement === input) input.select()
      }
      if (doc.activeElement === input) {
        p.focusedOnce = true
        if (p.text) {
          const text = p.text
          p.text = ''
          insertIntoInput(input, text)
        }
      }
    }
    if (elapsed > FRAME_FOCUS_MS) p.done = true
    return p.done
  }

  const start = (shapeId: TLShapeId, kind: Pending['kind'], text = '') => {
    if (pending && !pending.done && pending.shapeId === shapeId && pending.kind === kind) {
      pending.text += text
      return pending
    }
    if (pending) pending.done = true
    const p: Pending = { shapeId, kind, text, done: false, started: Date.now() }
    pending = p
    const tick = () => {
      if (disposed || p.done) return
      if (!flush(p)) editor.timers.requestAnimationFrame(tick)
    }
    editor.timers.requestAnimationFrame(tick)
    return p
  }

  // ---- editing / selection watchers -------------------------------------------------------------

  let lastEditing: TLShapeId | null = editor.getEditingShapeId()
  const stopEditing = react('dr-cux-editing', () => {
    const now = editor.getEditingShapeId()
    const prev = lastEditing
    if (now === prev) return
    lastEditing = now
    const shapeOf = (id: TLShapeId | null): TLShape | undefined => (id ? editor.getShape(id) : undefined)
    const prevShape = shapeOf(prev)
    const nowShape = shapeOf(now)
    if (prev && !now && prevShape?.type === 'note') {
      const sel = editor.getSelectedShapeIds()
      leftEditing = sel.length === 1 && sel[0] === prev ? prev : null
    } else if (now) {
      leftEditing = null
    }
    if (now && nowShape?.type === 'note' && prevShape?.type === 'note') {
      // RETRO-09: Tab / Shift+Tab / Ctrl+Enter moved editing to a NEW (empty) note; its text editor
      // mounts a frame or two later. Keys typed meanwhile wait for it (they would otherwise land in the
      // old note's editor as it unmounts, or in tldraw's shortcuts).
      const empty = editor.getShapeUtil(nowShape).getText?.(nowShape)?.trim() === ''
      if (empty && !rteFor(editor, now)) start(now, 'rte')
    }
    if (now && nowShape?.type === 'frame') start(now, 'frame')
  })
  const stopSelection = react('dr-cux-left-edit-selection', () => {
    const ids = editor.getSelectedShapeIds()
    if (leftEditing && !(ids.length === 1 && ids[0] === leftEditing)) leftEditing = null
  })
  const onEvent = (info: TLEventInfo) => {
    // Clicking the note (or anything) again ends RETRO-02's exception.
    if (info.type === 'pointer' && info.name === 'pointer_down') leftEditing = null
  }
  editor.on('event', onEvent)

  // ---- keys -------------------------------------------------------------------------------------

  const dispatchSpace = (name: 'key_down' | 'key_up') =>
    editor.dispatch({
      type: 'keyboard',
      name,
      key: ' ',
      code: 'Space',
      shiftKey: false,
      altKey: false,
      ctrlKey: false,
      metaKey: false,
      accelKey: false,
    })

  const onKeyDown = (e: KeyboardEvent) => {
    if (NAV_KEYS.has(e.key)) lastInput = 'keyboard'
    if (e.defaultPrevented) return
    const k = keyLike(e)

    if (isBoardSearchKey(k)) {
      if (opts.isModalOpen()) return
      e.preventDefault()
      e.stopPropagation()
      opts.onBoardSearch()
      return
    }

    const container = editor.getContainer()

    // F3: Space from a clicked button pans instead of pressing it.
    const active = doc.activeElement
    if (
      active &&
      shouldRedirectSpaceToBoard(k, {
        isButton: isButtonLike(active),
        isTextField: isTextField(active),
        focusedByKeyboard: focusOrigin.get(active) === 'keyboard',
        menusOpen: editor.menus.hasAnyOpenMenus(),
        // A modal, or a button inside a dialog-like popover (the bulk paste prompt's autofocused
        // "Notes" button takes Space as a press).
        modalOpen:
          opts.isModalOpen() ||
          active.closest('dialog, [role="dialog"], [role="alertdialog"], [role="menu"]') !== null,
      })
    ) {
      e.preventDefault()
      const outside = !(e.target instanceof Node && container.contains(e.target))
      focusBoard(editor)
      // Inside the editor the event still bubbles to tldraw's container listener, which now sees the
      // canvas focused and starts panning. Outside it (the top bar), tell the editor ourselves.
      if (outside && !e.repeat) {
        dispatchSpace('key_down')
        spaceInjected = true
      }
      return
    }

    const p = pending
    if (p && !p.done) {
      const inEditor = e.target instanceof Node && container.contains(e.target)
      if (editor.getEditingShapeId() === p.shapeId && (inEditor || !isTextField(e.target))) {
        // Until the buffered text is in, every printable key belongs to that field, including keys that
        // land in the freshly mounted (and caret-at-start) editor: buffer them to keep their order.
        if (isPrintableKey(k)) {
          e.preventDefault()
          e.stopPropagation()
          p.text += k.key
          return
        }
        // Enter, Backspace, Escape…: put the buffered text in first when the field is there.
        flush(p)
        // Enter ends a rename (tldraw's FrameLabelInput does this for Enter typed into the input
        // itself; this Enter arrived before the input had the focus).
        if (p.kind === 'frame' && k.key === 'Enter' && !k.shiftKey && !k.ctrlKey && !k.metaKey) {
          const input = frameInput(editor, p.shapeId)
          if (input && e.target !== input) {
            e.preventDefault()
            e.stopPropagation()
            editor.markEventAsHandled(e)
            p.done = true
            input.blur()
            editor.setEditingShape(null)
            return
          }
        }
      }
    }

    // Only when the board itself has the keyboard (the editor container or the canvas), never a toolbar
    // button, panel, prompt or dialog: there, single keys keep their usual meaning.
    const target = e.target as Element | null
    const onCanvas =
      !target ||
      target === doc.body ||
      target === container ||
      (typeof target.closest === 'function' && target.closest('.tl-canvas') !== null)
    if (!onCanvas || !editor.getInstanceState().isFocused) return

    const selected = editor.getSelectedShapes()
    const only = selected[0]
    const state: TypeToEditState = {
      selected: selected.map((s) => ({ type: s.type, locked: editor.isShapeOrAncestorLocked(s) })),
      isIdle: editor.isIn('select.idle'),
      isEditing: editor.getEditingShapeId() !== null,
      isReadonly: editor.getIsReadonly(),
      menusOpen: editor.menus.hasAnyOpenMenus(),
      targetIsTextField: isTextField(e.target),
      justLeftEditing: only !== undefined && selected.length === 1 && leftEditing === only.id,
    }

    if (only && shouldRenameFrame(k, state) && editor.canEditShape(only)) {
      e.preventDefault()
      e.stopPropagation()
      editor.markHistoryStoppingPoint('rename frame')
      editor.setEditingShape(only)
      editor.setCurrentTool('select.editing_shape', { target: 'shape', shape: only })
      return
    }

    if (!only || !shouldTypeToEdit(k, state) || !editor.canEditShape(only)) return
    e.preventDefault()
    e.stopPropagation()
    editor.markHistoryStoppingPoint('type to edit')
    // Buffer first: the editing watcher sees the change synchronously and must find this pending.
    start(only.id, 'rte', k.key)
    editor.setEditingShape(only)
    editor.setCurrentTool('select.editing_shape', { target: 'shape', shape: only })
  }

  const onKeyUp = (e: KeyboardEvent) => {
    if (!spaceInjected || (e.code !== 'Space' && e.key !== ' ')) return
    spaceInjected = false
    editor.markEventAsHandled(e)
    dispatchSpace('key_up')
  }
  const onBlur = () => {
    if (!spaceInjected) return
    spaceInjected = false
    dispatchSpace('key_up')
  }

  doc.addEventListener('keydown', onKeyDown, { capture: true })
  doc.addEventListener('keyup', onKeyUp, { capture: true })
  doc.addEventListener('pointerdown', onPointerDown, { capture: true })
  doc.addEventListener('focusin', onFocusIn, { capture: true })
  win.addEventListener('blur', onBlur)
  return () => {
    disposed = true
    doc.removeEventListener('keydown', onKeyDown, { capture: true })
    doc.removeEventListener('keyup', onKeyUp, { capture: true })
    doc.removeEventListener('pointerdown', onPointerDown, { capture: true })
    doc.removeEventListener('focusin', onFocusIn, { capture: true })
    win.removeEventListener('blur', onBlur)
    editor.off('event', onEvent)
    stopEditing()
    stopSelection()
    if (pending) pending.done = true
  }
}
