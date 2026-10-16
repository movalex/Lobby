// OWNER: 3c. The comments layer of the Excalidraw board page's overlay root (the tldraw page's
// ../CommentsOverlay.tsx): comment markers (pins) that follow their anchors under pan and zoom and element
// moves, the hover preview, the new-comment composer and the open thread's popover. A `scene` layer
// (docs/EXCALIDRAW-CONTRACTS.md §3): positions come from `canvas.sceneToOverlay`, and the pins and
// popovers take their own clicks (comments.css); the rest of the layer lets the canvas have the pointer.
//
// The popovers (the composer and the open thread; on a phone, the bottom sheet) are drawn in a layer of
// their own in the board's canvas region, above the board's chrome (the host slots: the toolbar, the
// navigation panel, 3i's floating "Board actions"), as the tldraw page drew them above tldraw's panels:
// the overlay root sits under the host slots, so a sheet in it was covered by the tools and the ≡ button
// (W5-07). Beside their marker, popovers also end above the toolbar's row (`toolbarBand`).
//
// Wave S (WS3, the media comments switch: features/review/flags.ts): a thread on another version than its card or
// image shows has no pin (its version keeps it; geometry.ts pinOnCanvas), an image's spot comment is pinned at its
// spot, and the popover of a thread on a video, a PDF or an image opens the review viewer there ("Jump to 00:12.4",
// "Open page 3"), with a "v1" chip (or "Earlier version") when the thread is on another version.

