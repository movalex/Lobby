import type { Board, BoardMember, InvitationCreated, WorkspaceMember } from '@draftroom/contracts'
import { useCallback, useId, useMemo, useState } from 'react'
import { api, isApiError } from '../api/client.ts'
import { absoluteUrl, copyText } from '../lib/clipboard.ts'
import { formatDateTime } from '../lib/format.ts'
import { initialsFor, safeColor } from '../lib/identity.ts'
import { BOARD_ROLES, type BoardRole, type BoardVisibility, can } from '../lib/permissions.ts'
import { useResource } from '../lib/useResource.ts'
import { Dialog } from '../ui/Dialog.tsx'
import {
  inviteRoleOptions,
  memberRoleEditable,
  shareableWorkspaceMembers,
  sortMembers,
  VISIBILITY_OPTIONS,
} from './share-model.ts'

const ROLE_OPTION_LABEL: Record<BoardRole, string> = {
  owner: 'Owner',
  editor: 'Can edit',
  commenter: 'Can comment',
  viewer: 'Can view',
}

export function ShareDialog({
  board,
  role,
  workspace,
  selfUserId,
  onClose,
  onBoardChange,
}: {
  board: Board
  role: BoardRole
  workspace: { id: string; name: string }
  selfUserId: string
  onClose(): void
  onBoardChange(board: Board): void
}) {
  const canManage = can(role, 'manage_access', board.status)
  const canChangeVisibility = can(role, 'change_visibility', board.status)
  const [error, setError] = useState<string | null>(null)
  const [pendingUser, setPendingUser] = useState<string | null>(null)

  const membersLoad = useCallback((signal: AbortSignal) => api.listMembers(board.id, signal), [board.id])
  const members = useResource(membersLoad)
  const wsLoad = useCallback(
    (signal: AbortSignal): Promise<WorkspaceMember[]> =>
      canManage ? api.listWorkspaceMembers(workspace.id, signal) : Promise.resolve([]),
    [canManage, workspace.id],
  )
  const wsMembers = useResource(wsLoad)

  const run = async (userId: string | null, fn: () => Promise<BoardMember[]>) => {
    setError(null)
    setPendingUser(userId)
    try {
      const next = await fn() // the API answers with the updated list
      members.update(() => next)
    } catch (e) {
      // e.g. the server protecting the last owner: its message says exactly why.
      setError(isApiError(e) ? e.message : 'That change was not saved. Try again.')
    } finally {
      setPendingUser(null)
    }
  }

  const sorted = useMemo(() => sortMembers(members.data ?? [], selfUserId), [members.data, selfUserId])
  const addable = useMemo(
    () => shareableWorkspaceMembers(wsMembers.data ?? [], members.data ?? []),
    [wsMembers.data, members.data],
  )

  return (
    <Dialog
      title={<>Share “{board.title}”</>}
      description={
        <>
          Board in <strong data-testid="share-workspace-name">{workspace.name}</strong>
        </>
      }
      onClose={onClose}
      testId="share-dialog"
      size="lg"
    >
      <div className="dr-share">
        <VisibilitySection
          board={board}
          workspaceName={workspace.name}
          editable={canChangeVisibility}
          onChange={async (visibility) => {
            setError(null)
            try {
              onBoardChange(await api.patchBoard(board.id, { visibility }))
              members.reload()
            } catch (e) {
              setError(isApiError(e) ? e.message : 'Access was not changed. Try again.')
            }
          }}
        />

        {canManage && <InviteSection boardId={board.id} />}

        <section className="dr-share__section" aria-labelledby="dr-share-people">
          <h3 id="dr-share-people" className="dr-share__heading">
            People with access
          </h3>
          {error && (
            <p className="dr-share__error" role="alert" data-testid="share-error">
              {error}
            </p>
          )}
          {canManage && addable.length > 0 && (
            <AddMember
              candidates={addable}
              pending={pendingUser === 'add'}
              onAdd={(userId, r) => void run('add', () => api.putMember(board.id, userId, r))}
            />
          )}
          {members.status === 'loading' && <p className="dr-muted">Loading people…</p>}
          {members.status === 'error' && (
            <p className="dr-share__error" role="alert">
              {members.error.message}{' '}
              <button type="button" className="dr-linkbtn" onClick={members.reload}>
                Retry
              </button>
            </p>
          )}
          {members.status === 'ready' && (
            <ul className="dr-members" data-testid="member-list">
              {sorted.map((m) => (
                <MemberRow
                  key={m.user.id}
                  member={m}
                  isSelf={m.user.id === selfUserId}
                  editable={canManage && memberRoleEditable(m)}
                  pending={pendingUser === m.user.id}
                  onRole={(r) => void run(m.user.id, () => api.putMember(board.id, m.user.id, r))}
                  onRemove={() => void run(m.user.id, () => api.removeMember(board.id, m.user.id))}
                />
              ))}
            </ul>
          )}
          {!canManage && <p className="dr-share__note">Only board owners can change who has access.</p>}
        </section>
      </div>
    </Dialog>
  )
}

