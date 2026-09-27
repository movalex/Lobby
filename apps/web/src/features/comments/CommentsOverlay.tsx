// Canvas layer: comment markers (pins) that follow their anchors under pan/zoom and shape moves,
// the hover preview, the new-comment composer and the open thread's popover. Rendered through
// tldraw's EditorPortal (above the canvas, inside the editor container).

import type { CommentThread } from '@draftroom/contracts'
import { useEffect, useMemo, useRef } from 'react'
import { EditorPortal, usePassThroughWheelEvents, useValue } from 'tldraw'
import { initialsFor, safeColor } from '../../lib/identity.ts'
import type { FeatureContext } from '../types.ts'
import { Composer } from './Composer.tsx'
import { canCommentIn, controllerFor, focusBoard } from './controller.ts'
import { anchorPointOnCurrentPage, placeOnBoard } from './geometry.ts'
import { CheckIcon, CloseIcon } from './icons.tsx'
import { anchorLabel, type PinState, pinState, snippet } from './model.ts'
import { NEW_THREAD_DRAFT } from './store.ts'
import { ThreadView } from './ThreadView.tsx'
import { COMMENT_TOOL_ID } from './tool.ts'

const PIN = 30
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

  return (
    <EditorPortal>
      <div className="dr-comments-layer" ref={layer} data-testid="comments-layer">
        <div className="dr-cpins" ref={pinLayer}>
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
              style={{ transform: `translate(${p.x}px, ${p.y - PIN}px)` }}
              onClick={(e) => {
                e.stopPropagation()
                store.openThread(p.open ? null : p.id)
              }}
              onPointerDown={(e) => e.stopPropagation()}
              onPointerEnter={() => store.hoverThreadId.set(p.id)}
              onPointerLeave={() => store.hoverThreadId.set(null)}
              onFocus={() => store.hoverThreadId.set(p.id)}
              onBlur={() => store.hoverThreadId.set(null)}
            >
              <span
                className="dr-cpin__face"
                style={{ ['--dr-cpin-color' as string]: safeColor(p.color, p.authorId) }}
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
  const pin = pins.find((p) => p.id === hover)
  if (!thread || !pin || pin.open) return null
  const first = thread.comments[0]
  const replies = thread.comments.length - 1
  return (
    <div
      className="dr-cpreview"
      data-testid="comment-preview"
      role="tooltip"
      style={{ transform: `translate(${pin.x + PIN + 6}px, ${pin.y - PIN}px)` }}
    >
      <div className="dr-cpreview__head">
        <strong>{thread.createdBy.name}</strong>
        {thread.status === 'resolved' && <span className="dr-cpreview__tag">Resolved</span>}
        {pin.state === 'mentioned' && (
          <span className="dr-cpreview__tag dr-cpreview__tag--at">Mentions you</span>
        )}
        {pin.state === 'unread' && <span className="dr-cpreview__tag dr-cpreview__tag--new">New</span>}
      </div>
      {first && <p className="dr-cpreview__body">{snippet(first.body, 160)}</p>}
      {replies > 0 && (
        <p className="dr-cpreview__meta">
          {replies} {replies === 1 ? 'reply' : 'replies'}
        </p>
      )}
    </div>
  )
}

/** Where a popover goes for a page point: right of the marker, kept inside the editor viewport. */
function usePopoverPosition(ctx: FeatureContext, pagePoint: { x: number; y: number } | null) {
  const { editor } = ctx
  return useValue('dr-comments.popover-pos', () => {
    const vp = editor.getViewportScreenBounds()
    const width = Math.min(340, vp.w - 24)
    if (!pagePoint) return { left: 12, top: 12, width, docked: true }
    const s = editor.pageToViewport(pagePoint)
    let left = s.x + PIN + 10
    if (left + width > vp.w - 12) left = Math.max(12, s.x - width - 10)
    const top = Math.min(Math.max(12, s.y - PIN - 8), Math.max(12, vp.h - 320))
    return { left: Math.round(left), top: Math.round(top), width, docked: false }
  }, [editor, pagePoint?.x, pagePoint?.y])
}

function NewThreadComposer({ ctx }: { ctx: FeatureContext }) {
  const { editor } = ctx
  const { store } = controllerFor(ctx)
  const pending = useValue('dr-comments.pending', () => store.pending.get(), [store])
  const point = useValue(
    'dr-comments.pending-point',
    () => (pending ? anchorPointOnCurrentPage(editor, pending.anchor) : null),
    [editor, pending],
  )
  const pos = usePopoverPosition(ctx, point)
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
            style={{ background: safeColor(ctx.me.user.color, ctx.me.user.id) }}
          >
            {initialsFor(ctx.me.user.name)}
          </span>
        </span>
      )}
      <section
        className="dr-cpopover"
        data-testid="new-comment-popover"
        aria-label="New comment"
        style={{ left: pos.left, top: pos.top, width: pos.width }}
      >
        <header className="dr-cthread__head">
          <div className="dr-cthread__title">
            <strong>New comment</strong>
            <span className="dr-cthread__where">
              {pending.anchor.kind === 'point' ? 'On the board' : 'Attached to the object you clicked'}
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
    () =>
      thread
        ? anchorLabel(thread.anchor, placeOnBoard(editor, thread.anchor), editor.getCurrentPageId())
        : '',
    [editor, thread],
  )
  const pos = usePopoverPosition(ctx, point)
  const opened = useRef<string | null>(null)
  const section = useRef<HTMLElement>(null)
  // Keyboard users land in the popover; Esc (handled in the composer or here) returns to the board.
  useEffect(() => {
    if (!openId || opened.current === openId) return
    opened.current = openId
    requestAnimationFrame(() => {
      const el = section.current
      if (el && !el.contains(document.activeElement)) el.focus({ preventScroll: true })
    })
  }, [openId])
  useEffect(() => {
    if (!openId) opened.current = null
  }, [openId])

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
      data-thread-id={thread.id}
      data-status={thread.status}
      role="dialog"
      aria-label={`Comment thread by ${thread.createdBy.name}`}
      style={{ left: pos.left, top: pos.top, width: pos.width }}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.preventDefault()
          close()
        }
      }}
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
