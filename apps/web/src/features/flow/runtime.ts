// OWNER: W4 (wave L, L4-1). Flow-building on one board: the keys (Ctrl/Cmd+Arrow makes the next connected shape,
// Ctrl/Cmd+Shift+Arrow the next one of the last created kind), the + handles' clicks and drops (./Handles.tsx),
// and the new shape's editor, opened through the text lease without losing a key typed before it opens.
//
// Never losing a keystroke (the mind map's queue pattern, features/mindmap/ported/keyboard.ts, copied, not
// shared): the key handler creates the shape, selects it and asks the lease for its editor in the same keydown,
// so from the next key on the board page keeps printable keys, Enter and Backspace in the lease's buffer and
// replays them into the editor on the grant. This keeps its own copy of the words typed meanwhile (the input
// stream's key-down notifications, the lease's synthetic Enter and Escape left out), so that:
//  - on the grant, the editor holds exactly those words (whatever the replay made of them);
//  - an Escape before the grant (the board then cancels the lease, and its buffer with it) still keeps the words:
//    they become the new shape's label without an editor (the shape is this tab's own, made a moment ago; nobody
//    else holds its lease), and the shape stays selected;
//  - a denied or failed open does the same.
// Keys are held for the editor at most HOLD_LIMIT_MS.
//
// The flow being built (what Ctrl/Cmd+Shift+Arrow repeats) is short-lived: it is the one shape the flow last made
// or connected to (`cursor`) with the kind it last made (`lastKind`), and it ends, both cleared, as soon as
//  - the selection becomes anything other than that shape (or its label): another shape, several, a frame, a
//    connector. An empty selection does not end it (the engine deselects while the shape's editor opens, and an
//    Escape may deselect); nothing is then selected for the key to act on anyway;
//  - the canvas is pressed (a click elsewhere, a drag, a click that closes the editor; the + handles are DOM
//    buttons and do not count);
//  - FLOW_IDLE_MS pass with no flow step (the shape's editor opening or closing counts as one: typing its words
//    is part of the flow).
// So the chord is a11y's again (Ctrl/Cmd+Shift+Down / Up into and out of a frame) on every shape the moment the
// person does anything but build the flow, including on the shape the flow made, selected again later.
//
// Alt+Arrow (the walk along the connections) is a11y's 'a11y.next' / 'a11y.previous', which traversal.ts now
// answers by the pressed arrow: this installs the key-down observer that tells it which arrow it was.
import { newElementId } from '@draftroom/board-ops/elements'
import type { CanvasFeatureContext, CanvasInputEvent, LobbyCanvas } from '../../canvas/api/index.ts'
import { bringIntoView, noteWalkKey } from '../a11y/ported/traversal.ts'
import { applyConnected, applyConnector } from './build.ts'
import type { FlowDir } from './connector.ts'
import { type FlowKind, flowSourceOf, planConnected, planConnector } from './planner.ts'

/** How long keys typed for a new shape are kept before its editor opens. */
export const HOLD_LIMIT_MS = 3000
/** How long a flow stays open to Ctrl/Cmd+Shift+Arrow after its last step (see the header). */
export const FLOW_IDLE_MS = 15_000

interface Pending {
  readonly id: string
  words: string
  escaped: boolean
  done: boolean
}

const MODIFIERS = new Set(['Shift', 'Control', 'Alt', 'Meta', 'AltGraph', 'CapsLock', 'OS'])

/** A key that types one character (the board's rule, canvas-ux/keys.ts isPrintableKey). */
function printable(e: { key: string; ctrl: boolean; meta: boolean; alt: boolean }): boolean {
  if (e.meta || (e.ctrl && !e.alt) || (e.alt && !e.ctrl)) return false
  return [...e.key].length === 1 && !/\p{C}/u.test(e.key)
}

/** The words typed for a pending editor after `key` (null: the key means nothing to it). */
export function wordsAfter(
  words: string,
  e: { key: string; shift: boolean; ctrl: boolean; meta: boolean; alt: boolean },
): { words: string; escape?: true } | null {
  if (MODIFIERS.has(e.key)) return null
  if (printable(e)) return { words: words + e.key }
  if (e.ctrl || e.meta || e.alt) return null
  if (e.key === 'Enter') return { words: `${words}\n` }
  if (e.key === 'Backspace') return { words: [...words].slice(0, -1).join('') }
  if (e.key === 'Escape') return { words, escape: true }
  return null
}

const DIR_OF_KEY: Readonly<Record<string, FlowDir>> = {
  ArrowRight: 'right',
  ArrowLeft: 'left',
  ArrowDown: 'down',
  ArrowUp: 'up',
}
export const dirOfKey = (key: string): FlowDir | null => DIR_OF_KEY[key] ?? null

