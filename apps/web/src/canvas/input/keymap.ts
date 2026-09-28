// The key allowlist (docs/EXCALIDRAW-MIGRATION.md §2.3.3). Pure: it classifies a key press from its
// fields and a small context; ./CanvasInput.ts applies the verdict in a capture-phase keydown listener on
// the board wrapper, so Excalidraw sees ONLY the keys this file delegates.
//
// Why an allowlist: Excalidraw's own handlers download the board (Ctrl+Shift+S has viewMode: true and no
// predicate, index.js:11608-11651), load files (Ctrl+O), copy the board as PNG (Alt+Shift+C), change an
// element's type in place (Tab, :43960-43977), make flowchart nodes (Ctrl+Arrow) and switch to tools whose
// clicks open the text editor without the lease (T, N, Shift+X; TOOLS at :9934). Its text editor's own
// onkeydown runs actionSaveToActiveFile on Ctrl/Cmd+S (:25388) through executeAction, which skips the
// action's predicate (:23095-23106), so `canvasActions.saveToActiveFile: false` does not stop it.
//
// Type-to-edit semantics follow today's Lobby (features/canvas-ux/keys.ts, COL-04 and A11Y-12): a
// printable key on the one selected note APPENDS, and Enter edits with the caret at the end. The two
// predicates below are copied from there (the canvas layer does not import feature code).

export interface KeyLike {
  key: string
  code?: string
  ctrlKey: boolean
  metaKey: boolean
  altKey: boolean
  shiftKey: boolean
  isComposing?: boolean
  repeat?: boolean
  /** KeyboardEvent.getModifierState('AltGraph'): Windows reports AltGr as Ctrl+Alt. */
  altGraph?: boolean
}

export type LobbyKeyAction =
  | 'tool:note'
  | 'tool:arrow'
  | 'tool:freedraw'
  | 'tool:text'
  | 'tool:rectangle'
  | 'tool:ellipse'
  | 'tool:frame'
  | 'tool:hand'
  | 'tool:comment'
  | 'tool:select'
  | 'tool:eraser'
  | 'tool:laser'
  | 'm'
  | 'search'
  | 'selectAll'
  | 'zoomToFit'
  | 'zoomToSelection'
  | 'zoomReset'
  | 'undo'
  | 'redo'
  | 'editText'
  | 'typeToEdit'
  | 'mindmap'
  | 'page'
  | 'ctrlAltEnter'
  | 'contextMenu'
  | 'a11yTraverse'

export type KeyVerdict =
  /** Let Excalidraw (or its focused text editor) handle it. */
  | { kind: 'delegate' }
  /** Lobby handles it: preventDefault + stopPropagation, then the action. */
  | { kind: 'lobby'; action: LobbyKeyAction }
  /** The editor is open or opening but its lease is pending: keep the key for replay. */
  | { kind: 'buffer' }
  /** Escape while the lease is pending: cancel the open. */
  | { kind: 'cancel' }
  /** Not delegated and not prevented: the browser acts (Tab moves the focus out of the canvas). */
  | { kind: 'browser' }
  /** Nobody acts. `preventDefault` also stops the browser's own default (Save page, Print, Back…). */
  | { kind: 'block'; preventDefault: boolean }

export interface KeyContext {
  /** 'readonly': commenters, viewers and limited guests (they also get Excalidraw's `interaction`). */
  role: 'editor' | 'readonly'
  /**
   * The text editor's state: 'none' (closed), 'granted' (open, this session holds the lease) or
   * 'pending' (open read-only by the guard, or being opened, while the lease is asked for).
   */
  editor: 'none' | 'granted' | 'pending'
  /** The key's target is Excalidraw's text editor (textarea.excalidraw-wysiwyg). */
  inTextEditor: boolean
  /** Exactly one element is selected and it is a text or a text container (P1's target). */
  singleTextTarget: boolean
  /** Exactly one unlocked sticky note is selected (P2's target). */
  singleNote: boolean
  /** The selection is a mind-map node (§4.7). Always false in spike A. */
  inMindMap?: boolean
}

const MODIFIER_KEYS = new Set(['Shift', 'Control', 'Alt', 'Meta', 'AltGraph', 'CapsLock', 'OS', 'Hyper'])
const ARROWS = new Set(['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'])

/** Tool letters Lobby owns (§2.3.3), unmodified. */
export const TOOL_KEYS: Readonly<Record<string, LobbyKeyAction>> = Object.freeze({
  n: 'tool:note',
  l: 'tool:arrow',
  p: 'tool:freedraw',
  t: 'tool:text',
  r: 'tool:rectangle',
  o: 'tool:ellipse',
  f: 'tool:frame',
  h: 'tool:hand',
  c: 'tool:comment',
  v: 'tool:select',
  e: 'tool:eraser',
  k: 'tool:laser',
  m: 'm',
})

