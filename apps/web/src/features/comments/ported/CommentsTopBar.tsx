// OWNER: 3c. The comments top-bar item on the Excalidraw board page (the tldraw page's ../CommentsTopBar.tsx):
// the comment tool toggle (C) and the notifications bell with its unread count. Notifications are in-app.

import type {
  NotificationAccessGranted,
  NotificationAccessRequest,
  NotificationItem,
} from '@draftroom/contracts'
import { type CSSProperties, useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { CanvasFeatureContext } from '../../../canvas/api/index.ts'
import { formatRelativeTime } from '../../../lib/format.ts'
import { boardPath, navigate } from '../../../lib/routing.ts'
import { useValue } from '../../../lib/signals.ts'
import { onFocusLeave } from '../../../ui/focus.ts'
import { useTopBarWidth } from '../../../ui/useMedia.ts'
import { ExternalTag } from '../../people/ExternalTag.tsx'
import { OUTSIDER_JOINED_KIND_TEXT, outsiderJoinedText } from '../../people/outside.ts'
import { BELL_EMPTY, BELL_NOTE } from '../copy.ts'
import { BellIcon, CommentIcon } from '../icons.tsx'
import { COMMENT_TOOL_ID, canCommentIn, controllerFor, focusThread, selectCommentTool } from './controller.ts'

/**
 * The comments' part of the bar: the notifications bell. K2-5 (UXD-01): the comment tool left the bar (the
 * toolbar's Comment, C, the rail's Comments and the context menu's Comment stay), and on a phone the bell and
 * the comment tool are in the "⋯" menu (`CommentsMenuItem`); the bar then keeps only an unread count.
 */
export function CommentsTopBar({ ctx }: { ctx: CanvasFeatureContext }) {
  const { store } = controllerFor(ctx)
  const canComment = canCommentIn(ctx)
  useEffect(() => store.setCanComment(canComment), [store, canComment])
  const phone = useTopBarWidth() === 'phone'
  if (phone) return <UnreadCount ctx={ctx} />
  return (
    <div className="dr-ctopbar">
      <NotificationsBell ctx={ctx} />
    </div>
  )
}

/** K2-5: on a phone, the "⋯" menu's comments row: the comment tool and the bell (nothing on wider screens). */
export function CommentsMenuItem({ ctx }: { ctx: CanvasFeatureContext }) {
  const phone = useTopBarWidth() === 'phone'
  if (!phone) return null
  return (
    <div className="dr-ctopbar">
      <CommentToolButton ctx={ctx} />
      <NotificationsBell ctx={ctx} />
    </div>
  )
}

/** K2-5: on a phone the bell is in "⋯": the bar keeps its unread count (not a control). */
function UnreadCount({ ctx }: { ctx: CanvasFeatureContext }) {
  const { store } = controllerFor(ctx)
  const count = useValue('dr-comments.unread', () => store.notifications.get().unreadCount, [store])
  if (!count) return null
  return (
    <span className="dr-cbell" data-testid="notifications-bar-count">
      <span
        className="dr-cbell__count"
        style={{ position: 'static', display: 'inline-block' }}
        aria-hidden="true"
      >
        {count > 99 ? '99+' : count}
      </span>
      <span className="dr-sr-only">
        {count === 1 ? '1 unread notification' : `${count} unread notifications`} in More board controls
      </span>
    </span>
  )
}

/** The comment tool's toggle (C), in the phone's "⋯" menu (K2-5). */
function CommentToolButton({ ctx }: { ctx: CanvasFeatureContext }) {
  const { canvas } = ctx
  const canComment = canCommentIn(ctx)
  const active = useValue('dr-comments.tool-active', () => canvas.tool() === COMMENT_TOOL_ID, [canvas])
  return (
    <button
      type="button"
      className="dr-iconbtn dr-ctopbar__tool"
      data-testid="comment-tool"
      aria-pressed={active}
      aria-disabled={!canComment}
      title={
        canComment
          ? active
            ? 'Comment tool is on: click an object or the board, or press Enter to comment on the selected object (the middle of the view when nothing is selected). Esc to stop.'
            : 'Comment (C): click an object or the board, or press Enter to comment on the selection'
          : 'You can read comments here but not add them'
      }
      aria-label="Comment tool"
      onClick={() => {
        if (active) canvas.setTool('select')
        else selectCommentTool(ctx)
      }}
    >
      <CommentIcon />
    </button>
  )
}

const KIND_TEXT: Record<NotificationItem['kind'], string> = {
  mention: 'mentioned you',
  reply: 'replied',
  resolved: 'resolved a thread',
  access_request: 'asked for access',
  new_comment: 'commented', // DANA-02: a new thread on a board you own
  access_granted: 'approved your access request', // PRI-09b
  outsider_joined: OUTSIDER_JOINED_KIND_TEXT, // wave J (rendered with the name's External tag)
  review_status: 'updated a review', // wave S (rev 3; WS1 words it from item.review)
}

const REQUEST_TEXT: Record<NotificationAccessRequest['role'], string> = {
  editor: 'Wants to edit',
  commenter: 'Wants to comment',
  viewer: 'Wants to view',
}

/** PRI-09b: what the approved request gave. */
const GRANTED_TEXT: Record<NotificationAccessGranted['role'], string> = {
  editor: 'You can edit it now',
  commenter: 'You can comment on it now',
  viewer: 'You can view it now',
}

function NotificationsBell({ ctx }: { ctx: CanvasFeatureContext }) {
  const { store } = controllerFor(ctx)
  const [open, setOpen] = useState(false)
  const inbox = useValue('dr-comments.notifications', () => store.notifications.get(), [store])
  const wrap = useRef<HTMLDivElement>(null)
  const button = useRef<HTMLButtonElement>(null)
  const panel = useRef<HTMLElement>(null)
  const panelId = useId()
  const [place, setPlace] = useState<CSSProperties>({})

  // The top bar is its own stacking context, so the inbox is portaled to <body> and positioned under the
  // bell.
  useLayoutEffect(() => {
    if (!open) return
    const update = () => {
      const r = button.current?.getBoundingClientRect()
      if (r)
        setPlace({
          top: Math.round(r.bottom + 8),
          right: Math.max(8, Math.round(window.innerWidth - r.right)),
        })
    }
    update()
    window.addEventListener('resize', update)
    panel.current?.focus()
    return () => window.removeEventListener('resize', update)
  }, [open])

  useEffect(() => {
    if (!open) return
    void store.refreshNotifications()
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node
      if (!wrap.current?.contains(t) && !panel.current?.contains(t)) setOpen(false)
    }
    document.addEventListener('pointerdown', onDown, true)
    // A11Y2-05: the keyboard leaving the inbox (Tab past its end, a dialog opening) closes it.
    const off = panel.current
      ? onFocusLeave(
          panel.current,
          () => setOpen(false),
          (to) => wrap.current?.contains(to) === true,
        )
      : () => {}
    return () => {
      document.removeEventListener('pointerdown', onDown, true)
      off()
    }
  }, [open, store])

  const openItem = (n: NotificationItem) => {
    if (!n.readAt) void store.markNotificationsRead({ ids: [n.id] })
    setOpen(false)
    if (n.boardId !== ctx.board.id) {
      navigate(
        n.threadId
          ? `${boardPath(n.boardId)}?thread=${encodeURIComponent(n.threadId)}`
          : boardPath(n.boardId),
      )
      return
    }
    if (n.kind === 'access_request' || n.kind === 'outsider_joined') {
      window.dispatchEvent(new CustomEvent('draftroom:open-share'))
      return
    }
    if (n.threadId && !focusThread(ctx, n.threadId)) {
      ctx.notify({ key: 'comments:gone', text: 'That comment was deleted.', testId: 'comments-gone' })
    }
  }

  const count = inbox.unreadCount
  return (
    <div className="dr-cbell" ref={wrap}>
      <button
        ref={button}
        type="button"
        className="dr-iconbtn dr-cbell__button"
        data-testid="notifications-bell"
        data-unread={count}
        // the words the "⋯" menu shows beside its icon (styles.css): its count stays the badge, said once
        data-label="Notifications"
        aria-label={count ? `Notifications, ${count} unread` : 'Notifications'}
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        onClick={() => setOpen((o) => !o)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') setOpen(false)
        }}
      >
        <BellIcon />
        {count > 0 && (
          <span className="dr-cbell__count" data-testid="notifications-count" aria-hidden="true">
            {count > 99 ? '99+' : count}
          </span>
        )}
      </button>
      {open &&
        createPortal(
          <section
            ref={panel}
            tabIndex={-1}
            style={place}
            id={panelId}
            className="dr-cbell__panel"
            aria-label="Notifications"
            data-testid="notifications-panel"
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                setOpen(false)
                button.current?.focus()
              }
            }}
          >
            <header className="dr-cbell__head">
              <strong>Notifications</strong>
              <button
                type="button"
                className="dr-linkbtn"
                data-testid="notifications-mark-all"
                disabled={count === 0}
                onClick={() => void store.markNotificationsRead({ all: true })}
              >
                Mark all as read
              </button>
            </header>
            {inbox.notifications.length === 0 ? (
              <p className="dr-cbell__empty">{BELL_EMPTY}</p>
            ) : (
              <ul className="dr-cbell__list">
                {inbox.notifications.map((n) => (
                  <li key={n.id}>
                    <button
                      type="button"
                      className="dr-cbell__item"
                      data-testid="notification-item"
                      data-notification-id={n.id}
                      data-kind={n.kind}
                      data-unread={n.readAt ? 'false' : 'true'}
                      onClick={() => openItem(n)}
                    >
                      {!n.readAt && <span className="dr-cbell__dot" aria-hidden="true" />}
                      {!n.readAt && <span className="dr-sr-only">Unread: </span>}
                      <span className="dr-cbell__text">
                        {n.kind === 'outsider_joined' ? (
                          <span data-testid="notification-outsider">
                            <strong>{n.actor?.name ?? 'Someone'}</strong>
                            <ExternalTag domain={n.outsiderJoined?.emailDomain ?? null} />{' '}
                            {outsiderJoinedText(n, n.boardId === ctx.board.id)}
                          </span>
                        ) : (
                          <span>
                            <strong>{n.actor?.name ?? 'Someone'}</strong> {KIND_TEXT[n.kind]}
                            {n.boardId !== ctx.board.id ? ` on ${n.boardTitle}` : ''}
                          </span>
                        )}
                        {n.kind === 'access_request' && n.accessRequest && (
                          <span className="dr-cbell__request" data-testid="notification-request">
                            {REQUEST_TEXT[n.accessRequest.role]}
                            {n.accessRequest.status !== 'pending' ? ` · ${n.accessRequest.status}` : ''}
                            {n.accessRequest.message && (
                              <span className="dr-cbell__snippet">“{n.accessRequest.message}”</span>
                            )}
                          </span>
                        )}
                        {n.kind === 'access_granted' && n.accessGranted && (
                          <span className="dr-cbell__request" data-testid="notification-granted">
                            {GRANTED_TEXT[n.accessGranted.role]}
                          </span>
                        )}
                        {n.snippet && <span className="dr-cbell__snippet">“{n.snippet}”</span>}
                        <time className="dr-cbell__time" dateTime={n.createdAt}>
                          {formatRelativeTime(n.createdAt)}
                        </time>
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
            <p className="dr-cbell__note" data-testid="notifications-note">
              {BELL_NOTE}
            </p>
          </section>,
          document.body,
        )}
    </div>
  )
}
