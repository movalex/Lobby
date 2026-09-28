// The mind-map keys (keys.ts has the table and the rules), on a capture-phase listener on the editor's
// document: it runs before tldraw's own hotkeys (body, bubble), its state machine (container, bubble)
// and the topic's text editor (the contenteditable), so Tab never moves the browser focus, Enter never
// adds a paragraph, and tldraw's note Tab (a new sticky note beside) never fires on a topic.
// canvas-ux registers its listener first (the registry order): keys it takes (type-to-edit on notes,
// Ctrl/Cmd+F, frame rename) arrive here with defaultPrevented and are left alone.
//
// Never losing a keystroke: a new topic's text editor mounts a frame or two after Tab/Enter made it.
// Until it is there, what the person types is queued, Tab/Enter/Shift+Tab/Esc included, and replayed
// in order (text is inserted, a queued Tab makes the next topic and the rest waits for that one's
// editor). "Idea<Tab>Detail<Enter>Other" typed at full speed builds the same map as typed slowly.
//
// A new map's central topic says "Central topic" as a placeholder: the first character typed into it
// (or Backspace) replaces the whole text, whenever the editor gets it. (tldraw's own select-all on
// edit start cannot be used for a shape created in the same tick: its text editor is not mounted yet
// when the event fires.) A click into the text keeps it, as a deliberate edit.

import { react, type TLShapeId } from 'tldraw'
import { isPrintableKey, type KeyEventLike } from '../canvas-ux/keys.ts'
import { type TopicKeyIntent, topicKeyIntent } from './keys.ts'
import type { MindmapRuntime } from './runtime.ts'

/** How long a new topic's text editor may take to appear before queued keys are dropped. */
const RTE_WAIT_MS = 2000

type Queued =
  | { kind: 'text'; text: string }
  | { kind: 'key'; intent: 'child' | 'sibling' | 'promote' | 'escape' }

/**
 * 'fresh': a new, empty topic (text goes in at the caret); 'append': an existing topic (at the end);
 * 'placeholder': a new map's central topic (the first text replaces the placeholder).
 */
export type EditorMode = 'fresh' | 'append' | 'placeholder'

interface Pending {
  shapeId: TLShapeId
  mode: EditorMode
  queue: Queued[]
  started: number
  done: boolean
}

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

const keyLike = (e: KeyboardEvent): KeyEventLike => ({
  key: e.key,
  code: e.code,
  ctrlKey: e.ctrlKey,
  metaKey: e.metaKey,
  altKey: e.altKey,
  shiftKey: e.shiftKey,
  isComposing: e.isComposing,
  altGraph: typeof e.getModifierState === 'function' && e.getModifierState('AltGraph'),
})

export interface MindmapKeyboard {
  /** Queue keys for `shapeId` until its text editor is ready (after the runtime started editing it). */
  expectEditor(shapeId: TLShapeId, mode: EditorMode, text?: string): void
  dispose(): void
}