import { type CommentThread, TEAM_ONLY_HINT } from '@draftroom/contracts'
import {
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { createPortal } from 'react-dom'
import type { CanvasFeatureContext } from '../../../canvas/api/index.ts'
import { initialsFor, safeColor } from '../../../lib/identity.ts'
import { useValue } from '../../../lib/signals.ts'
import { toolLock } from '../../canvas-ux/ported/tool-lock.ts'
import { ExternalTag } from '../../people/ExternalTag.tsx'
import { openThreadInViewer, viewerButtonText } from '../../review-viewer/threads/open.ts'
import { useVersionNumbers } from '../../review-viewer/threads/versions.ts'
import { Composer } from '../Composer.tsx'
import { CheckIcon, CloseIcon } from '../icons.tsx'
import { PIN_SIZE as PIN, type PopoverLayout, popoverLayout } from '../layout.ts'
import { type PinState, pinState, snippet, unreadComments, versionChipText } from '../model.ts'
import { pinFaceStyle } from '../pin-face.ts'
import { NEW_THREAD_DRAFT } from '../store.ts'
import { ThreadView } from '../ThreadView.tsx'
import { COMMENT_TOOL_ID, canCommentIn, controllerFor, focusBoard } from './controller.ts'
import {
  canvasSize,
  cornerPinOffset,
  describeAnchor,
  keepAnchorAboveSheet,
  onEarlierVersion,
  pinCornerOf,
  pinOnCanvas,
  pinPoint,
  toolbarBand,
} from './geometry.ts'

/** Below this zoom level markers are small dots. */
const DOT_ZOOM = 0.25
/** Markers this far outside the canvas are not rendered. */
const CULL = 60
/** P-037: the gap between pins side by side on one element's corner (overlay px). */
const PIN_GAP = 4

interface PlacedPin {
  id: string
  x: number
  y: number
  state: PinState
  name: string
  color: string
  authorId: string
  count: number
  preview: string
  open: boolean
}

/**
 * The popovers' layer in the board's canvas region: above the host slots (the toolbar and the navigation
 * panel at 20, the selection bar at 21, the phone sheet's button at 30), below the context menu (40) and
 * the shortcuts dialog (45) (canvas/board/chrome.tsx `SLOT_STYLE`).
 */
const POPOVER_LAYER_Z = 35

/**
 * The popovers' layer (see the header): a box over the board's canvas region (`canvas.container()`) that
 * lets the canvas have the pointer except on the popovers themselves; null until mounted.
 */
function usePopoverLayer(ctx: CanvasFeatureContext): HTMLElement | null {
  const { canvas } = ctx
  const [host, setHost] = useState<HTMLElement | null>(null)
  useLayoutEffect(() => {
    const root = canvas.container()
    if (!root) return
    const el = root.ownerDocument.createElement('div')
    // .dr-comments-layer: inset 0, no pointer, the font, hidden while presenting (comments.css)
    el.className = 'dr-comments-layer dr-comments-popovers'
    el.setAttribute('data-testid', 'comments-popover-layer')
    el.style.zIndex = String(POPOVER_LAYER_Z)
    root.appendChild(el)
    setHost(el)
    return () => {
      el.remove()
      setHost(null)
    }
  }, [canvas])
  return host
}

/** `children` in the popovers' layer (nothing until it is mounted). */
function InPopoverLayer({ host, children }: { host: HTMLElement | null; children: ReactNode }) {
  return host ? createPortal(children, host) : null
}

/** The open thread's reply box (not an edit box of one of its comments). */
const REPLY_BOX = '.dr-cthread__reply textarea'

/**
 * Keys pressed inside a comment popover are the popover's. The board page's key layer never takes keys
 * typed into an overlay's field, and a key on a popover button is not over the canvas; stopping them here
 * also keeps them from the page's own listeners. Esc is left alone: the popover handles it itself.
 */
function keepKeysInPopover(e: ReactKeyboardEvent) {
  if (e.key !== 'Escape') e.stopPropagation()
}

const STATE_LABEL: Record<PinState, string> = {
  unread: 'unread',
  read: 'read',
  resolved: 'resolved',
  mentioned: 'mentions you',
}

export function CommentsOverlay({ ctx }: { ctx: CanvasFeatureContext }) {
  const { canvas } = ctx
  const { store } = controllerFor(ctx)
  const canComment = canCommentIn(ctx)
  useEffect(() => store.setCanComment(canComment), [store, canComment])
  const layer = useRef<HTMLDivElement>(null)
  const popovers = usePopoverLayer(ctx)

  // Esc on a marker is the board's Esc (markers sit above the canvas, so the board's key layer does not
  // hear it): it closes the thread the marker just opened (the popover takes the focus on the next frame),
  // else leaves the comment tool, and the keyboard goes back to the board either way.
  useEffect(() => {
    const el = layer.current
    if (!el) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || !(e.target instanceof Element) || !e.target.closest('.dr-cpins')) return
      e.preventDefault()
      e.stopPropagation()
      if (store.openThreadId.get()) store.openThread(null)
      else if (!store.closeAll() && canvas.tool() === COMMENT_TOOL_ID) canvas.setTool('select')
      focusBoard(canvas)
    }
    el.addEventListener('keydown', onKey)
    return () => el.removeEventListener('keydown', onKey)
  }, [canvas, store])

  // Click-away (outside our UI) closes the open thread, except with the comment tool, which treats that
  // first click itself ("close, then the next click places a new comment").
  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      if (layer.current?.contains(e.target as Node) || popovers?.contains(e.target as Node)) return
      if (canvas.tool() === COMMENT_TOOL_ID) return
      if (store.openThreadId.get()) store.openThread(null)
    }
    document.addEventListener('pointerdown', onDown, true)
    return () => document.removeEventListener('pointerdown', onDown, true)
  }, [canvas, store, popovers])

  // A popover that closes on its own (resolve, the last comment deleted, the tool's Esc) takes the keyboard
  // focus with it, which falls back to <body>: hand it back to the board. Focus that went somewhere real
  // (the panel, the top bar) stays there.
  const anyOpen = useValue(
    'dr-comments.any-open',
    () => store.openThreadId.get() !== null || store.pending.get() !== null,
    [store],
  )
  const wasOpen = useRef(false)
  useEffect(() => {
    const closed = wasOpen.current && !anyOpen
    wasOpen.current = anyOpen
    if (!closed) return
    const id = requestAnimationFrame(() => {
      const active = document.activeElement
      if (!active || active === document.body) focusBoard(canvas)
    })
    return () => cancelAnimationFrame(id)
  }, [anyOpen, canvas])

  const pinsKey = useValue('dr-comment-pins', () => {
    if (store.pinsHidden.get()) return '[]'
    const threads = store.threads.get()
    const reads = store.reads.get()
    const showResolved = store.showResolved.get()
    const open = store.openThreadId.get()
    const vp = canvasSize(canvas)
    const out: PlacedPin[] = []
    // P-037: pins on one element's corner sit side by side along its top edge, oldest first (geometry.ts)
    const onCorner = new Map<string, number>()
    const ordered = Object.values(threads).sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    for (const t of ordered) {
      if (t.status === 'resolved' && !showResolved && t.id !== open) continue
      // wave S: a thread on another version of its file stays with that version (the viewer and the panel list it)
      if (!pinOnCanvas(canvas, t.anchor)) continue
      const pt = pinPoint(canvas, t.anchor, t.spot)
      if (!pt) continue
      const corner = pinCornerOf(canvas, t.anchor)
      const nth = corner ? (onCorner.get(corner.id) ?? 0) : 0
      if (corner) onCorner.set(corner.id, nth + 1)
      const at = canvas.sceneToOverlay(pt)
      const off = corner ? cornerPinOffset(corner.side, nth, PIN, PIN_GAP) : { dx: 0, dy: 0 }
      const s = { x: at.x + off.dx, y: at.y + off.dy }
      if (s.x < -CULL || s.y < -CULL || s.x > vp.w + CULL || s.y > vp.h + CULL) continue
      const first = t.comments[0]
      out.push({
        id: t.id,
        x: Math.round(s.x),
        y: Math.round(s.y),
        state: pinState(t, store.meId, reads[t.id]),
        name: t.createdBy.name,
        color: t.createdBy.color,
        authorId: t.createdBy.id,
        count: t.comments.length,
        preview: first ? snippet(first.body, 80) : '',
        open: t.id === open,
      })
    }
    // Newest on top; the open one above all.
    out.sort((a, b) => Number(a.open) - Number(b.open))
    return JSON.stringify(out)
  }, [canvas, store])
  const pins = useMemo(() => JSON.parse(pinsKey) as PlacedPin[], [pinsKey])
  // Zoomed far out, full markers would cover the content: they shrink to dots (hover/focus expands).
  const zoomedOut = useValue('dr-comments.zoomed-out', () => canvas.viewport.get().zoom < DOT_ZOOM, [canvas])

  return (
    <div className="dr-comments-layer" ref={layer} data-testid="comments-layer">
      <div className="dr-cpins" data-zoomed-out={zoomedOut ? 'true' : 'false'}>
        {pins.map((p) => (
          <button
            key={p.id}
            type="button"
            className="dr-cpin"
            data-testid="comment-pin"
            data-thread-id={p.id}
            data-state={p.state}
            aria-expanded={p.open}
            aria-label={`Comment by ${p.name} (${STATE_LABEL[p.state]}${p.count > 1 ? `, ${p.count} comments` : ''}): ${p.preview}`}
            // Bottom-left corner on the anchor at any size (markers shrink to dots when zoomed out).
            style={{ transform: `translate(${p.x}px, ${p.y}px) translateY(-100%)` }}
            onClick={(e) => {
              e.stopPropagation()
              store.openThread(p.open ? null : p.id)
              const anchor = p.open ? null : store.thread(p.id)?.anchor
              if (anchor) keepAnchorAboveSheet(canvas, anchor)
            }}
            onPointerDown={(e) => e.stopPropagation()}
            onPointerEnter={() => store.hoverThreadId.set(p.id)}
            onPointerLeave={() => store.hoverThreadId.set(null)}
            onFocus={() => store.hoverThreadId.set(p.id)}
            onBlur={() => store.hoverThreadId.set(null)}
          >
            <span
              className="dr-cpin__face"
              style={pinFaceStyle(safeColor(p.color, p.authorId), p.state) as CSSProperties}
            >
              {p.state === 'resolved' ? <CheckIcon size={13} /> : initialsFor(p.name)}
            </span>
            {p.state === 'mentioned' && (
              <span className="dr-cpin__badge dr-cpin__badge--at" aria-hidden="true">
                @
              </span>
            )}
            {p.state === 'unread' && (
              <span className="dr-cpin__badge dr-cpin__badge--dot" aria-hidden="true" />
            )}
            {p.count > 1 && p.state !== 'mentioned' && p.state !== 'unread' && (
              <span className="dr-cpin__badge dr-cpin__badge--count" aria-hidden="true">
                {p.count > 9 ? '9+' : p.count}
              </span>
            )}
          </button>
        ))}
      </div>
      <HoverPreview ctx={ctx} pins={pins} />
      <NewThreadComposer ctx={ctx} host={popovers} />
      <OpenThread ctx={ctx} host={popovers} />
    </div>
  )
}

