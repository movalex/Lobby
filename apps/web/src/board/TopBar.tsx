import type { Board } from '@draftroom/contracts'
import { type ReactNode, useMemo, useState } from 'react'
import { type Editor, useValue } from 'tldraw'
import { UserMenu } from '../auth/UserMenu.tsx'
import { Mark } from '../brand/Wordmark.tsx'
import { initialsFor } from '../lib/identity.ts'
import { type BoardRole, can } from '../lib/permissions.ts'
import { linkClick, workspacePath } from '../lib/routing.ts'
import { RenameInput } from '../ui/RenameInput.tsx'
import { readonlyPill } from './access.ts'
import { type PresenceUser, presenceUsers } from './presence.ts'

export type ConnState = 'connecting' | 'online' | 'offline' | 'error'

const CONN_LABEL: Record<ConnState, string> = {
  connecting: 'Connecting…',
  online: 'Live',
  offline: 'Offline',
  error: 'Disconnected',
}
const CONN_TITLE: Record<ConnState, string> = {
  connecting: 'Connecting to the board server',
  online: 'Connected: your changes are sent to everyone on this board as you make them',
  offline:
    'Offline: changes are kept in this tab only until the connection returns. Reloading now would lose them.',
  error: 'The connection to this board ended',
}

export function TopBar({
  extra,
  board,
  role,
  workspace,
  selfUserId,
  conn,
  editor,
  onRename,
  onShare,
}: {
  board: Board
  role: BoardRole
  workspace: { id: string; name: string }
  selfUserId: string
  conn: ConnState
  editor: Editor | null
  onRename(title: string): void
  onShare(): void
  /** Feature slot (features/FeatureHost.tsx): compact controls placed before Share. */
  extra?: ReactNode
}) {
  const home = workspacePath(workspace.id)
  const pill = readonlyPill(role, board.status)
  return (
    <header className="dr-topbar">
      <a
        className="dr-topbar__home"
        href={home}
        onClick={linkClick(home)}
        aria-label={`Back to ${workspace.name}`}
      >
        <Mark size={24} />
      </a>
      <span className="dr-topbar__sep" aria-hidden="true" />
      <div className="dr-topbar__board">
        <a className="dr-topbar__ws" href={home} onClick={linkClick(home)} title={workspace.name}>
          {workspace.name}
        </a>
        <span className="dr-topbar__slash" aria-hidden="true">
          /
        </span>
        <BoardTitle title={board.title} canRename={can(role, 'rename', board.status)} onRename={onRename} />
      </div>
      {pill && (
        <span
          className="dr-pill dr-pill--role"
          data-testid="readonly-pill"
          data-role={role}
          title={pill.title}
        >
          <svg viewBox="0 0 24 24" width="13" height="13" aria-hidden="true">
            <path
              d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12zm10 3a3 3 0 1 0 0-6 3 3 0 0 0 0 6z"
              fill="currentColor"
            />
          </svg>
          {pill.label}
        </span>
      )}
      <div className="dr-topbar__spacer" />
      <PresenceList editor={editor} selfUserId={selfUserId} />
      <span
        className={`dr-pill dr-pill--${conn}`}
        data-testid="conn-status"
        data-state={conn}
        role="status"
        title={CONN_TITLE[conn]}
      >
        <span className="dr-pill__dot" aria-hidden="true" />
        {CONN_LABEL[conn]}
      </span>
      {extra}
      <button
        type="button"
        className="dr-btn dr-btn--primary dr-btn--sm"
        data-testid="share-button"
        onClick={onShare}
      >
        <svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true">
          <path
            d="M16 11a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM8 13a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM2 20c0-3 2.7-5 6-5s6 2 6 5M14 15.5c.6-.3 1.3-.5 2-.5 3.3 0 6 2 6 5"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.9"
            strokeLinecap="round"
          />
        </svg>
        Share
      </button>
      <UserMenu compact />
    </header>
  )
}

function BoardTitle({
  title,
  canRename,
  onRename,
}: {
  title: string
  canRename: boolean
  onRename(title: string): void
}) {
  const [editing, setEditing] = useState(false)
  if (!canRename) {
    return (
      <h1 className="dr-topbar__title" data-testid="board-title" title={title}>
        {title}
      </h1>
    )
  }
  if (editing) {
    return (
      <RenameInput
        initial={title}
        label="Board title"
        testId="board-title-input"
        className="dr-input dr-topbar__title-input"
        onSubmit={(next) => {
          setEditing(false)
          onRename(next)
        }}
        onCancel={() => setEditing(false)}
      />
    )
  }
  return (
    <h1 className="dr-topbar__h1">
      <button
        type="button"
        className="dr-topbar__title dr-topbar__title--editable"
        data-testid="board-title"
        title="Rename board"
        aria-label={`${title}, rename board`}
        onClick={() => setEditing(true)}
      >
        {title}
      </button>
    </h1>
  )
}

const MAX_AVATARS = 5

function PresenceList({ editor, selfUserId }: { editor: Editor | null; selfUserId: string }) {
  // Serialized so cursor movement (which changes presence every frame) does not re-render the bar.
  const key = useValue(
    'dr-presence-users',
    () => (editor ? JSON.stringify(presenceUsers(editor.getCollaborators(), selfUserId)) : '[]'),
    [editor, selfUserId],
  )
  const following = useValue('dr-following', () => editor?.getInstanceState().followingUserId ?? null, [
    editor,
  ])
  const users = useMemo(() => JSON.parse(key) as PresenceUser[], [key])
  const shown = users.slice(0, MAX_AVATARS)
  const extra = users.length - shown.length
  return (
    <ul className="dr-presence" data-testid="presence-list" aria-label="People on this board">
      {shown.map((u) => {
        const isFollowing = following === u.followId
        return (
          <li key={u.userId} data-testid="presence-user" data-user-id={u.userId}>
            <button
              type="button"
              className="dr-avatar"
              style={{ background: u.color }}
              aria-pressed={isFollowing}
              aria-label={isFollowing ? `Stop following ${u.name}` : `Follow ${u.name}`}
              title={isFollowing ? `Following ${u.name}` : u.name}
              disabled={!editor}
              onClick={() => {
                if (!editor) return
                if (isFollowing) editor.stopFollowingUser()
                else editor.startFollowingUser(u.followId)
              }}
            >
              {initialsFor(u.name)}
            </button>
          </li>
        )
      })}
      {extra > 0 && (
        <li
          className="dr-avatar dr-avatar--more"
          title={users
            .slice(MAX_AVATARS)
            .map((u) => u.name)
            .join(', ')}
        >
          +{extra}
        </li>
      )}
    </ul>
  )
}