export function installMindmapKeyboard(rt: MindmapRuntime): MindmapKeyboard {
  const { editor } = rt
  const doc = editor.getContainer().ownerDocument
  let disposed = false
  let pending: Pending | null = null
  /** The new central topic whose text is still the placeholder. */
  let placeholder: TLShapeId | null = null
  /** RETRO-02: the topic whose editing just ended with Esc (still the only selection). */
  let leftEditing: TLShapeId | null = null
  /** Keys whose keydown this listener took: their keyup must not reach tldraw either. */
  const swallowUp = new Set<string>()

  /**
   * The editing shape's text editor, once it is mounted for `shapeId`. Right after Tab/Enter, tldraw
   * still returns the previous topic's editor (unmounting, possibly already detached from the page):
   * it must never receive the new topic's keys.
   */
  const rteFor = (shapeId: TLShapeId) => {
    if (editor.getEditingShapeId() !== shapeId) return null
    const rte = editor.getRichTextEditor()
    if (!rte || rte.isDestroyed) return null
    try {
      const dom = rte.view.dom as HTMLElement
      if (!dom.isConnected) return null
      if (dom.closest('[data-shape-id]')?.getAttribute('data-shape-id') !== shapeId) return null
    } catch {
      return null
    }
    return rte
  }

  /** Types `text` into the editing topic `id` (replacing the placeholder the first time). */
  const insert = (id: TLShapeId, text: string, mode: EditorMode) => {
    const rte = rteFor(id)
    if (!rte) return
    if (placeholder === id) {
      placeholder = null
      rte.chain().focus().selectAll().insertContent(text).run()
    } else if (mode === 'append') rte.chain().focus('end').insertContent(text).run()
    else rte.chain().focus().insertContent(text).run()
  }

  /** Runs a key's action on topic `id`; returns the new topic when one was made. */
  const perform = (intent: TopicKeyIntent, id: TLShapeId): TLShapeId | null => {
    switch (intent.kind) {
      case 'child': {
        const made = rt.addChild(id)
        if (made) expectEditor(made, 'fresh')
        return made
      }
      case 'sibling': {
        const made = rt.addSibling(id)
        if (made) expectEditor(made, 'fresh')
        return made
      }
      case 'promote':
        rt.promote(id)
        return null
      case 'nav':
        rt.navigate(id, intent.dir)
        return null
      case 'edit':
        if (rt.editTopic(id)) expectEditor(id, 'append', intent.text)
        return null
    }
  }

  /** Replays queued keys once the editor is there. Returns true when this pending is finished. */
  const drain = (p: Pending): boolean => {
    if (p.done) return true
    if (editor.getEditingShapeId() !== p.shapeId) {
      p.done = true
      return true
    }
    const rte = rteFor(p.shapeId)
    if (!rte) {
      if (Date.now() - p.started > RTE_WAIT_MS) p.done = true
      return p.done
    }
    p.done = true
    // From here on keys go straight to the editor: it must have the focus now, not when tldraw's own
    // delayed focus call runs.
    if (!(rte.view.dom as HTMLElement).contains(doc.activeElement)) {
      if (p.mode === 'placeholder') rte.commands.focus()
      else rte.commands.focus('end')
    }
    if (p.mode === 'placeholder' && !p.queue.length) {
      // Show the placeholder selected, the usual "typing replaces this" cue. tldraw's own delayed focus
      // (100 ms after its editor is created) moves the caret to the end, so select again after it.
      const select = () => {
        const r = rteFor(p.shapeId)
        if (r && placeholder === p.shapeId) r.chain().focus().selectAll().run()
      }
      select()
      editor.timers.setTimeout(select, 160)
    }
    while (p.queue.length) {
      const item = p.queue.shift() as Queued
      if (item.kind === 'text') {
        insert(p.shapeId, item.text, p.mode)
        p.mode = 'append'
        continue
      }
      if (item.intent === 'escape') {
        p.queue.length = 0
        editor.cancel()
        return true
      }
      if (item.intent === 'promote') {
        // Same topic, same editor: typing goes on here.
        rt.promote(p.shapeId)
        continue
      }
      const rest = p.queue.splice(0)
      const made = perform({ kind: item.intent }, p.shapeId)
      // A new topic: the rest of the queue waits for its editor.
      if (made && pending && pending.shapeId === made) {
        pending.queue.push(...rest)
        return true
      }
      // Nothing was made (read-only now, the topic is gone…): the rest stays with this topic.
      p.queue.push(...rest)
    }
    return true
  }

  const tick = (p: Pending) => {
    if (disposed || p.done) return
    if (!drain(p)) editor.timers.requestAnimationFrame(() => tick(p))
  }

  const expectEditor = (shapeId: TLShapeId, mode: EditorMode, text = '') => {
    if (pending && !pending.done) pending.done = true
    placeholder = mode === 'placeholder' ? shapeId : null
    const p: Pending = {
      shapeId,
      mode,
      queue: text ? [{ kind: 'text', text }] : [],
      started: Date.now(),
      done: false,
    }
    pending = p
    editor.timers.requestAnimationFrame(() => tick(p))
  }

  // ---- editing watcher: the empty new topic that was left, and RETRO-02 ---------------------------

  let lastEditing: TLShapeId | null = editor.getEditingShapeId()
  const stopEditing = react('dr-mindmap-editing', () => {
    const now = editor.getEditingShapeId()
    const prev = lastEditing
    if (now === prev) return
    lastEditing = now
    if (placeholder && now !== placeholder) placeholder = null
    if (prev && rt.isTopic(prev)) {
      const sel = editor.getSelectedShapeIds()
      leftEditing = !now && sel.length === 1 && sel[0] === prev ? prev : null
      // After the store has settled (a Tab from this topic may be creating its child right now).
      editor.timers.setTimeout(() => {
        if (!disposed && editor.getEditingShapeId() !== prev) rt.editingEnded(prev)
      }, 0)
    } else if (now) leftEditing = null
  })
  const stopSelection = react('dr-mindmap-left-edit', () => {
    const ids = editor.getSelectedShapeIds()
    if (leftEditing && !(ids.length === 1 && ids[0] === leftEditing)) leftEditing = null
  })
  const onPointerDown = () => {
    leftEditing = null
    placeholder = null
  }

  // ---- keys ---------------------------------------------------------------------------------------

  const take = (e: KeyboardEvent) => {
    e.preventDefault()
    e.stopPropagation()
    swallowUp.add(e.code || e.key)
  }

  /**
   * Queues the key for pending `p` (taking the event). False for keys that are not queued (modifier
   * chords, keys that do nothing in a new topic): those go on as usual.
   */
  const enqueue = (p: Pending, k: KeyEventLike, e: KeyboardEvent): boolean => {
    let q: Queued | null = null
    if (isPrintableKey(k)) q = { kind: 'text', text: k.key }
    else if (!k.ctrlKey && !k.metaKey && !k.altKey) {
      if (k.key === 'Tab') q = { kind: 'key', intent: k.shiftKey ? 'promote' : 'child' }
      else if (k.key === 'Enter' && !k.shiftKey) q = { kind: 'key', intent: 'sibling' }
      else if (k.key === 'Escape') q = { kind: 'key', intent: 'escape' }
      else if (k.key === 'Backspace') {
        const last = p.queue[p.queue.length - 1]
        if (last?.kind === 'text') {
          last.text = last.text.slice(0, -1)
          if (!last.text) p.queue.pop()
        }
        take(e)
        return true
      }
    }
    if (!q) return false
    const last = p.queue[p.queue.length - 1]
    if (q.kind === 'text' && last?.kind === 'text') last.text += q.text
    else p.queue.push(q)
    take(e)
    return true
  }

  /** The pending new topic keys belong to right now, if any (its editor missing or not focused). */
  const waiting = (): { p: Pending; focused: boolean; ready: boolean } | null => {
    const p = pending
    if (!p || p.done || editor.getEditingShapeId() !== p.shapeId) return null
    const rte = rteFor(p.shapeId)
    return { p, ready: !!rte, focused: !!rte && (rte.view.dom as HTMLElement).contains(doc.activeElement) }
  }

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.defaultPrevented) return
    const k = keyLike(e)
    const container = editor.getContainer()
    const inEditor = e.target instanceof Node && container.contains(e.target)

    // A new topic whose editor is not there yet, or does not have the keyboard yet: every key belongs
    // to it, in order. (A key let through before the focus lands would type into nothing, or land out
    // of order once the browser moves the focus.)
    const w = waiting()
    if (w && (inEditor || !isTextField(e.target))) {
      if (!w.focused) {
        if (k.isComposing) return
        // The editor is there, only not focused: put everything in now (this focuses it).
        if (enqueue(w.p, k, e) && w.ready) drain(w.p)
        return
      }
      drain(w.p)
      // What was queued may have ended in a Tab or Enter: then this key belongs to the topic it made.
      const next = waiting()
      if (next && next.p !== w.p) {
        if (!k.isComposing) enqueue(next.p, k, e)
        return
      }
    }

    const target = e.target as Element | null
    const editingId = editor.getEditingShapeId()
    const editingTopic =
      !!editingId &&
      rt.isTopic(editingId) &&
      !!target &&
      (target as HTMLElement).isContentEditable === true &&
      target.closest?.('[data-shape-id]')?.getAttribute('data-shape-id') === editingId

    // The placeholder of a new central topic: the first character (or Backspace/Delete) replaces it.
    if (
      editingTopic &&
      placeholder === editingId &&
      !k.isComposing &&
      !k.ctrlKey &&
      !k.metaKey &&
      !k.altKey
    ) {
      if (isPrintableKey(k)) {
        take(e)
        insert(editingId, k.key, 'fresh')
        return
      }
      if (k.key === 'Backspace' || k.key === 'Delete') {
        take(e)
        placeholder = null
        rteFor(editingId)?.chain().focus().selectAll().deleteSelection().run()
        return
      }
    }

    const onCanvas =
      !target ||
      target === doc.body ||
      target === container ||
      (typeof target.closest === 'function' && target.closest('.tl-canvas') !== null)
    if (!editingTopic && (!onCanvas || !editor.getInstanceState().isFocused)) return

    const only = editingTopic ? null : editor.getOnlySelectedShape()
    const topicSelected = !editingId && !!only && rt.isTopic(only.id)
    const intent = topicKeyIntent(k, {
      topicSelected,
      editingTopic,
      isIdle: editor.isIn('select.idle'),
      isReadonly: editor.getIsReadonly(),
      menusOpen: editor.menus.hasAnyOpenMenus(),
      targetIsTextField: !editingTopic && isTextField(e.target),
      justLeftEditing: !!only && leftEditing === only.id,
      locked: !!only && editor.isShapeOrAncestorLocked(only),
    })
    if (!intent) return
    const id = (editingTopic ? editingId : only?.id) as TLShapeId | undefined
    if (!id) return
    take(e)
    if (intent.kind === 'edit') leftEditing = null
    perform(intent, id)
  }

  const onKeyUp = (e: KeyboardEvent) => {
    const code = e.code || e.key
    if (!swallowUp.has(code)) return
    swallowUp.delete(code)
    e.stopPropagation()
  }

  doc.addEventListener('keydown', onKeyDown, { capture: true })
  doc.addEventListener('keyup', onKeyUp, { capture: true })
  doc.addEventListener('pointerdown', onPointerDown, { capture: true })
  return {
    expectEditor,
    dispose() {
      disposed = true
      doc.removeEventListener('keydown', onKeyDown, { capture: true })
      doc.removeEventListener('keyup', onKeyUp, { capture: true })
      doc.removeEventListener('pointerdown', onPointerDown, { capture: true })
      stopEditing()
      stopSelection()
      if (pending) pending.done = true
    },
  }
}
