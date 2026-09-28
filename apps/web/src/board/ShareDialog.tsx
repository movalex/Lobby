// The Share dialog (PRS-02..04 + review links): invite by @handle/email or from the workspace, invite
// by email (sent through Clerk when this server signs in with it; a link to copy otherwise), pending
// access requests, workspace-wide access, who has access and through which grant (with transfer of
// ownership), single-use invite links and multi-use review links. Board owners manage; everyone else
// sees who has access and can ask for more. The API enforces every rule; this only offers what the
// shared permission rules allow.
//
// Order for board owners (DANA-03 / F3, after F13): "Share with a client" first (one review link:
// comment, 14 days, join with just a name, created and copied by one button), then "Invite people",
// pending requests, "More ways to share" (collapsed: workshop link, invite by email, one-time invite
// links), then the settings (workspace access, export) and who has access. Every guest option sits
// above its Create button and applies to the link that button makes.

import type {
  AccessRequest,
  Board,
  BoardMember,
  EmailInviteResult,
  InvitationCreated,
  PendingInvitation,
  RequestableRole,
  ShareState,
  WorkspaceMember,
} from '@draftroom/contracts'
import { type ReactNode, useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import { api, isApiError } from '../api/client.ts'
import { useSession } from '../auth/session.tsx'
import { announceShareChanged, SHARE_REMOTE_EVENT, sharingApi } from '../features/sharing/api.ts'
import { ClientExportLine, ExportPolicySection } from '../features/sharing/ExportPolicySection.tsx'
import { refreshExportPolicy } from '../features/sharing/export-policy.ts'
import {
  canExtend,
  daysLabel,
  hoursLabel,
  REVIEW_LINK_DAY_OPTIONS,
  REVIEW_LINK_DEFAULT_DAY,
  shortDate,
  shortTime,
  WORKSHOP_LINK_DEFAULT_HOURS,
  WORKSHOP_LINK_HOUR_OPTIONS,
} from '../features/sharing/model.ts'
import { RequestAccess } from '../features/sharing/RequestAccess.tsx'
import '../features/sharing/sharing.css'
import { fetchBoardGuests, useIsGuest } from '../invite/guest.tsx'
import { splitGuestMarker } from '../invite/model.ts'
import { absoluteUrl, copyText } from '../lib/clipboard.ts'
import { formatDateTime, formatRelativeTime } from '../lib/format.ts'
import { initialsFor, safeColor } from '../lib/identity.ts'
import { BOARD_ROLES, type BoardRole, type BoardVisibility, can } from '../lib/permissions.ts'
import { boardPath } from '../lib/routing.ts'
import { useResource } from '../lib/useResource.ts'
import { Dialog } from '../ui/Dialog.tsx'
import {
  type AccessDetail,
  accessSource,
  CLIENT_LINK_DEFAULTS,
  checkInviteEmail,
  clientLinkHint,
  type EmailInviteOutcome,
  emailInviteHint,
  emailInviteOutcome,
  grantEditable,
  inviteRoleOptions,
  linkAccessLine,
  linkForEmailHint,
  moreWaysSummary,
  parseInviteTarget,
  ROLE_OPTION_LABEL,
  removalNote,
  removeConfirmText,
  shareableWorkspaceMembers,
  sortMembers,
  VISIBILITY_OPTIONS,
  WORKSHOP_LINK_GUESTS_DEFAULT,
  workshopLinkHint,
} from './share-model.ts'

const sharing = sharingApi(api)

type Row = BoardMember & Partial<Omit<AccessDetail, 'user' | 'role' | 'source'>>

/** Applies an M1 member list (the answer to PUT/DELETE) onto the detailed rows until they reload. */
function mergeRows(prev: readonly Row[], next: readonly BoardMember[]): Row[] {
  const byId = new Map(prev.map((r) => [r.user.id, r]))
  return next.map((m) => ({ ...byId.get(m.user.id), ...m }))
}

export function ShareDialog({
  board,
  role,
  workspace,
  selfUserId,
  focus,
  onClose,
  onBoardChange,
}: {
  board: Board
  role: BoardRole
  workspace: { id: string; name: string }
  selfUserId: string
  /** 'request': opened to ask for more access (role pill, blocked-edit hint): start at that form. */
  focus?: 'request'
  onClose(): void
  onBoardChange(board: Board): void
}) {
  // A change to the caller's own role (stepping down, transferring ownership) applies here at once;
  // the board page learns it from its next sync ticket.
  const [roleOverride, setRoleOverride] = useState<BoardRole | null>(null)
  const effectiveRole = roleOverride ?? role
  const canManage = can(effectiveRole, 'manage_access', board.status)
  const canChangeVisibility = can(effectiveRole, 'change_visibility', board.status)
  const [error, setError] = useState<string | null>(null)
  const [pendingUser, setPendingUser] = useState<string | null>(null)
  // R2-11: how many times "Workshop link (guests can edit)" was clicked (opens and focuses that section).
  const [workshopAsk, setWorkshopAsk] = useState(0)
  const changed = useCallback(() => announceShareChanged(board.id), [board.id])
  // Invitation emails go out only through Clerk (the server has the final word per address).
  const canEmail = useSession().config?.providers.includes('clerk') ?? false
  // A name-only guest (wave 3) cannot ask for more access; the dialog says what they can do instead.
  const guest = useIsGuest()

  // Managers get the detailed list (grant, workspace role, fallback, review-link joins); everyone else
  // the M1 list.
  const membersLoad = useCallback(
    (signal: AbortSignal): Promise<Row[]> =>
      canManage ? sharing.shareMembers(board.id, signal) : api.listMembers(board.id, signal),
    [board.id, canManage],
  )
  const members = useResource(membersLoad)
  // Wave 3: which members are name-only guests (they cannot be made owners; the server refuses).
  const guestsLoad = useCallback(
    (signal: AbortSignal): Promise<ReadonlySet<string>> =>
      canManage
        ? fetchBoardGuests(board.id, signal).catch(() => new Set<string>())
        : Promise.resolve(new Set()),
    [board.id, canManage],
  )
  const boardGuests = useResource(guestsLoad)
  const wsLoad = useCallback(
    (signal: AbortSignal): Promise<WorkspaceMember[]> =>
      canManage ? api.listWorkspaceMembers(workspace.id, signal) : Promise.resolve([]),
    [canManage, workspace.id],
  )
  const wsMembers = useResource(wsLoad)
  const requestsLoad = useCallback(
    (signal: AbortSignal): Promise<AccessRequest[]> =>
      canManage ? sharing.accessRequests(board.id, signal) : Promise.resolve([]),
    [board.id, canManage],
  )
  const requests = useResource(requestsLoad)
  const invitesLoad = useCallback(
    (signal: AbortSignal): Promise<PendingInvitation[]> =>
      canManage ? sharing.invitations(board.id, signal) : Promise.resolve([]),
    [board.id, canManage],
  )
  const invitations = useResource(invitesLoad)
  // Everyone sees whether a link is open (PRI-07): a reviewer must not read "Private" while one is.
  const stateLoad = useCallback(
    (signal: AbortSignal): Promise<ShareState | null> =>
      canManage ? Promise.resolve(null) : sharing.shareState(board.id, signal).catch(() => null),
    [board.id, canManage],
  )
  const shareStateRes = useResource(stateLoad)
  const linkLine = linkAccessLine(shareStateRes.data?.links ?? [], (iso, kind) =>
    kind === 'time' ? shortTime(iso) : shortDate(iso),
  )
  const askRef = useRef<HTMLElement>(null)
  // Runs after the <dialog> opened (child effects first) and placed its own initial focus.
  useEffect(() => {
    if (focus !== 'request') return
    askRef.current?.scrollIntoView({ block: 'center' })
    askRef.current?.querySelector<HTMLElement>('select, button')?.focus()
  }, [focus])

  // Someone else changed sharing while this dialog is open (a new access request, another owner's
  // grant or link): refetch, so the owner does not have to close and reopen it to see the request.
  // Reloads keep the current rows until the new ones arrive (useResource).
  const { reload: reloadMembers } = members
  const { reload: reloadRequests } = requests
  const { reload: reloadInvitations } = invitations
  const { reload: reloadShareState } = shareStateRes
  const { reload: reloadGuests } = boardGuests
  useEffect(() => {
    const onRemote = (e: Event) => {
      const id = (e as CustomEvent<{ boardId?: string }>).detail?.boardId
      if (id && id !== board.id) return
      reloadMembers()
      reloadRequests()
      reloadInvitations()
      reloadShareState()
      reloadGuests() // a guest may just have joined through a link
    }
    window.addEventListener(SHARE_REMOTE_EVENT, onRemote)
    return () => window.removeEventListener(SHARE_REMOTE_EVENT, onRemote)
  }, [board.id, reloadMembers, reloadRequests, reloadInvitations, reloadShareState, reloadGuests])

  const run = async (userId: string | null, fn: () => Promise<BoardMember[]>): Promise<boolean> => {
    setError(null)
    setPendingUser(userId)
    try {
      const next = await fn() // the API answers with the updated list
      const mine = next.find((m) => m.user.id === selfUserId)
      if (mine && mine.role !== effectiveRole) setRoleOverride(mine.role)
      members.update((prev) => mergeRows(prev, next))
      members.reload()
      changed()
      return true
    } catch (e) {
      // e.g. the server protecting the last owner: its message says exactly why.
      setError(isApiError(e) ? e.message : 'That change was not saved. Try again.')
      return false
    } finally {
      setPendingUser(null)
    }
  }

  const rows = members.data ?? []
  const sorted = useMemo(() => sortMembers(rows, selfUserId), [rows, selfUserId])
  const addable = useMemo(() => shareableWorkspaceMembers(wsMembers.data ?? [], rows), [wsMembers.data, rows])
  const self = rows.find((m) => m.user.id === selfUserId)
  const canTransfer = canManage && self?.grant === 'owner'
  const selfRole = self?.role ?? effectiveRole
  const allInvites = invitations.data ?? []
  const reviewLinks = allInvites.filter((i) => i.kind === 'review' && i.role !== 'editor')
  const workshopLinks = allInvites.filter((i) => i.kind === 'review' && i.role === 'editor')
  const oneTimeInvites = allInvites.filter((i) => i.kind === 'invite')

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
      <div className="dr-share dr-sharing">
        {/* DANA-03 / F3: the one obvious path for a client, first. A review link that lets people
            comment for 14 days and join with just a name; one button creates and copies it. */}
        {canManage && (
          <ClientLinkSection
            boardId={board.id}
            links={reviewLinks}
            onChange={() => {
              invitations.reload()
              members.reload()
              changed()
            }}
          />
        )}

        {canManage && invitations.data && workshopLinks.length === 0 && (
          <WorkshopShortcut onOpen={() => setWorkshopAsk((n) => n + 1)} />
        )}

        {canManage && (
          <InvitePeople
            boardId={board.id}
            workspaceName={workspace.name}
            workspaceMembers={wsMembers.data ?? []}
            boardMembers={rows}
            addable={addable}
            pendingAdd={pendingUser === 'add'}
            canEmail={canEmail}
            onGrant={(userId, r) => run('add', () => api.putMember(board.id, userId, r))}
            onLinkCreated={() => invitations.reload()}
          />
        )}

        {canManage && (requests.data?.length ?? 0) > 0 && (
          <AccessRequests
            requests={requests.data ?? []}
            onDecided={() => {
              requests.reload()
              members.reload()
              changed()
            }}
          />
        )}

        {/* DANA-03: the other mechanisms, one click away. An open workshop link opens this on the
            first load (a facilitator's "+1 h" stays at hand); the summary names what is open inside. */}
        {canManage && (
          <MoreWaysToShare
            workshopLinks={invitations.data ? workshopLinks.length : null}
            unusedInvites={oneTimeInvites.length}
            openAsk={workshopAsk}
          >
            <WorkshopLinksSection
              boardId={board.id}
              focusAsk={workshopAsk}
              links={workshopLinks}
              onChange={() => {
                invitations.reload()
                members.reload()
                changed()
              }}
            />
            <EmailInvite
              boardId={board.id}
              canEmail={canEmail}
              onResult={(result) => {
                if (result.mode === 'granted') {
                  if (result.alreadyHadAccess) return
                  members.reload()
                  changed()
                } else invitations.reload()
              }}
            />
            <InviteLinkSection
              boardId={board.id}
              invitations={oneTimeInvites}
              onChange={() => invitations.reload()}
            />
          </MoreWaysToShare>
        )}

        <VisibilitySection
          board={board}
          workspaceName={workspace.name}
          editable={canChangeVisibility}
          linkNote={canManage ? null : linkLine}
          onChange={async (visibility) => {
            setError(null)
            try {
              onBoardChange(await api.patchBoard(board.id, { visibility }))
              members.reload()
              changed()
            } catch (e) {
              setError(isApiError(e) ? e.message : 'Access was not changed. Try again.')
            }
          }}
        />

        <ExportPolicySection boardId={board.id} role={effectiveRole} canManage={canManage} />

        <section className="dr-share__section" aria-labelledby="dr-share-people">
          <h3 id="dr-share-people" className="dr-share__heading">
            People with access
          </h3>
          {error && (
            <p className="dr-share__error" role="alert" data-testid="share-error">
              {error}
            </p>
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
          {members.data && (
            <ul className="dr-members" data-testid="member-list">
              {sorted.map((m) => (
                <MemberRow
                  key={m.user.id}
                  member={m}
                  workspaceName={workspace.name}
                  isSelf={m.user.id === selfUserId}
                  editable={
                    canManage &&
                    (m.grant !== undefined ? grantEditable(m as AccessDetail) : m.source === 'grant')
                  }
                  guest={boardGuests.data?.has(m.user.id) ?? false}
                  transferable={
                    canTransfer &&
                    m.user.id !== selfUserId &&
                    m.role !== 'owner' &&
                    !(boardGuests.data?.has(m.user.id) ?? false)
                  }
                  pending={pendingUser === m.user.id}
                  onRole={(r) => void run(m.user.id, () => api.putMember(board.id, m.user.id, r))}
                  onRemove={() => void run(m.user.id, () => api.removeMember(board.id, m.user.id))}
                  onTransfer={() => void run(m.user.id, () => sharing.transferOwnership(board.id, m.user.id))}
                />
              ))}
            </ul>
          )}
          {!canManage && <p className="dr-share__note">Only board owners can change who has access.</p>}
        </section>

        {!canManage && guest && (
          <p className="dr-share__note" data-testid="share-guest-note">
            You're a guest on this board: to get more access, sign in with an account and ask whoever shared
            it.
          </p>
        )}
        {!canManage &&
          !guest &&
          (selfRole === 'viewer' || selfRole === 'commenter') &&
          board.status === 'active' && (
            <section
              ref={askRef}
              className="dr-share__section"
              aria-labelledby="dr-share-ask"
              data-testid="share-ask-section"
            >
              <h3 id="dr-share-ask" className="dr-share__heading">
                Need more access?
              </h3>
              <RequestAccess
                boardId={board.id}
                userId={selfUserId}
                currentRole={selfRole}
                autoFocus={focus === 'request'}
              />
            </section>
          )}

        <CopyBoardLink boardId={board.id} />
      </div>
    </Dialog>
  )
}

// ---- invite people -------------------------------------------------------------------------------

function InvitePeople({
  boardId,
  workspaceName,
  workspaceMembers,
  boardMembers,
  addable,
  pendingAdd,
  canEmail,
  onGrant,
  onLinkCreated,
}: {
  boardId: string
  workspaceName: string
  workspaceMembers: readonly WorkspaceMember[]
  boardMembers: readonly BoardMember[]
  addable: readonly WorkspaceMember[]
  pendingAdd: boolean
  /** This server can email invitations (the "Invite by email" form below does). */
  canEmail: boolean
  /** Resolves false when the grant failed (the dialog shows the server's reason). */
  onGrant(userId: string, role: BoardRole): Promise<boolean>
  onLinkCreated(): void
}) {
  const inputId = useId()
  const listId = useId()
  const roleId = useId()
  const [text, setText] = useState('')
  const [role, setRole] = useState<Exclude<BoardRole, 'owner'>>('editor')
  const [roleTouched, setRoleTouched] = useState(false)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<{ tone: 'info' | 'error'; text: string } | null>(null)
  const [link, setLink] = useState<{ url: string; to: string; role: BoardRole; expiresAt: string } | null>(
    null,
  )
  const [copied, setCopied] = useState(false)
  const target = parseInviteTarget(text, workspaceMembers, boardMembers)

  // Default role (checklist decision 2): edit for workspace members, comment for everyone else.
  useEffect(() => {
    if (roleTouched) return
    setRole(target.kind === 'email' || target.kind === 'unknown' ? 'commenter' : 'editor')
  }, [target.kind, roleTouched])

  const submit = async () => {
    setNotice(null)
    setLink(null)
    setCopied(false)
    if (target.kind === 'empty') return
    if (target.kind === 'already') {
      setNotice({
        tone: 'info',
        text: `${target.member.user.name} already has access. Change their role below.`,
      })
      return
    }
    setBusy(true)
    try {
      if (target.kind === 'member') {
        const ok = await onGrant(target.member.user.id, role)
        if (!ok) return // the reason is shown with the people list
        setNotice({ tone: 'info', text: `${target.member.user.name} can now open this board.` })
      } else {
        const inv: InvitationCreated = await api.createBoardInvitation(boardId, role)
        const url = inv.url.startsWith('/') ? absoluteUrl(inv.url) : inv.url
        setLink({
          url,
          to: target.kind === 'email' ? target.email : target.text,
          role,
          expiresAt: inv.expiresAt,
        })
        setCopied(await copyText(url))
        onLinkCreated()
      }
      setText('')
      setRoleTouched(false)
    } catch (e) {
      setNotice({ tone: 'error', text: isApiError(e) ? e.message : 'That did not work. Try again.' })
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="dr-share__section" aria-labelledby={`${inputId}-h`}>
      <h3 id={`${inputId}-h`} className="dr-share__heading">
        Invite people
      </h3>
      <form
        className="dr-sharing__invite"
        onSubmit={(e) => {
          e.preventDefault()
          void submit()
        }}
      >
        <label htmlFor={inputId} className="dr-sr-only">
          Invite by @handle, name or email
        </label>
        <input
          id={inputId}
          className="dr-input dr-sharing__invite-input"
          data-testid="share-invite-input"
          list={listId}
          placeholder="@handle, name or email"
          autoComplete="off"
          value={text}
          onChange={(e) => {
            setText(e.target.value)
            setNotice(null)
          }}
        />
        <datalist id={listId}>
          {addable.map((m) => (
            <option key={m.user.id} value={m.user.handle ? `@${m.user.handle}` : m.user.name}>
              {m.user.name}
            </option>
          ))}
        </datalist>
        <label htmlFor={roleId} className="dr-sr-only">
          Role for the person you invite
        </label>
        <select
          id={roleId}
          className="dr-input dr-select dr-select--compact"
          data-testid="share-invite-role"
          value={role}
          onChange={(e) => {
            setRole(e.target.value as Exclude<BoardRole, 'owner'>)
            setRoleTouched(true)
          }}
        >
          {inviteRoleOptions().map((r) => (
            <option key={r} value={r}>
              {ROLE_OPTION_LABEL[r]}
            </option>
          ))}
        </select>
        <button
          type="submit"
          className="dr-btn dr-btn--primary"
          data-testid="share-invite-submit"
          disabled={busy || target.kind === 'empty'}
        >
          {target.kind === 'email' || target.kind === 'unknown' ? 'Create invite link' : 'Invite'}
        </button>
      </form>
      <p className="dr-share__hint" data-testid="share-invite-hint">
        {target.kind === 'member' &&
          `${target.member.user.name} is in ${workspaceName}: they get access right away.`}
        {target.kind === 'email' && linkForEmailHint(canEmail)}
        {target.kind === 'unknown' &&
          `No one in ${workspaceName} matches. You get a one-time invite link to copy and send them.`}
        {(target.kind === 'empty' || target.kind === 'already') &&
          'People in the workspace get access right away. For anyone else you get a link to send.'}
      </p>
      {notice && (
        <p
          className={notice.tone === 'error' ? 'dr-share__error' : 'dr-share__hint'}
          role={notice.tone === 'error' ? 'alert' : 'status'}
          data-testid="share-invite-notice"
        >
          {notice.text}
        </p>
      )}
      {link && (
        <div className="dr-invite" data-testid="share-invite-result">
          <div className="dr-row">
            <input
              className="dr-input dr-invite__link"
              data-testid="share-invite-link"
              aria-label={`Invite link for ${link.to}`}
              value={link.url}
              readOnly
              onFocus={(e) => e.currentTarget.select()}
            />
            <button
              type="button"
              className="dr-btn"
              onClick={async () => setCopied(await copyText(link.url))}
            >
              {copied ? 'Copied' : 'Copy'}
            </button>
          </div>
          <p className="dr-share__hint" role="status">
            {copied ? 'Copied. ' : ''}Copy the link to send it to <strong>{link.to}</strong> — no email is
            sent. It works once, as “{ROLE_OPTION_LABEL[link.role]}”, until {formatDateTime(link.expiresAt)}.
          </p>
        </div>
      )}
      {/* F13: while someone is typed above, the suggestions list is the picker; a second one below
          would read as another invite row. */}
      {addable.length > 0 && text.trim() === '' && (
        <AddMember
          candidates={addable}
          pending={pendingAdd}
          onAdd={(userId, r) => {
            void onGrant(userId, r)
          }}
        />
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
        <option value="">Or pick someone from the workspace…</option>
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

// ---- invite by email -----------------------------------------------------------------------------

/**
 * One address and a role. The server grants someone who already uses Draftroom at once, emails a
 * single-use link to anyone else (Clerk sign-in only), or answers the link for the inviter to send
 * when no email went out. The form's errors are announced (role=alert) and tied to the field.
 */
function EmailInvite({
  boardId,
  canEmail,
  onResult,
}: {
  boardId: string
  canEmail: boolean
  onResult(result: EmailInviteResult): void
}) {
  const inputId = useId()
  const roleId = useId()
  const hintId = useId()
  const errorId = useId()
  const linkId = useId()
  const inputRef = useRef<HTMLInputElement>(null)
  const [text, setText] = useState('')
  const [role, setRole] = useState<Exclude<BoardRole, 'owner'>>('commenter')
  const [busy, setBusy] = useState(false)
  const [fieldError, setFieldError] = useState<string | null>(null)
  const [failure, setFailure] = useState<string | null>(null)
  const [outcome, setOutcome] = useState<(EmailInviteOutcome & { mode: EmailInviteResult['mode'] }) | null>(
    null,
  )
  // null: not tried yet; false: the browser refused (the person copies from the field).
  const [copied, setCopied] = useState<boolean | null>(null)

  const submit = async () => {
    setFailure(null)
    setOutcome(null)
    setCopied(null)
    const checked = checkInviteEmail(text)
    if (!checked.ok) {
      setFieldError(checked.message)
      inputRef.current?.focus()
      return
    }
    setFieldError(null)
    setBusy(true)
    try {
      const result = await sharing.inviteByEmail(boardId, { email: checked.email, role })
      setOutcome({ mode: result.mode, ...emailInviteOutcome(result, role, formatDateTime) })
      setText('')
      onResult(result)
    } catch (e) {
      // A 400 is about the address (the server's words); anything else is about sending at all.
      if (isApiError(e) && e.kind === 'invalid') {
        setFieldError(e.message.replace(/^email: /, ''))
        inputRef.current?.focus()
      } else setFailure(isApiError(e) ? e.message : 'The invitation was not sent. Try again.')
    } finally {
      setBusy(false)
    }
  }

  const link = outcome?.link
    ? outcome.link.startsWith('/')
      ? absoluteUrl(outcome.link)
      : outcome.link
    : null

  return (
    <section className="dr-share__section" aria-labelledby={`${inputId}-h`} data-testid="share-email-section">
      <h3 id={`${inputId}-h`} className="dr-share__heading">
        Invite by email
      </h3>
      <form
        className="dr-sharing__invite"
        noValidate
        onSubmit={(e) => {
          e.preventDefault()
          void submit()
        }}
      >
        <label htmlFor={inputId} className="dr-sr-only">
          Email address to invite
        </label>
        <input
          ref={inputRef}
          id={inputId}
          type="email"
          inputMode="email"
          className="dr-input dr-sharing__invite-input"
          data-testid="share-email-input"
          placeholder="name@example.com"
          autoComplete="off"
          autoCapitalize="none"
          spellCheck={false}
          value={text}
          aria-invalid={fieldError ? true : undefined}
          aria-describedby={fieldError ? `${errorId} ${hintId}` : hintId}
          onChange={(e) => {
            setText(e.target.value)
            setFieldError(null)
          }}
        />
        <label htmlFor={roleId} className="dr-sr-only">
          Role for the person you email
        </label>
        <select
          id={roleId}
          className="dr-input dr-select dr-select--compact"
          data-testid="share-email-role"
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
          type="submit"
          className="dr-btn dr-btn--primary"
          data-testid="share-email-submit"
          disabled={busy}
          aria-busy={busy || undefined}
        >
          {busy ? 'Sending…' : 'Send invite'}
        </button>
      </form>
      {fieldError && (
        <p id={errorId} className="dr-field-error" role="alert" data-testid="share-email-error">
          {fieldError}
        </p>
      )}
      <p id={hintId} className="dr-share__hint" data-testid="share-email-hint">
        {emailInviteHint(canEmail)}
      </p>
      {failure && (
        <p className="dr-share__error" role="alert" data-testid="share-email-failure">
          {failure}
        </p>
      )}
      {/* Always rendered, so screen readers announce each new outcome. */}
      <div role="status" className="dr-sharing__email-status">
        {outcome && (
          <p
            className="dr-sharing__email-result"
            data-testid="share-email-result"
            data-mode={outcome.mode}
            data-tone={outcome.tone}
          >
            <strong>{outcome.text}</strong> {outcome.detail}
          </p>
        )}
        {link && copied === false && (
          <span className="dr-share__hint">
            Your browser didn’t allow copying: select the link and copy it.
          </span>
        )}
      </div>
      {link && (
        <div className="dr-invite dr-row" data-testid="share-email-link-row">
          <label htmlFor={linkId} className="dr-sr-only">
            Invite link to send
          </label>
          <input
            id={linkId}
            className="dr-input dr-invite__link"
            data-testid="share-email-link"
            value={link}
            readOnly
            onFocus={(e) => e.currentTarget.select()}
          />
          <button
            type="button"
            className="dr-btn"
            data-testid="share-email-copy"
            onClick={async () => setCopied(await copyText(link))}
          >
            {copied ? 'Copied' : 'Copy link'}
          </button>
        </div>
      )}
    </section>
  )
}

// ---- access requests -----------------------------------------------------------------------------

function AccessRequests({ requests, onDecided }: { requests: readonly AccessRequest[]; onDecided(): void }) {
  return (
    <section className="dr-share__section dr-sharing__requests" aria-labelledby="dr-share-requests">
      <h3 id="dr-share-requests" className="dr-share__heading">
        Access requests <span className="dr-sharing__count">{requests.length}</span>
      </h3>
      <ul className="dr-members" data-testid="access-request-list">
        {requests.map((r) => (
          <AccessRequestRow key={r.id} request={r} onDecided={onDecided} />
        ))}
      </ul>
    </section>
  )
}

function AccessRequestRow({ request, onDecided }: { request: AccessRequest; onDecided(): void }) {
  const roleId = useId()
  const [role, setRole] = useState<RequestableRole>(request.roleRequested)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const { user } = request
  const decide = async (approve: boolean) => {
    setBusy(true)
    setError(null)
    try {
      if (approve) await sharing.approveAccessRequest(request.id, role)
      else await sharing.denyAccessRequest(request.id)
      onDecided()
    } catch (e) {
      setError(isApiError(e) ? e.message : 'That did not work. Try again.')
      setBusy(false)
    }
  }
  return (
    <li
      className="dr-member dr-sharing__request"
      data-testid="access-request-row"
      data-user-id={user.id}
      data-request-id={request.id}
      aria-busy={busy || undefined}
    >
      <Avatar user={user} />
      <div className="dr-member__text">
        <span className="dr-member__name">{user.name}</span>
        <span className="dr-member__sub">
          Asks to{' '}
          {request.roleRequested === 'editor'
            ? 'edit'
            : request.roleRequested === 'commenter'
              ? 'comment'
              : 'view'}{' '}
          · {formatRelativeTime(request.updatedAt)}
          {request.currentRole ? ` · now ${ROLE_OPTION_LABEL[request.currentRole]}` : ''}
        </span>
        {request.message && <q className="dr-sharing__request-msg">{request.message}</q>}
        {error && (
          <span className="dr-share__error" role="alert">
            {error}
          </span>
        )}
      </div>
      <div className="dr-member__actions">
        <label htmlFor={roleId} className="dr-sr-only">
          Role to give {user.name}
        </label>
        <select
          id={roleId}
          className="dr-input dr-select dr-select--compact"
          data-testid="access-request-grant-role"
          value={role}
          disabled={busy}
          onChange={(e) => setRole(e.target.value as RequestableRole)}
        >
          {inviteRoleOptions().map((r) => (
            <option key={r} value={r}>
              {ROLE_OPTION_LABEL[r]}
            </option>
          ))}
        </select>
        <button
          type="button"
          className="dr-btn dr-btn--primary dr-btn--sm"
          data-testid="access-request-approve"
          disabled={busy}
          onClick={() => void decide(true)}
        >
          Approve
        </button>
        <button
          type="button"
          className="dr-btn dr-btn--sm"
          data-testid="access-request-deny"
          disabled={busy}
          onClick={() => void decide(false)}
        >
          Deny
        </button>
      </div>
    </li>
  )
}

// ---- visibility ----------------------------------------------------------------------------------

function VisibilitySection({
  board,
  workspaceName,
  editable,
  linkNote = null,
  onChange,
}: {
  board: Board
  workspaceName: string
  editable: boolean
  /** For people who cannot manage access: an open link also lets people in (PRI-07). */
  linkNote?: string | null
  onChange(v: BoardVisibility): Promise<void>
}) {
  const id = useId()
  const [pending, setPending] = useState(false)
  const current = VISIBILITY_OPTIONS.find((o) => o.value === board.visibility)
  return (
    <section className="dr-share__section">
      <label htmlFor={id} className="dr-share__heading">
        Workspace access
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
          {linkNote && (
            <p className="dr-share__hint dr-sharing__linknote" data-testid="share-link-note">
              {linkNote}
            </p>
          )}
        </div>
      </div>
    </section>
  )
}

// ---- people --------------------------------------------------------------------------------------

function Avatar({ user }: { user: { id: string; name: string; color: string } }) {
  return (
    <span
      className="dr-avatar dr-avatar--static"
      style={{ background: safeColor(user.color, user.id) }}
      aria-hidden="true"
    >
      {initialsFor(user.name)}
    </span>
  )
}

function MemberRow({
  member,
  workspaceName,
  isSelf,
  editable,
  guest = false,
  transferable,
  pending,
  onRole,
  onRemove,
  onTransfer,
}: {
  member: Row
  workspaceName: string
  isSelf: boolean
  editable: boolean
  /** A name-only guest (wave 3): never an owner, so ownership is not offered. */
  guest?: boolean
  transferable: boolean
  pending: boolean
  onRole(role: BoardRole): void
  onRemove(): void
  onTransfer(): void
}) {
  const selectId = useId()
  const [confirming, setConfirming] = useState(false)
  const [confirmingRemove, setConfirmingRemove] = useState(false)
  const { user } = member
  const [baseName, marker] = splitGuestMarker(user.name)
  const detailed = member.grant !== undefined && member.workspaceRole !== undefined
  const detail = detailed ? (member as unknown as AccessDetail) : null
  const source = detail
    ? accessSource(detail, workspaceName, (iso, kind) => (kind === 'time' ? shortTime(iso) : shortDate(iso)))
    : member.source === 'workspace'
      ? 'Access through the workspace'
      : ''
  const fallback = detail ? removalNote(detail) : null
  // A workspace-derived role with a lower direct grant: the select edits the grant, not the effective role.
  const selectValue = detail?.grant ?? member.role
  return (
    <li
      className="dr-member"
      data-testid="member-row"
      data-user-id={user.id}
      data-role={member.role}
      data-source={member.source}
      data-guest={guest || undefined}
      aria-busy={pending || undefined}
    >
      <Avatar user={user} />
      <div className="dr-member__text">
        {marker ? (
          // Wave 3 (guests): a long name is cut, never the "(guest)" marker (phone widths).
          <span className="dr-member__name dr-member__name--guest">
            <span className="dr-member__name-text">{baseName}</span>
            <span className="dr-member__marker" data-testid="member-guest-marker">
              {marker}
            </span>
            {isSelf && <span className="dr-member__you"> (you)</span>}
          </span>
        ) : (
          <span className="dr-member__name">
            {user.name}
            {isSelf && <span className="dr-member__you"> (you)</span>}
          </span>
        )}
        <span className="dr-member__sub" data-testid="member-source">
          {user.handle ? `@${user.handle}` : ''}
          {source ? `${user.handle ? ' · ' : ''}${source}` : ''}
        </span>
        {editable && !isSelf && fallback && (
          <span className="dr-sharing__fallback" data-testid="member-fallback">
            {fallback}
          </span>
        )}
        {confirming && (
          <fieldset className="dr-sharing__confirm">
            <legend className="dr-sr-only">Transfer ownership to {user.name}</legend>
            Make {user.name} the owner? You become an editor.{' '}
            <button
              type="button"
              className="dr-btn dr-btn--primary dr-btn--sm"
              data-testid="member-transfer-confirm"
              onClick={() => {
                setConfirming(false)
                onTransfer()
              }}
            >
              Transfer
            </button>{' '}
            <button type="button" className="dr-btn dr-btn--sm" onClick={() => setConfirming(false)}>
              Cancel
            </button>
          </fieldset>
        )}
        {confirmingRemove && (
          <fieldset className="dr-sharing__confirm" data-testid="member-remove-confirm-box">
            <legend className="dr-sr-only">Remove {user.name}</legend>
            <span data-testid="member-remove-question">{removeConfirmText(user.name, fallback)}</span>{' '}
            <button
              type="button"
              className="dr-btn dr-btn--sm dr-sharing__danger"
              data-testid="member-remove-confirm"
              // biome-ignore lint/a11y/noAutofocus: the confirmation the remove button just asked for
              autoFocus
              onClick={() => {
                setConfirmingRemove(false)
                onRemove()
              }}
            >
              Remove
            </button>{' '}
            <button
              type="button"
              className="dr-btn dr-btn--sm"
              data-testid="member-remove-cancel"
              onClick={() => setConfirmingRemove(false)}
            >
              Cancel
            </button>
          </fieldset>
        )}
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
            value={selectValue}
            disabled={pending}
            onChange={(e) => onRole(e.target.value as BoardRole)}
          >
            {BOARD_ROLES.filter((r) => !(guest && r === 'owner')).map((r) => (
              <option key={r} value={r}>
                {ROLE_OPTION_LABEL[r]}
              </option>
            ))}
          </select>
          {transferable && !confirming && (
            <button
              type="button"
              className="dr-iconbtn"
              data-testid="member-transfer"
              aria-label={`Transfer ownership to ${user.name}`}
              title="Transfer ownership"
              disabled={pending}
              onClick={() => setConfirming(true)}
            >
              <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
                <path
                  d="M4 17l3-9 5 5 5-5 3 9zM4 20h16"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.8"
                  strokeLinejoin="round"
                />
              </svg>
            </button>
          )}
          <button
            type="button"
            className="dr-iconbtn"
            data-testid="member-remove"
            aria-label={`Remove ${user.name}'s invite to this board`}
            title={fallback ?? 'Remove from board'}
            disabled={pending || confirmingRemove}
            onClick={() => setConfirmingRemove(true)}
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

// ---- links ---------------------------------------------------------------------------------------

function InviteLinkSection({
  boardId,
  invitations,
  onChange,
}: {
  boardId: string
  invitations: readonly PendingInvitation[]
  onChange(): void
}) {
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
      onChange()
    } catch (e) {
      setError(isApiError(e) ? e.message : 'The invite link could not be created.')
    } finally {
      setPending(false)
    }
  }

  const revoke = async (id: string) => {
    setPending(true)
    setError(null)
    try {
      await api.revokeInvitation(id)
      if (created?.id === id) setCreated(null)
      onChange()
    } catch (e) {
      setError(isApiError(e) ? e.message : 'The invite link could not be revoked.')
    } finally {
      setPending(false)
    }
  }

  const others = invitations.filter((i) => i.id !== created?.id)

  return (
    <section className="dr-share__section" aria-labelledby={`${roleId}-h`}>
      <h3 id={`${roleId}-h`} className="dr-share__heading">
        One-time invite links
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
          className="dr-btn"
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
            {copied ? 'Copied to your clipboard. ' : ''}This link is shown only once and works for one person.
            Whoever opens it and signs in joins as “{ROLE_OPTION_LABEL[role]}” until{' '}
            {formatDateTime(created.expiresAt)}.{' '}
            <button
              type="button"
              className="dr-linkbtn"
              data-testid="invite-revoke"
              onClick={() => void revoke(created.id)}
            >
              Revoke link
            </button>
          </p>
        </div>
      )}
      {others.length > 0 && (
        <ul className="dr-sharing__links" aria-label="Unused invite links">
          {others.map((i) => (
            <li
              key={i.id}
              className="dr-sharing__link"
              data-testid="invitation-row"
              data-invitation-id={i.id}
            >
              <span className="dr-sharing__link-text">
                Unused link · {ROLE_OPTION_LABEL[i.role]} · expires {shortDate(i.expiresAt)} · by{' '}
                {i.createdBy.name}
              </span>
              <button
                type="button"
                className="dr-linkbtn"
                data-testid="invitation-revoke"
                disabled={pending}
                onClick={() => void revoke(i.id)}
              >
                Revoke
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

/**
 * Workshop link (RETRO-04a): one EDIT link for a live session. Anyone with it can edit after signing
 * in, for a few hours (3 by default, 24 at most, "+1 h" while it runs); the edit access it gave ends
 * with it. Same machinery as review links (multi-use invitations).
 */
function WorkshopLinksSection({
  boardId,
  focusAsk = 0,
  links,
  onChange,
}: {
  boardId: string
  /** R2-11: bumped by "Workshop link (guests can edit)": let guests in, and bring Create into view. */
  focusAsk?: number
  links: readonly PendingInvitation[]
  onChange(): void
}) {
  const hoursId = useId()
  const [hours, setHours] = useState<number>(WORKSHOP_LINK_DEFAULT_HOURS)
  const [allowGuests, setAllowGuests] = useState<boolean>(WORKSHOP_LINK_GUESTS_DEFAULT)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [justCreated, setJustCreated] = useState<{ id: string; copied: boolean } | null>(null)
  const sectionRef = useRef<HTMLElement>(null)
  const createRef = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    if (focusAsk <= 0) return
    setAllowGuests(true)
    // After "More ways to share" has opened (its own effect, same commit): scroll and focus.
    let frame = requestAnimationFrame(() => {
      frame = requestAnimationFrame(() => {
        sectionRef.current?.scrollIntoView({ block: 'nearest' })
        createRef.current?.focus()
      })
    })
    return () => cancelAnimationFrame(frame)
  }, [focusAsk])

  const create = async () => {
    setPending(true)
    setError(null)
    try {
      const link = await sharing.createReviewLink(boardId, {
        role: 'editor',
        expiresInHours: hours,
        allowGuests,
      })
      setJustCreated({ id: link.id, copied: await copyText(link.url) })
      onChange()
    } catch (e) {
      setError(isApiError(e) ? e.message : 'The workshop link could not be created.')
    } finally {
      setPending(false)
    }
  }

  return (
    <section
      ref={sectionRef}
      className="dr-share__section"
      aria-labelledby={`${hoursId}-h`}
      data-testid="workshop-links"
    >
      <h3 id={`${hoursId}-h`} className="dr-share__heading">
        Workshop link
      </h3>
      <p className="dr-share__hint" data-testid="workshop-link-hint">
        {workshopLinkHint(allowGuests)}
      </p>
      {/* R15: the guest choice comes before Create, and applies to the link it makes. */}
      <GuestsOption testId="workshop-link-guests" checked={allowGuests} onChange={setAllowGuests} />
      <div className="dr-row dr-row--wrap dr-sharing__create">
        <label htmlFor={hoursId} className="dr-sr-only">
          Workshop link works for
        </label>
        <select
          id={hoursId}
          className="dr-input dr-select dr-select--compact"
          data-testid="workshop-link-expiry"
          value={hours}
          onChange={(e) => setHours(Number(e.target.value))}
        >
          {WORKSHOP_LINK_HOUR_OPTIONS.map((h) => (
            <option key={h} value={h}>
              For {hoursLabel(h)}
            </option>
          ))}
        </select>
        <button
          ref={createRef}
          type="button"
          className="dr-btn"
          data-testid="workshop-link-create"
          disabled={pending}
          onClick={() => void create()}
        >
          Create workshop link
        </button>
      </div>
      {error && (
        <p className="dr-share__error" role="alert">
          {error}
        </p>
      )}
      {links.length > 0 && (
        <ul className="dr-sharing__links" aria-label="Open workshop links">
          {links.map((l) => (
            <ReviewLinkRow
              key={l.id}
              boardId={boardId}
              link={l}
              workshop
              copiedOnCreate={justCreated?.id === l.id && justCreated.copied}
              onChange={onChange}
            />
          ))}
        </ul>
      )}
    </section>
  )
}

/**
 * "Share with a client" (DANA-03 / F3): a review link, the path most people open this dialog for.
 * Comment, 14 days and "join with just a name" are preselected; the guest option sits above the one
 * button, which creates the link and copies it. Role and expiry stay one select away.
 */
function ClientLinkSection({
  boardId,
  links,
  onChange,
}: {
  boardId: string
  links: readonly PendingInvitation[]
  onChange(): void
}) {
  const roleId = useId()
  const daysId = useId()
  const [role, setRole] = useState<'viewer' | 'commenter'>(CLIENT_LINK_DEFAULTS.role)
  const [days, setDays] = useState<number>(REVIEW_LINK_DEFAULT_DAY)
  const [allowGuests, setAllowGuests] = useState<boolean>(CLIENT_LINK_DEFAULTS.allowGuests)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [justCreated, setJustCreated] = useState<{ id: string; copied: boolean } | null>(null)

  const create = async () => {
    setPending(true)
    setError(null)
    try {
      const link = await sharing.createReviewLink(boardId, { role, expiresInDays: days, allowGuests })
      setJustCreated({ id: link.id, copied: await copyText(link.url) })
      onChange()
      // DANA2-01: the first client link may have turned exporting off. The board event says so too,
      // but this dialog also opens from the dashboard, where no board events arrive.
      refreshExportPolicy(api, boardId).catch(() => {})
    } catch (e) {
      setError(isApiError(e) ? e.message : 'The review link could not be created.')
    } finally {
      setPending(false)
    }
  }

  return (
    <section
      className="dr-share__section dr-sharing__client"
      aria-labelledby={`${roleId}-h`}
      data-testid="share-client"
    >
      <h3 id={`${roleId}-h`} className="dr-share__heading dr-sharing__client-heading">
        Share with a client
      </h3>
      <p className="dr-share__hint" data-testid="review-link-hint">
        {clientLinkHint(role, allowGuests)}
      </p>
      <GuestsOption testId="review-link-guests" checked={allowGuests} onChange={setAllowGuests} />
      <ClientExportLine boardId={boardId} />
      <div className="dr-row dr-row--wrap dr-sharing__create">
        <label htmlFor={roleId} className="dr-sr-only">
          What people with the review link can do
        </label>
        <select
          id={roleId}
          className="dr-input dr-select dr-select--compact"
          data-testid="review-link-role"
          value={role}
          onChange={(e) => setRole(e.target.value as 'viewer' | 'commenter')}
        >
          <option value="commenter">Can comment</option>
          <option value="viewer">Can view</option>
        </select>
        <label htmlFor={daysId} className="dr-sr-only">
          Link expires after
        </label>
        <select
          id={daysId}
          className="dr-input dr-select dr-select--compact"
          data-testid="review-link-expiry"
          value={days}
          onChange={(e) => setDays(Number(e.target.value))}
        >
          {REVIEW_LINK_DAY_OPTIONS.map((d) => (
            <option key={d} value={d}>
              Expires in {daysLabel(d)}
            </option>
          ))}
        </select>
        <button
          type="button"
          className="dr-btn dr-btn--primary"
          data-testid="review-link-create"
          disabled={pending}
          aria-busy={pending || undefined}
          onClick={() => void create()}
        >
          {pending ? 'Creating…' : 'Create and copy link'}
        </button>
      </div>
      {error && (
        <p className="dr-share__error" role="alert">
          {error}
        </p>
      )}
      {links.length > 0 && (
        <ul className="dr-sharing__links" aria-label="Open review links">
          {links.map((l) => (
            <ReviewLinkRow
              key={l.id}
              boardId={boardId}
              link={l}
              copiedOnCreate={justCreated?.id === l.id && justCreated.copied}
              onChange={onChange}
            />
          ))}
        </ul>
      )}
    </section>
  )
}

/**
 * R2-11: the retro path, right under the client card. A client link only lets people comment, so a
 * facilitator who needs everyone to add notes and vote gets the workshop (edit) link from here: one
 * click opens it under "More ways to share" with guests let in, and puts the focus on its Create.
 * Once a workshop link is open, that section opens by itself with the dialog, so this is not shown.
 */
function WorkshopShortcut({ onOpen }: { onOpen(): void }) {
  return (
    <p className="dr-share__hint dr-sharing__workshop-shortcut" data-testid="share-workshop-shortcut">
      <span>Running a retro or workshop? A client link only lets people comment.</span>{' '}
      <button type="button" className="dr-linkbtn" data-testid="share-workshop-open" onClick={onOpen}>
        Workshop link (guests can edit)
      </button>
    </p>
  )
}

/**
 * DANA-03: workshop link, invite by email and one-time invite links, behind one native disclosure
 * (keyboard and screen readers get its expanded state for free). It opens by itself once, on the
 * first load, when a workshop link is running; the person's own toggling wins after that.
 */
function MoreWaysToShare({
  workshopLinks,
  unusedInvites,
  openAsk = 0,
  children,
}: {
  /** Open workshop links; null until the invitations have loaded. */
  workshopLinks: number | null
  unusedInvites: number
  /** R2-11: bumped by "Workshop link (guests can edit)": open. */
  openAsk?: number
  children: ReactNode
}) {
  const [open, setOpen] = useState(false)
  // Whether the first load has decided the opening state (from then on, only the person toggles it).
  const [settled, setSettled] = useState(false)
  useEffect(() => {
    if (settled || workshopLinks === null) return
    setSettled(true)
    if (workshopLinks > 0) setOpen(true)
  }, [settled, workshopLinks])
  useEffect(() => {
    if (openAsk <= 0) return
    setSettled(true)
    setOpen(true)
  }, [openAsk])
  return (
    <details
      className="dr-share__section dr-sharing__more"
      data-testid="share-more"
      data-loaded={settled}
      open={open}
      onToggle={(e) => setOpen(e.currentTarget.open)}
    >
      <summary className="dr-sharing__more-summary" data-testid="share-more-toggle">
        <span className="dr-sharing__more-title">More ways to share</span>
        <span className="dr-sharing__more-sub" data-testid="share-more-summary">
          {moreWaysSummary({ workshopLinks: workshopLinks ?? 0, unusedInvites })}
        </span>
      </summary>
      {children}
    </details>
  )
}

/**
 * Wave 3 (guests): "Anyone with the link can join with just a name (no account)". On for a client
 * link, off for a workshop (edit) link; always above the Create button it applies to. The server
 * keeps guests to this board and marks their name everywhere.
 */
function GuestsOption({
  testId,
  checked,
  onChange,
}: {
  testId: string
  checked: boolean
  onChange(next: boolean): void
}) {
  const hintId = useId()
  return (
    <div className="dr-sharing__guests">
      <label className="dr-sharing__check">
        <input
          type="checkbox"
          data-testid={testId}
          checked={checked}
          aria-describedby={hintId}
          onChange={(e) => onChange(e.target.checked)}
        />
        Anyone with the link can join with just a name (no account)
      </label>
      <p id={hintId} className="dr-share__hint">
        Guests show as “Name (guest)”, reach only this board, and lose access when the link ends or is
        revoked.
      </p>
    </div>
  )
}

function ReviewLinkRow({
  boardId,
  link,
  copiedOnCreate,
  workshop = false,
  onChange,
}: {
  boardId: string
  link: PendingInvitation
  copiedOnCreate: boolean
  /** A workshop (edit) link: ends at a time of day, and offers "+1 h". */
  workshop?: boolean
  onChange(): void
}) {
  const [copied, setCopied] = useState(copiedOnCreate)
  const [confirming, setConfirming] = useState(false)
  const [removeAccess, setRemoveAccess] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const kindName = workshop ? 'workshop link' : 'review link'
  const revoke = async () => {
    setBusy(true)
    setError(null)
    try {
      await sharing.revokeReviewLink(boardId, link.id, removeAccess)
      onChange()
    } catch (e) {
      setError(isApiError(e) ? e.message : `The ${kindName} could not be revoked.`)
      setBusy(false)
    }
  }
  const extend = async () => {
    setBusy(true)
    setError(null)
    try {
      await sharing.extendReviewLink(boardId, link.id, 1)
      onChange()
    } catch (e) {
      setError(isApiError(e) ? e.message : 'The link could not be extended.')
    } finally {
      setBusy(false)
    }
  }
  const joined = link.uses === 1 ? '1 person joined' : `${link.uses} people joined`
  return (
    <li
      className="dr-sharing__link dr-sharing__link--review"
      data-testid={workshop ? 'workshop-link-row' : 'review-link-row'}
      data-invitation-id={link.id}
      data-expires-at={link.expiresAt}
      data-allow-guests={link.allowGuests}
    >
      <div className="dr-sharing__link-main">
        {/* F13: what the link is, then its actions on the same line ("+1 h" and "Revoke…" at their own
            size, never stretched across the row); the URL and Copy below. */}
        <div className="dr-sharing__link-head">
          <span className="dr-sharing__link-text">
            <strong>{ROLE_OPTION_LABEL[link.role]}</strong> · until{' '}
            {workshop ? shortTime(link.expiresAt) : shortDate(link.expiresAt)} · {joined}
            {link.maxUses ? ` (max ${link.maxUses})` : ''}
            {link.allowGuests && (
              <>
                {' · '}
                <span data-testid="link-guests-allowed">guests can join with a name</span>
              </>
            )}
          </span>
          <span className="dr-sharing__link-actions">
            {workshop && (
              <button
                type="button"
                className="dr-btn dr-btn--sm dr-sharing__extend"
                data-testid="workshop-link-extend"
                disabled={busy || !canExtend(link)}
                title={
                  canExtend(link)
                    ? 'One more hour'
                    : `Workshop links last at most 24 hours (until ${shortTime(link.maxExpiresAt ?? link.expiresAt)})`
                }
                onClick={() => void extend()}
              >
                +1 h
              </button>
            )}
            {!confirming && (
              <button
                type="button"
                className="dr-linkbtn dr-sharing__revoke"
                data-testid="review-link-revoke"
                onClick={() => setConfirming(true)}
              >
                Revoke…
              </button>
            )}
          </span>
        </div>
        {link.url ? (
          <div className="dr-row">
            <input
              className="dr-input dr-invite__link"
              data-testid="review-link-url"
              aria-label={workshop ? 'Workshop link' : 'Review link'}
              value={link.url}
              readOnly
              onFocus={(e) => e.currentTarget.select()}
            />
            <button
              type="button"
              className="dr-btn dr-btn--sm"
              data-testid="review-link-copy"
              onClick={async () => setCopied(await copyText(link.url ?? ''))}
            >
              {copied ? 'Copied' : 'Copy'}
            </button>
          </div>
        ) : (
          <span className="dr-share__hint">This link can’t be shown again. Create a new one to share.</span>
        )}
        {confirming && (
          <fieldset className="dr-sharing__confirm">
            <legend className="dr-sr-only">{workshop ? 'Revoke workshop link' : 'Revoke review link'}</legend>
            {link.uses > 0 && (
              <label className="dr-sharing__check">
                <input
                  type="checkbox"
                  data-testid="review-link-remove-access"
                  checked={removeAccess}
                  onChange={(e) => setRemoveAccess(e.target.checked)}
                />
                Also remove the {joined.replace(' joined', '')} who joined through it
              </label>
            )}
            <button
              type="button"
              className="dr-btn dr-btn--sm dr-sharing__danger"
              data-testid="review-link-revoke-confirm"
              disabled={busy}
              onClick={() => void revoke()}
            >
              Revoke link
            </button>
            <button type="button" className="dr-btn dr-btn--sm" onClick={() => setConfirming(false)}>
              Cancel
            </button>
          </fieldset>
        )}
        {error && (
          <span className="dr-share__error" role="alert">
            {error}
          </span>
        )}
      </div>
    </li>
  )
}

function CopyBoardLink({ boardId }: { boardId: string }) {
  const [copied, setCopied] = useState<boolean | null>(null)
  const url = absoluteUrl(boardPath(boardId))
  return (
    <footer className="dr-sharing__footer">
      <button
        type="button"
        className="dr-btn"
        data-testid="share-copy-link"
        onClick={async () => setCopied(await copyText(url))}
      >
        <svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true">
          <path
            d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.9"
            strokeLinecap="round"
          />
        </svg>
        {copied ? 'Board link copied' : 'Copy board link'}
      </button>
      <span className="dr-share__hint" role="status">
        {copied === false
          ? `Copy this link: ${url}`
          : 'Only people with access can open it. Anyone else who opens it can request access.'}
      </span>
    </footer>
  )
}
