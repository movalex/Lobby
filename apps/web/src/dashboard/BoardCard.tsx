import { type BoardWithRole, NEW_CANVAS_CARD_NOTE, thumbnailPath } from '@draftroom/contracts'
import { type CSSProperties, useEffect, useState } from 'react'
import { SharedOutsideMarker } from '../features/people/SharedOutside.tsx'
import { onThumbnailUpdated, recentThumbnail } from '../features/thumbnails/card-events.ts'
import { formatRelativeTime } from '../lib/format.ts'
import { initialsFor } from '../lib/identity.ts'
import { can } from '../lib/permissions.ts'
import { boardPath, linkClick } from '../lib/routing.ts'
import { MenuButton } from '../ui/Menu.tsx'
import { RenameInput } from '../ui/RenameInput.tsx'
import {
  type BoardMenuAction,
  type BoardMenuContext,
  boardMenuItems,
  ROLE_LABEL,
  thumbStyle,
} from './model.ts'
import { type BoardNews, newsLabel } from './notifications.ts'
import type { ViewMode } from './prefs.ts'
import './dashboard.css'

/**
 * The board's thumbnail (features/thumbnails: an editor's client captures it), lazy-loaded over a
 * theme-aware background, cropped to the card's 16:10. The placeholder shows while there is none, for
 * trashed boards (nobody can open one), and when the image fails to load.
 */
export function BoardCardThumb({
  board,
}: {
  board: { id: string; title?: string; status: BoardWithRole['status']; thumbnailVersion?: string | null }
}) {
  const listed = board.status === 'trashed' ? null : (board.thumbnailVersion ?? null)
  // A thumbnail this tab sent after the list was fetched (e.g. the board just closed) wins until the
  // list itself changes.
  const [sent, setSent] = useState<{ version: string | null; over: string | null } | null>(null)
  useEffect(() => {
    if (board.status === 'trashed') return
    const off = onThumbnailUpdated(board.id, (version) => setSent({ version, over: listed }))
    // N1-THUMBS: also one whose answer came before this card listened (the list was read before that
    // upload was stored), before the card was made or between its first render and this effect
    const recent = recentThumbnail(board.id)
    if (recent) setSent({ version: recent.version, over: listed })
    return off
  }, [board.id, board.status, listed])
  const version = sent && sent.over === listed ? sent.version : listed
  const [failed, setFailed] = useState<string | null>(null)
  if (!version || failed === version) return <BoardThumb boardId={board.id} title={board.title} />
  return (
    <img
      className="dr-bcard__img"
      data-testid="board-thumbnail"
      data-version={version}
      src={thumbnailPath(board.id, version)}
      alt=""
      width={480}
      height={300}
      loading="lazy"
      decoding="async"
      draggable={false}
      onError={() => setFailed(version)}
    />
  )
}

/**
 * The placeholder of a board with no picture yet (P-004): one calm, neutral design for every such board, never a drawing
 * that could pass for the board's content. A tint that is stable per board id (so a board keeps its colour in every
 * view and for every viewer), the board's initials, and "No preview yet". Its colours are presentation attributes (the
 * light look); dashboard.css recolours the classed parts on the dark theme from the same palette (--th-*).
 */
export function BoardThumb({ boardId, title }: { boardId: string; title?: string }) {
  const t = thumbStyle(boardId)
  const palette = { '--th-bg': t.bg, '--th-ink': t.ink } as CSSProperties
  const named = !!title && !/^untitled/i.test(title.trim())
  return (
    <svg
      className="dr-thumb"
      data-testid="board-thumb-placeholder"
      viewBox="0 0 160 100"
      preserveAspectRatio="xMidYMid slice"
      role="img"
      aria-label="No preview yet"
      style={palette}
    >
      <rect className="dr-thumb__bg" width="160" height="100" fill={t.bg} />
      {named ? (
        <text
          className="dr-thumb__initials"
          data-testid="board-thumb-initials"
          x="80"
          y="52"
          textAnchor="middle"
          fontSize="30"
          fontWeight="700"
          fill={t.ink}
          opacity="0.8"
        >
          {initialsFor(title)}
        </text>
      ) : (
        <rect
          className="dr-thumb__ink"
          x="62"
          y="26"
          width="36"
          height="28"
          rx="5"
          fill="none"
          stroke={t.ink}
          strokeWidth="2"
          opacity="0.5"
        />
      )}
      <text
        className="dr-thumb__label"
        x="80"
        y="78"
        textAnchor="middle"
        fontSize="8.5"
        fontWeight="600"
        fill={t.ink}
        opacity="0.7"
      >
        No preview yet
      </text>
    </svg>
  )
}

export function BoardCard<
  B extends BoardWithRole & { starred?: boolean; thumbnailVersion?: string | null; sharedOutside?: boolean },
