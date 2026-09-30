// The mind-map keys on the new canvas (../keys.ts has the table and the rules; the same intents here):
//
//   Tab / Enter / Shift+Tab   add a child / add a sibling / move up a level, on the one selected topic
//                             (`canvas` scope) or while typing in a topic (`editor` scope: the words are
//                             committed first, then the new topic opens for typing)
//   Arrow keys                move the selection through the map (only while not typing)
//   F2                        edit the selected topic
//   Delete / Backspace        remove the selected topics with their branches (asks above a size)
//
// Keys are declared as FeatureKeySpecs (docs/EXCALIDRAW-CONTRACTS.md §1 rule 8): the board page's key
// dispatch (canvas/board/input.ts) runs them before the key allowlist, so Excalidraw never sees them.
//
// Never losing a keystroke. A new topic's editor opens through the text lease: between the Tab (or Enter)
// and the grant, the editor is "pending" and the board page keeps printable keys, Enter and Backspace in
// the lease's buffer (replayed into the editor on the grant) and stops the rest, feature keys included. So
// while its own new topic is pending this observes the TRUSTED key-downs on the board (a document-capture
// listener filtered to the board's container; the input stream's `on('input')` also reports the lease's own
// synthetic Enter, CR-3D-2), keeps them in order (between one topic's editor closing and the next one's
// lease request it also keeps them from the board, which would take a letter for a tool key), and when the
// editor opens it puts the words typed before the first Tab, Enter, Shift+Tab or Esc into the topic
// (replacing what the replay typed, which turned an Enter into a new line) and runs the key itself; the keys
// after it wait for the next topic's editor. Esc before the grant cancels the lease: the queued words are
// then written without an editor (the runtime's `setTopicText`) and an empty new topic is taken back. Keys
// are held at most HOLD_LIMIT_MS. "Idea<Tab>Detail<Enter>Other" typed at full speed builds the same map as
// typed slowly, as it does on the tldraw page.
//
// A new map's central topic says "Central topic" as a placeholder: it opens with all of its text selected,
// so the first character typed replaces it.

import type {
  CanvasFeatureContext,
  FeatureKeySpec,
  KeyEventLike,
  LobbyCanvas,
} from '../../../canvas/api/index.ts'
import { type TopicKeyIntent, topicKeyIntent } from '../keys.ts'
import type { MindmapRuntime } from './runtime.ts'

/** 'fresh': a new, empty topic; 'append': an existing topic (at the end); 'placeholder': a new map's root. */
export type EditorMode = 'fresh' | 'append' | 'placeholder'

type Queued =
  | { kind: 'text'; text: string }
  | { kind: 'key'; intent: 'child' | 'sibling' | 'promote' | 'escape' }

interface Pending {
  /** the topic whose editor is opening (null while the previous topic's editor closes) */
  id: string | null
  mode: EditorMode
  queue: Queued[]
  done: boolean
}

/** How long keys are held for a topic whose editor is on its way before they are let go. */
export const HOLD_LIMIT_MS = 3000

const MODIFIERS = new Set(['Shift', 'Control', 'Alt', 'Meta', 'AltGraph', 'CapsLock', 'OS'])

/** A key that types one character (the board's own rule, canvas-ux/keys.ts isPrintableKey). */
function printable(e: { key: string; ctrl: boolean; meta: boolean; alt: boolean }): boolean {
  if (e.meta || (e.ctrl && !e.alt) || (e.alt && !e.ctrl)) return false
  return [...e.key].length === 1 && !/\p{C}/u.test(e.key)
}

/** What a key typed while a topic's editor is pending means, or null (it means nothing to a topic). */
export function queuedOf(e: {
  key: string
  shift: boolean
  ctrl: boolean
  meta: boolean
  alt: boolean
}): Queued | 'backspace' | null {
  if (MODIFIERS.has(e.key)) return null
  if (printable(e)) return { kind: 'text', text: e.key }
  if (e.ctrl || e.meta || e.alt) return null
  if (e.key === 'Tab') return { kind: 'key', intent: e.shift ? 'promote' : 'child' }
  if (e.key === 'Enter') return e.shift ? { kind: 'text', text: '\n' } : { kind: 'key', intent: 'sibling' }
  if (e.key === 'Escape') return { kind: 'key', intent: 'escape' }
  if (e.key === 'Backspace') return 'backspace'
  return null
}

