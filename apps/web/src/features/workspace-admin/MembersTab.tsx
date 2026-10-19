// OWNER: WS5 (wave W, W5-1). The members tab: everyone with an account in the workspace (name-only guests are on the
// links tab), their role, whether they are a creator, how many boards they hold a direct grant on, and the outside
// markers; then the pending invitations. A role change and a removal go through the existing member routes, where
// the creator rule and the last-owner rule stay; revoking an invitation is the existing DELETE /api/invitations/:id.
// No "last visit": visit times are private to each person (migration 0031's promise).
import type { AdminInvitation, AdminMember } from '@draftroom/contracts'
import { useCallback, useState } from 'react'
import { formatDateTime } from '../../lib/format.ts'
import { boardPath, linkClick } from '../../lib/routing.ts'
import type { AdminApi, WorkspaceRole } from './api.ts'
import { roleWords } from './model.ts'
import {
  type AdminViewer,
  Confirm,
  errorText,
  LoadFailed,
  Loading,
  Tag,
  useAdminResource,
} from './shared.tsx'

const ROLE_OPTIONS: readonly { role: WorkspaceRole; label: string }[] = [
  { role: 'owner', label: 'Owner' },
  { role: 'admin', label: 'Admin' },
  { role: 'member', label: 'Member' },
  { role: 'guest', label: 'Guest' },
]
const RANK: Record<WorkspaceRole, number> = { owner: 0, admin: 1, member: 2, guest: 3 }

export function MembersTab({
  api,
  viewer,
  workspaceName,
  onDenied,
}: {
  api: AdminApi
  viewer: AdminViewer
  workspaceName: string
  onDenied(): void
}) {
  const members = useAdminResource(
    useCallback((signal: AbortSignal) => api.members(signal), [api]),
    onDenied,
  )
  const invitations = useAdminResource(
    useCallback((signal: AbortSignal) => api.invitations(signal), [api]),
    onDenied,
  )
  return (
    <div className="dr-admin__stack">
      <section aria-labelledby="admin-members-h">
        <h2 id="admin-members-h" className="dr-admin__h2">
          People{' '}
          {members.status === 'ready' && (
            <span className="dr-admin__count">{members.data.members.length}</span>
          )}
        </h2>
        {members.status === 'loading' && <Loading label="Loading members…" />}
        {members.status === 'error' && (
          <LoadFailed message={members.error.message} onRetry={members.reload} />
        )}
        {members.status === 'ready' && (
          <ul className="dr-admin__list" data-testid="admin-members">
            {members.data.members.map((m) => (
              <MemberRow
                key={m.user.id}
                member={m}
                viewer={viewer}
                workspaceName={workspaceName}
                api={api}
                onChanged={members.reload}
              />
            ))}
          </ul>
        )}
      </section>
      <section aria-labelledby="admin-invitations-h">
        <h2 id="admin-invitations-h" className="dr-admin__h2">
          Pending invitations
        </h2>
        {invitations.status === 'loading' && <Loading label="Loading invitations…" />}
        {invitations.status === 'error' && (
          <LoadFailed message={invitations.error.message} onRetry={invitations.reload} />
        )}
        {invitations.status === 'ready' && invitations.data.invitations.length === 0 && (
          <p className="dr-admin__empty dr-muted" data-testid="admin-invitations-empty">
            No invitations are waiting to be accepted.
          </p>
        )}
        {invitations.status === 'ready' && invitations.data.invitations.length > 0 && (
          <ul className="dr-admin__list" data-testid="admin-invitations">
            {invitations.data.invitations.map((i) => (
              <InvitationRow key={i.id} invitation={i} api={api} onChanged={invitations.reload} />
            ))}
          </ul>
        )}
        {invitations.status === 'ready' && invitations.data.more && (
          <p className="dr-admin__note dr-muted">Showing the newest 100.</p>
        )}
      </section>
    </div>
  )
}

