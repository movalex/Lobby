// OWNER: the wave S foundation (the lead). The review viewer's shell (docs/WAVE-S-CONTRACTS.md §4.2): one modal
// <dialog> per file, portalled to <body> like the PDF viewer (file-card/ported/PdfViewer.tsx): a header (the file's
// name, the `header` slot, close), the body (`body` per kind, or `compare` in compare mode) and the side list
// (`threads`). It holds no feature of its own: WS1, WS2 and WS3 fill the slots (./slots.ts) from their folders.
//
// Mounted once per board page by the media feature (file-card/ported/index.tsx, a screen overlay). It renders nothing
// while the viewer's switches are off (features/review/flags.ts reviewViewerEnabled) or nothing asked for it, and it
// closes when its element is deleted (here or by someone else). Keys pressed in it stop at the dialog: the board's
// shortcuts and Excalidraw never see them (as in the PDF viewer); a key that lands outside it while it is open is
// handed to it. Escape and a click on the backdrop close it.
import { type ReactNode, useEffect, useId, useRef } from 'react'
import { createPortal } from 'react-dom'
import type { CanvasFeatureContext } from '../../canvas/api/index.ts'
import { factsOf } from '../../file-card/ported/model.ts'
import { useValue } from '../../lib/signals.ts'
import { reviewFlags, reviewViewerEnabled } from '../review/flags.ts'
import { type ViewerFileKind, type ViewerSlotName, type ViewerSlotProps, viewerSlotEntries } from './slots.ts'
import { closeReviewViewer, type ReviewViewerRequest, reviewViewerRequest } from './viewer-state.ts'
import './review-viewer.css'

/** The second click of a double-click that opened the viewer must not close it on the backdrop. */
const BACKDROP_GRACE_MS = 500

/** Which slots the viewer shows for a request: the body or, in compare mode, the compare slot. */
export function viewerLayout(request: Pick<ReviewViewerRequest, 'mode'>): readonly ViewerSlotName[] {
  return request.mode === 'compare' ? ['header', 'compare', 'threads'] : ['header', 'body', 'threads']
}

/** Shown in the body while no workstream fills it for this kind (never reached with the switches off). */
export const VIEWER_EMPTY_TEXT = 'Nothing to show for this file here yet.'

export function ReviewViewerHost({ ctx }: { ctx: CanvasFeatureContext }) {
  const request = useValue('review-viewer-request', () => reviewViewerRequest(ctx.registries).get(), [ctx])
  const file = useValue('review-viewer-file', () => {
    if (!request) return null
    const el = ctx.canvas.get(request.elementId)
    const facts = el && !el.isDeleted ? factsOf(el) : null
    return facts && facts.assetId === request.assetId
      ? { kind: facts.kind, name: facts.name, mimeType: facts.mimeType }
      : null
  }, [ctx, request])
  // The element was deleted (or now shows another deliverable) while its viewer was open.
  useEffect(() => {
    if (request && !file) closeReviewViewer(ctx.registries)
  }, [ctx, request, file])
  if (!request || !file || !reviewViewerEnabled(reviewFlags())) return null
  const close = () => closeReviewViewer(ctx.registries)
  return createPortal(
    <ReviewViewer key={request.nonce} props={{ ctx, request, file, close }} />,
    document.body,
  )
}

function Slot({ name, props }: { name: ViewerSlotName; props: ViewerSlotProps }) {
  const entries = viewerSlotEntries(name, props.file.kind as ViewerFileKind)
  if (!entries.length) return name === 'body' ? <p className="dr-rv__empty">{VIEWER_EMPTY_TEXT}</p> : null
  return (
    <>
      {entries.map(({ id, Component }) => (
        <Component key={id} {...props} />
      ))}
    </>
  )
}

function ReviewViewer({ props }: { props: ViewerSlotProps }) {
  const titleId = useId()
  const layout = viewerLayout(props.request)
  const main = layout[1] ?? 'body'
  return (
    <ViewerDialog labelledBy={titleId} onClose={props.close}>
      <header className="dr-rv__head">
        <h2 className="dr-rv__title" id={titleId}>
          {props.file.name || 'File'}
        </h2>
        <div className="dr-rv__header-slot" data-slot="header">
          <Slot name="header" props={props} />
        </div>
        <button
          type="button"
          className="dr-rv__close"
          data-testid="review-viewer-close"
          aria-label="Close"
          onClick={props.close}
        >
          ×
        </button>
      </header>
      <div className="dr-rv__main">
        <section className="dr-rv__body" data-slot={main}>
          <Slot name={main} props={props} />
        </section>
        <aside className="dr-rv__threads" data-slot="threads">
          <Slot name="threads" props={props} />
        </aside>
      </div>
    </ViewerDialog>
  )
}

function ViewerDialog({
  labelledBy,
  onClose,
  children,
}: {
  labelledBy: string
  onClose(): void
  children: ReactNode
}) {
  const ref = useRef<HTMLDialogElement>(null)
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose
  const openedAt = useRef(0)

  useEffect(() => {
    const dialog = ref.current
    if (!dialog) return
    openedAt.current = performance.now()
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null
    if (!dialog.open) dialog.showModal()
    // Native listeners: the board's shortcuts listen on <body> and the document, so presses in here stop at the
    // dialog (the slots handle their own keys with React handlers inside it).
    const keydown = (e: KeyboardEvent) => e.stopPropagation()
    // A press that lands outside the dialog while it is open (focus fell onto <body>) is never the board's.
    const outside = (e: KeyboardEvent) => {
      if (e.target instanceof Node && dialog.contains(e.target)) return
      e.stopPropagation()
      dialog.focus({ preventScroll: true })
    }
    dialog.addEventListener('keydown', keydown)
    window.addEventListener('keydown', outside, true)
    return () => {
      dialog.removeEventListener('keydown', keydown)
      window.removeEventListener('keydown', outside, true)
      if (dialog.open) dialog.close()
      if (opener?.isConnected) opener.focus({ preventScroll: true })
    }
  }, [])

  return (
    <dialog
      ref={ref}
      className="dr-rv"
      data-testid="review-viewer"
      tabIndex={-1}
      aria-labelledby={labelledBy}
      onCancel={(e) => {
        e.preventDefault() // we unmount instead of letting the browser close it
        onCloseRef.current()
      }}
      onPointerDown={(e) => {
        if (e.target === ref.current && performance.now() - openedAt.current > BACKDROP_GRACE_MS) {
          onCloseRef.current()
        }
      }}
    >
      <div className="dr-rv__panel">{children}</div>
    </dialog>
  )
}

/** Test seam: the modal without the portal and the dialog's showModal (react-dom/server renders it as markup). */
export function ReviewViewerMarkup({ props }: { props: ViewerSlotProps }) {
  return <ReviewViewer props={props} />
}
