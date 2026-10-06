// The feedback inbox (wave J5), at /feedback: for the people in DRAFTROOM_FEEDBACK_ADMINS only. The api decides
// (a 404 for everybody else, guests included), so this page shows the same "Page not found" screen a mistyped
// address does: nothing says the inbox exists. Newest first, Open / Done / All, mark done or reopen, load more.
// Every message is plain text, shown as text (line breaks kept, never rendered as markup).
import type { FeedbackItem, FeedbackStatus } from '@draftroom/contracts'
import { useCallback, useEffect, useRef, useState } from 'react'
import { isApiError } from '../../api/client.ts'
import { Wordmark } from '../../brand/Wordmark.tsx'
import { formatDateTime, formatRelativeTime } from '../../lib/format.ts'
import { boardPath, linkClick } from '../../lib/routing.ts'
import { LoadingScreen, MessageScreen } from '../../ui/screens.tsx'
import { feedbackApi } from './api.ts'
import { contextRows } from './model.ts'
import './feedback.css'

type Filter = FeedbackStatus | 'all'
type Phase = 'loading' | 'ready' | 'denied' | 'error'

const FILTERS: readonly { id: Filter; label: string }[] = [
  { id: 'open', label: 'Open' },
  { id: 'done', label: 'Done' },
  { id: 'all', label: 'All' },
]
const PAGE = 50

export default function FeedbackPage() {
  const [filter, setFilter] = useState<Filter>('open')
  const [phase, setPhase] = useState<Phase>('loading')
  const [items, setItems] = useState<FeedbackItem[]>([])
  const [next, setNext] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [moreBusy, setMoreBusy] = useState(false)
  const [attempt, setAttempt] = useState(0)
  // The "Load more" request in flight, if any: it belongs to the list that was on screen when it started, so
  // a switch of the filter (or a retry) drops it. Without that, a page of Open would be appended to Done.
  const moreRequest = useRef<AbortController | null>(null)

  useEffect(() => {
    void attempt // run again on retry
    const controller = new AbortController()
    setMoreBusy(false) // a "Load more" of the list that is leaving was dropped by the cleanup below
    setPhase('loading')
    setMessage(null)
    feedbackApi()
      .list({ status: filter, limit: PAGE }, controller.signal)
      .then(
        (page) => {
          if (controller.signal.aborted) return
          setItems(page.items)
          setNext(page.next)
          setPhase('ready')
        },
        (e: unknown) => {
          if (controller.signal.aborted) return
          if (isApiError(e) && (e.kind === 'not-found' || e.kind === 'forbidden')) return setPhase('denied')
          setMessage(isApiError(e) ? e.message : 'Lobby could not load the feedback.')
          setPhase('error')
        },
      )
    return () => {
      controller.abort()
      moreRequest.current?.abort()
      moreRequest.current = null
    }
  }, [filter, attempt])

  const loadMore = useCallback(async () => {
    if (!next || moreBusy) return
    const controller = new AbortController()
    moreRequest.current = controller
    setMoreBusy(true)
    setMessage(null)
    try {
      const page = await feedbackApi().list({ status: filter, cursor: next, limit: PAGE }, controller.signal)
      if (controller.signal.aborted) return // another list is on screen now: this page is not its
      setItems((cur) => [...cur, ...page.items.filter((i) => !cur.some((c) => c.id === i.id))])
      setNext(page.next)
    } catch (e) {
      if (controller.signal.aborted) return
      setMessage(isApiError(e) ? e.message : 'Lobby could not load more.')
    } finally {
      if (moreRequest.current === controller) {
        moreRequest.current = null
        setMoreBusy(false)
      }
    }
  }, [next, moreBusy, filter])

  const mark = async (item: FeedbackItem, status: FeedbackStatus) => {
    setBusy(item.id)
    setMessage(null)
    try {
      const updated = await feedbackApi().setStatus(item.id, status)
      // Open and Done are lists of one status: a message that changed leaves the list it was in.
      setItems((cur) =>
        filter === 'all'
          ? cur.map((i) => (i.id === updated.id ? updated : i))
          : cur.filter((i) => i.id !== updated.id),
      )
    } catch (e) {
      setMessage(isApiError(e) ? e.message : 'That was not saved. Try again.')
    } finally {
      setBusy(null)
    }
  }

  if (phase === 'denied')
    return (
      <MessageScreen
        testId="feedback-denied"
        title="Page not found"
        body="There is nothing at this address."
      />
    )

  return (
    <div className="dr-fbp" data-testid="feedback-page">
      <header className="dr-fbp__bar">
        <a href="/" onClick={linkClick('/')} aria-label="Lobby home">
          <Wordmark />
        </a>
        <a className="dr-btn dr-btn--ghost dr-btn--sm" href="/" onClick={linkClick('/')}>
          Back to boards
        </a>
      </header>
      <main className="dr-fbp__main">
        <div className="dr-fbp__head">
          <h1 className="dr-fbp__title">Feedback</h1>
          <fieldset className="dr-fbp__tabs">
            <legend className="dr-sr-only">Show</legend>
            {FILTERS.map((f) => (
              <button
                key={f.id}
                type="button"
                className="dr-fbp__tab"
                data-testid={`feedback-filter-${f.id}`}
                aria-pressed={filter === f.id}
                onClick={() => setFilter(f.id)}
              >
                {f.label}
              </button>
            ))}
          </fieldset>
        </div>

        {message && (
          <p className="dr-field-error" role="alert" data-testid="feedback-page-error">
            {message}
          </p>
        )}

        {phase === 'loading' && <LoadingScreen label="Loading feedback…" testId="feedback-loading" />}
        {phase === 'error' && (
          <div className="dr-fbp__note">
            <button type="button" className="dr-btn" onClick={() => setAttempt((n) => n + 1)}>
              Try again
            </button>
          </div>
        )}
        {phase === 'ready' && items.length === 0 && (
          <p className="dr-fbp__empty dr-muted" data-testid="feedback-empty">
            {filter === 'open'
              ? 'Nothing open. Every message is marked done.'
              : filter === 'done'
                ? 'Nothing is marked done yet.'
                : 'No feedback yet.'}
          </p>
        )}
        {phase === 'ready' && items.length > 0 && (
          <ul className="dr-fbp__list" data-testid="feedback-list">
            {items.map((item) => (
              <FeedbackCard
                key={item.id}
                item={item}
                busy={busy === item.id}
                onMark={(status) => void mark(item, status)}
              />
            ))}
          </ul>
        )}
        {phase === 'ready' && next && (
          <div className="dr-fbp__note">
            <button
              type="button"
              className="dr-btn"
              data-testid="feedback-more"
              disabled={moreBusy}
              onClick={() => void loadMore()}
            >
              {moreBusy ? 'Loading…' : 'Load more'}
            </button>
          </div>
        )}
      </main>
    </div>
  )
}

