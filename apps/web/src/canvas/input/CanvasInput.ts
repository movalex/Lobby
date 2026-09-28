// Lobby's input layer on the board wrapper (docs/EXCALIDRAW-MIGRATION.md §2.3.3, §2.3.4, §2.9.2).
//
// Capture-phase listeners on the element that wraps <Excalidraw>, so they run before every Excalidraw
// handler that matters: its React handlers (the container's onKeyDown, the canvas's onDoubleClick and
// onContextMenu; React listens on the root, bubble phase), its native listeners on the interactive canvas
// (touchstart, :47143-47148) and on the document (copy, cut, paste, keyup; :49340-49400), and the text
// editor's own `onkeydown` (:25365-25405, target phase).
//
//  - keydown: the allowlist (./keymap.ts). A key Excalidraw must not see gets stopPropagation; its keyup
//    is stopped too (Excalidraw's onKeyUp rebinds selected arrows on an arrow keyup, :44237+).
//  - dblclick: stopped only when Excalidraw would open the text editor (./dblclick.ts); Lobby then runs
//    the lease flow. Linear-editor toggles, entering a group, crop… are forwarded (open item 2).
//  - touchstart: Lobby's tap-twice mirror (./doubleTap.ts) swallows the one touchstart Excalidraw would
//    turn into a double-tap, calls preventDefault on it (Excalidraw's iOS preventDefault no longer runs)
//    and runs the lease flow (P4).
//  - contextmenu: Lobby's menu, never Excalidraw's.
//  - copy / cut: the export policy. paste: read-only roles get nothing. dragover / drop: Lobby's upload
//    path for editors, nothing for read-only roles; never Excalidraw's, never the browser's.
//  - api.onChange: the editor-open guard (../lease/editorLease.ts).
//
// Events Lobby dispatches itself (the synthetic Enter / Escape) are in `synthetic` and pass untouched.

import { viewportCoordsToSceneCoords } from '@excalidraw/excalidraw'
import type { ExcalidrawElement } from '@excalidraw/excalidraw/element/types'
import type { ExcalidrawImperativeAPI } from '@excalidraw/excalidraw/types'
import type { LeaseClient } from '../lease/client.ts'
import { EditorLease, type EditTrace } from '../lease/editorLease.ts'
import { bufferedKeyOf } from '../lease/replay.ts'
import { classifyDoubleClick, type DblClickElement } from './dblclick.ts'
import { DoubleTapMirror } from './doubleTap.ts'
import { classifyKey, type KeyContext, type KeyVerdict, type LobbyKeyAction } from './keymap.ts'
import { computeSelectAll } from './selectAll.ts'

export type InputRole = 'editor' | 'readonly'

export interface InputTrace {
  type: string
  at: number
  [key: string]: unknown
}

export interface CanvasInputOptions {
  role: () => InputRole
  lease: LeaseClient
  /** CanvasPort.setTool (../tools/tools.ts). */
  setTool: (tool: string) => boolean
  /** Lobby-owned key actions. A Lobby-owned key with no handler here and no built-in is blocked. */
  actions?: Partial<Record<LobbyKeyAction, (e: KeyboardEvent) => void>>
  /** Elements hidden by a mind-map collapse (Ctrl+A leaves them out). */
  hiddenIds?: () => ReadonlySet<string>
  /** The export policy: may this viewer copy or cut? (Default: editors only.) */
  canCopy?: () => boolean
  /** Lobby's upload path for dropped files (editors). */
  onDrop?: (e: DragEvent) => void
  onContextMenu?: (e: MouseEvent) => void
  /** A double-click / double-tap on empty canvas (editors): Lobby creates a text there. */
  onEmptyDoubleClick?: (scene: { x: number; y: number }) => void
  onDeny?: (leaseId: string, holderName: string) => void
  trace?: (t: InputTrace | EditTrace) => void
  /** Spike control runs only: 'off' lets every key reach Excalidraw (shows what the allowlist stops). */
  allowlist?: 'on' | 'off'
  /** Spike control runs only: false lets every dblclick / touchstart through. */
  interceptDoubleClicks?: boolean
}

