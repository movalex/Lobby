// The key allowlist (docs/EXCALIDRAW-MIGRATION.md §2.3.3). Pure: it classifies a key press from its
// fields and a small context; ./CanvasInput.ts applies the verdict in a capture-phase keydown listener on
// the board wrapper, so Excalidraw sees ONLY the keys this file delegates.
//
// Why an allowlist: Excalidraw's own handlers download the board (Ctrl+Shift+S has viewMode: true and no
// predicate, index.js:11608-11651), load files (Ctrl+O), copy the board as PNG (Alt+Shift+C), change an
// element's type in place (Tab, :43960-43977), make flowchart nodes (Ctrl+Arrow) and switch to tools whose
// clicks open the text editor without the lease (T, N, Shift+X; TOOLS at :9934).
//
// Inside the text editor the rule is an allowlist too (classifyTextEditorKey). The textarea's own
// `onkeydown` (index.js:25367-25409, the whole handler) can trigger, in its order:
//   :25368  zoom in       — actionZoomIn.keyTest (:9593): code Equal|NumpadAdd and (CTRL_OR_CMD or Shift),
//                           guarded by !Shift, so CTRL_OR_CMD+=, Alt ignored
//   :25372  zoom out      — actionZoomOut.keyTest (:9638): Minus|NumpadSubtract, same modifiers
//   :25376  reset zoom    — actionResetZoom.keyTest (:9686): Digit0|Numpad0, same modifiers
//   :25380  font size -   — actionDecreaseFontSize.keyTest (:8326): CTRL_OR_CMD+Shift and key '<' or ','
//                           (writes the label's fontSize), Alt ignored
//   :25382  font size +   — actionIncreaseFontSize.keyTest (:8346): CTRL_OR_CMD+Shift and key '>' or '.'
//   :25384  submit        — key Escape, any modifiers (closes the editor)
//   :25388  save          — actionSaveToActiveFile.keyTest (:11606): key 's', CTRL_OR_CMD, !Shift, Alt
//                           IGNORED; submits, then executeAction, which skips the predicate (:23095-23106):
//                           showSaveFilePicker (the whole board). So Ctrl+Alt+S / Cmd+Alt+S save too.
//   :25392  submit        — key Enter with CTRL_OR_CMD, any other modifiers
//   :25399  indent/outdent — key Tab with ANY modifiers (Shift outdents), or CTRL_OR_CMD+[ / ] by code
// CTRL_OR_CMD is metaKey on macOS and ctrlKey elsewhere, from navigator.platform at load (common :2242,
// :2391). Excalidraw's container onKeyDown then sees what bubbles: for a textarea target it shows a toast
// on CTRL_OR_CMD+P (:43983) and prevents CTRL_OR_CMD+-/= (:43999) before returning (:44005-44011).
//
// Kept (delegated) there: every key without Ctrl, Cmd or Alt (typing, dead keys, IME keys, Enter,
// Shift+Enter, Tab / Shift+Tab indent, Escape submit, caret keys, Backspace, Delete); caret and selection
// moves with modifiers (Alt only on macOS: elsewhere Alt+Left/Right/Home are Back/Forward/Home page);
// Ctrl/Cmd/Alt+Backspace/Delete (word and line deletes); Ctrl/Cmd+Z, Ctrl/Cmd+Shift+Z, Ctrl+Y (native
// undo/redo of the typing); Ctrl/Cmd+A (select the text); Ctrl/Cmd+C, X, V, Shift+V, Ctrl+Insert (the
// clipboard arrives as copy/cut/paste events, where the export policy applies). None of the kept chords
// matches any key test above (the container only notes Ctrl/Cmd+V as a plain-paste flag, :43992). AltGr
// characters (Windows reports AltGr as Ctrl+Alt) and macOS Option characters type through the browser's
// default, but their keydown is stopped. Every other chord with Ctrl, Cmd or Alt is stopped (and
// prevented, except browser chords), whatever the other modifiers.
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
  /** 229 while an IME or a soft keyboard composes ('Process' / 'Unidentified'). */
  keyCode?: number
}