function HoverPreview({ ctx, pins }: { ctx: CanvasFeatureContext; pins: PlacedPin[] }) {
  const { store } = controllerFor(ctx)
  const hover = useValue('dr-comments.hover', () => store.hoverThreadId.get(), [store])
  const thread = useValue(
    'dr-comments.hover-thread',
    () => (hover ? store.threads.get()[hover] : undefined),
    [store, hover],
  )
  const readAt = useValue('dr-comments.hover-read', () => (hover ? store.reads.get()[hover] : undefined), [
    store,
    hover,
  ])
  const pin = pins.find((p) => p.id === hover)
  if (!thread || !pin || pin.open) return null
  // Unread: the newest comment I have not seen (never one of mine) is what's "New"; otherwise the
  // thread's opening comment.
  const unread =
    pin.state === 'unread' || pin.state === 'mentioned' ? unreadComments(thread, store.meId, readAt) : []
  const latestUnread = unread[unread.length - 1]
  const shown = latestUnread ?? thread.comments[0]
  const replies = thread.comments.length - 1
  return (
    <div
      className="dr-cpreview"
      data-testid="comment-preview"
      role="tooltip"
      style={{ transform: `translate(${pin.x + PIN + 6}px, ${pin.y - PIN}px)` }}
    >
      <div className="dr-cpreview__head">
        <strong>{shown?.author.name ?? thread.createdBy.name}</strong>
        {(shown?.author ?? thread.createdBy).external && <ExternalTag compact />}
        {thread.status === 'resolved' && <span className="dr-cpreview__tag">Resolved</span>}
        {pin.state === 'mentioned' && (
          <span className="dr-cpreview__tag dr-cpreview__tag--at">Mentions you</span>
        )}
        {pin.state === 'unread' && <span className="dr-cpreview__tag dr-cpreview__tag--new">New</span>}
      </div>
      {shown && (
        <p className="dr-cpreview__body" data-comment-id={shown.id}>
          {snippet(shown.body, 160)}
        </p>
      )}
      {replies > 0 && (
        <p className="dr-cpreview__meta">
          {replies} {replies === 1 ? 'reply' : 'replies'}
        </p>
      )}
    </div>
  )
}