const TEXT_CONTAINERS = new Set(['rectangle', 'stickynote', 'ellipse', 'diamond'])

type SceneEl = ExcalidrawElement

const LINEAR = new Set(['arrow', 'line', 'freedraw'])

/** Distance from (x, y) to a linear element's polyline (its points are relative to el.x, el.y). */
function distanceToPolyline(el: SceneEl, x: number, y: number): number {
  const pts = (el as { points?: readonly (readonly [number, number])[] }).points ?? []
  let best = Number.POSITIVE_INFINITY
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1]
    const b = pts[i]
    if (!a || !b) continue
    const ax = el.x + a[0]
    const ay = el.y + a[1]
    const bx = el.x + b[0]
    const by = el.y + b[1]
    const len2 = (bx - ax) ** 2 + (by - ay) ** 2
    const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((x - ax) * (bx - ax) + (y - ay) * (by - ay)) / len2))
    best = Math.min(best, Math.hypot(x - (ax + t * (bx - ax)), y - (ay + t * (by - ay))))
  }
  return best
}

/**
 * Lobby's hit test: the stroke (within `threshold` scene px) for arrows, lines and freedraw; the
 * (rotated) box for everything else. Good enough for notes, filled shapes and text.
 */
function hits(el: SceneEl, x: number, y: number, threshold: number): boolean {
  if (LINEAR.has(el.type)) return distanceToPolyline(el, x, y) <= threshold
  return containsPoint(el, x, y)
}

function containsPoint(el: SceneEl, x: number, y: number): boolean {
  const cx = el.x + el.width / 2
  const cy = el.y + el.height / 2
  const a = -(el.angle ?? 0)
  const dx = x - cx
  const dy = y - cy
  const lx = dx * Math.cos(a) - dy * Math.sin(a) + cx
  const ly = dx * Math.sin(a) + dy * Math.cos(a) + cy
  const minX = Math.min(el.x, el.x + el.width)
  const maxX = Math.max(el.x, el.x + el.width)
  const minY = Math.min(el.y, el.y + el.height)
  const maxY = Math.max(el.y, el.y + el.height)
  return lx >= minX && lx <= maxX && ly >= minY && ly <= maxY
}

export class CanvasInput {
  readonly synthetic = new WeakSet<Event>()
  private readonly blockedKeyups = new Set<string>()
  private readonly tapMirror = new DoubleTapMirror()
  private editor: EditorLease | null = null
  private api: ExcalidrawImperativeAPI | null = null

  readonly opts: CanvasInputOptions

  constructor(opts: CanvasInputOptions) {
    this.opts = opts
  }

  get editorLease(): EditorLease | null {
    return this.editor
  }

  /** ExcalidrawHost wiring: attach once the engine is initialised. */
  readonly attach = (wrapper: HTMLElement, api: ExcalidrawImperativeAPI): (() => void) => {
    this.api = api
    this.editor = new EditorLease({
      api,
      wrapper,
      lease: this.opts.lease,
      synthetic: this.synthetic,
      onDeny: this.opts.onDeny,
      trace: (t) => this.opts.trace?.(t),
    })
    const capture = { capture: true } as const
    const activeCapture = { capture: true, passive: false } as const
    wrapper.addEventListener('keydown', this.onKeyDown, capture)
    wrapper.addEventListener('keyup', this.onKeyUp, capture)
    wrapper.addEventListener('dblclick', this.onDblClick, capture)
    wrapper.addEventListener('touchstart', this.onTouchStart, activeCapture)
    wrapper.addEventListener('contextmenu', this.onContextMenu, capture)
    wrapper.addEventListener('copy', this.onCopy, capture)
    wrapper.addEventListener('cut', this.onCut, capture)
    wrapper.addEventListener('paste', this.onPaste, capture)
    wrapper.addEventListener('dragover', this.onDragOver, activeCapture)
    wrapper.addEventListener('drop', this.onDrop, activeCapture)
    const unsubscribe = api.onChange((_elements, appState) => {
      this.editor?.onEngineChange(appState.editingTextElement)
    })
    return () => {
      unsubscribe()
      wrapper.removeEventListener('keydown', this.onKeyDown, capture)
      wrapper.removeEventListener('keyup', this.onKeyUp, capture)
      wrapper.removeEventListener('dblclick', this.onDblClick, capture)
      wrapper.removeEventListener('touchstart', this.onTouchStart, activeCapture)
      wrapper.removeEventListener('contextmenu', this.onContextMenu, capture)
      wrapper.removeEventListener('copy', this.onCopy, capture)
      wrapper.removeEventListener('cut', this.onCut, capture)
      wrapper.removeEventListener('paste', this.onPaste, capture)
      wrapper.removeEventListener('dragover', this.onDragOver, activeCapture)
      wrapper.removeEventListener('drop', this.onDrop, activeCapture)
      this.editor = null
      this.api = null
    }
  }

