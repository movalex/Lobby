// Where the keyboard goes when the control that had it goes away (A11Y-01, A11Y-02). A closed popover,
// a replaced button ("Start vote" → the running vote) or a dismissed panel used to drop the focus on
// <body>: the next Tab restarted from the page top and canvas keys stopped working.

const TABBABLE = [
  'button:not([disabled])',
  'a[href]',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[contenteditable="true"]',
  '[tabindex]',
].join(',')

/** The focus is nowhere useful: on <body>, or on an element that has left the page. */
export function isFocusLost(doc: Document = document): boolean {
  const a = doc.activeElement
  return !a || a === doc.body || a === doc.documentElement || !a.isConnected
}

/** A field that takes typing (input, textarea, select, contenteditable): never pull the focus off it. */
export function isTextEntry(el: Element | null): boolean {
  if (!el || typeof (el as HTMLElement).tagName !== 'string') return false
  const h = el as HTMLElement
  if (h.isContentEditable || h.tagName === 'TEXTAREA' || h.tagName === 'SELECT') return true
  if (h.tagName !== 'INPUT') return false
  const type = (h as HTMLInputElement).type
  return !['checkbox', 'radio', 'range', 'button', 'file', 'reset', 'submit', 'color'].includes(type)
}

function isVisible(el: HTMLElement): boolean {
  return el.getClientRects().length > 0 && !el.closest('[inert], [hidden], [aria-hidden="true"]')
}

/** The first control in `root` that Tab would reach (tabindex >= 0, enabled, rendered). */
export function firstTabbable(root: ParentNode | null | undefined): HTMLElement | null {
  if (!root) return null
  for (const el of root.querySelectorAll<HTMLElement>(TABBABLE)) {
    if (el.tabIndex < 0 || !isVisible(el)) continue
    return el
  }
  return null
}

/** Every control in `root` that Tab would reach, in document order. */
export function tabbables(root: ParentNode | null | undefined): HTMLElement[] {
  if (!root) return []
  return [...root.querySelectorAll<HTMLElement>(TABBABLE)].filter((el) => el.tabIndex >= 0 && isVisible(el))
}

/**
 * A11Y-15: keeps Tab inside a popover. Tab on its last control goes to the first, Shift+Tab on the first
 * to the last; in between the browser moves as usual. True when it placed the focus itself.
 */
export function trapTab(e: KeyboardEvent, root: HTMLElement): boolean {
  if (e.key !== 'Tab' || e.ctrlKey || e.metaKey || e.altKey || e.isComposing) return false
  const items = tabbables(root)
  const active = root.ownerDocument.activeElement as HTMLElement | null
  const at = active ? items.indexOf(active) : -1
  const wrap = items.length === 0 || (e.shiftKey ? at <= 0 : at < 0 || at === items.length - 1)
  if (!wrap) return false
  e.preventDefault()
  const next = e.shiftKey ? items[items.length - 1] : items[0]
  if (next) next.focus({ preventScroll: true })
  return true
}

/**
 * A11Y-15: calls `onLeave` when the keyboard focus moves from inside `root` to somewhere outside it (not
 * when it merely drops to <body>, as it does while the popover re-renders its content). `keep` names
 * outside places that do not count, such as the button that toggles the popover.
 */
export function onFocusLeave(
  root: HTMLElement,
  onLeave: () => void,
  keep?: (el: Element) => boolean,
): () => void {
  const onOut = (e: FocusEvent) => {
    const to = e.relatedTarget
    if (!(to instanceof Element) || root.contains(to) || keep?.(to)) return
    onLeave()
  }
  root.addEventListener('focusout', onOut)
  return () => root.removeEventListener('focusout', onOut)
}

/** Focuses `el` if it can take the focus; true when it now has it. */
export function tryFocus(el: Element | null | undefined): boolean {
  if (!el || !(el as HTMLElement).focus || !el.isConnected) return false
  const h = el as HTMLElement
  if ((h as HTMLButtonElement).disabled || h.closest('[inert]')) return false
  h.focus({ preventScroll: true })
  return h.ownerDocument.activeElement === h
}

/** Places that keep the keyboard inside them: a modal, a dock panel, a popover marked as a scope. */
const SCOPES = 'dialog[open], [role="dialog"], [role="alertdialog"], .dr-dock__panel, [data-focus-scope]'

function ancestors(el: Element): Element[] {
  const out: Element[] = []
  for (let n: Element | null = el; n && out.length < 40; n = n.parentElement) out.push(n)
  return out
}

/**
 * Moves the focus somewhere sensible when it falls to <body> WITHOUT the pointer causing it (a click on
 * empty page chrome is left alone): the nearest control that is still there, inside the same dialog or
 * panel; else into the open modal; else `fallback()` (the board: the canvas). Checked one frame later,
 * so a component that places the focus itself (a dialog handing it back to its opener, a panel focusing
 * its field) wins.
 */
export function installFocusGuard({
  doc = document,
  fallback,
}: {
  doc?: Document
  fallback(): void
}): () => void {
  const win = doc.defaultView ?? window
  let chain: Element[] = []
  let pointerTask = false
  let frame = 0
  const onFocusIn = (e: FocusEvent) => {
    if (e.target instanceof win.Element) chain = ancestors(e.target)
  }
  const onPointerDown = () => {
    pointerTask = true
    win.setTimeout(() => {
      pointerTask = false
    }, 0)
  }
  const recover = (lost: Element[]) => {
    if (!doc.hasFocus() || !isFocusLost(doc)) return
    for (const el of lost) {
      if (!el.isConnected) continue
      const scope = el.closest(SCOPES)
      if (scope && (tryFocus(firstTabbable(el)) || tryFocus(firstTabbable(scope)))) return
      break
    }
    const modals = doc.querySelectorAll('dialog[open]')
    const modal = modals[modals.length - 1]
    if (modal) {
      tryFocus(firstTabbable(modal))
      return
    }
    fallback()
  }
  const onFocusOut = (e: FocusEvent) => {
    if (e.relatedTarget || pointerTask) return
    const lost = chain
    if (frame) win.cancelAnimationFrame(frame)
    frame = win.requestAnimationFrame(() => {
      frame = 0
      recover(lost)
    })
  }
  doc.addEventListener('focusin', onFocusIn, true)
  doc.addEventListener('focusout', onFocusOut, true)
  doc.addEventListener('pointerdown', onPointerDown, true)
  return () => {
    doc.removeEventListener('focusin', onFocusIn, true)
    doc.removeEventListener('focusout', onFocusOut, true)
    doc.removeEventListener('pointerdown', onPointerDown, true)
    if (frame) win.cancelAnimationFrame(frame)
  }
}
