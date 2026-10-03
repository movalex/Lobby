// OWNER: 3c. The comments top-bar item on the Excalidraw board page (the tldraw page's ../CommentsTopBar.tsx):
// the comment tool toggle (C) and the notifications bell with its unread count. Notifications are in-app
// only; the inbox says so.

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
import { BellIcon, CommentIcon } from '../icons.tsx'
import { COMMENT_TOOL_ID, canCommentIn, controllerFor, focusThread, selectCommentTool } from './controller.ts'

export function CommentsTopBar({ ctx }: { ctx: CanvasFeatureContext }) {
  const { canvas } = ctx
  const { store } = controllerFor(ctx)
  const canComment = canCommentIn(ctx)
  useEffect(() => store.setCanComment(canComment), [store, canComment])
  const active = useValue('dr-comments.tool-active', () => canvas.tool() === COMMENT_TOOL_ID, [canvas])
  return (
    <div className="dr-ctopbar">
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
      <NotificationsBell ctx={ctx} />
    </div>
  )
}

const KIND_TEXT: Record<NotificationItem['kind'], string> = {
  mention: 'mentioned you',
  reply: 'replied',
  resolved: 'resolved a thread',
  access_request: 'asked for access',
  new_comment: 'commented', // DANA-02: a new thread on a board you own
  access_granted: 'approved your access request', // PRI-09b
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
    if (n.kind === 'access_request') {
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
              <p className="dr-cbell__empty">
                You’re all caught up. Mentions, replies and new comments on boards you own show up here.
              </p>
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
                        <span>
                          <strong>{n.actor?.name ?? 'Someone'}</strong> {KIND_TEXT[n.kind]}
                          {n.boardId !== ctx.board.id ? ` on ${n.boardTitle}` : ''}
                        </span>
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
            <p className="dr-cbell__note">In-app only: email notifications aren’t available yet.</p>
          </section>,
          document.body,
        )}
    </div>
  )
}
