// OWNER: WS3 (wave V, the join card; docs/WAVE-V-CONTRACTS.md §3.3). The QR as an inline <svg> (dark modules on a white
// quiet zone of 4, whatever the theme: a phone camera reads dark-on-light) and the full-screen join card a facilitator
// projects for a room: the QR, the short code in large type, the host to type it at and when it stops working.
//
// Never on the board (a link expires within 24 h, a board outlives it), never a `data:`/`blob:` URL, a canvas or an
// external reference: one <path>, drawn from qr.ts's matrix. The e2e follows the `data-join-url` the QR was made from.
import { useEffect, useId, useMemo, useRef } from 'react'
import { expiresLabel, type JoinTarget } from './model.ts'
import { qrMatrix, qrPath, qrSide } from './qr.ts'
import './join.css'

/** The QR of `text` (M level). `label` is what a screen reader hears instead of the picture. */
export function QrSvg({ text, label, testId = 'join-qr' }: { text: string; label: string; testId?: string }) {
  const { d, side } = useMemo(() => {
    const m = qrMatrix(text, 'M')
    return { d: qrPath(m), side: qrSide(m) }
  }, [text])
  return (
    <svg
      className="dr-join-qr"
      xmlns="http://www.w3.org/2000/svg"
      viewBox={`0 0 ${side} ${side}`}
      role="img"
      aria-label={label}
      shapeRendering="crispEdges"
      data-testid={testId}
      data-join-url={text}
    >
      <rect width={side} height={side} fill="#ffffff" />
      <path d={d} fill="#000000" />
    </svg>
  )
}

/**
 * The join card: a modal <dialog> over the whole window (top layer, above the board and the Share dialog), closed by
 * its button or Escape; the keyboard goes back to whatever opened it.
 */
export function JoinCard({
  target,
  title,
  note,
  onClose,
}: {
  target: JoinTarget
  /** the board's title, as the card's heading says it */
  title: string
  /** a line under the code (e.g. why there is no code) */
  note?: string | null
  onClose(): void
}) {
  const ref = useRef<HTMLDialogElement>(null)
  const headingId = useId()
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose
  useEffect(() => {
    const dialog = ref.current
    if (!dialog) return
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null
    if (!dialog.open) dialog.showModal()
    const cancel = (e: Event) => {
      e.preventDefault()
      onCloseRef.current()
    }
    dialog.addEventListener('cancel', cancel)
    return () => {
      dialog.removeEventListener('cancel', cancel)
      if (dialog.open) dialog.close()
      if (opener?.isConnected) opener.focus()
    }
  }, [])
  const spoken = target.display
    ? `QR code to join. Or go to ${target.host} and enter the code ${target.display}.`
    : `QR code to join ${title}.`
  return (
    <dialog ref={ref} className="dr-join-card" aria-labelledby={headingId} data-testid="join-card">
      <div className="dr-join-card__inner">
        <button
          type="button"
          className="dr-btn dr-join-card__close"
          onClick={() => onCloseRef.current()}
          data-testid="join-card-close"
          aria-label="Close the join card"
        >
          Close
        </button>
        <h2 id={headingId} className="dr-join-card__title">
          Join <span className="dr-join-card__board">{title}</span>
        </h2>
        <QrSvg text={target.qrText} label={spoken} />
        {target.display ? (
          <>
            <p className="dr-join-card__how">
              Scan the code, or go to <strong>{target.host}</strong> and enter
            </p>
            <p className="dr-join-card__code" data-testid="join-card-code">
              {target.display}
            </p>
          </>
        ) : (
          <p className="dr-join-card__how">Scan the code with a phone camera to join.</p>
        )}
        {note && (
          <p className="dr-join-card__note" data-testid="join-card-note">
            {note}
          </p>
        )}
        <p className="dr-join-card__expiry" data-testid="join-card-expiry">
          {expiresLabel(target.expiresAt)}
        </p>
      </div>
    </dialog>
  )
}