/** Adds one pending key to a queue (text runs merge; Backspace takes back the last typed character). */
export function enqueue(queue: Queued[], q: Queued | 'backspace'): void {
  const last = queue[queue.length - 1]
  if (q === 'backspace') {
    if (last?.kind === 'text') {
      last.text = [...last.text].slice(0, -1).join('')
      if (!last.text) queue.pop()
    } else queue.push({ kind: 'text', text: '\b' })
    return
  }
  if (q.kind === 'text' && last?.kind === 'text') last.text += q.text
  else queue.push(q)
}

/**
 * The topic's text after the queued words (up to the first key): `base` is its text when the editor
 * opened ('' for a new topic; replaced by the first character for a placeholder). '\b' is a Backspace
 * that reached past the queued words.
 */
export function textAfter(base: string, mode: EditorMode, words: string): string {
  let out = mode === 'fresh' ? '' : base
  let replaced = mode !== 'placeholder'
  for (const ch of [...words]) {
    if (!replaced) {
      out = ''
      replaced = true
      if (ch === '\b') continue
    }
    if (ch === '\b') out = [...out].slice(0, -1).join('')
    else out += ch
  }
  return out
}

export class MindmapKeyboard {
  private pending: Pending | null = null
  private offs: (() => void)[] = []
  private disposed = false
  readonly rt: MindmapRuntime
  readonly canvas: LobbyCanvas

  constructor(rt: MindmapRuntime) {
    this.rt = rt
    this.canvas = rt.canvas
  }

  install(): () => void {
    // An observer of the board's key-downs (it acts on none; it stops one only in the moment between two
    // topics' editors, see onKey), trusted events only: the lease's own synthetic Enter, which opens an editor, must never be taken for a key
    // the person typed, and the `input` stream does not say which key-downs are synthetic (CR-3D-2).
    // On the document, so it sees a key before the board's own dispatch: the Tab that starts a new topic
    // is handled there, and only the keys AFTER it are the new topic's.
    const root = this.canvas.container()
    const doc = root?.ownerDocument
    if (root && doc) {
      const onKey = (e: KeyboardEvent) => {
        if (e.target instanceof Node && root.contains(e.target)) this.onKey(e)
      }
      doc.addEventListener('keydown', onKey, { capture: true })
      this.offs.push(() => doc.removeEventListener('keydown', onKey, { capture: true }))
    }
    return () => {
      this.disposed = true
      for (const f of this.offs.splice(0)) f()
      if (this.pending) this.pending.done = true
      this.pending = null
    }
  }

  /** Whether keys are being kept for a topic whose editor is still to open. */
  get waiting(): boolean {
    return !!this.pending && !this.pending.done
  }

  private onKey(e: KeyboardEvent) {
    if (!e.isTrusted || e.isComposing) return
    const p = this.pending
    if (!p || p.done) return
    // typed into some other field (a comment, the search box): not a key for the board
    const t = e.target as HTMLElement | null
    const wysiwyg = t instanceof HTMLTextAreaElement && t.classList.contains('excalidraw-wysiwyg')
    const field =
      !!t && (t.isContentEditable || t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement)
    if (field && !wysiwyg) return
    // the editor is open: the editor-scope keys and the textarea take it from here
    if (p.id && this.canvas.text.editorElement() && this.canvas.editingId() === p.id) return
    const q = queuedOf({ key: e.key, shift: e.shiftKey, ctrl: e.ctrlKey, meta: e.metaKey, alt: e.altKey })
    if (!q) return
    enqueue(p.queue, q)
    // Between a topic's editor closing and the next topic's lease request (no lease is pending yet, so
    // the board would take a letter for a tool key and the closing editor would take the rest), the key
    // is the next topic's alone: nothing else sees it. Once the request is out, the lease keeps the keys.
    if (p.id === null) {
      e.preventDefault()
      e.stopImmediatePropagation()
    }
  }