  // --- scene helpers -------------------------------------------------------------------------------

  toScene(clientX: number, clientY: number): { x: number; y: number } {
    const api = this.api
    if (!api) return { x: Number.NaN, y: Number.NaN }
    return viewportCoordsToSceneCoords({ clientX, clientY }, api.getAppState())
  }

  /** Selected, non-deleted elements, bound labels excluded (Excalidraw's getSelectedElements). */
  selected(): SceneEl[] {
    const api = this.api
    if (!api) return []
    const ids = api.getAppState().selectedElementIds
    return api
      .getSceneElements()
      .filter((e) => ids[e.id] && !(e.type === 'text' && (e as { containerId?: string | null }).containerId))
  }

  /** The top element under a scene point (bound labels included when `labels`). */
  elementAt(x: number, y: number, labels = false): SceneEl | null {
    const els = this.api?.getSceneElements() ?? []
    const threshold = 10 / (this.api?.getAppState().zoom.value ?? 1)
    for (let i = els.length - 1; i >= 0; i--) {
      const el = els[i]
      if (!el || el.isDeleted) continue
      if (!labels && el.type === 'text' && (el as { containerId?: string | null }).containerId) continue
      if (hits(el, x, y, threshold)) return el
    }
    return null
  }

  /**
   * What a text-editing double-click at this point edits: a label's container, a text container (arrows
   * included: their label, as Excalidraw's getTextBindableContainerAtPosition picks them), or a text.
   */
  textTargetAt(x: number, y: number): SceneEl | null {
    const hit = this.elementAt(x, y, true)
    if (!hit) return null
    if (hit.type === 'text') {
      const containerId = (hit as { containerId?: string | null }).containerId
      if (!containerId) return hit
      return this.api?.getSceneElements().find((e) => e.id === containerId) ?? null
    }
    return TEXT_CONTAINERS.has(hit.type) || hit.type === 'arrow' ? hit : null
  }

  private trace(type: string, data: Record<string, unknown> = {}): void {
    this.opts.trace?.({ type, at: performance.now(), ...data })
  }

  private isTextEditor(target: EventTarget | null): target is HTMLTextAreaElement {
    return target instanceof HTMLTextAreaElement && target.classList.contains('excalidraw-wysiwyg')
  }

  private keyContext(inTextEditor: boolean): KeyContext {
    const sel = this.selected()
    const only = sel.length === 1 ? sel[0] : undefined
    return {
      role: this.opts.role(),
      editor: this.editor?.keyState() ?? 'none',
      inTextEditor,
      singleTextTarget:
        !!only && (only.type === 'text' || only.type === 'arrow' || TEXT_CONTAINERS.has(only.type)),
      singleNote: !!only && only.type === 'stickynote' && !only.locked,
    }
  }

  // --- keys ------------------------------------------------------------------------------------------