>({
  board,
  renaming,
  busy,
  now,
  layout = 'grid',
  menu = { canCreate: true, canMove: true },
  projectName,
  news,
  onAction,
  onRename,
  onRenameCancel,
  onStar,
}: {
  board: B
  renaming: boolean
  busy: boolean
  now: Date
  layout?: ViewMode
  menu?: BoardMenuContext
  /** Shown in the list view. */
  projectName?: string | null
  /** Unread notifications on this board (PRI-05a), e.g. "2 new · mentioned you". */
  news?: BoardNews | null
  onAction(action: BoardMenuAction, board: B): void
  onRename(board: B, title: string): void
  onRenameCancel(): void
  onStar?(board: B, starred: boolean): void
}) {
  const items = boardMenuItems(board, menu)
  const starred = board.starred === true
  const canStar = !!onStar && can(board.role, 'view', board.status)
  const canOpen = items.some((i) => i.action === 'open')
  const href = boardPath(board.id)
  const when =
    board.status === 'trashed'
      ? `Trashed ${formatRelativeTime(board.trashedAt ?? board.updatedAt, now)}`
      : `Edited ${formatRelativeTime(board.updatedAt, now)}`

  const body = (
    <div className="dr-bcard__thumb">
      <BoardCardThumb board={board} />
      {board.status !== 'active' && (
        <span className="dr-bcard__status">{board.status === 'archived' ? 'Archived' : 'In trash'}</span>
      )}
    </div>
  )

  const star = canStar && (
    <button
      type="button"
      className="dr-star"
      data-testid="board-star"
      data-board-id={board.id}
      aria-pressed={starred}
      aria-label={starred ? `Remove star from ${board.title}` : `Star ${board.title}`}
      title={starred ? 'Starred' : 'Star'}
      onClick={() => onStar?.(board, !starred)}
    >
      <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
        <path
          d="M12 3.5l2.6 5.3 5.9.9-4.3 4.1 1 5.8-5.2-2.7-5.2 2.7 1-5.8-4.3-4.1 5.9-.9z"
          fill={starred ? 'currentColor' : 'none'}
          stroke="currentColor"
          strokeWidth="1.7"
          strokeLinejoin="round"
        />
      </svg>
    </button>
  )

  return (
    <li
      className={`dr-bcard${busy ? ' dr-bcard--busy' : ''}${layout === 'list' ? ' dr-bcard--row' : ''}`}
      data-testid="board-card"
      data-board-id={board.id}
      data-status={board.status}
      data-role={board.role}
      data-starred={starred ? 'true' : 'false'}
      // PRI-11: the card's one link covers the whole card (title and body); star and ⋯ sit above it.
      data-renaming={renaming ? 'true' : undefined}
      aria-busy={busy || undefined}
    >
      {canOpen ? (
        <a
          className="dr-bcard__link"
          href={href}
          onClick={linkClick(href)}
          aria-label={news ? `Open ${board.title}, ${newsLabel(news)}` : `Open ${board.title}`}
          tabIndex={renaming ? -1 : 0}
        >
          {body}
        </a>
      ) : (
        <div className="dr-bcard__link dr-bcard__link--disabled">{body}</div>
      )}
      <div className="dr-bcard__foot">
        <div className="dr-bcard__text">
          {renaming ? (
            <RenameInput
              initial={board.title}
              label={`Rename ${board.title}`}
              testId="board-card-rename"
              onSubmit={(title) => onRename(board, title)}
              onCancel={onRenameCancel}
            />
          ) : (
            <span className="dr-bcard__title" data-testid="board-card-title" title={board.title}>
              {board.title}
            </span>
          )}
          <span className="dr-bcard__meta">
            {news && (
              <span className="dr-bcard__news" data-testid="board-card-news" data-comments={news.comments}>
                {news.comments > 0 && (
                  <svg viewBox="0 0 24 24" width="13" height="13" aria-hidden="true">
                    <path
                      d="M5 5.5h14a1.5 1.5 0 0 1 1.5 1.5v8.5A1.5 1.5 0 0 1 19 17h-8l-4.5 3.5V17H5a1.5 1.5 0 0 1-1.5-1.5V7A1.5 1.5 0 0 1 5 5.5z"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                      strokeLinejoin="round"
                    />
                  </svg>
                )}
                {newsLabel(news)}
              </span>
            )}
            <span>{when}</span>
            {/* Bridge release R0: made on the new canvas (this build cannot open it; the line below says when). */}
            {board.newCanvas && (
              <span className="dr-bcard__canvas" data-testid="board-card-new-canvas">
                New canvas
              </span>
            )}
            {layout === 'list' && projectName && <span className="dr-bcard__project">{projectName}</span>}
            {/* Wave J: someone outside Dark Burn / TPG, a guest or an open link can open it. */}
            {board.sharedOutside && board.status !== 'trashed' && (
              <SharedOutsideMarker testId="board-card-shared-outside" />
            )}
            <span className="dr-role" data-role={board.role}>
              {ROLE_LABEL[board.role]}
            </span>
          </span>
          {/* What the badge means, in words on the card (never only a tooltip). */}
          {board.newCanvas && (
            <span className="dr-bcard__canvas-note" data-testid="board-card-new-canvas-note">
              {NEW_CANVAS_CARD_NOTE}
            </span>
          )}
        </div>
        {star}
        <MenuButton
          label={`Board options for ${board.title}`}
          items={items}
          onSelect={(action) => onAction(action, board)}
          testId="board-card-menu"
        >
          <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
            <circle cx="5" cy="12" r="1.8" fill="currentColor" />
            <circle cx="12" cy="12" r="1.8" fill="currentColor" />
            <circle cx="19" cy="12" r="1.8" fill="currentColor" />
          </svg>
        </MenuButton>
      </div>
    </li>
  )
}
