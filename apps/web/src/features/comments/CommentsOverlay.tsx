// Canvas layer: comment markers (pins) that follow their anchors under pan/zoom and shape moves,
// the hover preview, the new-comment composer and the open thread's popover. Rendered through
// tldraw's EditorPortal (above the canvas, inside the editor container).

import type { CommentThread } from '@draftroom/contracts'
import {
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  useEffect,
  useMemo,
  useRef,
} from 'react'
import { EditorPortal, usePassThroughWheelEvents, useToasts, useValue } from 'tldraw'
import { initialsFor, safeColor } from '../../lib/identity.ts'
import type { FeatureContext } from '../types.ts'
import { Composer } from './Composer.tsx'
import { type CommentToast, canCommentIn, controllerFor, focusBoard } from './controller.ts'
import { anchorPointOnCurrentPage, describeAnchor, keepAnchorAboveSheet } from './geometry.ts'
import { CheckIcon, CloseIcon } from './icons.tsx'
import { PIN_SIZE as PIN, type PopoverLayout, popoverLayout } from './layout.ts'
import { type PinState, pinState, snippet, unreadComments } from './model.ts'
import { pinFaceStyle } from './pin-face.ts'
import { NEW_THREAD_DRAFT } from './store.ts'
import { ThreadView } from './ThreadView.tsx'
import { COMMENT_TOOL_ID } from './tool.ts'

/** Below this zoom level markers are small dots. */
const DOT_ZOOM = 0.25
/** Markers this far outside the viewport are not rendered. */
const CULL = 60

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

/** The open thread's reply box (not an edit box of one of its comments). */
const REPLY_BOX = '.dr-cthread__reply textarea'

/**
 * Keys pressed inside a comment popover are the popover's: tldraw's shortcuts listen on <body>
 * (bubble phase), so a key typed on a popover button (or anywhere but a text field, which tldraw
 * skips itself) would otherwise switch tools, zoom or delete the selection. React's stopPropagation
 * runs at the React root, which sits below <body>, so it is early enough. Esc is left alone: the
 * popover handles it itself and the board may still need to hear it.
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

export function CommentsOverlay({ ctx }: { ctx: FeatureContext }) {
  const { editor } = ctx
  const { store } = controllerFor(ctx)
  const canComment = canCommentIn(ctx)
  useEffect(() => store.setCanComment(canComment), [store, canComment])

  // tldraw handles keys on its container (nudging selected shapes, Esc, …) before React sees them:
  // keystrokes inside our UI are ours alone, except Esc on a marker, which is the board's (tldraw
  // cancels: closes what is open, then leaves the comment tool, and refocuses its container).
  const layer = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const el = layer.current
    if (!el) return
    const mark = (e: KeyboardEvent) => {
      if (e.target === el) return
      if (e.key === 'Escape' && e.target instanceof Element && e.target.closest('.dr-cpins')) {
        // The marker that just opened its thread keeps the focus until the popover takes it on the
        // next frame: an Esc in between closes that thread, as it would inside the popover. (tldraw's
        // cancel only closes threads in the comment tool, so it would leave it open in select.)
        if (e.type === 'keydown' && store.openThreadId.get()) {
          e.preventDefault()
          editor.markEventAsHandled(e)
          store.openThread(null)
          focusBoard(editor)
        }
        return
      }
      editor.markEventAsHandled(e)
    }
    el.addEventListener('keydown', mark)
    el.addEventListener('keyup', mark)
    return () => {
      el.removeEventListener('keydown', mark)
      el.removeEventListener('keyup', mark)
    }
  }, [editor, store])

  // Click-away (outside our UI) closes the open thread, except with the comment tool, which treats
  // that first click itself ("close, then the next click places a new comment").
  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      if (layer.current?.contains(e.target as Node)) return
      if (editor.getCurrentToolId() === COMMENT_TOOL_ID) return
      if (store.openThreadId.get()) store.openThread(null)
    }
    document.addEventListener('pointerdown', onDown, true)
    return () => document.removeEventListener('pointerdown', onDown, true)
  }, [editor, store])

  // A popover that closes on its own (resolve, the last comment deleted, the tool's Esc) takes the
  // keyboard focus with it, which falls back to <body> where tldraw hears neither Esc nor its keys:
  // hand it back to the board. Focus that went somewhere real (the panel, the top bar) stays there.
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
      if (!active || active === document.body) focusBoard(editor)
    })
    return () => cancelAnimationFrame(id)
  }, [anyOpen, editor])

  const pinsKey = useValue('dr-comment-pins', () => {
    if (store.pinsHidden.get()) return '[]'
    const threads = store.threads.get()
    const reads = store.reads.get()
    const showResolved = store.showResolved.get()
    const open = store.openThreadId.get()
    const vp = editor.getViewportScreenBounds()
    const out: PlacedPin[] = []
    for (const t of Object.values(threads)) {
      if (t.status === 'resolved' && !showResolved && t.id !== open) continue
      const pt = anchorPointOnCurrentPage(editor, t.anchor)
      if (!pt) continue
      const s = editor.pageToViewport(pt)
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
  }, [editor, store])
  const pins = useMemo(() => JSON.parse(pinsKey) as PlacedPin[], [pinsKey])
  const pinLayer = useRef<HTMLDivElement>(null)
  usePassThroughWheelEvents(pinLayer)
  // Zoomed far out, full markers would cover the content: they shrink to dots (hover/focus expands).
  const zoomedOut = useValue('dr-comments.zoomed-out', () => editor.getZoomLevel() < DOT_ZOOM, [editor])

  // Toasts with an action (mention → View, resolve → Undo) use tldraw's toasts (inside <Tldraw>).
  const toasts = useToasts()
  useEffect(() => {
    const c = controllerFor(ctx)
    const show = (t: CommentToast) =>
      void toasts.addToast({
        id: t.id,
        title: t.title,
        severity: 'info',
        actions: t.action ? [{ type: 'primary', label: t.action.label, onClick: t.action.run }] : undefined,
      })
    c.toast = show
    return () => {
      if (c.toast === show) c.toast = undefined
    }
  }, [ctx, toasts])

  return (
    <EditorPortal>
      <div className="dr-comments-layer" ref={layer} data-testid="comments-layer">
        <div className="dr-cpins" ref={pinLayer} data-zoomed-out={zoomedOut ? 'true' : 'false'}>
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
                if (anchor) keepAnchorAboveSheet(editor, anchor)
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
        <NewThreadComposer ctx={ctx} />
        <OpenThread ctx={ctx} />
      </div>
    </EditorPortal>
  )
}

function HoverPreview({ ctx, pins }: { ctx: FeatureContext; pins: PlacedPin[] }) {
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
 * Where a popover goes for a page point (layout.ts): next to the marker on wide boards, a bottom
 * sheet on phones. Follows the camera and the viewport size.
 */
