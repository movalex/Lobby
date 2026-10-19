// OWNER: WS5 (wave W, W5-4). Every open link of the workspace's boards (review, workshop and client review page
// links) and every name-only guest who can still open a board here, 100 of each at a time ("Load more" under each
// list pages it on by itself). Revoke, "+1 h" and taking a guest off a board are
// the Share dialog's own routes (api.ts): a workspace owner or admin is an owner of every board of the workspace there.
// Never a link's address or its join code (whether it has one only): copy those from the board's Share dialog.
import type { AdminGuest, AdminLink } from '@draftroom/contracts'
import { useCallback, useMemo, useState } from 'react'
import { formatDateTime, formatRelativeTime } from '../../lib/format.ts'
import { boardPath, linkClick } from '../../lib/routing.ts'
import type { AdminApi } from './api.ts'
import { LINK_KIND_LABELS, roleWords, usesText } from './model.ts'
import {
  type AdminViewer,
  Confirm,
  errorText,
  LoadFailed,
  Loading,
  LoadMore,
  type MoreControl,
  Tag,
  useAdminResource,
  useMorePages,
} from './shared.tsx'

export function LinksTab({
  api,
  viewer,
  onDenied,
}: {
  api: AdminApi
  viewer: AdminViewer
  onDenied(): void
}) {
  const res = useAdminResource(
    useCallback((signal: AbortSignal) => api.links({}, signal), [api]),
    onDenied,
  )
  // the two lists page apart: "Load more" under each asks for that list's next page only
  const first = res.status === 'ready' ? res.data : null
  const links = useMorePages(
    useMemo(() => first && { items: first.links, next: first.nextLinks ?? null }, [first]),
    useCallback(
      async (linksBefore: string, signal: AbortSignal) => {
        const page = await api.links({ linksBefore }, signal)
        return { items: page.links, next: page.nextLinks ?? null }
      },
      [api],
    ),
    linkKey,
    onDenied,
  )
  const guests = useMorePages(
    useMemo(() => first && { items: first.guests, next: first.nextGuests ?? null }, [first]),
    useCallback(
      async (guestsBefore: string, signal: AbortSignal) => {
        const page = await api.links({ guestsBefore }, signal)
        return { items: page.guests, next: page.nextGuests ?? null }
      },
      [api],
    ),
    guestKey,
    onDenied,
  )
  if (res.status === 'loading') return <Loading label="Loading links and guests…" />
  if (res.status === 'error') return <LoadFailed message={res.error.message} onRetry={res.reload} />
  return (
    <div className="dr-admin__stack">
      <section aria-labelledby="admin-links-h">
        <h2 id="admin-links-h" className="dr-admin__h2">
          Open links <Count shown={links.items.length} more={links.next !== null} />
        </h2>
        <LinkList links={links.items} api={api} viewer={viewer} onChanged={res.reload} more={links} />
      </section>
      <section aria-labelledby="admin-guests-h">
        <h2 id="admin-guests-h" className="dr-admin__h2">
          Guests by name <Count shown={guests.items.length} more={guests.next !== null} />
        </h2>
        <p className="dr-admin__note dr-muted">
          People who joined through a link with just a name, and can still open a board here.
        </p>
        <GuestList guests={guests.items} api={api} onChanged={res.reload} more={guests} />
      </section>
    </div>
  )
}

const linkKey = (l: AdminLink) => l.id
const guestKey = (g: AdminGuest) => g.user.id

/** How many rows are shown, "100+" while the api has more. */
function Count({ shown, more }: { shown: number; more: boolean }) {
  return (
    <span className="dr-admin__count">
      {shown}
      {more && '+'}
    </span>
  )
}

/** The open links shown so far, and "Load more" while the api has older ones. */
export function LinkList({
  links,
  api,
  viewer,
  onChanged,
  more,
}: {
  links: readonly AdminLink[]
  api: AdminApi
  viewer: AdminViewer
  onChanged(): void
  more: MoreControl
}) {
  if (links.length === 0 && more.next === null)
    return (
      <p className="dr-admin__empty dr-muted" data-testid="admin-links-empty">
        No board of this workspace has an open link.
      </p>
    )
  return (
    <>
      <ul className="dr-admin__list" data-testid="admin-links">
        {links.map((l) => (
          <LinkRow key={l.id} link={l} api={api} viewer={viewer} onChanged={onChanged} />
        ))}
      </ul>
      <LoadMore more={more} testId="admin-links-more" />
    </>
  )
}

/** The name-only guests shown so far, and "Load more" while the api has older ones. */
export function GuestList({
  guests,
  api,
  onChanged,
  more,
}: {
  guests: readonly AdminGuest[]
  api: AdminApi
  onChanged(): void
  more: MoreControl
}) {
  if (guests.length === 0 && more.next === null)
    return (
      <p className="dr-admin__empty dr-muted" data-testid="admin-guests-empty">
        No guests can open a board here.
      </p>
    )
  return (
    <>
      <ul className="dr-admin__list" data-testid="admin-guests">
        {guests.map((g) => (
          <GuestRow key={g.user.id} guest={g} api={api} onChanged={onChanged} />
        ))}
      </ul>
      <LoadMore more={more} testId="admin-guests-more" />
    </>
  )
}

