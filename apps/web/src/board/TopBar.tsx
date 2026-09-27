import type { Board } from '@draftroom/contracts'
import { useLayoutEffect, useMemo, useRef, useState } from 'react'
import { type Editor, useValue } from 'tldraw'
import { UserMenu } from '../auth/UserMenu.tsx'
import { Mark } from '../brand/Wordmark.tsx'
import { FeatureTopBarItems, PINNED_TOP_BAR_FEATURES } from '../features/FeatureHost.tsx'
import type { BoardFeature, FeatureContext } from '../features/types.ts'
import { initialsFor } from '../lib/identity.ts'
import { type BoardRole, can } from '../lib/permissions.ts'
import { linkClick, workspacePath } from '../lib/routing.ts'
import { SaveStatus, type SaveStatusView } from '../sync-quality/SaveStatus.tsx'
import { OverflowMenu } from '../ui/OverflowMenu.tsx'
import { RenameInput } from '../ui/RenameInput.tsx'
import { useTopBarWidth } from '../ui/useMedia.ts'
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
  features,
  featureCtx,
  board,
  role,
  workspace,
  selfUserId,
  conn,
  save,
  editor,
  onRename,
  onShare,
  onRequestAccess,
}: {
  board: Board
  role: BoardRole
  workspace: { id: string; name: string }
  selfUserId: string
  /** The socket only ("Live"): never evidence that anything was saved. */
  conn: ConnState
  /** What the server has acknowledged (sync-quality/saveTracker.ts). */
  save: SaveStatusView
  editor: Editor | null
  onRename(title: string): void
  onShare(): void
  /** The role pill opens the request-more-access flow (PRI-09b). */
  onRequestAccess(): void
  /** Feature slot (features/FeatureHost.tsx): compact controls placed before Share. */
  features: readonly BoardFeature[]
  featureCtx: FeatureContext | null
}) {
  const home = workspacePath(workspace.id)
  const pill = readonlyPill(role, board.status)
  // PRI-02: at 768 px and below the feature controls (present, export, timer, sharing badge) move
  // into a "⋯" menu; at 480 px and below the people list and the account button do too. The title,
  // the bell and Share always stay in the bar.
  const width = useTopBarWidth()
  const narrow = width !== 'wide'
  const phone = width === 'phone'
  // The role pill already says what a viewer/commenter can do: a second "View only" is noise (RETRO-17).
  const saveHidden = !!pill && save.state === 'readonly'
  // Tab order = DOM order (RETRO-22a): breadcrumb, title, role, people, status, feature controls,
  // Share. The account (DEV identity) badge is drawn at the bar's right end but comes LAST in the
  // page (BoardAccount below, rendered by BoardPage after the canvas); on phones it is in the menu.
  return (
    <header className="dr-topbar" data-width={width} data-testid="topbar">
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
        <button
          type="button"
          className="dr-pill dr-pill--role"
          data-testid="readonly-pill"
          data-role={role}
          title={pill.request ? `${pill.title}. Ask for more access.` : pill.title}
          aria-label={pill.request ? `${pill.label}: ask for more access` : pill.label}
          aria-haspopup={pill.request ? 'dialog' : undefined}
          disabled={!pill.request}
          onClick={onRequestAccess}
        >
          <svg viewBox="0 0 24 24" width="13" height="13" aria-hidden="true">
            <path
              d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12zm10 3a3 3 0 1 0 0-6 3 3 0 0 0 0 6z"
              fill="currentColor"
            />
          </svg>
          <span className="dr-pill__label">{pill.label}</span>
        </button>
      )}
      <div className="dr-topbar__spacer" />
      {!phone && <PresenceList editor={editor} selfUserId={selfUserId} max={narrow ? 2 : MAX_AVATARS} />}
      <SaveStatus view={save} hidden={saveHidden} />
      <span
        className={`dr-pill dr-pill--${conn}`}
        data-testid="conn-status"
        data-state={conn}
        role="status"
        title={CONN_TITLE[conn]}
      >
        <span className="dr-pill__dot" aria-hidden="true" />
        <span className="dr-pill__label">{CONN_LABEL[conn]}</span>
      </span>
      <FeatureTopBarItems
        features={features}
        ctx={featureCtx}
        only={narrow ? PINNED_TOP_BAR_FEATURES : undefined}
      />
      {narrow && (
        <OverflowMenu label="More board controls" testId="topbar-overflow">
          <FeatureTopBarItems features={features} ctx={featureCtx} except={PINNED_TOP_BAR_FEATURES} stacked />
          {phone && (
            <div className="dr-overflow__item" data-feature="people">
              <span className="dr-overflow__caption" aria-hidden="true">
                On this board
              </span>
              <PresenceList editor={editor} selfUserId={selfUserId} max={MAX_AVATARS} />
            </div>
          )}
          {phone && (
            <div className="dr-overflow__item" data-feature="account">
              <span className="dr-overflow__caption" aria-hidden="true">
                Your account
              </span>
              <UserMenu />
            </div>
          )}
        </OverflowMenu>
      )}
      <button
        type="button"
        className="dr-btn dr-btn--primary dr-btn--sm dr-topbar__share"
        data-testid="share-button"
        aria-label="Share"
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
        <span className="dr-topbar__share-label">Share</span>
      </button>
    </header>
  )
}

/**
 * The account button of the board page, drawn at the right end of the top bar but placed last in the
 * DOM (after the canvas and its toolbar), so keyboard users reach the board's own controls first
 * (RETRO-22a). The bar keeps room for it through --dr-account-w. On phones it lives in the "⋯" menu.
 */
export function BoardAccount() {
  const width = useTopBarWidth()
  const wrap = useRef<HTMLDivElement>(null)
  const phone = width === 'phone'
  useLayoutEffect(() => {
    const el = wrap.current
    const board = el?.closest<HTMLElement>('.dr-board')
    if (!el || !board) return
    const set = () =>
      board.style.setProperty('--dr-account-w', `${Math.ceil(el.getBoundingClientRect().width)}px`)
    set()
    const ro = new ResizeObserver(set)
    ro.observe(el)
    return () => {
      ro.disconnect()
      board.style.removeProperty('--dr-account-w')
    }
  }, [phone])
  if (phone) return null
  return (
    <div className="dr-board__account" ref={wrap}>
      <UserMenu compact />
    </div>
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

function PresenceList({
  editor,
  selfUserId,
  max,
}: {
  editor: Editor | null
  selfUserId: string
  max: number
}) {
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
  const shown = users.slice(0, max)
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
            .slice(max)
            .map((u) => u.name)
            .join(', ')}
        >
          +{extra}
        </li>
      )}
    </ul>
  )
}
