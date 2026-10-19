// OWNER: WS5 (wave W, W5-3). The audit log: newest first, 50 at a time with "Load more" (the api pages by id, so rows
// written meanwhile never shift a page), filtered by a kind of action and by a person. Each row shows only what the
// api's allowlist lets through (apps/api/src/features/workspace-admin/audit-view.ts): never a token, a link, a webhook,
// an address or anyone's words.
import type { AdminAuditEvent, AdminMember } from '@draftroom/contracts'
import { useCallback, useEffect, useId, useRef, useState } from 'react'
import { isApiError } from '../../api/client.ts'
import { formatBytes, formatDateTime, formatRelativeTime } from '../../lib/format.ts'
import { boardPath, linkClick } from '../../lib/routing.ts'
import type { AdminApi } from './api.ts'
import { ACTION_FILTERS, actionLabel, detailLabel, detailPairs, detailValue } from './model.ts'
import { errorText, LoadFailed, Loading } from './shared.tsx'

const PAGE = 50

type Phase = 'loading' | 'ready' | 'error'

export function AuditTab({ api, onDenied }: { api: AdminApi; onDenied(): void }) {
  const [action, setAction] = useState('')
  const [actor, setActor] = useState('')
  const [events, setEvents] = useState<AdminAuditEvent[]>([])
  const [next, setNext] = useState<number | null>(null)
  const [phase, setPhase] = useState<Phase>('loading')
  const [message, setMessage] = useState('')
  const [moreBusy, setMoreBusy] = useState(false)
  const [moreError, setMoreError] = useState<string | null>(null)
  const [attempt, setAttempt] = useState(0)
  const [people, setPeople] = useState<AdminMember[]>([])
  const more = useRef<AbortController | null>(null)
  const ids = useId()

  // The people filter's list: the workspace's members (anyone else in the log stays reachable through "Every person").
  useEffect(() => {
    const c = new AbortController()
    api.members(c.signal).then(
      (r) => setPeople(r.members),
      () => undefined,
    )
    return () => c.abort()
  }, [api])

  useEffect(() => {
    void attempt
    const c = new AbortController()
    setPhase('loading')
    setMoreError(null)
    api.audit({ limit: PAGE, ...(action ? { action } : {}), ...(actor ? { actor } : {}) }, c.signal).then(
      (page) => {
        if (c.signal.aborted) return
        setEvents(page.events)
        setNext(page.nextBefore)
        setPhase('ready')
      },
      (e: unknown) => {
        if (c.signal.aborted) return
        if (isApiError(e) && e.kind === 'not-found') return onDenied()
        setMessage(errorText(e, 'Lobby could not load the audit log.'))
        setPhase('error')
      },
    )
    return () => {
      c.abort()
      more.current?.abort()
      more.current = null
      setMoreBusy(false)
    }
  }, [api, action, actor, attempt, onDenied])

  const loadMore = useCallback(async () => {
    if (next === null || moreBusy) return
    const c = new AbortController()
    more.current = c
    setMoreBusy(true)
    setMoreError(null)
    try {
      const page = await api.audit(
        { limit: PAGE, before: next, ...(action ? { action } : {}), ...(actor ? { actor } : {}) },
        c.signal,
      )
      if (c.signal.aborted) return
      setEvents((cur) => [...cur, ...page.events.filter((e) => !cur.some((x) => x.id === e.id))])
      setNext(page.nextBefore)
    } catch (e) {
      if (c.signal.aborted) return
      if (isApiError(e) && e.kind === 'not-found') return onDenied()
      setMoreError(errorText(e, 'Lobby could not load more.'))
    } finally {
      if (more.current === c) {
        more.current = null
        setMoreBusy(false)
      }
    }
  }, [api, next, moreBusy, action, actor, onDenied])

  return (
    <div className="dr-admin__stack">
      <div className="dr-admin__filters" data-testid="admin-audit-filters">
        <label className="dr-admin__filter" htmlFor={`${ids}-action`}>
          <span>Action</span>
          <select
            id={`${ids}-action`}
            className="dr-input dr-select"
            data-testid="admin-audit-action"
            value={action}
            onChange={(e) => setAction(e.target.value)}
          >
            {ACTION_FILTERS.map((f) => (
              <option key={f.value} value={f.value}>
                {f.label}
              </option>
            ))}
          </select>
        </label>
        <label className="dr-admin__filter" htmlFor={`${ids}-actor`}>
          <span>Person</span>
          <select
            id={`${ids}-actor`}
            className="dr-input dr-select"
            data-testid="admin-audit-actor"
            value={actor}
            onChange={(e) => setActor(e.target.value)}
          >
            <option value="">Every person</option>
            {people.map((p) => (
              <option key={p.user.id} value={p.user.id}>
                {p.user.name}
              </option>
            ))}
          </select>
        </label>
      </div>
      {phase === 'loading' && <Loading label="Loading the audit log…" />}
      {phase === 'error' && <LoadFailed message={message} onRetry={() => setAttempt((n) => n + 1)} />}
      {phase === 'ready' && events.length === 0 && (
        <p className="dr-admin__empty dr-muted" data-testid="admin-audit-empty">
          {action || actor ? 'Nothing matches these filters.' : 'Nothing has been recorded yet.'}
        </p>
      )}
      {phase === 'ready' && events.length > 0 && (
        <ol className="dr-admin__list" data-testid="admin-audit-list" aria-label="Audit log, newest first">
          {events.map((e) => (
            <AuditRow key={e.id} event={e} />
          ))}
        </ol>
      )}
      {moreError && (
        <p className="dr-field-error" role="alert">
          {moreError}
        </p>
      )}
      {phase === 'ready' && next !== null && (
        <div className="dr-admin__more">
          <button
            type="button"
            className="dr-btn"
            data-testid="admin-audit-more"
            disabled={moreBusy}
            onClick={() => void loadMore()}
          >
            {moreBusy ? 'Loading…' : 'Load more'}
          </button>
        </div>
      )}
    </div>
  )
}

const FMT = { bytes: formatBytes, date: formatDateTime }

function AuditRow({ event: e }: { event: AdminAuditEvent }) {
  const pairs = detailPairs(e)
  return (
    <li className="dr-admin__row dr-admin__row--audit" data-testid="admin-audit-row" data-action={e.action}>
      <div className="dr-admin__who">
        <span className="dr-admin__name">
          <span data-testid="admin-audit-actor-name">{e.actor ? e.actor.name : 'Lobby'}</span>{' '}
          <span className="dr-admin__what">
            {actionLabel(e.action).replace(/^./, (c) => c.toLowerCase())}
          </span>
        </span>
        <span className="dr-admin__meta dr-muted">
          <time dateTime={e.at} title={formatDateTime(e.at)}>
            {formatRelativeTime(e.at)}
          </time>
          {e.board && (
            <a href={boardPath(e.board.id)} onClick={linkClick(boardPath(e.board.id))}>
              {e.board.title || 'Untitled board'}
            </a>
          )}
        </span>
        {pairs.length > 0 && (
          <dl className="dr-admin__detail" data-testid="admin-audit-detail">
            {pairs.map(([k, v]) => (
              <div key={k} className="dr-admin__pair">
                <dt>{detailLabel(k)}</dt>
                <dd>{detailValue(k, v, FMT)}</dd>
              </div>
            ))}
          </dl>
        )}
      </div>
    </li>
  )
}