function usePopoverPosition(ctx: FeatureContext, pagePoint: { x: number; y: number } | null) {
  const { editor } = ctx
  return useValue('dr-comments.popover-pos', () => {
    const vp = editor.getViewportScreenBounds()
    return popoverLayout(vp, pagePoint ? editor.pageToViewport(pagePoint) : null)
  }, [editor, pagePoint?.x, pagePoint?.y])
}

const popoverStyle = (pos: PopoverLayout): CSSProperties => ({
  left: pos.left,
  width: pos.width,
  ...(pos.top !== null ? { top: pos.top } : {}),
  ...(pos.bottom !== null ? { bottom: pos.bottom } : {}),
  ...(pos.maxHeight !== null ? { maxHeight: pos.maxHeight } : {}),
})

function NewThreadComposer({ ctx }: { ctx: FeatureContext }) {
  const { editor } = ctx
  const { store } = controllerFor(ctx)
  const pending = useValue('dr-comments.pending', () => store.pending.get(), [store])
  const point = useValue(
    'dr-comments.pending-point',
    () => (pending ? anchorPointOnCurrentPage(editor, pending.anchor) : null),
    [editor, pending],
  )
  const where = useValue(
    'dr-comments.pending-where',
    () => (pending ? describeAnchor(editor, pending.anchor) : ''),
    [editor, pending],
  )
  const pos = usePopoverPosition(ctx, point)
  // F10: "Team only" for people on the team (on by default while guests or a client link can open the board).
  const canTeamOnly = useValue('dr-comments.privacy-team', () => store.privacy.get().teamOnly, [store])
  const teamOnly = useValue('dr-comments.new-team-only', () => store.newThreadTeamOnly(), [store])
  if (!pending) return null
  // Keyboard focus goes back to the board, so Esc/C/V keep working after the composer closes.
  const cancel = () => {
    store.cancelNewThread()
    focusBoard(editor)
  }
  const s = point ? editor.pageToViewport(point) : null
  return (
    <>
      {s && (
        <span
          className="dr-cpin dr-cpin--ghost"
          aria-hidden="true"
          style={{ transform: `translate(${Math.round(s.x)}px, ${Math.round(s.y) - PIN}px)` }}
        >
          <span
            className="dr-cpin__face"
            style={pinFaceStyle(safeColor(ctx.me.user.color, ctx.me.user.id), 'unread') as CSSProperties}
          >
            {initialsFor(ctx.me.user.name)}
          </span>
        </span>
      )}
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
              <span>
                {teamOnly ? 'Guests and client links won’t see it' : 'Everyone on the board sees it'}
              </span>
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
            onSubmit={async (draft) => (await store.createThread(pending.anchor, draft)) !== null}
            onCancel={cancel}
          />
        </div>
      </section>
    </>
  )
}

function OpenThread({ ctx }: { ctx: FeatureContext }) {
  const { editor } = ctx
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
    () => (thread ? anchorPointOnCurrentPage(editor, thread.anchor) : null),
    [editor, thread],
  )
  const where = useValue(
    'dr-comments.open-where',
    () => (thread ? describeAnchor(editor, thread.anchor) : ''),
    [editor, thread],
  )
  const pos = usePopoverPosition(ctx, point)
  const opened = useRef<string | null>(null)
  const section = useRef<HTMLElement>(null)
  const shown = !!thread && !hidden
  // Opening a thread (from its marker, a notification, the panel or a deep link) puts the keyboard in
  // its reply box, so what people type is a reply and never a board shortcut. People who cannot
  // reply land on the popover itself. Esc (handled in the composer or here) returns to the board.
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
  // Back to the board (not the marker): tldraw's shortcuts work again at once, and the next Esc
  // leaves the comment tool.
  const close = () => {
    store.openThread(null)
    focusBoard(editor)
  }
  return (
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
      <ThreadView
        store={store}
        thread={thread}
        isOwner={ctx.role === 'owner'}
        locationLabel={where}
        onClose={close}
        autoFocusReply={false}
      />
    </section>
  )
}