function VisibilitySection({
  board,
  workspaceName,
  editable,
  onChange,
}: {
  board: Board
  workspaceName: string
  editable: boolean
  onChange(v: BoardVisibility): Promise<void>
}) {
  const id = useId()
  const [pending, setPending] = useState(false)
  const current = VISIBILITY_OPTIONS.find((o) => o.value === board.visibility)
  return (
    <section className="dr-share__section">
      <label htmlFor={id} className="dr-share__heading">
        General access
      </label>
      <div className="dr-share__visibility">
        <span className="dr-share__visicon" aria-hidden="true" data-visibility={board.visibility} />
        <div className="dr-share__vistext">
          <select
            id={id}
            className="dr-input dr-select"
            data-testid="visibility-select"
            value={board.visibility}
            disabled={!editable || pending}
            onChange={async (e) => {
              setPending(true)
              await onChange(e.target.value as BoardVisibility)
              setPending(false)
            }}
          >
            {VISIBILITY_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
          <p className="dr-share__hint">{current?.describe(workspaceName)}</p>
        </div>
      </div>
    </section>
  )
}

function InviteSection({ boardId }: { boardId: string }) {
  const roleId = useId()
  const linkId = useId()
  const [role, setRole] = useState<Exclude<BoardRole, 'owner'>>('viewer')
  const [created, setCreated] = useState<InvitationCreated | null>(null)
  const [copied, setCopied] = useState(false)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const url = created ? (created.url.startsWith('/') ? absoluteUrl(created.url) : created.url) : ''

  const create = async () => {
    setPending(true)
    setError(null)
    setCopied(false)
    try {
      const inv = await api.createBoardInvitation(boardId, role)
      setCreated(inv)
      setCopied(await copyText(inv.url.startsWith('/') ? absoluteUrl(inv.url) : inv.url))
    } catch (e) {
      setError(isApiError(e) ? e.message : 'The invite link could not be created.')
    } finally {
      setPending(false)
    }
  }

  const revoke = async () => {
    if (!created) return
    setPending(true)
    setError(null)
    try {
      await api.revokeInvitation(created.id)
      setCreated(null)
    } catch (e) {
      setError(isApiError(e) ? e.message : 'The invite link could not be revoked.')
    } finally {
      setPending(false)
    }
  }

  return (
    <section className="dr-share__section" aria-labelledby={`${roleId}-h`}>
      <h3 id={`${roleId}-h`} className="dr-share__heading">
        Invite with a link
      </h3>
      <div className="dr-row dr-row--wrap">
        <label htmlFor={roleId} className="dr-sr-only">
          Role for people who use the link
        </label>
        <select
          id={roleId}
          className="dr-input dr-select dr-select--compact"
          data-testid="invite-role"
          value={role}
          onChange={(e) => setRole(e.target.value as Exclude<BoardRole, 'owner'>)}
        >
          {inviteRoleOptions().map((r) => (
            <option key={r} value={r}>
              {ROLE_OPTION_LABEL[r]}
            </option>
          ))}
        </select>
        <button
          type="button"
          className="dr-btn dr-btn--primary"
          data-testid="invite-create"
          disabled={pending}
          onClick={() => void create()}
        >
          {created ? 'Create another link' : 'Create invite link'}
        </button>
      </div>
      {error && (
        <p className="dr-share__error" role="alert">
          {error}
        </p>
      )}
      {created && (
        <div className="dr-invite" data-testid="invite-result">
          <label htmlFor={linkId} className="dr-sr-only">
            Invite link
          </label>
          <div className="dr-row">
            <input
              id={linkId}
              className="dr-input dr-invite__link"
              data-testid="invite-link"
              value={url}
              readOnly
              onFocus={(e) => e.currentTarget.select()}
            />
            <button
              type="button"
              className="dr-btn"
              data-testid="invite-copy"
              onClick={async () => setCopied(await copyText(url))}
            >
              {copied ? 'Copied' : 'Copy'}
            </button>
          </div>
          <p className="dr-share__hint" role="status">
            {copied ? 'Copied to your clipboard. ' : ''}This link is shown only once. Anyone who opens it and
            signs in joins as “{ROLE_OPTION_LABEL[role]}” until {formatDateTime(created.expiresAt)}.{' '}
            <button
              type="button"
              className="dr-linkbtn"
              data-testid="invite-revoke"
              onClick={() => void revoke()}
            >
              Revoke link
            </button>
          </p>
        </div>
      )}
    </section>
  )
}

function AddMember({
  candidates,
  pending,
  onAdd,
}: {
  candidates: readonly WorkspaceMember[]
  pending: boolean
  onAdd(userId: string, role: BoardRole): void
}) {
  const personId = useId()
  const roleId = useId()
  const [userId, setUserId] = useState('')
  const [role, setRole] = useState<BoardRole>('editor')
  return (
    <form
      className="dr-share__add"
      onSubmit={(e) => {
        e.preventDefault()
        if (userId) onAdd(userId, role)
        setUserId('')
      }}
    >
      <label htmlFor={personId} className="dr-sr-only">
        Person from the workspace
      </label>
      <select
        id={personId}
        className="dr-input dr-select"
        data-testid="share-add-member"
        value={userId}
        onChange={(e) => setUserId(e.target.value)}
      >
        <option value="">Add someone from the workspace…</option>
        {candidates.map((m) => (
          <option key={m.user.id} value={m.user.id}>
            {m.user.name}
            {m.user.handle ? ` (@${m.user.handle})` : ''}
          </option>
        ))}
      </select>
      <label htmlFor={roleId} className="dr-sr-only">
        Their role on this board
      </label>
      <select
        id={roleId}
        className="dr-input dr-select dr-select--compact"
        data-testid="share-add-role"
        value={role}
        onChange={(e) => setRole(e.target.value as BoardRole)}
      >
        {BOARD_ROLES.map((r) => (
          <option key={r} value={r}>
            {ROLE_OPTION_LABEL[r]}
          </option>
        ))}
      </select>
      <button type="submit" className="dr-btn" data-testid="share-add-submit" disabled={!userId || pending}>
        Add
      </button>
    </form>
  )
}

function MemberRow({
  member,
  isSelf,
  editable,
  pending,
  onRole,
  onRemove,
}: {
  member: BoardMember
  isSelf: boolean
  editable: boolean
  pending: boolean
  onRole(role: BoardRole): void
  onRemove(): void
}) {
  const selectId = useId()
  const { user } = member
  return (
    <li
      className="dr-member"
      data-testid="member-row"
      data-user-id={user.id}
      data-role={member.role}
      aria-busy={pending || undefined}
    >
      <span
        className="dr-avatar dr-avatar--static"
        style={{ background: safeColor(user.color, user.id) }}
        aria-hidden="true"
      >
        {initialsFor(user.name)}
      </span>
      <div className="dr-member__text">
        <span className="dr-member__name">
          {user.name}
          {isSelf && <span className="dr-member__you"> (you)</span>}
        </span>
        <span className="dr-member__sub">
          {user.handle ? `@${user.handle}` : ''}
          {member.source === 'workspace' ? `${user.handle ? ' · ' : ''}Access through the workspace` : ''}
        </span>
      </div>
      {editable ? (
        <div className="dr-member__actions">
          <label htmlFor={selectId} className="dr-sr-only">
            Role for {user.name}
          </label>
          <select
            id={selectId}
            className="dr-input dr-select dr-select--compact"
            data-testid="member-role"
            value={member.role}
            disabled={pending}
            onChange={(e) => onRole(e.target.value as BoardRole)}
          >
            {BOARD_ROLES.map((r) => (
              <option key={r} value={r}>
                {ROLE_OPTION_LABEL[r]}
              </option>
            ))}
          </select>
          <button
            type="button"
            className="dr-iconbtn"
            data-testid="member-remove"
            aria-label={`Remove ${user.name} from this board`}
            title="Remove from board"
            disabled={pending}
            onClick={onRemove}
          >
            <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
              <path d="M6 6l12 12M18 6L6 18" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
            </svg>
          </button>
        </div>
      ) : (
        <span className="dr-member__role" data-testid="member-role">
          {ROLE_OPTION_LABEL[member.role]}
        </span>
      )}
    </li>
  )
}
