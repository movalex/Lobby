// Document-level keyboard hooks that tldraw's `kbd` system cannot express:
//  - type-to-edit a selected note (COL-04; the decision and exclusions are documented in keys.ts)
//  - Ctrl/Cmd+F opens board search even while a text field or note has focus (MAK-12)
// Both listen in the capture phase on the editor's document, so they run before tldraw's own
// hotkeys (body, bubble) and before the editor's state machine (container, bubble).

import type { Editor, TLShapeId } from 'tldraw'
import { isBoardSearchKey, type KeyEventLike, shouldTypeToEdit } from './keys.ts'

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

/** Starts editing `shapeId` and appends `text` at the end once its rich-text editor exists. */
function editAndAppend(editor: Editor, shapeId: TLShapeId, pending: { text: string; done: boolean }) {
  const shape = editor.getShape(shapeId)
  if (!shape) return
  editor.markHistoryStoppingPoint('type to edit')
  editor.setEditingShape(shape)
  editor.setCurrentTool('select.editing_shape', { target: 'shape', shape })
  const started = Date.now()
  const tick = () => {
    if (pending.done) return
    if (editor.getEditingShapeId() !== shapeId || Date.now() - started > 2000) {
      pending.done = true
      return
    }
    const rte = editor.getRichTextEditor()
    if (!rte || rte.isDestroyed) {
      editor.timers.requestAnimationFrame(tick)
      return
    }
    pending.done = true
    const text = pending.text
    pending.text = ''
    rte.chain().focus('end').insertContent(text).run()
  }
  editor.timers.requestAnimationFrame(tick)
}

export function installCanvasKeyboard(
  editor: Editor,
  opts: { onBoardSearch(): void; isModalOpen(): boolean },
): () => void {
  const doc = editor.getContainer().ownerDocument
  // Keys typed between "start editing" and the note's text editor mounting (a frame or two) are
  // buffered here so fast typists lose nothing.
  let pending: { shapeId: TLShapeId; text: string; done: boolean } | null = null

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.defaultPrevented) return
    const k = keyLike(e)

    if (isBoardSearchKey(k)) {
      if (opts.isModalOpen()) return
      e.preventDefault()
      e.stopPropagation()
      opts.onBoardSearch()
      return
    }

    if (pending && !pending.done) {
      // Until the buffered text is in, every printable key belongs to that note, including keys that
      // land in its freshly mounted (and caret-at-start) text editor: buffer them to keep their order.
      const inEditor = e.target instanceof Node && editor.getContainer().contains(e.target)
      if (editor.getEditingShapeId() === pending.shapeId && (inEditor || !isTextField(e.target))) {
        if (
          [...k.key].length === 1 &&
          !k.ctrlKey &&
          !k.metaKey &&
          !(k.altKey && !k.altGraph) &&
          !k.isComposing
        ) {
          e.preventDefault()
          e.stopPropagation()
          pending.text += k.key
          return
        }
      }
    }

    // Only when the board itself has the keyboard (the editor container or the canvas), never a toolbar
    // button, panel, prompt or dialog: there, single keys keep their usual meaning.
    const container = editor.getContainer()
    const target = e.target as Element | null
    const onCanvas =
      !target ||
      target === doc.body ||
      target === container ||
      (typeof target.closest === 'function' && target.closest('.tl-canvas') !== null)
    if (!onCanvas || !editor.getInstanceState().isFocused) return

    const selected = editor.getSelectedShapes()
    const ok = shouldTypeToEdit(k, {
      selected: selected.map((s) => ({ type: s.type, locked: editor.isShapeOrAncestorLocked(s) })),
      isIdle: editor.isIn('select.idle'),
      isEditing: editor.getEditingShapeId() !== null,
      isReadonly: editor.getIsReadonly(),
      menusOpen: editor.menus.hasAnyOpenMenus(),
      targetIsTextField: isTextField(e.target),
    })
    const only = selected[0]
    if (!ok || !only || !editor.canEditShape(only)) return
    e.preventDefault()
    e.stopPropagation()
    pending = { shapeId: only.id, text: k.key, done: false }
    editAndAppend(editor, only.id, pending)
  }

  doc.addEventListener('keydown', onKeyDown, { capture: true })
  return () => {
    doc.removeEventListener('keydown', onKeyDown, { capture: true })
    if (pending) pending.done = true
  }
}