/** The fields of a DOM KeyboardEvent the allowlist reads (a KeyboardEvent has no `altGraph` field). */
export function keyLikeOf(e: KeyboardEvent): KeyLike {
  return {
    key: e.key,
    code: e.code,
    ctrlKey: e.ctrlKey,
    metaKey: e.metaKey,
    altKey: e.altKey,
    shiftKey: e.shiftKey,
    isComposing: e.isComposing,
    repeat: e.repeat,
    altGraph: typeof e.getModifierState === 'function' && e.getModifierState('AltGraph'),
    keyCode: e.keyCode,
  }
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
   * 'pending' (open read-only by the guard, or being opened, while the lease is asked for). For a key
   * aimed at a textarea: 'foreign' when that textarea is not the one Lobby's session owns (an editor
   * Excalidraw opened without a grant, being closed or re-queued by the guard).
   */
  editor: 'none' | 'granted' | 'pending' | 'foreign'
  /** The key's target is Excalidraw's text editor (textarea.excalidraw-wysiwyg). */
  inTextEditor: boolean
  /** macOS (navigator.platform, as Excalidraw decides CTRL_OR_CMD): Option types and moves by word. */
  mac?: boolean
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

/**
 * The letter a chord names: its `key` when that is a Latin letter (the layout's character: the browser's
 * accelerators and editing commands follow it), else its `code` (non-Latin layouts: Ctrl+Я is still
 * Ctrl+Z to the browser, and a dead key or 'Unidentified' names no letter).
 */
function chordLetter(e: KeyLike): string | null {
  if (/^[a-z]$/i.test(e.key)) return e.key.toLowerCase()
  const code = e.code ?? ''
  return /^Key[A-Z]$/.test(code) ? code.slice(3).toLowerCase() : null
}

/**
 * `mod+shift+s` style name (mod = Ctrl or Cmd). Letters by the layout's character (chordLetter: Colemak's
 * Ctrl+T on the physical F key is Ctrl+T to the browser), digits by `code`.
 */