  private readonly onKeyDown = (e: KeyboardEvent): void => {
    if (this.synthetic.has(e) || this.opts.allowlist === 'off') return
    const inTextEditor = this.isTextEditor(e.target)
    const editor = this.editor
    if (inTextEditor && editor && editor.phase === 'idle') {
      const editing = this.api?.getAppState().editingTextElement
      if (editing) editor.guardOpen(editing, 'keydown')
    }
    const verdict = classifyKey(e, this.keyContext(inTextEditor))
    this.trace('key', { key: e.key, code: e.code, verdict: verdictName(verdict), inTextEditor })
    if (verdict.kind === 'delegate') return
    e.stopPropagation()
    if (e.code) this.blockedKeyups.add(e.code)
    switch (verdict.kind) {
      case 'browser':
        return
      case 'block':
        if (verdict.preventDefault) e.preventDefault()
        return
      case 'buffer':
        e.preventDefault()
        editor?.bufferKey(bufferedKeyOf(e))
        return
      case 'cancel':
        e.preventDefault()
        editor?.cancel()
        return
      case 'lobby':
        e.preventDefault()
        this.runAction(verdict.action, e)
        return
    }
  }

  private readonly onKeyUp = (e: KeyboardEvent): void => {
    if (this.synthetic.has(e) || this.opts.allowlist === 'off') return
    if (e.code && this.blockedKeyups.delete(e.code)) e.stopPropagation()
  }

  private runAction(action: LobbyKeyAction, e: KeyboardEvent): void {
    const custom = this.opts.actions?.[action]
    if (custom) {
      custom(e)
      return
    }
    const editor = this.editor
    if (action === 'editText' || action === 'typeToEdit') {
      const only = this.selected()[0]
      if (!only || !editor) return
      editor.requestEdit(only.id, {
        reason: action === 'editText' ? 'P1-enter' : 'P2-type',
        caretEnd: true,
        firstKey: action === 'typeToEdit' ? bufferedKeyOf(e) : undefined,
      })
      return
    }
    if (action === 'selectAll') {
      this.selectAll()
      return
    }
    if (action.startsWith('tool:')) {
      this.opts.setTool(action.slice(5))
    }
    // Other Lobby-owned keys without a handler: nothing (blocked).
  }

  /** Lobby's Ctrl+A: Excalidraw's set minus hidden elements, installed as a selection change. */
  selectAll(): void {
    const api = this.api
    if (!api) return
    const els = api.getSceneElements().map((e) => ({
      id: e.id,
      type: e.type,
      isDeleted: e.isDeleted,
      locked: e.locked,
      containerId: (e as { containerId?: string | null }).containerId ?? null,
      groupIds: e.groupIds,
    }))
    const next = computeSelectAll(els, this.opts.hiddenIds?.() ?? new Set())
    api.updateScene({ appState: { ...next, editingGroupId: null } })
  }

  // --- double-click and double-tap -------------------------------------------------------------------

  private readonly onDblClick = (e: MouseEvent): void => {
    if (this.opts.interceptDoubleClicks === false || !this.api) return
    const s = this.api.getAppState()
    const scene = this.toScene(e.clientX, e.clientY)
    const view = {
      interactionEnabled: this.opts.role() === 'editor',
      editingText: !!s.editingTextElement,
      drawingMultiElement: !!s.multiElement,
      activeToolType: s.activeTool.type,
      preferredSelectionToolType: s.preferredSelectionTool.type,
      selected: this.selected().map(toDbl),
      selectedLinear: s.selectedLinearElement
        ? { elementId: s.selectedLinearElement.elementId, isEditing: s.selectedLinearElement.isEditing }
        : null,
      selectedGroupIds: Object.keys(s.selectedGroupIds).filter((g) => s.selectedGroupIds[g]),
      hit: (() => {
        const h = this.elementAt(scene.x, scene.y)
        return h ? toDbl(h) : null
      })(),
      ctrlOrCmd: e.ctrlKey || e.metaKey,
    }
    const verdict = classifyDoubleClick(view)
    this.trace('dblclick', { verdict: verdict.kind === 'text' ? 'text' : `forward:${verdict.reason}` })
    if (verdict.kind === 'forward') return
    e.stopPropagation()
    e.preventDefault()
    this.editAt(scene.x, scene.y, 'P3-dblclick', e.ctrlKey || e.metaKey)
  }