/**
 * Browser chords a blocked key must not prevent (reload, tabs, windows, address bar, devtools). Every
 * other blocked chord with Ctrl, Cmd or Alt is prevented, so neither Excalidraw nor the browser acts on
 * Ctrl+S (Save page), Ctrl+P (Print), Ctrl+O (Open file) or Alt+Left (Back).
 */
const BROWSER_CHORDS = new Set([
  'mod+r',
  'mod+shift+r',
  'mod+l',
  'mod+t',
  'mod+shift+t',
  'mod+w',
  'mod+shift+w',
  'mod+n',
  'mod+shift+n',
  'mod+shift+i',
  'mod+shift+j',
  'mod+shift+c',
  'mod+tab',
  'mod+shift+tab',
  'mod+pageup',
  'mod+pagedown',
  'alt+f4',
])

const NOT_TYPING = new Set([' ', '[', ']'])

/** A printable character that starts type-to-edit on a note (copied from canvas-ux/keys.ts, COL-04). */
export function isTypeToEditKey(e: KeyLike): boolean {
  if (e.isComposing) return false
  if (e.metaKey) return false
  if ((e.ctrlKey || e.altKey) && !e.altGraph) return false
  const k = e.key
  if (typeof k !== 'string' || [...k].length !== 1) return false
  if (NOT_TYPING.has(k)) return false
  if (/\p{C}/u.test(k)) return false
  return true
}

/** A key that types one character into a text field, Space included (canvas-ux/keys.ts). */
export function isPrintableKey(e: KeyLike): boolean {
  if (e.isComposing || e.metaKey) return false
  if ((e.ctrlKey || e.altKey) && !e.altGraph) return false
  const k = e.key
  return typeof k === 'string' && [...k].length === 1 && !/\p{C}/u.test(k)
}

/** What the pending buffer keeps (§2.3.3): printable keys, Enter, Backspace, Delete. */
export function isBufferableKey(e: KeyLike): boolean {
  if (isPrintableKey(e)) return true
  if (e.ctrlKey || e.metaKey || e.altKey || e.isComposing) return false
  return e.key === 'Enter' || e.key === 'Backspace' || e.key === 'Delete'
}

/** `mod+shift+s` style name (mod = Ctrl or Cmd). Letters and digits by `code`, so layouts don't matter. */
export function chordOf(e: KeyLike): string {
  const parts: string[] = []
  if (e.ctrlKey || e.metaKey) parts.push('mod')
  if (e.altKey) parts.push('alt')
  if (e.shiftKey) parts.push('shift')
  const code = e.code ?? ''
  let name: string
  if (/^Key[A-Z]$/.test(code)) name = code.slice(3).toLowerCase()
  else if (/^Digit[0-9]$/.test(code)) name = code.slice(5)
  else name = e.key.length === 1 ? e.key.toLowerCase() : e.key.toLowerCase()
  parts.push(name)
  return parts.join('+')
}

const block = (e: KeyLike): KeyVerdict => {
  const modified = e.ctrlKey || e.metaKey || e.altKey
  const fKey = /^F([1-9]|1[0-2])$/.test(e.key)
  return { kind: 'block', preventDefault: modified ? !BROWSER_CHORDS.has(chordOf(e)) : !fKey }
}

const isMod = (e: KeyLike) => e.ctrlKey || e.metaKey
const codeIs = (e: KeyLike, ...codes: string[]) => codes.includes(e.code ?? '')
const letterIs = (e: KeyLike, letter: string) =>
  e.code === `Key${letter.toUpperCase()}` || e.key.toLowerCase() === letter

/** Ctrl/Cmd+S with or without Shift: Excalidraw's save paths (open item 1). */
export function isSaveChord(e: KeyLike): boolean {
  return isMod(e) && !e.altKey && letterIs(e, 's')
}