function FeedbackCard({
  item,
  busy,
  onMark,
}: {
  item: FeedbackItem
  busy: boolean
  onMark(status: FeedbackStatus): void
}) {
  const done = item.status === 'done'
  return (
    <li className="dr-fbp__item" data-testid="feedback-item" data-id={item.id} data-status={item.status}>
      <div className="dr-fbp__meta">
        <span className="dr-fbp__who" data-testid="feedback-who">
          {item.name}
        </span>
        <span className="dr-fbp__chip">{item.kind === 'guest' ? 'Guest' : 'Account'}</span>
        <time dateTime={item.createdAt} title={formatDateTime(item.createdAt)}>
          {formatRelativeTime(item.createdAt)}
        </time>
        <span className="dr-fbp__chip" data-status={item.status}>
          {done ? 'Done' : 'Open'}
        </span>
      </div>
      <p className="dr-fbp__label">What happened</p>
      <p className="dr-fbp__text" data-testid="feedback-item-text">
        {item.text}
      </p>
      {item.expected && (
        <>
          <p className="dr-fbp__label">What they expected</p>
          <p className="dr-fbp__text" data-testid="feedback-item-expected">
            {item.expected}
          </p>
        </>
      )}
      <details className="dr-fbp__details">
        <summary>Where it was sent from</summary>
        <dl className="dr-fb__rows" data-testid="feedback-item-context">
          {contextRows(item.context, formatDateTime).map((row) => (
            <div key={row.key} className="dr-fb__row">
              <dt>{row.label}</dt>
              <dd>{row.value}</dd>
            </div>
          ))}
        </dl>
      </details>
      <div className="dr-fbp__actions">
        <button
          type="button"
          className={done ? 'dr-btn dr-btn--sm' : 'dr-btn dr-btn--primary dr-btn--sm'}
          data-testid={done ? 'feedback-reopen' : 'feedback-done'}
          disabled={busy}
          onClick={() => onMark(done ? 'open' : 'done')}
        >
          {done ? 'Reopen' : 'Mark done'}
        </button>
        {item.context.boardId && (
          <a
            className="dr-btn dr-btn--ghost dr-btn--sm"
            href={boardPath(item.context.boardId)}
            onClick={linkClick(boardPath(item.context.boardId))}
          >
            Open board
          </a>
        )}
      </div>
    </li>
  )
}