  private readonly onTouchStart = (e: TouchEvent): void => {
    if (this.opts.interceptDoubleClicks === false || this.opts.role() !== 'editor') return
    // Excalidraw's listener is on the interactive canvas only.
    const target = e.target as Element | null
    if (!target || !(target instanceof HTMLCanvasElement) || !target.classList.contains('interactive')) return
    const verdict = this.tapMirror.onTouchStart({
      time: e.timeStamp,
      touches: Array.from(e.touches, (t) => ({ clientX: t.clientX, clientY: t.clientY })),
    })
    if (verdict.kind === 'pass') return
    e.stopPropagation()
    e.preventDefault()
    this.trace('doubletap', {
      clientX: verdict.clientX,
      clientY: verdict.clientY,
      prevented: e.defaultPrevented,
    })
    const scene = this.toScene(verdict.clientX, verdict.clientY)
    this.editAt(scene.x, scene.y, 'P4-doubletap', false)
  }

  /** Lobby's handler for a text-editing double-click or double-tap at a scene point. */
  editAt(x: number, y: number, reason: string, skipContainer: boolean): void {
    const editor = this.editor
    if (editor?.phase !== 'idle') return
    const target = skipContainer ? null : this.textTargetAt(x, y)
    if (target) {
      editor.requestEdit(target.id, { reason, caretEnd: true })
      return
    }
    this.opts.onEmptyDoubleClick?.({ x, y })
  }

  // --- menus, clipboard, drop ------------------------------------------------------------------------

  private readonly onContextMenu = (e: MouseEvent): void => {
    if (this.isTextEditor(e.target) && this.editor?.phase === 'open') return // the textarea's own menu
    e.preventDefault()
    e.stopPropagation()
    this.trace('contextmenu', {})
    this.opts.onContextMenu?.(e)
  }

  private canCopy(): boolean {
    return this.opts.canCopy ? this.opts.canCopy() : this.opts.role() === 'editor'
  }

  private readonly onCopy = (e: ClipboardEvent): void => {
    if (this.isTextEditor(e.target)) return
    if (this.canCopy()) return
    e.preventDefault()
    e.stopPropagation()
    this.trace('copy-blocked', {})
  }

  private readonly onCut = (e: ClipboardEvent): void => {
    if (this.isTextEditor(e.target) && this.editor?.phase === 'open') return
    if (this.opts.role() === 'editor' && this.canCopy()) return
    e.preventDefault()
    e.stopPropagation()
    this.trace('cut-blocked', {})
  }

  private readonly onPaste = (e: ClipboardEvent): void => {
    if (this.isTextEditor(e.target)) {
      if (this.editor?.phase === 'open') return
      e.preventDefault() // no paste into an editor whose lease is pending
      e.stopPropagation()
      this.trace('paste-blocked', { where: 'pending-editor' })
      return
    }
    if (this.opts.role() === 'editor') return // Excalidraw -> props.onPaste (Lobby's handler)
    e.preventDefault()
    e.stopPropagation()
    this.trace('paste-blocked', { where: 'read-only' })
  }

  private readonly onDragOver = (e: DragEvent): void => {
    if (this.isTextEditor(e.target) && this.editor?.phase === 'open') return
    e.preventDefault() // the drop lands here, not in a new browser tab
    e.stopPropagation()
  }

  private readonly onDrop = (e: DragEvent): void => {
    if (this.isTextEditor(e.target) && this.editor?.phase === 'open') return
    e.preventDefault()
    e.stopPropagation()
    const editor = this.opts.role() === 'editor'
    this.trace('drop', { files: e.dataTransfer?.files.length ?? 0, handled: editor })
    if (editor) this.opts.onDrop?.(e)
  }
}

function toDbl(el: SceneEl): DblClickElement {
  return {
    id: el.id,
    type: el.type,
    elbowed: (el as { elbowed?: boolean }).elbowed === true,
    groupIds: el.groupIds,
  }
}

function verdictName(v: KeyVerdict): string {
  switch (v.kind) {
    case 'lobby':
      return `lobby:${v.action}`
    case 'block':
      return v.preventDefault ? 'block+prevent' : 'block'
    default:
      return v.kind
  }
}
