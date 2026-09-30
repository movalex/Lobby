// The camera keys from the chrome (A11Y2-02; 3i's request to 3b at wave 3). On the tldraw board, history
// and camera keys still act while the keyboard is in Lobby's chrome (features/canvas-ux/keyboard-scope.ts
// CHROME_SAFE_ACTIONS: zoom in/out, on the cursor, 100%, fit, selection, board search), and nothing else
// does. On the Excalidraw page the key registry only sees keys over the canvas (canvas/board/input.ts), so
// the navigation feature listens on the document for these keys while the keyboard is on the board page's
// chrome: the top bar, the dock rail, a panel's heading, a host slot's button, or nowhere. Never inside a
// text field, a menu, a dialog or while a modal is open (they own their keys), and never while the canvas
// has the keyboard (the key registry has the key then).
import {
  type CanvasFeatureContext,
  currentPlatform,
  type KeyEventLike,
  matchChord,
  type ParsedChord,
  parseChord,
} from '../../../../canvas/api/index.ts'

export interface ChromeKey {
  readonly chord: string
  run(ctx: CanvasFeatureContext): void
}

/** Where the keyboard is, as the rule needs it (so it runs without a browser in tests). */
export interface ChromeSpot {
  /** a text field, a content-editable, a select */
  readonly textEntry: boolean
  /** inside a dialog, a menu, a listbox or a focus-keeping popover */
  readonly ownsKeys: boolean
  /** a modal dialog is open */
  readonly modalOpen: boolean
  /** the canvas (or its granted editor) has the keyboard */
  readonly onCanvas: boolean
}

/** Whether a camera key typed at `spot` acts on the board from the chrome. */
export const chromeMayZoom = (s: ChromeSpot): boolean =>
  !s.onCanvas && !s.textEntry && !s.ownsKeys && !s.modalOpen

const OWNS_KEYS =
  '[role="dialog"], [role="alertdialog"], [role="menu"], [role="menubar"], [role="listbox"], [data-focus-scope]'

/** The spot of a key event's target in `doc`. */
export function chromeSpot(target: EventTarget | null, doc: Document, onCanvas: boolean): ChromeSpot {
  const el = target instanceof Element ? target : null
  const textEntry =
    !!el &&
    ((el as HTMLElement).isContentEditable ||
      el instanceof HTMLInputElement ||
      el instanceof HTMLTextAreaElement ||
      el instanceof HTMLSelectElement)
  return {
    textEntry,
    ownsKeys: !!el?.closest(OWNS_KEYS),
    modalOpen: doc.querySelector('dialog[open], [aria-modal="true"]') !== null,
    onCanvas,
  }
}

/** The first key of `keys` this event is (parsed once). */
export function chromeKeyFor(
  keys: readonly (ChromeKey & { readonly parsed: ParsedChord })[],
  e: KeyEventLike,
): ChromeKey | null {
  const platform = currentPlatform()
  return keys.find((k) => matchChord(k.parsed, e, platform)) ?? null
}

/** Listens for `keys` on the document while the keyboard is on the chrome. Returns the unsubscribe. */
export function installChromeKeys(ctx: CanvasFeatureContext, keys: readonly ChromeKey[]): () => void {
  const parsed = keys.map((k) => ({ ...k, parsed: parseChord(k.chord) }))
  const doc = ctx.canvas.container()?.ownerDocument ?? document
  const onKey = (e: KeyboardEvent) => {
    if (e.defaultPrevented || e.isComposing) return
    const key = chromeKeyFor(parsed, e)
    if (!key) return
    if (!chromeMayZoom(chromeSpot(e.target, doc, ctx.canvas.hasKeyboard()))) return
    e.preventDefault()
    key.run(ctx)
  }
  doc.addEventListener('keydown', onKey)
  return () => doc.removeEventListener('keydown', onKey)
}
