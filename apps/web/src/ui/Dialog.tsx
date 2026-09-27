import { type ReactNode, useEffect, useId, useRef } from 'react'

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

  useEffect(() => {
    const dialog = ref.current
    if (!dialog) return
    // Removing a modal <dialog> from the DOM does not restore focus by itself.
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null
    if (!dialog.open) dialog.showModal()
    return () => {
      if (dialog.open) dialog.close()
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
      <div className="dr-dialog__panel">
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