function MemberRow({
  member: m,
  viewer,
  workspaceName,
  api,
  onChanged,
}: {
  member: AdminMember
  viewer: AdminViewer
  workspaceName: string
  api: AdminApi
  onChanged(): void
}) {
  const [busy, setBusy] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const self = m.user.id === viewer.id
  // Only an owner changes an owner or makes one (the route says so too); nobody changes their own role here.
  const locked = self || (m.role === 'owner' && viewer.role !== 'owner')
  const optionDisabled = (role: WorkspaceRole): string | null => {
    if (role === m.role) return null
    if (role === 'owner' && viewer.role !== 'owner') return 'only an owner'
    const raise = RANK[role] < RANK[m.role]
    if (raise && !viewer.creator) return 'creators only'
    if (raise && (role === 'admin' || role === 'owner') && !m.creator) return 'needs a creator'
    return null
  }
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
  const selectId = `admin-role-${m.user.id}`
  return (
    <li className="dr-admin__row" data-testid="admin-member" data-user-id={m.user.id} data-role={m.role}>
      <div className="dr-admin__who">
        <span className="dr-admin__name">
          {m.user.name}
          {self && <span className="dr-muted"> (you)</span>}
        </span>
        <span className="dr-admin__tags">
          {m.creator && <Tag tone="ok">Creator</Tag>}
          {m.outside === true && (
            <Tag tone="warn" title={m.emailDomain ? `Outside: ${m.emailDomain}` : 'Outside'}>
              External
            </Tag>
          )}
          {m.outside === 'unconfirmed' && (
            <Tag title="Lobby has not checked this account's addresses yet">Unconfirmed</Tag>
          )}
        </span>
        <span className="dr-admin__meta dr-muted">
          {m.emailHint && <span>{m.emailHint}</span>}
          <span data-testid="admin-member-grants">
            {m.boardGrants === 0
              ? 'No direct board access'
              : m.boardGrants === 1
                ? 'Direct access to 1 board'
                : `Direct access to ${m.boardGrants} boards`}
          </span>
        </span>
      </div>
      <div className="dr-admin__actions">
        <label className="dr-sr-only" htmlFor={selectId}>
          Role of {m.user.name}
        </label>
        <select
          id={selectId}
          className="dr-input dr-select dr-select--compact"
          data-testid="admin-member-role"
          value={m.role}
          disabled={locked || busy}
          onChange={(e) => {
            const role = e.target.value as WorkspaceRole
            void run(() => api.setRole(m.user.id, role), 'The role was not changed.')
          }}
        >
          {ROLE_OPTIONS.map((o) => {
            const why = optionDisabled(o.role)
            return (
              <option key={o.role} value={o.role} disabled={why !== null}>
                {why ? `${o.label} (${why})` : o.label}
              </option>
            )
          })}
        </select>
        {!locked && !confirming && (
          <button
            type="button"
            className="dr-btn dr-btn--sm"
            data-testid="admin-member-remove"
            disabled={busy}
            onClick={() => setConfirming(true)}
          >
            Remove
          </button>
        )}
      </div>
      {confirming && (
        <Confirm
          testId="admin-member-remove-confirm"
          question={`Remove ${m.user.name} from ${workspaceName}?`}
          action="Remove"
          busy={busy}
          onConfirm={() => void run(() => api.removeMember(m.user.id), 'They were not removed.')}
          onCancel={() => setConfirming(false)}
        >
          <p className="dr-admin__confirm-note dr-muted">
            They lose every board they could open here. Their boards and files stay in the workspace.
          </p>
        </Confirm>
      )}
      {error && (
        <p className="dr-field-error dr-admin__rowerror" role="alert" data-testid="admin-member-error">
          {error}
        </p>
      )}
    </li>
  )
}

function InvitationRow({
  invitation: i,
  api,
  onChanged,
}: {
  invitation: AdminInvitation
  api: AdminApi
  onChanged(): void
}) {
  const [busy, setBusy] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const revoke = async () => {
    setBusy(true)
    setError(null)
    try {
      await api.revokeInvitation(i.id)
      onChanged()
    } catch (e) {
      setError(errorText(e, 'The invitation was not revoked.'))
      setBusy(false)
    }
  }
  const where = i.board ? i.board.title || 'Untitled board' : 'The workspace'
  return (
    <li className="dr-admin__row" data-testid="admin-invitation" data-invitation-id={i.id}>
      <div className="dr-admin__who">
        <span className="dr-admin__name">
          {i.board ? (
            <a href={boardPath(i.board.id)} onClick={linkClick(boardPath(i.board.id))}>
              {where}
            </a>
          ) : (
            where
          )}{' '}
          <span className="dr-muted">· {roleWords(i.role)}</span>
        </span>
        <span className="dr-admin__meta dr-muted">
          <span>{i.emailHint ?? 'Anyone with the link'}</span>
          {i.invitedBy && <span>Sent by {i.invitedBy.name}</span>}
          {i.expiresAt && <span>Until {formatDateTime(i.expiresAt)}</span>}
        </span>
      </div>
      <div className="dr-admin__actions">
        {!confirming && (
          <button
            type="button"
            className="dr-btn dr-btn--sm"
            data-testid="admin-invitation-revoke"
            disabled={busy}
            onClick={() => setConfirming(true)}
          >
            Revoke
          </button>
        )}
      </div>
      {confirming && (
        <Confirm
          testId="admin-invitation-revoke-confirm"
          question={`Revoke this invitation to ${where.toLowerCase() === 'the workspace' ? 'the workspace' : where}?`}
          action="Revoke"
          busy={busy}
          onConfirm={() => void revoke()}
          onCancel={() => setConfirming(false)}
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
