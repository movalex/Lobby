import { useMemo, useState } from 'react'
import { type Editor, useValue } from 'tldraw'
import { Wordmark } from '../brand/Wordmark.tsx'
import { type DevIdentity, initialsFor } from '../lib/identity.ts'
import { boardPath, navigate } from '../lib/routing.ts'
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
  boardId,
  identity,
  conn,
  editor,
  onCopyLink,
}: {
  boardId: string
  identity: DevIdentity
  conn: ConnState
  editor: Editor | null
  onCopyLink(): void
}) {
  return (
    <header className="dr-topbar">
      <a
        className="dr-topbar__home"
        href="/"
        onClick={(e) => {
          if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return
          e.preventDefault()
          navigate(`/${homeQuery(identity)}`)
        }}
        aria-label="Draftroom home"
      >
        <Wordmark />
      </a>
      <span className="dr-topbar__sep" aria-hidden="true" />
      <div className="dr-topbar__board">
        <span className="dr-topbar__label">Board</span>
        <code className="dr-topbar__board-id" data-testid="board-id" title={boardId}>
          {boardId}
        </code>
        <button type="button" className="dr-btn dr-btn--ghost" data-testid="copy-link" onClick={onCopyLink}>
          <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
            <path
              d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
            />
          </svg>
          Copy link
        </button>
      </div>
      <div className="dr-topbar__spacer" />
      <PresenceList editor={editor} selfUserId={identity.userId} />
      <ReadonlyPill editor={editor} />
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
      <DevIdentityBadge identity={identity} boardId={boardId} />
    </header>
  )
}

const homeQuery = (identity: DevIdentity) =>
  `?user=${encodeURIComponent(identity.userId)}${identity.role === 'viewer' ? '&role=viewer' : ''}`

/** Reflects what the server granted (the editor turns read-only when the session is), not the URL. */
function ReadonlyPill({ editor }: { editor: Editor | null }) {
  const readonly = useValue('dr-readonly', () => editor?.getIsReadonly() ?? false, [editor])
  if (!readonly) return null
  return (
    <span
      className="dr-pill"
      data-testid="readonly-pill"
      title="You can look around but not change this board"
    >
      View only
    </span>
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

function DevIdentityBadge({ identity, boardId }: { identity: DevIdentity; boardId: string }) {
  const [open, setOpen] = useState(false)
  return (
    <div className="dr-devbadge-wrap">
      <button
        type="button"
        className="dr-devbadge"
        data-testid="dev-identity-badge"
        aria-expanded={open}
        title="Development identity (no sign-in yet). Click to switch."
        onClick={() => setOpen((o) => !o)}
      >
        <span className="dr-devbadge__tag">DEV</span>
        <span>{identity.userId}</span>
        {identity.role === 'viewer' && <span className="dr-devbadge__role">viewer</span>}
      </button>
      {open && (
        <div className="dr-devbadge__menu" role="dialog" aria-label="Dev identity">
          <p>
            You are using a development identity. Anyone can pick any name; real sign-in arrives in milestone
            1.
          </p>
          <button type="button" className="dr-btn" onClick={() => navigate(boardPath(boardId))}>
            Switch identity
          </button>
        </div>
      )}
    </div>
  )
}