/**
 * Where a popover goes for a scene point (layout.ts): next to the marker on wide boards, ending above the
 * toolbar's row, and a bottom sheet on phones. Follows the camera and the canvas size.
 */
function usePopoverPosition(ctx: CanvasFeatureContext, point: { x: number; y: number } | null) {
  const { canvas } = ctx
  return useValue(
    'dr-comments.popover-pos',
    () =>
      popoverLayout(canvasSize(canvas), point ? canvas.sceneToOverlay(point) : null, {
        bottomInset: toolbarBand(canvas),
      }),
    [canvas, point?.x, point?.y],
  )
}

const popoverStyle = (pos: PopoverLayout): CSSProperties => ({
  left: pos.left,
  width: pos.width,
  ...(pos.top !== null ? { top: pos.top } : {}),
  ...(pos.bottom !== null ? { bottom: pos.bottom } : {}),
  ...(pos.maxHeight !== null ? { maxHeight: pos.maxHeight } : {}),
})

function NewThreadComposer({ ctx, host }: { ctx: CanvasFeatureContext; host: HTMLElement | null }) {
  const { canvas } = ctx
  const { store } = controllerFor(ctx)
  const pending = useValue('dr-comments.pending', () => store.pending.get(), [store])
  const point = useValue(
    'dr-comments.pending-point',
    () => (pending ? pinPoint(canvas, pending.anchor, pending.spot) : null),
    [canvas, pending],
  )
  const where = useValue(
    'dr-comments.pending-where',
    () => (pending ? describeAnchor(canvas, pending.anchor) : ''),
    [canvas, pending],
  )
  const pos = usePopoverPosition(ctx, point)
  const ghost = useValue('dr-comments.pending-ghost', () => (point ? canvas.sceneToOverlay(point) : null), [
    canvas,
    point?.x,
    point?.y,
  ])
  // F10: "Team only" for people on the team (on by default while guests or a client link can open the board).
  const canTeamOnly = useValue('dr-comments.privacy-team', () => store.privacy.get().teamOnly, [store])
  const teamOnly = useValue('dr-comments.new-team-only', () => store.newThreadTeamOnly(), [store])
  if (!pending) return null
  // Keyboard focus goes back to the board, so Esc/C/V keep working after the composer closes.
  const cancel = () => {
    store.cancelNewThread()
    focusBoard(canvas)
  }
  // P-014: a posted comment puts the tool back to Select (as Miro does, and as a note or a text does after one
  // placement), so the next click on the board starts nothing; the tool lock (Q) keeps the comment tool
  const post = async (draft: Parameters<typeof store.createThread>[1]) => {
    const thread = await store.createThread(pending.anchor, draft, pending.spot ? { spot: pending.spot } : {})
    if (thread && !toolLock.get() && canvas.tool() === COMMENT_TOOL_ID) canvas.setTool('select')
    return thread !== null
  }
  return (
    <>
      {ghost && (
        <span
          className="dr-cpin dr-cpin--ghost"
          aria-hidden="true"
          style={{ transform: `translate(${Math.round(ghost.x)}px, ${Math.round(ghost.y) - PIN}px)` }}
        >
          <span
            className="dr-cpin__face"
            style={pinFaceStyle(safeColor(ctx.me.user.color, ctx.me.user.id), 'unread') as CSSProperties}
          >
            {initialsFor(ctx.me.user.name)}
          </span>
        </span>
      )}
      <InPopoverLayer host={host}>
        <section
          className={`dr-cpopover${pos.docked ? ' dr-cpopover--docked' : ''}`}
          data-testid="new-comment-popover"
          data-docked={pos.docked ? 'true' : 'false'}
          aria-label="New comment"
          style={popoverStyle(pos)}
          onKeyDown={keepKeysInPopover}
          onKeyUp={keepKeysInPopover}
        >
          <header className="dr-cthread__head">
            <div className="dr-cthread__title">
              <strong>New comment</strong>
              <span className="dr-cthread__where" data-testid="new-comment-where">
                {where}
              </span>
            </div>
            <button
              type="button"
              className="dr-iconbtn dr-iconbtn--sm"
              aria-label="Close (your text is kept as a draft)"
              onClick={cancel}
            >
              <CloseIcon />
            </button>
          </header>
          {canTeamOnly && (
            <label className="dr-cteamtoggle" data-testid="new-comment-team-only-row">
              <input
                type="checkbox"
                role="switch"
                aria-checked={teamOnly}
                data-testid="new-comment-team-only"
                checked={teamOnly}
                onChange={(e) => store.teamOnlyChoice.set(e.target.checked)}
              />
              <span className="dr-cteamtoggle__track" aria-hidden="true" />
              <span className="dr-cteamtoggle__text">
                <strong>Team only</strong>
                <span>{teamOnly ? TEAM_ONLY_HINT : 'Everyone on the board sees it'}</span>
              </span>
            </label>
          )}
          <div className="dr-cthread__reply">
            <Composer
              store={store}
              draftKey={NEW_THREAD_DRAFT}
              label="New comment"
              placeholder="Add a comment… (@ to mention)"
              submitLabel="Post"
              autoFocus
              onSubmit={post}
              onCancel={cancel}
            />
          </div>
        </section>
      </InPopoverLayer>
    </>
  )
}