function LinkRow({
  link: l,
  api,
  viewer,
  onChanged,
}: {
  link: AdminLink
  api: AdminApi
  viewer: AdminViewer
  onChanged(): void
}) {
  const [busy, setBusy] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const [removeAccess, setRemoveAccess] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const run = async (fn: () => Promise<unknown>, fallback: string) => {
    setBusy(true)
    setError(null)
    try {
      await fn()
      setConfirming(false)
      onChanged()
    } catch (e) {
      setError(errorText(e, fallback))
    } finally {
      setBusy(false)
    }
  }
  const board = l.board.title || 'Untitled board'
  return (
    <li className="dr-admin__row" data-testid="admin-link" data-link-id={l.id} data-kind={l.kind}>
      <div className="dr-admin__who">
        <span className="dr-admin__name">
          {LINK_KIND_LABELS[l.kind]}{' '}
          <span className="dr-muted">
            ·{' '}
            <a href={boardPath(l.board.id)} onClick={linkClick(boardPath(l.board.id))}>
              {board}
            </a>
          </span>
        </span>
        <span className="dr-admin__tags">
          <Tag>{roleWords(l.role)}</Tag>
          {l.allowGuests && <Tag tone="warn">Guests by name</Tag>}
          {l.hasJoinCode && <Tag>Join code</Tag>}
        </span>
        <span className="dr-admin__meta dr-muted">
          {l.createdBy && <span>Made by {l.createdBy.name}</span>}
          <span>
            <time dateTime={l.createdAt} title={formatDateTime(l.createdAt)}>
              {formatRelativeTime(l.createdAt)}
            </time>
          </span>
          {l.expiresAt && <span>Until {formatDateTime(l.expiresAt)}</span>}
          <span data-testid="admin-link-uses">{usesText(l.uses, l.maxUses)}</span>
        </span>
      </div>
      <div className="dr-admin__actions">
        {l.kind === 'workshop' && viewer.creator && !confirming && (
          <button
            type="button"
            className="dr-btn dr-btn--sm"
            data-testid="admin-link-extend"
            disabled={busy}
            onClick={() => void run(() => api.extendLink(l.board.id, l.id), 'The link was not extended.')}
          >
            +1 h
          </button>
        )}
        {!confirming && (
          <button
            type="button"
            className="dr-btn dr-btn--sm"
            data-testid="admin-link-revoke"
            disabled={busy}
            onClick={() => setConfirming(true)}
          >
            Revoke
          </button>
        )}
      </div>
      {confirming && (
        <Confirm
          testId="admin-link-revoke-confirm"
          question={`Revoke this ${LINK_KIND_LABELS[l.kind].toLowerCase()} to ${board}?`}
          action="Revoke link"
          busy={busy}
          onConfirm={() =>
            void run(
              () => api.revokeLink(l.board.id, l.id, l.uses > 0 && removeAccess),
              'The link was not revoked.',
            )
          }
          onCancel={() => setConfirming(false)}
        >
          {l.uses > 0 && (
            <label className="dr-admin__check">
              <input
                type="checkbox"
                data-testid="admin-link-remove-access"
                checked={removeAccess}
                onChange={(e) => setRemoveAccess(e.target.checked)}
              />
              Also remove the people who joined through it
            </label>
          )}
        </Confirm>
      )}
      {error && (
        <p className="dr-field-error dr-admin__rowerror" role="alert" data-testid="admin-link-error">
          {error}
        </p>
      )}
    </li>
  )
}

function GuestRow({ guest: g, api, onChanged }: { guest: AdminGuest; api: AdminApi; onChanged(): void }) {
  const [busy, setBusy] = useState<string | null>(null)
  const [confirming, setConfirming] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const remove = async (boardId: string) => {
    setBusy(boardId)
    setError(null)
    try {
      await api.removeFromBoard(boardId, g.user.id)
      setConfirming(null)
      onChanged()
    } catch (e) {
      setError(errorText(e, 'They were not removed.'))
    } finally {
      setBusy(null)
    }
  }
  const asking = g.boards.find((b) => b.id === confirming)
  return (
    <li className="dr-admin__row" data-testid="admin-guest" data-user-id={g.user.id}>
      <div className="dr-admin__who">
        {/* a name-only guest's name already says " (guest)" (contracts guests.ts guestDisplayName) */}
        <span className="dr-admin__name">{g.user.name}</span>
        <span className="dr-admin__meta dr-muted">
          <span>
            Joined{' '}
            <time dateTime={g.joinedAt} title={formatDateTime(g.joinedAt)}>
              {formatRelativeTime(g.joinedAt)}
            </time>
          </span>
          <span>{g.grants === 1 ? 'Can open 1 board' : `Can open ${g.grants} boards`}</span>
        </span>
        <ul className="dr-admin__boards">
          {g.boards.map((b) => (
            <li key={b.id}>
              <a href={boardPath(b.id)} onClick={linkClick(boardPath(b.id))}>
                {b.title || 'Untitled board'}
              </a>
              {confirming !== b.id && (
                <button
                  type="button"
                  className="dr-btn dr-btn--ghost"
                  data-testid="admin-guest-remove"
                  data-board-id={b.id}
                  disabled={busy !== null}
                  aria-label={`Remove ${g.user.name} from ${b.title || 'Untitled board'}`}
                  onClick={() => setConfirming(b.id)}
                >
                  Remove
                </button>
              )}
            </li>
          ))}
        </ul>
        {g.grants > g.boards.length && (
          <span className="dr-admin__meta dr-muted">
            and {g.grants - g.boards.length} more (open those boards’ Share dialog)
          </span>
        )}
      </div>
      {asking && (
        <Confirm
          testId="admin-guest-remove-confirm"
          question={`Remove ${g.user.name} from ${asking.title || 'Untitled board'}?`}
          action="Remove"
          busy={busy !== null}
          onConfirm={() => void remove(asking.id)}
          onCancel={() => setConfirming(null)}
        />
      )}
      {error && (
        <p className="dr-field-error dr-admin__rowerror" role="alert">
          {error}
        </p>
      )}
    </li>
  )
}