/** Label text style of a label this makes without an editor (Excalidraw's own defaults, Lobby's font). */
const LABEL_FONT_FAMILY = 6
const LABEL_FONT_SIZE = 20

export class FlowRuntime {
  readonly canvas: LobbyCanvas
  /** the kind the flow being built last made (Ctrl/Cmd+Shift+Arrow makes one more of it), or null */
  lastKind: FlowKind | null = null
  /** the shape the flow being built last made or connected to: Ctrl/Cmd+Shift+Arrow acts only on it, or null */
  cursor: string | null = null
  /** when the flow's last step was (Date.now) */
  private stepAt = 0
  private pending: Pending | null = null
  private offs: (() => void)[] = []
  private disposed = false

  constructor(canvas: LobbyCanvas) {
    this.canvas = canvas
  }

  install(): () => void {
    this.offs.push(
      this.canvas.on('input', (e) => {
        // a press on the canvas ends the flow being built (see the header)
        if (e.type === 'pointer-down') this.endFlow()
        if (e.type !== 'key-down') return
        this.onKey(e)
        // Alt+Arrow: traversal.ts follows the connections in the pressed arrow's direction
        if (!e.synthetic && !e.composing && e.alt && !e.ctrl && !e.meta && !e.shift && dirOfKey(e.key))
          noteWalkKey(this.canvas, e.key)
      }),
      this.canvas.on('selectionChanged', (ids) => {
        if (this.cursor !== null && ids.length > 0 && !this.isCursor(ids)) this.endFlow()
      }),
      this.canvas.on('editingChanged', () => {
        // typing the new shape's words is part of the flow: its editor opening or closing is a step
        if (this.cursor !== null) this.stepAt = Date.now()
      }),
    )
    return () => {
      this.disposed = true
      for (const f of this.offs.splice(0)) f()
      if (this.pending) this.pending.done = true
      this.pending = null
    }
  }

  /** Whether keys are being kept for a new shape whose editor is on its way. */
  get waiting(): boolean {
    return !!this.pending && !this.pending.done
  }

  /** The shape a flow can be built from right now (this tab may edit, nothing in progress), or null. */
  source(): string | null {
    const c = this.canvas
    if (c.readOnly() || c.gesture() !== 'idle' || c.editingId() !== null || this.waiting) return null
    return flowSourceOf(c, c.selection)
  }

  /**
   * The source Ctrl/Cmd+Shift+Arrow acts on: the shape the flow being built last made or connected to, while it
   * is the selection and the flow has not ended (see the header), or null (the chord is then a11y's).
   */
  repeatSource(): string | null {
    if (this.lastKind === null || this.cursor === null || this.canvas.tool() === 'comment') return null
    if (Date.now() - this.stepAt > FLOW_IDLE_MS) return null
    const id = this.source()
    return id !== null && id === this.cursor ? id : null
  }

  /** Ends the flow being built: Ctrl/Cmd+Shift+Arrow declines until the next flow step. */
  endFlow(): void {
    this.cursor = null
    this.lastKind = null
  }

  /** The flow being built goes on from `id` (made or connected to just now). */
  private step(id: string, kind: FlowKind | null): void {
    this.cursor = id
    this.stepAt = Date.now()
    if (kind) this.lastKind = kind
  }

  /** `ids` is the cursor alone, or its label (a selected label stands for its container). */
  private isCursor(ids: readonly string[]): boolean {
    if (ids.length !== 1) return false
    const id = ids[0] as string
    if (id === this.cursor) return true
    const el = this.canvas.get(id) as { containerId?: string | null } | undefined
    return !!el && el.containerId === this.cursor
  }

  /**
   * Makes the next connected shape from `sourceId` going `dir` (one undo step), selects it and opens its editor.
   * `at`: dropped there (a + handle dragged out). Returns the new shape's id, or null when nothing was made.
   */
  next(
    sourceId: string,
    dir: FlowDir,
    opts: { readonly kind?: FlowKind; readonly at?: { x: number; y: number } } = {},
  ): string | null {
    const c = this.canvas
    if (c.readOnly()) return null
    const plan = planConnected(c, sourceId, dir, { newId: freshId, ...opts })
    if (!plan) return null
    const { shapeId } = applyConnected(c, plan)
    // before the selection moves to it (its change would end a flow that still pointed at the source)
    this.step(shapeId, plan.kind)
    c.select([shapeId])
    bringIntoView(c, [shapeId])
    this.expectEditor(shapeId)
    return shapeId
  }

  /** A connector from `fromId` to the existing `toId` (a + handle dropped on a shape); its id, or null. */
  connect(fromId: string, toId: string): string | null {
    const c = this.canvas
    if (c.readOnly()) return null
    const plan = planConnector(c, fromId, toId, { newId: freshId })
    if (!plan) return null
    const id = applyConnector(c, fromId, toId, plan)
    // the flow goes on from the shape connected to, with the kind it last made (none yet: the chord declines)
    this.step(toId, null)
    c.select([toId])
    return id
  }

