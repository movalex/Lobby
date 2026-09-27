import type { BoardWithRole } from '@draftroom/contracts'
import { useId } from 'react'
import { formatRelativeTime } from '../lib/format.ts'
import { boardPath, linkClick } from '../lib/routing.ts'
import { MenuButton } from '../ui/Menu.tsx'
import { RenameInput } from '../ui/RenameInput.tsx'
import { type BoardMenuAction, boardMenuItems, ROLE_LABEL, thumbStyle } from './model.ts'

/** A deterministic, colored placeholder until real board thumbnails exist. */
export function BoardThumb({ boardId }: { boardId: string }) {
  const t = thumbStyle(boardId)
  const dots = useId()
  return (
    <svg className="dr-thumb" viewBox="0 0 160 100" preserveAspectRatio="xMidYMid slice" aria-hidden="true">
      <defs>
        <pattern id={dots} width="10" height="10" patternUnits="userSpaceOnUse">
          <circle cx="1" cy="1" r="0.8" fill={t.ink} opacity="0.14" />
        </pattern>
      </defs>
      <rect width="160" height="100" fill={t.bg} />
      <rect width="160" height="100" fill={`url(#${dots})`} />
      {t.layout === 0 && (
        <g>
          <path
            d="M52 44 C 70 30, 86 64, 104 50"
            stroke={t.ink}
            strokeWidth="1.6"
            fill="none"
            opacity="0.55"
          />
          <rect x="26" y="30" width="30" height="30" rx="2" fill={t.note} transform="rotate(-4 41 45)" />
          <rect x="100" y="34" width="30" height="30" rx="2" fill={t.note} transform="rotate(3 115 49)" />
          <rect x="64" y="58" width="30" height="30" rx="2" fill="#fff" stroke={t.ink} strokeOpacity="0.2" />
          <path d="M70 68h18M70 74h12" stroke={t.ink} strokeWidth="1.6" strokeLinecap="round" opacity="0.5" />
        </g>
      )}
      {t.layout === 1 && (
        <g>
          <rect
            x="22"
            y="18"
            width="116"
            height="66"
            rx="4"
            fill="#fff"
            stroke={t.ink}
            strokeOpacity="0.35"
          />
          <path d="M22 30h116" stroke={t.ink} strokeOpacity="0.2" />
          <rect x="32" y="40" width="26" height="26" rx="2" fill={t.note} />
          <rect x="66" y="40" width="26" height="26" rx="2" fill={t.note} opacity="0.75" />
          <path
            d="M102 44h26M102 52h20M102 60h24"
            stroke={t.ink}
            strokeWidth="1.8"
            strokeLinecap="round"
            opacity="0.45"
          />
        </g>
      )}
      {t.layout === 2 && (
        <g stroke={t.ink} strokeWidth="1.6" fill="none">
          <rect x="18" y="38" width="34" height="22" rx="5" fill="#fff" strokeOpacity="0.5" />
          <rect x="64" y="20" width="34" height="22" rx="5" fill={t.note} stroke="none" />
          <rect x="64" y="58" width="34" height="22" rx="5" fill="#fff" strokeOpacity="0.5" />
          <rect x="110" y="38" width="34" height="22" rx="11" fill={t.note} stroke="none" opacity="0.8" />
          <path d="M52 46l12-12M52 52l12 14M98 31l12 12M98 69l12-12" opacity="0.5" strokeLinecap="round" />
        </g>
      )}
      {t.layout === 3 && (
        <g stroke={t.ink} strokeWidth="1.6" strokeLinecap="round">
          <path d="M80 50L40 28M80 50L40 74M80 50L122 26M80 50L124 72" opacity="0.4" />
          <circle cx="80" cy="50" r="14" fill={t.note} stroke="none" />
          <rect x="22" y="20" width="30" height="16" rx="8" fill="#fff" strokeOpacity="0.35" />
          <rect x="22" y="66" width="30" height="16" rx="8" fill="#fff" strokeOpacity="0.35" />
          <rect x="108" y="18" width="30" height="16" rx="8" fill="#fff" strokeOpacity="0.35" />
          <rect x="110" y="64" width="30" height="16" rx="8" fill={t.note} stroke="none" opacity="0.7" />
        </g>
      )}
    </svg>
  )
}

export function BoardCard({
  board,
  renaming,
  busy,
  now,
  onAction,
  onRename,
  onRenameCancel,
}: {
  board: BoardWithRole
  renaming: boolean
  busy: boolean
  now: Date
  onAction(action: BoardMenuAction, board: BoardWithRole): void
  onRename(board: BoardWithRole, title: string): void
  onRenameCancel(): void
}) {
  const items = boardMenuItems(board)
  const canOpen = items.some((i) => i.action === 'open')
  const href = boardPath(board.id)
  const when =
    board.status === 'trashed'
      ? `Trashed ${formatRelativeTime(board.trashedAt ?? board.updatedAt, now)}`
      : `Edited ${formatRelativeTime(board.updatedAt, now)}`

  const body = (
    <div className="dr-bcard__thumb">
      <BoardThumb boardId={board.id} />
      {board.status !== 'active' && (
        <span className="dr-bcard__status">{board.status === 'archived' ? 'Archived' : 'In trash'}</span>
      )}
    </div>
  )

  return (
    <li
      className={`dr-bcard${busy ? ' dr-bcard--busy' : ''}`}
      data-testid="board-card"
      data-board-id={board.id}
      data-status={board.status}
      data-role={board.role}
      aria-busy={busy || undefined}
    >
      {canOpen ? (
        <a
          className="dr-bcard__link"
          href={href}
          onClick={linkClick(href)}
          aria-label={`Open ${board.title}`}
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
            <span>{when}</span>
            <span className="dr-role" data-role={board.role}>
              {ROLE_LABEL[board.role]}
            </span>
          </span>
        </div>
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