  /** Opens `id`'s editor through the lease; keys typed until it is open are kept for it (see the header). */
  expectEditor(id: string, mode: EditorMode, carried: Queued[] = []): void {
    if (this.pending) this.pending.done = true
    const p: Pending = { id, mode, queue: [...carried], done: false }
    this.pending = p
    const base = this.canvas.text.of(id)
    setTimeout(() => {
      if (!p.done && this.pending === p) {
        p.done = true
        this.pending = null
      }
    }, HOLD_LIMIT_MS)
    void this.canvas.text
      .edit(id, { via: mode === 'append' ? 'enter' : 'api', caret: mode === 'placeholder' ? 'all' : 'end' })
      .then(
        (ok) => this.opened(p, base, ok),
        () => this.opened(p, base, false),
      )
  }

  private opened(p: Pending, base: string, ok: boolean) {
    if (p.done || this.pending !== p) return
    p.done = true
    this.pending = null
    const id = p.id as string
    if (ok) {
      this.drain(id, p.mode, base, p.queue)
      return
    }
    // The editor never opened. An Esc while it was on its way cancels the open (the board's own rule),
    // but the keys before it still count: typed that fast, they go in without an editor. Otherwise
    // (someone else is typing in it) a new topic that stays empty goes back.
    if (p.queue.some((q) => q.kind === 'key' && q.intent === 'escape'))
      void this.replayWithoutEditor(id, p.mode, base, p.queue)
    else this.rt.editorNeverOpened(id)
  }

