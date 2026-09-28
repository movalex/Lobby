import { type ReactNode, useEffect, useId, useRef } from 'react'

const FIELDS =
  'input:not([type="hidden"]):not([type="checkbox"]):not([type="radio"]):not([disabled]), textarea:not([disabled]), select:not([disabled])'

/** Checkboxes and radio buttons: what a dialog without a text field opens on. */
const CHOICES = 'input[type="checkbox"]:not([disabled]), input[type="radio"]:not([disabled])'

function firstMatch(panel: HTMLElement | null, selector: string): HTMLElement | null {
  if (!panel) return null
  for (const el of panel.querySelectorAll<HTMLElement>(selector)) {
    if (el.closest('.dr-dialog__head')) continue
    if (el.getClientRects().length === 0 || el.tabIndex < 0) continue
    // A radio group is entered on its picked option, as Tab would.
    const radio = el as HTMLInputElement
    if (radio.type === 'radio' && !radio.checked && radio.name) {
      const picked = [...panel.querySelectorAll<HTMLInputElement>('input[type="radio"]:checked')].find(
        (r) => r.name === radio.name,
      )
      if (picked && !picked.disabled) return picked
    }
    return el
  }
  return null
}

/**
 * The first enabled, rendered text field or select below the dialog's header; without one, its first
 * choice (Export's format, for instance: the picked radio). A dialog of buttons only keeps the ×, so a
 * reflex Enter never confirms something.
 */
function firstField(panel: HTMLElement | null): HTMLElement | null {
  return firstMatch(panel, FIELDS) ?? firstMatch(panel, CHOICES)
}

/**
 * A modal built on the native <dialog>: showModal() gives the focus trap, inert background, Escape
 * and top-layer stacking (above the tldraw canvas) for free. Mount it only while open.
 */
export function Dialog({
  title,
  description,
  onClose,
  children,
  testId,
  size = 'md',
}: {
  title: ReactNode
  description?: ReactNode
  onClose(): void
  children: ReactNode
  testId?: string
  size?: 'md' | 'lg'
}) {
  const ref = useRef<HTMLDialogElement>(null)
  const titleId = useId()
  const descId = useId()
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose

  const panelRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const dialog = ref.current
    if (!dialog) return
    // Removing a modal <dialog> from the DOM does not restore focus by itself. A field that focused
    // itself on mount (React's autoFocus runs before this effect) is inside already: keep it.
    const active = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const autoFocused = active && dialog.contains(active) ? active : null
    const opener = autoFocused ? null : active
    if (!dialog.open) dialog.showModal()
    // A11Y-08: showModal() focuses the first control, the header's ×, so a reflex Enter closed the
    // dialog. Start on the field that autofocused, else the first field of the body (search, prompt,
    // title); a dialog without fields keeps the ×.
    const start = autoFocused ?? firstField(panelRef.current)
    if (start) start.focus()
    return () => {
      if (dialog.open) dialog.close()
      // The opener may be gone ("Start a vote…" is replaced by the running vote): then the board's focus
      // guard (ui/focus.ts) places the keyboard.
      if (opener?.isConnected) opener.focus()
    }
  }, [])

  return (
    <dialog
      ref={ref}
      className={`dr-dialog dr-dialog--${size}`}
      data-testid={testId}
      aria-labelledby={titleId}
      aria-describedby={description ? descId : undefined}
      onCancel={(e) => {
        e.preventDefault() // we unmount instead of letting the browser close it
        onCloseRef.current()
      }}
      onPointerDown={(e) => {
        // The dialog element itself is only hit on its backdrop (the panel covers the rest).
        if (e.target === ref.current) onCloseRef.current()
      }}
    >
      <div className="dr-dialog__panel" ref={panelRef}>
        <header className="dr-dialog__head">
          <div>
            <h2 id={titleId} className="dr-dialog__title">
              {title}
            </h2>
            {description && (
              <p id={descId} className="dr-dialog__desc">
                {description}
              </p>
            )}
          </div>
          <button
            type="button"
            className="dr-iconbtn"
            aria-label="Close"
            onClick={() => onCloseRef.current()}
          >
            <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
              <path d="M6 6l12 12M18 6L6 18" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />
            </svg>
          </button>
        </header>
        {children}
      </div>
    </dialog>
  )
}