  private onKey(e: Extract<CanvasInputEvent, { type: 'key-down' }>) {
    if (e.synthetic || e.composing) return
    const p = this.pending
    if (!p || p.done) return
    // the editor is open: the textarea takes the keys from here
    if (this.canvas.editingId() === p.id && this.canvas.text.editorElement()) return
    const next = wordsAfter(p.words, e)
    if (!next) return
    p.words = next.words
    if (next.escape) p.escaped = true
  }

  /** Opens `id`'s editor through the lease; the words typed until it opens are kept for it (see the header). */
  expectEditor(id: string): void {
    if (this.pending) this.pending.done = true
    const p: Pending = { id, words: '', escaped: false, done: false }
    this.pending = p
    setTimeout(() => {
      if (!p.done && this.pending === p) {
        p.done = true
        this.pending = null
      }
    }, HOLD_LIMIT_MS)
    void this.canvas.text.edit(id, { via: 'api', caret: 'end' }).then(
      (ok) => this.opened(p, ok),
      () => this.opened(p, false),
    )
  }

  private opened(p: Pending, ok: boolean) {
    if (p.done || this.pending !== p || this.disposed) return
    p.done = true
    this.pending = null
    if (ok) {
      const ta = this.canvas.text.editorElement()
      if (ta && p.words && ta.value !== p.words) {
        ta.value = p.words
        ta.setSelectionRange(p.words.length, p.words.length)
        ta.dispatchEvent(new Event('input', { bubbles: true }))
      }
      if (p.escaped) this.canvas.text.stop()
      return
    }
    // no editor (an Escape before the grant cancelled it, or the lease was refused): the words typed still count
    if (p.words.trim()) void this.writeWords(p.id, p.words)
  }

  /** The words typed for `id` without an editor: its label's words, or a new label (this tab's own new shape). */
  private async writeWords(id: string, words: string): Promise<void> {
    const c = this.canvas
    // the editor the cancelled open may have begun closes first (its clean-up selects the shape again)
    for (let i = 0; i < 30 && (c.gesture() === 'editing-text' || c.text.editorElement() !== null); i++)
      await new Promise<void>((r) => setTimeout(r, 16))
    const el = c.get(id)
    if (!el || el.isDeleted || c.readOnly()) return
    const holder = c.leaseHolder(id)
    if (holder && holder.sid !== (c.engine?.welcome?.sid ?? null)) return
    const bound = (
      (el as { boundElements?: { id: string; type: string }[] | null }).boundElements ?? []
    ).find((b) => b.type === 'text')
    const label = bound ? c.get(bound.id) : undefined
    if (label && !label.isDeleted) {
      await c.text.replace(id, words, 'flow: words')
      return
    }
    const text = words.replace(/\n+$/, '')
    const pad = 10
    const m = c.text.measure(text, { fontFamily: LABEL_FONT_FAMILY, fontSize: LABEL_FONT_SIZE })
    const width = Math.max(el.width, m.width + 2 * pad)
    const height = Math.max(el.height, m.height + 2 * pad)
    const labelId = freshId()
    c.transact('flow: words', (tx) => {
      if (width !== el.width || height !== el.height) tx.update(id, { width, height })
      tx.create('text', {
        id: labelId,
        x: el.x + width / 2,
        y: el.y + height / 2,
        text,
        originalText: text,
        fontFamily: LABEL_FONT_FAMILY,
        fontSize: LABEL_FONT_SIZE,
        textAlign: 'center',
        verticalAlign: 'middle',
        containerId: id,
        frameId: el.frameId ?? null,
        autoResize: true,
      })
      tx.update(id, {
        boundElements: [
          ...((el as { boundElements?: { id: string; type: string }[] | null }).boundElements ?? []),
          { id: labelId, type: 'text' },
        ],
      })
    })
    c.select([id])
  }
}

/** A fresh element id (board-ops' element ids, as the mind map's draft makes them). */
export const freshId = (): string => newElementId()

const runtimes = new WeakMap<object, FlowRuntime>()

/** This board's flow runtime (made on mount), or null. */
export const flowRuntimeOf = (canvas: LobbyCanvas): FlowRuntime | null => runtimes.get(canvas) ?? null

/** Makes and installs the board's flow runtime; returns its removal. */
export function mountFlow(ctx: CanvasFeatureContext): () => void {
  const rt = new FlowRuntime(ctx.canvas)
  runtimes.set(ctx.canvas, rt)
  const off = rt.install()
  return () => {
    off()
    if (runtimes.get(ctx.canvas) === rt) runtimes.delete(ctx.canvas)
  }
}
