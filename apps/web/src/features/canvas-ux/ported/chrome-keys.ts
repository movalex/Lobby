// A11Y2-02 on the Excalidraw canvas: the history keys still act while the keyboard is in Lobby's chrome (the
// top bar, the dock rail and panels, the toolbar and other host slots, nothing at all), as they do on the
// tldraw page (../keyboard-scope.ts CHROME_SAFE_ACTIONS: undo and redo are not board content).
//
// On the canvas the key allowlist (canvas/input/keymap.ts) routes Ctrl/Cmd+Z, Ctrl/Cmd+Shift+Z and Ctrl+Y to
// the board's history; it listens on Excalidraw's own container, so a key pressed anywhere else reached
// nobody. This listener takes those three chords on the document when the key was not for the board
// (the allowlist already had it, or a text field keeps its own native undo), through the canvas history
// API (`canvas.history`, via canvas-ux's undo and redo commands: editors only, and only with a step to
// take). It stands aside, as tldraw's shortcuts do, while a text field, a text editor or one of the menus
// has the keyboard, and while a modal dialog is open (a deliberate difference: tldraw also undid the board
// behind Lobby's own dialogs). The keyboard stays where it was.
import type { CanvasFeatureContext, KeyEventLike } from '../../../canvas/api/index.ts'
import { currentPlatform, matchChord, parseChord } from '../../../canvas/api/index.ts'
import { CMD, runCommand } from './commands.ts'

const UNDO = [parseChord('mod+z')]
const REDO = [parseChord('mod+shift+z'), parseChord('mod+y')]

/** Which history command a key press asks for, or null. */
export function historyChordOf(e: KeyEventLike, platform = currentPlatform()): 'undo' | 'redo' | null {
  if (UNDO.some((c) => matchChord(c, e, platform))) return 'undo'
  if (REDO.some((c) => matchChord(c, e, platform))) return 'redo'
  return null
}

const isTextEntry = (t: EventTarget | null): boolean => {
  if (!t || typeof (t as Element).closest !== 'function') return false
  const el = t as HTMLElement
  if (el.isContentEditable) return true
  const tag = el.tagName
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT'
}

/** A modal dialog is open (the board behind it is inert). */
function modalOpen(doc: Document): boolean {
  try {
    if (doc.querySelector(':modal')) return true
  } catch {
    // no :modal support: fall back to the ARIA flag
  }
  return doc.querySelector('[aria-modal="true"]') !== null
}

/** Whether `target` is the board's own canvas (where the allowlist takes the key itself). */
const onBoardCanvas = (target: EventTarget | null): boolean =>
  !!target &&
  typeof (target as Element).closest === 'function' &&
  !!(target as Element).closest('.excalidraw')

export function installChromeHistoryKeys(ctx: CanvasFeatureContext): () => void {
  const doc = ctx.canvas.container()?.ownerDocument ?? (typeof document === 'undefined' ? null : document)
  if (!doc) return () => {}
  const onKey = (e: KeyboardEvent) => {
    if (e.defaultPrevented || e.isComposing) return
    const which = historyChordOf(e)
    if (!which) return
    if (onBoardCanvas(e.target) || isTextEntry(e.target)) return
    if (ctx.canvas.editingId() !== null || ctx.registries.menusOpen.call() || modalOpen(doc)) return
    e.preventDefault()
    runCommand(ctx, which === 'undo' ? CMD.undo : CMD.redo, 'kbd')
  }
  doc.addEventListener('keydown', onKey)
  return () => doc.removeEventListener('keydown', onKey)
}
