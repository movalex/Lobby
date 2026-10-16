// OWNER: WS3 (wave S, media comments). What the review viewer's media slots (video, image, PDF bodies and the threads
// list) share: the comments store of the board page, this version's threads, the shared session, who may comment,
// and the spot pins drawn on a picture.
import type { CommentSpot } from '@draftroom/contracts'
import { type CSSProperties, type ReactNode, type RefObject, useLayoutEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { useAssetMeta } from '../../../assets/meta-store.ts'
import { mediaMetaStore } from '../../../file-card/ported/meta.ts'
import { initialsFor, safeColor } from '../../../lib/identity.ts'
import { useValue } from '../../../lib/signals.ts'
import { canCommentIn, controllerFor } from '../../comments/ported/controller.ts'
import { reviewFlags } from '../../review/flags.ts'
import type { ViewerSlotProps } from '../slots.ts'
import { type MediaThread, spotStyle, threadsOfVersion } from './model.ts'
import { type MediaSession, mediaSession, patchSession } from './session.ts'

/** Whether the media comments switch is on for this page (features/review/flags.ts). */
export const mediaCommentsOn = () => reviewFlags().mediaComments

/** The comments store, the session and this version's threads (open ones; resolved too with `resolved`). */
export function useMedia(props: ViewerSlotProps, opts: { resolved?: boolean } = {}) {
  const { ctx, request } = props
  const store = controllerFor(ctx).store
  const session = mediaSession(ctx.registries, request)
  const state = useValue(session)
  const resolved = opts.resolved === true
  // a computed signal: recomputed (a new list) only when the board's threads change
  const threads = useValue(
    'review-viewer-thread-list',
    () => threadsOfVersion(Object.values(store.threads.get()), request, { resolved }),
    [store, request.assetId, request.versionId, resolved],
  )
  const canComment =
    useValue('review-viewer-can-comment', () => store.canComment.get(), [store]) && canCommentIn(ctx)
  const meta = useAssetMeta(mediaMetaStore, ctx.board.id, request.assetId, request.versionId)
  return { store, session, state, threads, canComment, meta }
}

/** Opens the composer at `place` (and picks no thread). */
export function startComment(session: ReturnType<typeof mediaSession>, place: MediaSession['draft']) {
  patchSession(session, { draft: place, selected: null })
}

/** A thread's pin on the picture (the video frame, the image, the PDF page). */
export function SpotPin({
  thread,
  selected,
  onPick,
}: {
  thread: MediaThread
  selected: boolean
  onPick(): void
}) {
  const author = thread.createdBy
  if (!thread.spot) return null
  return (
    <button
      type="button"
      className="dr-rvm-pin"
      data-testid="rv-spot-pin"
      data-thread-id={thread.id}
      data-selected={selected || undefined}
      data-resolved={thread.status === 'resolved' || undefined}
      aria-label={`Comment by ${author.name}`}
      style={{ ...spotStyle(thread.spot), '--pin': safeColor(author.color, author.id) } as CSSProperties}
      onPointerDown={(e) => e.stopPropagation()}
      onClick={(e) => {
        e.stopPropagation()
        onPick()
      }}
    >
      {initialsFor(author.name)}
    </button>
  )
}

/** The new comment's spot, before it is posted. */
export function DraftPin({ spot }: { spot: CommentSpot }) {
  return (
    <span
      className="dr-rvm-pin dr-rvm-pin--draft"
      data-testid="rv-draft-pin"
      style={spotStyle(spot)}
      aria-hidden="true"
    />
  )
}

/** An element's border-box size, kept current (a picture is fitted into it). */
export function useBoxSize(ref: RefObject<HTMLElement | null>): { w: number; h: number } {
  const [size, setSize] = useState({ w: 0, h: 0 })
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    // the border box: scrollbars appearing when zoomed in must not shrink "fit"
    const measure = () => setSize({ w: el.offsetWidth, h: el.offsetHeight })
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [ref])
  return size
}

/** Space kept around a fitted picture in its stage (px each side; .dr-rvm-stage padding). */
export const STAGE_PAD = 12

/**
 * The viewer's dialog stops every key press at itself (ViewerHost.tsx, a native listener, so the board's shortcuts
 * never see one), and React listens above it, on <body> where the dialog is portalled: React's own key handlers
 * inside the dialog would never run (the composer's Enter, the transport's keys). React also listens on a portal's
 * container, so the slots render through a portal into a box of their own inside the dialog: their keys reach React
 * there, and still stop at the dialog.
 */
export function ReactKeys({ children }: { children: ReactNode }) {
  const [host, setHost] = useState<HTMLDivElement | null>(null)
  return (
    <div ref={setHost} className="dr-rvm-keys">
      {host && createPortal(children, host)}
    </div>
  )
}