  /**
   * Runs a queue with no editor: each topic's words are written by the runtime (through the lease, or as
   * a new label), and Tab, Enter and Shift+Tab act as they would in the editor. Keys still typing when the
   * queue ends open that topic's editor after all.
   */
  private async replayWithoutEditor(id: string, mode: EditorMode, base: string, queue: Queued[]) {
    // the cancelled open first closes the editor the engine may have begun (its clean-up runs a moment
    // later, selects the topic it was for and may drop the empty label it had open): act once that is over
    const frame = () => new Promise<void>((r) => requestAnimationFrame(() => r()))
    const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))
    await frame()
    await frame()
    for (
      let i = 0;
      i < 60 && (this.canvas.gesture() === 'editing-text' || this.canvas.text.editorElement() !== null);
      i++
    )
      await frame()
    // Writes the words and checks they stayed: a clean-up that lands after the write (the engine's
    // submit of the closed editor) is followed by the write again.
    const write = async (topic: string, text: string) => {
      for (let i = 0; i < 20 && !this.disposed; i++) {
        if (this.rt.setTopicText(topic, text)) {
          await frame()
          await wait(60)
          if (this.rt.textOf(topic) === text) return
        } else await wait(60)
      }
    }
    let cur = id
    let curMode = mode
    let curBase = base
    let q = [...queue]
    for (let guard = 0; guard < 500; guard++) {
      let words = ''
      let i = 0
      for (; i < q.length && q[i]?.kind === 'text'; i++) words += (q[i] as { text: string }).text
      const text = textAfter(curBase, curMode, words)
      if (text !== curBase) await write(cur, text)
      const key = q[i]
      q = q.slice(i + 1)
      if (key?.kind !== 'key') {
        this.expectEditor(cur, 'append')
        return
      }
      if (key.intent === 'escape') {
        // as after typing: the topic stays selected, not being edited (an empty new one goes back)
        this.rt.editorNeverOpened(cur, { selectParent: true })
        if (this.rt.isTopic(cur)) this.canvas.select([cur])
        return
      }
      if (key.intent === 'promote') {
        this.rt.promote(cur)
        curMode = 'append'
        curBase = this.canvas.text.of(cur)
        continue
      }
      if (this.rt.fresh?.id === cur) this.rt.fresh = null
      const made = key.intent === 'child' ? this.rt.addChild(cur) : this.rt.addSibling(cur)
      if (!made) return
      cur = made
      curMode = 'fresh'
      curBase = ''
    }
  }

  /** Puts the words queued before the first key into the open editor, then runs that key. */
  private drain(id: string, mode: EditorMode, base: string, queue: Queued[]) {
    if (!queue.length) return
    let words = ''
    let i = 0
    for (; i < queue.length; i++) {
      const q = queue[i] as Queued
      if (q.kind === 'text') words += q.text
      else break
    }
    const ta = this.canvas.text.editorElement()
    if (ta) {
      const next = textAfter(base, mode, words)
      if (ta.value !== next) {
        ta.value = next
        ta.setSelectionRange(next.length, next.length)
        ta.dispatchEvent(new Event('input', { bubbles: true }))
      }
    }
    const key = queue[i]
    if (key?.kind !== 'key') return
    const rest = queue.slice(i + 1)
    if (key.intent === 'escape') {
      this.canvas.text.stop()
      return
    }
    this.fromEditor(key.intent, id, rest)
  }

  /**
   * Tab, Enter or Shift+Tab inside a topic's editor: the words are committed (the editor closes), then
   * the new topic (or, for Shift+Tab, the same one one level up) opens for typing. Keys typed meanwhile
   * are kept for it.
   */
  fromEditor(intent: 'child' | 'sibling' | 'promote', id: string, carried: Queued[] = []): void {
    if (this.pending) this.pending.done = true
    const p: Pending = { id: null, mode: 'fresh', queue: [...carried], done: false }
    this.pending = p
    // leaving a topic for its child or sibling keeps it, even empty (as tldraw does)
    if (intent !== 'promote' && this.rt.fresh?.id === id) this.rt.fresh = null
    this.canvas.text.stop()
    // the editor always closes on its Escape; should it not, the keys are not held for ever
    setTimeout(() => {
      if (!p.done && this.pending === p && p.id === null) {
        p.done = true
        this.pending = null
      }
    }, HOLD_LIMIT_MS)
    this.rt.whenEditorClosed(() => {
      if (p.done || this.pending !== p) return
      p.done = true
      this.pending = null
      if (intent === 'promote') {
        this.rt.promote(id)
        if (this.rt.isTopic(id)) this.expectEditor(id, 'append', p.queue)
        return
      }
      const made = intent === 'child' ? this.rt.addChild(id) : this.rt.addSibling(id)
      if (made) this.expectEditor(made, 'fresh', p.queue)
    })
  }

  /** Runs a canvas-scope intent on the selected topic. */
  perform(intent: TopicKeyIntent, id: string): void {
    switch (intent.kind) {
      case 'child': {
        const made = this.rt.addChild(id)
        if (made) this.expectEditor(made, 'fresh')
        return
      }
      case 'sibling': {
        const made = this.rt.addSibling(id)
        if (made) this.expectEditor(made, 'fresh')
        return
      }
      case 'promote':
        this.rt.promote(id)
        return
      case 'nav':
        this.rt.navigate(id, intent.dir)
        return
      case 'edit':
        if (this.canvas.text.canEdit(id)) this.expectEditor(id, 'append')
        return
    }
  }
}

// ---- the key specs ------------------------------------------------------------------------------------

/** The chords the mind map claims (the keyboard map and the shortcuts dialog read them). */
export const MINDMAP_CANVAS_CHORDS = [
  'tab',
  'shift+tab',
  'enter',
  'f2',
  'left',
  'right',
  'up',
  'down',
] as const
export const MINDMAP_EDITOR_CHORDS = ['tab', 'shift+tab', 'enter'] as const
export const MINDMAP_DELETE_CHORDS = ['delete', 'backspace'] as const

