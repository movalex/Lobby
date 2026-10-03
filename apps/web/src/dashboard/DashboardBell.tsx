// The dashboard's notifications bell (PRI-05a): the in-board bell's list, deep links and read state,
// without opening a board. Also feeds the "2 new · mentioned you" line on board cards.

import type { ListNotificationsResponse, NotificationItem } from '@draftroom/contracts'
import { type CSSProperties, useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { api } from '../api/client.ts'
import { formatRelativeTime } from '../lib/format.ts'
import { navigate } from '../lib/routing.ts'
import {
  GRANTED_TEXT,
  KIND_TEXT,
  markLocallyRead,
  notificationHref,
  notificationsApi,
  REQUEST_TEXT,
} from './notifications.ts'

const inboxApi = notificationsApi(api)
/** DANA-02: a client's comment should reach an owner sitting on the dashboard within seconds. */
const REFRESH_MS = 15_000

export interface DashboardInbox {
  inbox: ListNotificationsResponse | null
  refresh(): void
  markRead(sel: { ids: string[] } | { all: true }): void
}

/** The caller's notifications: on load, when the tab comes back, and every 15 s while visible. */
export function useDashboardInbox(): DashboardInbox {
  const [inbox, setInbox] = useState<ListNotificationsResponse | null>(null)
  const seq = useRef(0)
  const refresh = useCallback(() => {
    const mine = ++seq.current
    inboxApi.list().then(
      (r) => {
        if (mine === seq.current) setInbox(r)
      },
      () => {}, // keep the last list; the bell just shows no count
    )
  }, [])
  useEffect(() => {
    refresh()
    const onVisible = () => {
      if (document.visibilityState === 'visible') refresh()
    }
    const t = setInterval(onVisible, REFRESH_MS)
    document.addEventListener('visibilitychange', onVisible)
    window.addEventListener('focus', onVisible)
    return () => {
      clearInterval(t)
      document.removeEventListener('visibilitychange', onVisible)
      window.removeEventListener('focus', onVisible)
    }
  }, [refresh])
  const markRead = useCallback(
    (sel: { ids: string[] } | { all: true }) => {
      seq.current++ // a list already on its way predates this
      setInbox((cur) => (cur ? markLocallyRead(cur, sel, new Date().toISOString()) : cur))
      inboxApi.markRead(sel).then(refresh, refresh)
    },
    [refresh],
  )
  return { inbox, refresh, markRead }
}

function BellIcon() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
      <path
        d="M6 16V11a6 6 0 1 1 12 0v5l1.5 2h-15zM10 20.5a2 2 0 0 0 4 0"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinejoin="round"
        strokeLinecap="round"
      />
    </svg>
  )
}

export function DashboardBell({ inbox, refresh, markRead }: DashboardInbox) {
  const [open, setOpen] = useState(false)
  const wrap = useRef<HTMLDivElement>(null)
  const button = useRef<HTMLButtonElement>(null)
  const panel = useRef<HTMLElement>(null)
  const panelId = useId()
  const [place, setPlace] = useState<CSSProperties>({})

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
    refresh()
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node
      if (!wrap.current?.contains(t) && !panel.current?.contains(t)) setOpen(false)
    }
    document.addEventListener('pointerdown', onDown, true)
    return () => document.removeEventListener('pointerdown', onDown, true)
  }, [open, refresh])

  const openItem = (n: NotificationItem) => {
    if (!n.readAt) markRead({ ids: [n.id] })
    setOpen(false)
    navigate(notificationHref(n))
  }

  const count = inbox?.unreadCount ?? 0
  const items = inbox?.notifications ?? []
  return (
    <div className="dr-dbell" ref={wrap}>
      <button
        ref={button}
        type="button"
        className="dr-iconbtn dr-dbell__button"
        data-testid="dashboard-bell"
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
          <span className="dr-dbell__count" data-testid="dashboard-bell-count" aria-hidden="true">
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
            className="dr-dbell__panel"
            aria-label="Notifications"
            data-testid="dashboard-notifications"
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                setOpen(false)
                button.current?.focus()
              }
            }}
          >
            <header className="dr-dbell__head">
              <strong>Notifications</strong>
              <button
                type="button"
                className="dr-linkbtn"
                data-testid="dashboard-notifications-mark-all"
                disabled={count === 0}
                onClick={() => markRead({ all: true })}
              >
                Mark all as read
              </button>
            </header>
            {items.length === 0 ? (
              <p className="dr-dbell__empty">
                You’re all caught up. Mentions, replies and new comments on boards you own show up here.
              </p>
            ) : (
              <ul className="dr-dbell__list">
                {items.map((n) => (
                  <li key={n.id}>
                    <button
                      type="button"
                      className="dr-dbell__item"
                      data-testid="dashboard-notification-item"
                      data-notification-id={n.id}
                      data-board-id={n.boardId}
                      data-kind={n.kind}
                      data-unread={n.readAt ? 'false' : 'true'}
                      onClick={() => openItem(n)}
                    >
                      {!n.readAt && <span className="dr-dbell__dot" aria-hidden="true" />}
                      {!n.readAt && <span className="dr-sr-only">Unread: </span>}
                      <span className="dr-dbell__text">
                        <span>
                          <strong>{n.actor?.name ?? 'Someone'}</strong> {KIND_TEXT[n.kind]} on {n.boardTitle}
                        </span>
                        {n.kind === 'access_request' && n.accessRequest && (
                          <span className="dr-dbell__request">
                            {REQUEST_TEXT[n.accessRequest.role]}
                            {n.accessRequest.status !== 'pending' ? ` · ${n.accessRequest.status}` : ''}
                          </span>
                        )}
                        {n.kind === 'access_granted' && n.accessGranted && (
                          <span className="dr-dbell__request" data-testid="dashboard-notification-granted">
                            {GRANTED_TEXT[n.accessGranted.role]}
                          </span>
                        )}
                        {n.snippet && <span className="dr-dbell__snippet">“{n.snippet}”</span>}
                        <time className="dr-dbell__time" dateTime={n.createdAt}>
                          {formatRelativeTime(n.createdAt)}
                        </time>
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
            <p className="dr-dbell__note">In-app only: email notifications aren’t available yet.</p>
          </section>,
          document.body,
        )}
    </div>
  )
}