/** Lobby-owned keys that make sense for every role (navigation, search, menus). */
function lobbyCommon(e: KeyLike): LobbyKeyAction | null {
  const mod = isMod(e)
  if (mod && !e.altKey && !e.shiftKey && letterIs(e, 'f')) return 'search'
  if (mod && !e.altKey && !e.shiftKey && codeIs(e, 'Digit0', 'Numpad0')) return 'zoomReset'
  if (!mod && e.altKey && !e.shiftKey && codeIs(e, 'Digit1')) return 'zoomToFit'
  if (!mod && e.altKey && !e.shiftKey && codeIs(e, 'Digit2')) return 'zoomToSelection'
  if (!mod && !e.altKey && (e.key === 'PageUp' || e.key === 'PageDown')) return 'page'
  if (!mod && !e.altKey && (e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10'))) return 'contextMenu'
  if (!mod && !e.altKey && !e.shiftKey && e.key === 'F6') return 'a11yTraverse'
  if (!mod && e.altKey && !e.shiftKey && ARROWS.has(e.key)) return 'a11yTraverse'
  return null
}

export function classifyKey(e: KeyLike, ctx: KeyContext): KeyVerdict {
  // 1. The editor is open (or opening) but the lease is still pending: buffer, Escape cancels.
  if (ctx.editor === 'pending') {
    if (MODIFIER_KEYS.has(e.key)) return { kind: 'block', preventDefault: false }
    if (e.key === 'Escape') return { kind: 'cancel' }
    if (isBufferableKey(e)) return { kind: 'buffer' }
    return block(e)
  }

  // 2. The text editor has the keyboard and this session holds the lease: everything goes to the
  //    textarea (native typing, native Ctrl+Z / Ctrl+Y, Ctrl+A selects the text), except the save chords.
  if (ctx.editor === 'granted' && ctx.inTextEditor) {
    if (isSaveChord(e)) return { kind: 'block', preventDefault: true }
    if (ctx.inMindMap && (e.key === 'Tab' || (e.key === 'Enter' && !isMod(e) && !e.altKey))) {
      return { kind: 'lobby', action: 'mindmap' }
    }
    return { kind: 'delegate' }
  }

  // A key aimed at a text editor Lobby did not open is a guard case (CanvasInput turns it into
  // 'pending' before calling this); if one gets here anyway, nobody acts.
  if (ctx.inTextEditor) return block(e)

  if (MODIFIER_KEYS.has(e.key)) return { kind: 'delegate' }
  if (e.key === 'Tab' && !isMod(e) && !e.altKey) {
    return ctx.inMindMap ? { kind: 'lobby', action: 'mindmap' } : { kind: 'browser' }
  }

  const common = lobbyCommon(e)
  if (common) return { kind: 'lobby', action: common }

  const mod = isMod(e)

  // 3. Read-only roles: canvas zoom keys only (Excalidraw's `interaction.navigation` handles them).
  if (ctx.role === 'readonly') {
    if (mod && !e.altKey && codeIs(e, 'Equal', 'Minus', 'NumpadAdd', 'NumpadSubtract')) {
      return { kind: 'delegate' }
    }
    if (!mod && !e.altKey && !e.shiftKey) {
      if (letterIs(e, 'v')) return { kind: 'lobby', action: 'tool:select' }
      if (letterIs(e, 'h')) return { kind: 'lobby', action: 'tool:hand' }
      if (letterIs(e, 'c')) return { kind: 'lobby', action: 'tool:comment' }
    }
    return block(e)
  }

  // 4. Editors, no text editor open.
  if (e.key === 'Escape' && !mod && !e.altKey) return { kind: 'delegate' }
  if (ARROWS.has(e.key)) return !mod && !e.altKey ? { kind: 'delegate' } : block(e)
  if ((e.key === 'Delete' || e.key === 'Backspace') && !mod && !e.altKey) return { kind: 'delegate' }
  if (e.key === ' ' && !mod && !e.altKey && !e.shiftKey) return { kind: 'delegate' }
  if (mod && !e.altKey && codeIs(e, 'Equal', 'Minus', 'NumpadAdd', 'NumpadSubtract')) {
    return { kind: 'delegate' }
  }
  if (mod && !e.altKey && !e.shiftKey && letterIs(e, 'd')) return { kind: 'delegate' }
  if (mod && !e.altKey && letterIs(e, 'g')) return { kind: 'delegate' }
  if (mod && !e.altKey && e.shiftKey && letterIs(e, 'l')) return { kind: 'delegate' }
  // z-order: Ctrl+[ ] and Ctrl+Shift+[ ] (Excalidraw uses Cmd+Alt+[ ] for the latter on macOS).
  if (mod && codeIs(e, 'BracketLeft', 'BracketRight') && !(e.altKey && e.shiftKey)) {
    return { kind: 'delegate' }
  }

  if (mod && !e.altKey && !e.shiftKey && letterIs(e, 'z')) return { kind: 'lobby', action: 'undo' }
  if (mod && !e.altKey && e.shiftKey && letterIs(e, 'z')) return { kind: 'lobby', action: 'redo' }
  if (mod && !e.altKey && !e.shiftKey && letterIs(e, 'y')) return { kind: 'lobby', action: 'redo' }
  if (mod && !e.altKey && !e.shiftKey && letterIs(e, 'a')) return { kind: 'lobby', action: 'selectAll' }
  if (mod && e.altKey && !e.shiftKey && e.key === 'Enter') return { kind: 'lobby', action: 'ctrlAltEnter' }

  if (e.key === 'Enter' && !mod && !e.altKey && !e.shiftKey && !e.isComposing) {
    if (ctx.inMindMap) return { kind: 'lobby', action: 'mindmap' }
    return ctx.singleTextTarget ? { kind: 'lobby', action: 'editText' } : block(e)
  }

  if (ctx.singleNote && isTypeToEditKey(e)) return { kind: 'lobby', action: 'typeToEdit' }

  if (!mod && !e.altKey && !e.shiftKey) {
    const name = /^Key[A-Z]$/.test(e.code ?? '') ? (e.code ?? '').slice(3).toLowerCase() : e.key.toLowerCase()
    const tool = TOOL_KEYS[name]
    if (tool) return { kind: 'lobby', action: tool }
  }

  return block(e)
}