/** The one selected topic (a selected label stands for its container), or null. */
export function selectedTopic(rt: MindmapRuntime): string | null {
  const sel = rt.canvas.selection
  if (sel.length !== 1) return null
  const el = rt.canvas.get(sel[0] as string)
  const id = el?.type === 'text' && el.containerId ? el.containerId : (sel[0] as string)
  return rt.isTopic(id) ? id : null
}

/** The topic this tab is typing in, or null. */
export function editingTopic(rt: MindmapRuntime): string | null {
  const id = rt.canvas.editingId()
  return id && rt.isTopic(id) ? id : null
}

const plain = (e: KeyEventLike) => !e.ctrlKey && !e.metaKey && !e.altKey

export function mindmapKeys(
  get: (ctx: CanvasFeatureContext) => { rt: MindmapRuntime; keys: MindmapKeyboard } | null,
): FeatureKeySpec[] {
  const intentFor = (
    e: KeyEventLike,
    ctx: CanvasFeatureContext,
  ): { intent: TopicKeyIntent; id: string } | null => {
    const m = get(ctx)
    if (!m) return null
    const id = selectedTopic(m.rt)
    if (!id || m.keys.waiting) return null
    const intent = topicKeyIntent(e, {
      topicSelected: true,
      editingTopic: false,
      isIdle: ctx.canvas.gesture() === 'idle',
      isReadonly: ctx.canvas.readOnly(),
      menusOpen: ctx.registries.menusOpen.call(),
      targetIsTextField: false,
      justLeftEditing: true, // no type-to-edit on topics here (see index.tsx): only F2 edits
      locked: ctx.canvas.isLocked(id),
    })
    return intent ? { intent, id } : null
  }
  // While a new topic's editor is on its way, the board's own meaning of these keys must not run (Tab
  // would move the focus out of the canvas, the arrows would nudge the topic): they are kept for the
  // topic (onInput saw them first) and swallowed here.
  const holding = (ctx: CanvasFeatureContext) => get(ctx)?.keys.waiting === true
  return [
    {
      id: 'mindmap.topic',
      scope: 'canvas',
      chords: MINDMAP_CANVAS_CHORDS,
      match: (e, ctx) => holding(ctx) || intentFor(e, ctx) !== null,
      handle(e, ctx) {
        const m = get(ctx)
        if (!m) return false
        if (m.keys.waiting) return true
        const r = intentFor(e, ctx)
        if (!r) return false
        m.keys.perform(r.intent, r.id)
        return true
      },
    },
    {
      id: 'mindmap.editor',
      scope: 'editor',
      chords: MINDMAP_EDITOR_CHORDS,
      match: (e, ctx) => {
        const m = get(ctx)
        return !!m && plain(e) && !ctx.canvas.readOnly() && editingTopic(m.rt) !== null
      },
      handle(e, ctx) {
        const m = get(ctx)
        const id = m ? editingTopic(m.rt) : null
        if (!m || !id) return false
        if (e.key === 'Tab') m.keys.fromEditor(e.shiftKey ? 'promote' : 'child', id)
        else if (e.key === 'Enter' && !e.shiftKey) m.keys.fromEditor('sibling', id)
        else return false
        return true
      },
    },
    {
      id: 'mindmap.delete',
      scope: 'canvas',
      chords: MINDMAP_DELETE_CHORDS,
      match: (_e, ctx) => {
        const m = get(ctx)
        if (!m) return false
        if (m.keys.waiting) return true
        return (
          !ctx.canvas.readOnly() &&
          ctx.canvas.gesture() === 'idle' &&
          m.rt.planDelete(ctx.canvas.selection) !== null
        )
      },
      handle(_e, ctx) {
        const m = get(ctx)
        if (!m) return false
        // Backspace for the topic on its way (kept by onInput): never a delete of the topic being left
        if (m.keys.waiting) return true
        return m.rt.requestDelete(ctx.canvas.selection) !== 'not-mindmap'
      },
    },
  ]
}