export function chordOf(e: KeyLike): string {
  const parts: string[] = []
  if (e.ctrlKey || e.metaKey) parts.push('mod')
  if (e.altKey) parts.push('alt')
  if (e.shiftKey) parts.push('shift')
  const code = e.code ?? ''
  const letter = chordLetter(e)
  let name: string
  if (letter) name = letter
  else if (/^Digit[0-9]$/.test(code)) name = code.slice(5)
  else name = e.key.toLowerCase()
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
/** A Lobby-owned chord's letter, by the layout's character (chordLetter), never by the physical key alone. */
const letterIs = (e: KeyLike, letter: string) => chordLetter(e) === letter

const CARET_KEYS = new Set([...ARROWS, 'Home', 'End', 'PageUp', 'PageDown'])

// --- Delegation outside the text editor ------------------------------------------------------------
//
// Corrected after the second verifier: Lobby used to pass Ctrl+D, Ctrl+G, Ctrl+Shift+L, Ctrl+= / - and
// Ctrl+[ ] to Excalidraw by physical `code`, while most of Excalidraw's handlers test `key`. On a layout
// that puts S on the physical L key (Bone), Ctrl+Shift+S reports code KeyL and key 'S': Lobby passed it as
// the lock chord and Excalidraw ran saveFileToDisk (a whole-board save picker). German Ctrl+Shift+ß
// (code Minus, key '?') and Dvorak Ctrl+Shift+[ (code BracketLeft, key '?') opened the help dialog.
//
// The rule now: a chord is delegated only when Excalidraw itself would run exactly one delegated action
// for that very event, decided the way its handlers decide (index.js, App.onKeyDown 43923-44030 and
// ActionManager.handleKeyDown 23055-23093):
//   - the key its handlers test is `key` after its CapsLock fix (43925-43939); `code` is read only where
//     the delegated action's own keyTest reads it (zoom: Equal / Minus / Numpad, z-order: brackets). So
//     duplicate, group, ungroup and lock are decided by key, and a dead key or 'Unidentified' never
//     delegates them; zoom and z-order follow the physical key as Excalidraw does, a dead key included;
//   - CTRL_OR_CMD is Excalidraw's (metaKey on macOS, ctrlKey elsewhere, common index.js:2391): on macOS
//     Ctrl+G is not group to Excalidraw (it opens the background popup, 44193-44205), so it is blocked;
//   - no handler that runs before the actions claims the event: help on key '?' with any modifiers
//     (44013), image export (44018), the command-palette toast (43983);
//   - exactly one action's keyTest matches (handleKeyDown gives up on two, 23064-23069) and it is on the
//     plan's delegated list (§2.3.3). Every keyTest in the bundle is transcribed below (46 with a test,
//     `keymap.test.ts` pins the count and the lines against the dist).
// Anything else is blocked (and prevented, except browser chords).

/** Excalidraw's CapsLock fix (App.onKeyDown, index.js:43925-43939): the `key` its handlers compare. */
export function engineKeyOf(e: KeyLike): string {
  const key = typeof e.key === 'string' ? e.key : ''
  if (!e.shiftKey && /^[A-Z]$/.test(key)) return key.toLowerCase()
  if (e.shiftKey && /^[a-z]$/.test(key)) return key.toUpperCase()
  return key
}

/** The Excalidraw actions Lobby delegates outside the text editor (plan §2.3.3, first row). */
export type DelegatedAction =
  | 'duplicateSelection'
  | 'group'
  | 'ungroup'
  | 'toggleElementLock'
  | 'sendBackward'
  | 'bringForward'
  | 'sendToBack'
  | 'bringToFront'
  | 'zoomIn'
  | 'zoomOut'

interface EngineKeyEvent {
  /** `key` after Excalidraw's CapsLock fix. */
  k: string
  code: string
  /** Excalidraw's CTRL_OR_CMD. */
  cmd: boolean
  shift: boolean
  alt: boolean
  mac: boolean
  /** Excalidraw's matchKey (common index.js:2443-2449): the key, or the code for a non-Latin key. */
  z: boolean
  y: boolean
}

const ARROW_KEYS = ARROWS

/**
 * Every Excalidraw action with a keyTest (dist/dev/index.js, the line of each keyTest), as its test reads
 * the event. appState / selection conditions are left out: they only narrow a match (deselect, finalize,
 * lock), so leaving them out can only block more.
 */
const ENGINE_KEY_TESTS: readonly { name: string; line: number; test: (x: EngineKeyEvent) => boolean }[] = [
  {
    name: 'deleteSelectedElements',
    line: 3481,
    test: (x) => (x.k === 'Backspace' || x.k === 'Delete') && !x.cmd,
  },
  { name: 'sendBackward', line: 3537, test: (x) => x.cmd && !x.shift && x.code === 'BracketLeft' },
  { name: 'bringForward', line: 3563, test: (x) => x.cmd && !x.shift && x.code === 'BracketRight' },
  {
    name: 'sendToBack',
    line: 3588,
    test: (x) => (x.mac ? x.cmd && x.alt : x.cmd && x.shift) && x.code === 'BracketLeft',
  },
  {
    name: 'bringToFront',
    line: 3613,
    test: (x) => (x.mac ? x.cmd && x.alt : x.cmd && x.shift) && x.code === 'BracketRight',
  },
  { name: 'selectAll', line: 3672, test: (x) => x.cmd && x.k === 'a' },
  { name: 'duplicateSelection', line: 3763, test: (x) => x.cmd && x.k === 'd' },
  { name: 'decreaseFontSize', line: 8326, test: (x) => x.cmd && x.shift && (x.k === '<' || x.k === ',') },
  { name: 'increaseFontSize', line: 8346, test: (x) => x.cmd && x.shift && (x.k === '>' || x.k === '.') },
  {
    name: 'zoomIn',
    line: 9593,
    test: (x) => (x.code === 'Equal' || x.code === 'NumpadAdd') && (x.cmd || x.shift),
  },
  {
    name: 'zoomOut',
    line: 9638,
    test: (x) => (x.code === 'Minus' || x.code === 'NumpadSubtract') && (x.cmd || x.shift),
  },
  {
    name: 'resetZoom',
    line: 9686,
    test: (x) => (x.code === 'Digit0' || x.code === 'Numpad0') && (x.cmd || x.shift),
  },
  {
    name: 'zoomToFitSelectionInViewport',
    line: 9728,
    test: (x) => x.code === 'Digit2' && x.shift && !x.alt && !x.cmd,
  },
  { name: 'zoomToFitSelection', line: 9761, test: (x) => x.code === 'Digit3' && x.shift && !x.alt && !x.cmd },
  { name: 'zoomToFit', line: 9789, test: (x) => x.code === 'Digit1' && x.shift && !x.alt && !x.cmd },
  { name: 'toggleTheme', line: 9814, test: (x) => !x.cmd && x.alt && x.shift && x.code === 'KeyD' },
  { name: 'finalize', line: 10482, test: (x) => x.k === 'Escape' || x.k === 'Enter' },
  { name: 'deselect', line: 10600, test: (x) => x.k === 'Escape' },
  { name: 'saveToActiveFile', line: 11606, test: (x) => x.k === 's' && x.cmd && !x.shift },
  { name: 'saveFileToDisk', line: 11651, test: (x) => x.k.toLowerCase() === 's' && x.shift && x.cmd },
  { name: 'loadScene', line: 11699, test: (x) => x.cmd && x.k === 'o' },
  { name: 'copyStyles', line: 11797, test: (x) => x.cmd && x.alt && x.code === 'KeyC' },
  { name: 'pasteStyles', line: 11912, test: (x) => x.cmd && x.alt && x.code === 'KeyV' },
  { name: 'help', line: 11940, test: (x) => x.k === '?' },
  { name: 'group', line: 12085, test: (x) => !x.shift && x.cmd && x.k === 'g' },
  { name: 'ungroup', line: 12175, test: (x) => x.shift && x.cmd && x.k === 'G' },
  { name: 'alignTop', line: 12661, test: (x) => x.cmd && x.shift && x.k === 'ArrowUp' },
  { name: 'alignBottom', line: 12693, test: (x) => x.cmd && x.shift && x.k === 'ArrowDown' },
  { name: 'alignLeft', line: 12725, test: (x) => x.cmd && x.shift && x.k === 'ArrowLeft' },
  { name: 'alignRight', line: 12757, test: (x) => x.cmd && x.shift && x.k === 'ArrowRight' },
  { name: 'distributeHorizontally', line: 12880, test: (x) => !x.cmd && x.alt && x.code === 'KeyH' },
  { name: 'distributeVertically', line: 12910, test: (x) => !x.cmd && x.alt && x.code === 'KeyV' },
  { name: 'flipHorizontal', line: 12958, test: (x) => x.shift && x.code === 'KeyH' },
  { name: 'flipVertical', line: 12982, test: (x) => x.shift && x.code === 'KeyV' && !x.cmd },
  { name: 'cut', line: 13153, test: (x) => x.cmd && x.k === 'x' },
  { name: 'copyAsPng', line: 13267, test: (x) => x.code === 'KeyC' && x.alt && x.shift },
  { name: 'gridMode', line: 13324, test: (x) => x.cmd && x.code === 'Quote' },
  { name: 'zenMode', line: 13352, test: (x) => !x.cmd && x.alt && x.code === 'KeyZ' },
  { name: 'objectsSnapMode', line: 13381, test: (x) => !x.cmd && x.alt && x.code === 'KeyS' },
  { name: 'stats', line: 13450, test: (x) => !x.cmd && x.alt && x.code === 'Slash' },
  { name: 'hyperlink', line: 14133, test: (x) => x.cmd && x.k === 'k' },
  {
    name: 'toggleElementLock',
    line: 14251,
    test: (x) => x.k.toLocaleLowerCase() === 'l' && x.cmd && x.shift,
  },
  { name: 'viewMode', line: 18556, test: (x) => !x.cmd && x.alt && x.code === 'KeyR' },
  { name: 'searchMenu', line: 22406, test: (x) => x.cmd && x.k === 'f' },
  { name: 'undo', line: 22832, test: (x) => x.cmd && x.z && !x.shift },
  { name: 'redo', line: 22870, test: (x) => (x.cmd && x.shift && x.z) || (x.cmd && !x.shift && x.y) },
]

/** The transcribed keyTests, name and dist line (keymap.test.ts pins both against the pinned dist). */
export const ENGINE_KEY_TEST_LINES: readonly { name: string; line: number }[] = ENGINE_KEY_TESTS.map(
  ({ name, line }) => ({ name, line }),
)

/** Handlers of App.onKeyDown that run before the action manager and act on a Ctrl/Cmd chord. */
function claimedBeforeActions(x: EngineKeyEvent): string | null {
  if (x.cmd && x.k === 'p' && !x.shift && !x.alt) return 'commandPaletteToast' // 43983
  if (x.k === '?') return 'helpDialog' // 44013, any modifiers
  if (x.k.toLowerCase() === 'e' && x.shift && x.cmd) return 'imageExportDialog' // 44018
  if (x.k === 'PageUp' || x.k === 'PageDown') return 'pageScroll' // 43041
  if (ARROW_KEYS.has(x.k) && ((x.cmd && !x.shift) || x.alt)) return 'flowchart' // 28674-28710
  return null
}

const DELEGATED_ACTIONS: ReadonlySet<string> = new Set<DelegatedAction>([
  'duplicateSelection',
  'group',
  'ungroup',
  'toggleElementLock',
  'sendBackward',
  'bringForward',
  'sendToBack',
  'bringToFront',
  'zoomIn',
  'zoomOut',
])

/** What Excalidraw's container keydown would do with a Ctrl/Cmd chord outside an input (null: nothing). */
export function engineChordAction(e: KeyLike, mac: boolean): string | null {
  const k = engineKeyOf(e)
  const latin = /^[a-z]$/.test(k.toLowerCase())
  const x: EngineKeyEvent = {
    k,
    code: e.code ?? '',
    cmd: mac ? e.metaKey : e.ctrlKey,
    shift: e.shiftKey,
    alt: e.altKey,
    mac,
    z: k.toLowerCase() === 'z' || (!latin && e.code === 'KeyZ'),
    y: k.toLowerCase() === 'y' || (!latin && e.code === 'KeyY'),
  }
  const pre = claimedBeforeActions(x)
  if (pre) return pre
  const matches = ENGINE_KEY_TESTS.filter((t) => t.test(x))
  if (matches.length === 1) return matches[0]?.name ?? null
  return matches.length > 1 ? 'ambiguous' : null
}

/**
 * The delegated action a chord would run in Excalidraw, or null (blocked). Excalidraw's own decision
 * (engineChordAction) with only this on top: the platform's Ctrl/Cmd held and not the other one (the
 * other one is not CTRL_OR_CMD to Excalidraw, and on macOS Ctrl+G opens a popup), no AltGr (Windows
 * reports AltGr as Ctrl+Alt; getModifierState('AltGraph') tells them apart) and no IME. Alt is not
 * narrowed further: where Excalidraw's delegated keyTests ignore Alt, the same delegated action runs.
 */
export function delegatedChord(e: KeyLike, mac: boolean): DelegatedAction | null {
  const cmd = mac ? e.metaKey : e.ctrlKey
  const other = mac ? e.ctrlKey : e.metaKey
  if (!cmd || other || e.altGraph || e.isComposing || e.keyCode === 229) return null
  const action = engineChordAction(e, mac)
  return action && DELEGATED_ACTIONS.has(action) ? (action as DelegatedAction) : null
}

/** One character (or a dead key) the browser types by default: AltGr and macOS Option characters. */
function typesCharacter(e: KeyLike): boolean {
  return e.key === 'Dead' || ([...e.key].length === 1 && !/\p{C}/u.test(e.key))
}

/**
 * A kept text-editing chord inside the granted text editor (Ctrl, Cmd or Alt held). None of these matches
 * a key test of the textarea's handler (see the header), so delegating them runs only the browser's own
 * editing: caret and selection moves, word/line deletes, native undo/redo, select all, clipboard events.
 */
export function isKeptTextEditorChord(e: KeyLike, mac: boolean): boolean {
  if (CARET_KEYS.has(e.key)) return !e.altKey || mac // Alt+Left/Right/Home: Back/Forward/Home page off macOS
  if (e.key === 'Backspace' || e.key === 'Delete') return !e.shiftKey // Ctrl/Alt/Cmd word and line deletes
  if (e.altKey || e.ctrlKey === e.metaKey) return false // exactly one of Ctrl / Cmd, no Alt
  if (e.key === 'Insert') return !e.shiftKey // Ctrl+Insert: copy
  switch (chordLetter(e)) {
    case 'z': // undo, Shift: redo
    case 'v': // paste, Shift: paste as plain text
      return true
    case 'a': // select the text
    case 'c': // copy
    case 'x': // cut
      return !e.shiftKey
    case 'y': // redo (Windows / Linux)
      return e.ctrlKey && !e.shiftKey
    default:
      return false
  }
}

/**
 * Inside the granted text editor (open item 1, corrected after the verifier found Ctrl+Alt+S and
 * Cmd+Alt+S still saving): an allowlist, not a list of save chords.
 */
export function classifyTextEditorKey(e: KeyLike, ctx: Pick<KeyContext, 'inMindMap' | 'mac'>): KeyVerdict {
  const mod = isMod(e)
  if (ctx.inMindMap && (e.key === 'Tab' || (e.key === 'Enter' && !mod && !e.altKey))) {
    return { kind: 'lobby', action: 'mindmap' }
  }
  if (MODIFIER_KEYS.has(e.key)) return { kind: 'delegate' }
  // No Ctrl, Cmd or Alt: the textarea's handler acts only on Escape (submit) and Tab / Shift+Tab (indent),
  // both kept. The rest is the browser's own typing, dead keys, IME keys and caret keys.
  if (!mod && !e.altKey) return { kind: 'delegate' }
  // An IME composing (keyCode 229 'Process'): the browser owns it; Excalidraw does not see it.
  if (e.isComposing || e.keyCode === 229 || e.key === 'Process') return { kind: 'browser' }
  // A character typed with AltGr (Windows: Ctrl+Alt) or macOS Option: the browser types it by default,
  // but its keydown never reaches Excalidraw (AltGr+S on a layout with no AltGr character reports 's').
  if (typesCharacter(e) && (e.altGraph || (ctx.mac && e.altKey && !e.ctrlKey && !e.metaKey))) {
    return { kind: 'browser' }
  }
  if (isKeptTextEditorChord(e, ctx.mac === true)) return { kind: 'delegate' }
  return block(e)
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

  // 2. The text editor has the keyboard and this session holds the lease: the text-editor allowlist
  //    (native typing and editing, native Ctrl+Z / Ctrl+Y, Ctrl+A selects the text, clipboard events).
  if (ctx.editor === 'granted' && ctx.inTextEditor) return classifyTextEditorKey(e, ctx)

  // A key aimed at a text editor Lobby's session does not own ('foreign': an editor Excalidraw opened
  // without a grant, which the guard is closing or re-queuing): nobody acts.
  if (ctx.inTextEditor) {
    if (MODIFIER_KEYS.has(e.key)) return { kind: 'block', preventDefault: false }
    return block(e)
  }

  if (MODIFIER_KEYS.has(e.key)) return { kind: 'delegate' }
  if (e.key === 'Tab' && !isMod(e) && !e.altKey) {
    return ctx.inMindMap ? { kind: 'lobby', action: 'mindmap' } : { kind: 'browser' }
  }

  const common = lobbyCommon(e)
  if (common) return { kind: 'lobby', action: common }

  const mod = isMod(e)

  const delegated = delegatedChord(e, ctx.mac === true)

  // 3. Read-only roles: canvas zoom keys only (Excalidraw's `interaction.navigation` handles them).
  if (ctx.role === 'readonly') {
    if (delegated === 'zoomIn' || delegated === 'zoomOut') return { kind: 'delegate' }
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
  // Ctrl+D, Ctrl+G, Ctrl+Shift+G, Ctrl+Shift+L, Ctrl+[ ], Ctrl+Shift+[ ] (Cmd+Option+[ ] on macOS),
  // Ctrl+= / Ctrl+-: only when Excalidraw would run exactly that action for this event (see above).
  if (delegated) return { kind: 'delegate' }

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