function OpenThread({ ctx, host }: { ctx: CanvasFeatureContext; host: HTMLElement | null }) {
  const { canvas } = ctx
  const { store } = controllerFor(ctx)
  const openId = useValue('dr-comments.open', () => store.openThreadId.get(), [store])
  const hidden = useValue('dr-comments.hidden', () => store.pinsHidden.get(), [store])
  const thread: CommentThread | undefined = useValue(
    'dr-comments.open-thread',
    () => (openId ? store.threads.get()[openId] : undefined),
    [store, openId],
  )
  const point = useValue(
    'dr-comments.open-point',
    () => (thread ? pinPoint(canvas, thread.anchor, thread.spot) : null),
    [canvas, thread],
  )
  const where = useValue(
    'dr-comments.open-where',
    () => (thread ? describeAnchor(canvas, thread.anchor) : ''),
    [canvas, thread],
  )
  const pos = usePopoverPosition(ctx, point)
  const opened = useRef<string | null>(null)
  const section = useRef<HTMLElement>(null)
  const shown = !!thread && !hidden
  // Opening a thread (from its marker, a notification, the panel or a deep link) puts the keyboard in its
  // reply box, so what people type is a reply and never a board shortcut. People who cannot reply land on
  // the popover itself. Esc (handled in the composer or here) returns to the board.
  useEffect(() => {
    if (!openId) {
      opened.current = null
      return
    }
    if (!shown || opened.current === openId) return
    opened.current = openId
    const id = requestAnimationFrame(() => {
      const el = section.current
      if (!el || el.contains(document.activeElement)) return
      const reply = el.querySelector<HTMLTextAreaElement>(REPLY_BOX)
      if (reply) {
        reply.focus({ preventScroll: true })
        reply.setSelectionRange(reply.value.length, reply.value.length)
      } else el.focus({ preventScroll: true })
    })
    return () => cancelAnimationFrame(id)
  }, [openId, shown])

  if (!thread || hidden) return null
  // Back to the board (not the marker): the board's keys work again at once, and the next Esc leaves the
  // comment tool.
  const close = () => {
    store.openThread(null)
    focusBoard(canvas)
  }
  return (
    <InPopoverLayer host={host}>
      <section
        ref={section}
        tabIndex={-1}
        className={`dr-cpopover${pos.docked ? ' dr-cpopover--docked' : ''}`}
        data-testid="thread-popover"
        data-docked={pos.docked ? 'true' : 'false'}
        data-thread-id={thread.id}
        data-status={thread.status}
        role="dialog"
        aria-label={`Comment thread by ${thread.createdBy.name}`}
        style={popoverStyle(pos)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.preventDefault()
            close()
            return
          }
          keepKeysInPopover(e)
        }}
        onKeyUp={keepKeysInPopover}
      >
        <ViewerLink ctx={ctx} thread={thread} />
        <ThreadView
          store={store}
          thread={thread}
          isOwner={ctx.role === 'owner'}
          locationLabel={where}
          onClose={close}
          autoFocusReply={false}
        />
      </section>
    </InPopoverLayer>
  )
}

/**
 * Wave S (WS3): the open thread's way into the review viewer, for a thread on a video, a PDF or an image (the media
 * comments switch on): "Jump to 00:12.4", "Open page 3" or "Open in viewer", and the version chip ("v1", or "Earlier
 * version" until the version list numbers it) when the thread is on another version than the card shows.
 */
function ViewerLink({ ctx, thread }: { ctx: CanvasFeatureContext; thread: CommentThread }) {
  const { canvas } = ctx
  const { store } = controllerFor(ctx)
  const text = useValue('dr-comments.viewer-link', () => viewerButtonText(ctx, thread.anchor), [
    ctx,
    thread.anchor,
  ])
  const earlier = useValue('dr-comments.earlier-version', () => onEarlierVersion(canvas, thread.anchor), [
    canvas,
    thread.anchor,
  ])
  const numbers = useVersionNumbers(
    ctx.board.id,
    earlier && thread.anchor.kind === 'asset' ? thread.anchor.assetId : null,
  )
  if (!text) return null
  const versionId = thread.anchor.kind === 'asset' ? thread.anchor.versionId : ''
  const open = () => {
    if (openThreadInViewer(ctx, thread.id, thread.anchor)) store.openThread(null)
  }
  return (
    <div className="dr-cthread__viewer" data-testid="thread-viewer-row">
      {earlier && (
        <button type="button" className="dr-cteam" data-testid="thread-version-chip" onClick={open}>
          {versionChipText(numbers.get(versionId))}
        </button>
      )}
      <button type="button" className="dr-btn dr-btn--sm" data-testid="thread-open-viewer" onClick={open}>
        {text}
      </button>
    </div>
  )
}
