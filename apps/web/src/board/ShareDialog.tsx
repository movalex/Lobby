// The Share dialog (PRS-02..04 + review links): invite by @handle/email or from the workspace, invite
// by email (sent through Clerk when this server signs in with it; a link to copy otherwise), pending
// access requests, workspace-wide access, who has access and through which grant (with transfer of
// ownership), single-use invite links and multi-use review links. Board owners manage; everyone else
// sees who has access and can ask for more. The API enforces every rule; this only offers what the
// shared permission rules allow.
//
// Order (K5-5, wave K; P-022, wave P: one way in, then who is in, then the link): "Invite people" first, ONE field
// with a role (it lists the people whose @handle or name starts with what is typed, and every person who can still
// be given access when it is clicked empty: ../features/sharing/InviteField.tsx; it was a second "Or pick someone
// from the workspace" row), pending requests, "People with access", "Board link" (who can open it with the link, and
// Copy board link, one section), then the
// collapsed "Guests and clients" (the client review link: comment, 14 days, join with just a name, created
// and copied by one button; the workshop link; invite by email; one-time invite links; its summary names
// what is open inside, and it opens by itself while a client or workshop link is open), then the collapsed "Advanced"
// (export and download; its summary says the setting), then the workspace's members. The dialog keeps its top edge
// as it grows (sharing.css), and the hint under the field keeps room for two lines. Someone who may only
// reduce access sees every open link and the export setting without unfolding anything. Every guest option
// sits above its Create button and applies to the link that button makes (once a link is open, the box says
// "for the next link"); a link that exists has its own box in its row (G2: PATCH review-links/:id).
//
// Wave J (outside markers): people outside Dark Burn / TPG carry an "External" tag with their verified
// email domain (the server's manager-only fields) in every list here: who has access, access requests,
// the workspace picker and the workspace members; an account Lobby never checked says "Not confirmed".
// The picker (and a typed @handle) gets the fields as this board's manager (?boardId=), so a board
// owner who is a plain workspace member sees them too. Before inviting an outside address (the
// server's address check decides, exceptions list included; when the check fails, nothing is
// invited), approving an outside account's request or giving one a grant or a higher role, the dialog
// asks once per person while it is open. While the board's workspace or project is internal only it says so and
// offers no link to create; the server refuses the rest (409 INTERNAL_ONLY, its message shown as is).

import {
  type AccessRequest,
  AddressCheckResult,
  type Board,
  type BoardMember,
  DOMAIN_ACCESS_CODES,
  type EmailInviteResult,
  INTERNAL_ONLY_MESSAGES,
  type InvitationCreated,
  ListWorkspaceMembersResponse,
  type OutsideStatus,
  outsideConfirmText,
  type PendingInvitation,
  type RequestableRole,
  type ReviewLinkCreated,
  type ShareState,
  type WorkspaceMember,
} from '@draftroom/contracts'
import { type ReactNode, useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import { api, isApiError } from '../api/client.ts'
import { useSession } from '../auth/session.tsx'
import { OutsideConfirm, OutsideStatusTag } from '../features/people/ExternalTag.tsx'
import { useBoardOutside } from '../features/people/outside.ts'
import { reviewFlags } from '../features/review/flags.ts'
import { openAsReviewPageDefault } from '../features/review-page/landing.ts'
import { announceShareChanged, SHARE_REMOTE_EVENT, sharingApi } from '../features/sharing/api.ts'
import {
  CLOSED,
  InviteHint,
  InviteInput,
  SuggestionList,
  type SuggestState,
  suggestionKey,
} from '../features/sharing/InviteField.tsx'
import {
  canExtend,
  createdSaying,
  daysLabel,
  hoursLabel,
  REVIEW_LINK_DAY_OPTIONS,
  REVIEW_LINK_DEFAULT_DAY,
  shortDate,
  shortTime,
  WORKSHOP_LINK_DEFAULT_HOURS,
  WORKSHOP_LINK_HOUR_OPTIONS,
} from '../features/sharing/model.ts'
import { ClientExportLine, ExportPolicySection } from '../features/sharing/ported/ExportPolicySection.tsx'
import { exportStateOf, refreshExportPolicy } from '../features/sharing/ported/export-policy.ts'
import { RequestAccess } from '../features/sharing/RequestAccess.tsx'
import '../features/sharing/sharing.css'
import { fetchBoardGuests, useIsGuest } from '../invite/guest.tsx'
import { splitGuestMarker } from '../invite/model.ts'
import { absoluteUrl } from '../lib/clipboard.ts'
import { formatDateTime, formatRelativeTime } from '../lib/format.ts'
import { initialsFor, safeColor } from '../lib/identity.ts'
import {
  type BoardRole,
  type BoardVisibility,
  can,
  canHandOutAccess,
  type WorkspaceRole,
} from '../lib/permissions.ts'
import { boardPath } from '../lib/routing.ts'
import { useValue } from '../lib/signals.ts'
import { useResource } from '../lib/useResource.ts'
import { Dialog } from '../ui/Dialog.tsx'
import { boardLinkCopyFailed, copyBounded, copyFailedText, copyNote } from './share-copy.ts'
import {
  type AccessDetail,
  ADDRESS_CHECK_FAILED,
  ADVANCED_SECTION_TITLE,
  accessSource,
  advancedSummary,
  asksBeforeGiving,
  CLIENT_LINK_DEFAULTS,
  checkInviteEmail,
  clientLinkHint,
  type EmailInviteOutcome,
  emailInviteHint,
  emailInviteOutcome,
  GUESTS_SECTION_TITLE,
  GUESTS_TOGGLE_LABEL,
  grantEditable,
  guestsOptionLabel,
  guestsSummary,
  guestsToggleSaying,
  type InviteTarget,
  internalOnlyNote,
  inviteHintText,
  invitePlan,
  inviteRoleOptions,
  isOwnAddress,
  linkAccessLine,
  listShowsOwnerNote,
  lockedLinkNote,
  memberRoleChoices,
  OWN_ADDRESS_MESSAGE,
  OWNER_NEEDS_CREATOR,
  OWNER_NEEDS_CREATOR_NOTE,
  type OwnerNoteRow,
  outsideConfirmFor,
  outsideWho,
  parseInviteTarget,
  pendingInviteLabel,
  pickedText,
  ROLE_OPTION_LABEL,
  raisesAccess,
  removalNote,
  removeConfirmText,
  rowNeedsOwnerNote,
  shareableWorkspaceMembers,
  shareCreatorNote,
  sortMembers,
  targetFor,
  VISIBILITY_OPTIONS,
  visibilityChoices,
  WORKSHOP_LINK_GUESTS_DEFAULT,
  workshopLinkHint,
} from './share-model.ts'

const sharing = sharingApi(api)

/**
 * A person with access; managers get the detailed fields (grant, workspace role, links, canOwn) and,
 * from wave J, whether they are outside Dark Burn / TPG.
 */
type Row = BoardMember &
  Partial<Omit<AccessDetail, 'user' | 'role' | 'source'>> & {
    canOwn?: boolean
    outside?: OutsideStatus
    emailDomain?: string | null
    emailHint?: string | null
  }

// ---- wave J: the one-time confirm before giving someone outside access -----------------------------

/**
 * People (`user:<id>`) and addresses (`email:<address>`) the open Share dialog already asked about. One
 * dialog is open at a time; it empties the set when it opens and when it closes.
 */
const askedInDialog = new Set<string>()

/**
 * `confirm(key, text, yes)` shows the confirm (`box`, where the section renders it) and resolves with the
 * answer; at once with true for someone this dialog already asked about.
 */
function useOutsideAsk() {
  const asked = askedInDialog
  const [ask, setAsk] = useState<{ text: string; yes: string; done(ok: boolean): void } | null>(null)
  const confirm = useCallback(
    (key: string, text: string, yes: string): Promise<boolean> => {
      if (asked.has(key)) return Promise.resolve(true)
      return new Promise<boolean>((resolve) =>
        setAsk({
          text,
          yes,
          done: (ok) => {
            setAsk(null)
            if (ok) asked.add(key)
            resolve(ok)
          },
        }),
      )
    },
    [asked],
  )
  const box = ask ? (
    <OutsideConfirm text={ask.text} yes={ask.yes} onYes={() => ask.done(true)} onNo={() => ask.done(false)} />
  ) : null
  return { confirm, box }
}

/** The server's word on an address: its answer, an api from before wave J, or a failed check. */
type AddressAnswer =
  | { kind: 'checked'; result: AddressCheckResult }
  | { kind: 'older-api' }
  | { kind: 'failed'; message: string }

async function checkAddress(boardId: string, email: string): Promise<AddressAnswer> {
  try {
    const result = await api.request(
      'POST',
      `/api/boards/${encodeURIComponent(boardId)}/sharing/address-check`,
      { body: { email }, schema: AddressCheckResult },
    )
    return { kind: 'checked', result }
  } catch (e) {
    // Only an api without the route (404) asks nothing: it predates the rule. Anything else (429,
    // 503, the network) is said, and nothing is invited, so the question is never skipped silently.
    if (isApiError(e) && e.kind === 'not-found') return { kind: 'older-api' }
    const message =
      isApiError(e) && e.kind !== 'network' && e.kind !== 'server' ? e.message : ADDRESS_CHECK_FAILED
    return { kind: 'failed', message }
  }
}

/**
 * Before an invitation to an address: asks when it is outside (once per address); says why when the
 * board is internal only (the server would refuse it) or the check failed. `ok: false` means: create
 * nothing (`refused`: what to say instead).
 */
async function confirmAddress(
  boardId: string,
  email: string,
  confirm: ReturnType<typeof useOutsideAsk>['confirm'],
): Promise<{ ok: boolean; refused: string | null }> {
  const answer = await checkAddress(boardId, email)
  if (answer.kind === 'older-api') return { ok: true, refused: null }
  if (answer.kind === 'failed') return { ok: false, refused: answer.message }
  const r = answer.result
  if (!r.outside) return { ok: true, refused: null }
  if (r.internalOnly) return { ok: false, refused: INTERNAL_ONLY_MESSAGES[r.internalOnly] }
  return {
    ok: await confirm(`email:${r.email}`, outsideConfirmText(r.email), 'Invite anyway'),
    refused: null,
  }
}

/** Before giving an account access (a grant, a higher role, an approval): asks when it is outside. */
function confirmPerson(
  confirm: ReturnType<typeof useOutsideAsk>['confirm'],
  person: { user: { id: string; name: string }; outside?: OutsideStatus; emailHint?: string | null },
  yes: string,
): Promise<boolean> {
  if (!asksBeforeGiving(person.outside)) return Promise.resolve(true)
  return confirm(
    `user:${person.user.id}`,
    outsideConfirmFor(outsideWho(person.user.name, person.emailHint), person.outside),
    yes,
  )
}

/** A manager's detailed row (grant, workspace role, links), else null (the M1 list). */
function rowDetail(member: Row): AccessDetail | null {
  return member.grant !== undefined && member.workspaceRole !== undefined
    ? (member as unknown as AccessDetail)
    : null
}

/** The role a row's menu shows: a workspace-derived role with a lower direct grant edits the grant. */
const rowSelectValue = (member: Row): BoardRole => rowDetail(member)?.grant ?? member.role

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
  const session = useSession()
  // Invitation emails go out only through Clerk (the server has the final word per address).
  const canEmail = session.config?.providers.includes('clerk') ?? false
  // Domain access (docs/DOMAIN-ACCESS-CONTRACTS.md §9, D4): only creators hand out access (invitations,
  // links, extending, approving, raising a role or the visibility, transferring ownership). A manager
  // who is not a creator (a pre-existing outside owner) keeps every way to reduce access: revoke,
  // remove, lower, deny. The api refuses the rest with 403 CREATOR_REQUIRED.
  const access = session.state.status === 'signed-in' ? session.state.me.access : null
  const creator = access?.creator ?? false
  const canShare = canHandOutAccess(creator, effectiveRole, board.status)
  const reduceOnly = canManage && !canShare
  // An account Lobby could not confirm is told it is paused, never that it is not at Dark Burn Creative.
  const creatorNote = shareCreatorNote(access)
  // A name-only guest (wave 3) cannot ask for more access; the dialog says what they can do instead.
  const guest = useIsGuest()
  // Wave J: whom this dialog already asked about (asked once per person while it is open), and whether
  // the board is internal only (the board's outside list; null from an older api).
  useEffect(() => {
    askedInDialog.clear()
    return () => askedInDialog.clear()
  }, [])
  const { snap: outsideState } = useBoardOutside(board.id)
  const internalOnly = outsideState.internalOnly
  const mayCreateLinks = canShare && !internalOnly

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
  // Wave J: as this board's manager (`boardId`), the people come with their outside fields (the
  // picker's External tag and the confirm before adding one); an older api ignores the parameter.
  const wsLoad = useCallback(
    async (signal: AbortSignal): Promise<WorkspaceMember[]> => {
      if (!canManage) return []
      const path = `/api/workspaces/${encodeURIComponent(workspace.id)}/members?boardId=${encodeURIComponent(board.id)}`
      return (await api.request('GET', path, { schema: ListWorkspaceMembersResponse, signal })).members
    },
    [board.id, canManage, workspace.id],
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
  const canTransfer = canShare && self?.grant === 'owner'
  const selfRole = self?.role ?? effectiveRole
  const allInvites = invitations.data ?? []
  const reviewLinks = allInvites.filter((i) => i.kind === 'review' && i.role !== 'editor')
  const workshopLinks = allInvites.filter((i) => i.kind === 'review' && i.role === 'editor')
  const oneTimeInvites = allInvites.filter((i) => i.kind === 'invite')
  // The people list: which rows the caller can edit, and (domain access) why Owner is off for someone,
  // said once under the heading (`member-owner-note`) for every row it applies to.
  const ownerNoteId = useId()
  const people = sorted.map((m) => {
    const row: OwnerNoteRow & { member: Row } = {
      member: m,
      editable:
        canManage && (m.grant !== undefined ? grantEditable(m as AccessDetail) : m.source === 'grant'),
      guest: boardGuests.data?.has(m.user.id) ?? false,
      canOwn: m.canOwn,
      current: rowSelectValue(m),
    }
    return row
  })
  const ownerNote = listShowsOwnerNote(people, canShare)
  // "Guests and clients": the workshop link section, first in it when a link was running as the dialog opened
  // (decided once: moving it later would remount it and lose what its Create just said)
  const [workshopFirst, setWorkshopFirst] = useState<boolean | null>(null)
  // Wave K integration: decided in the render the invitations first arrive in (React renders again before
  // committing), not in an effect after it: the effect committed the section at the end for one frame and
  // then moved it up, a remount that detached its row (guests-sharing at 390 px: "not attached to the DOM")
  if (workshopFirst === null && invitations.data) setWorkshopFirst(workshopLinks.length > 0)
  const workshopSection = (
    <WorkshopLinksSection
      boardId={board.id}
      focusAsk={workshopAsk}
      links={workshopLinks}
      canCreate={!internalOnly}
      onChange={() => {
        invitations.reload()
        members.reload()
        changed()
      }}
    />
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
      <div className="dr-share dr-sharing">
        {/* Wave J: an internal-only workspace or project says so (the server refuses outside sharing). */}
        {canManage && internalOnly && (
          <p className="dr-share__note" role="note" data-testid="share-internal-only-note">
            {internalOnlyNote(internalOnly)}
          </p>
        )}
        {/* Domain access: a manager who is not a creator is told why nothing here hands out access. */}
        {reduceOnly && (
          <p
            className="dr-share__note dr-sharing__creator-note"
            role="note"
            data-testid="share-creator-note"
            data-reason={creatorNote.reason}
          >
            {creatorNote.text}
          </p>
        )}

        {/* K5-5: what most people open this dialog for comes first: inviting a colleague. */}
        {canShare && (
          <InvitePeople
            boardId={board.id}
            workspaceName={workspace.name}
            workspaceMembers={wsMembers.data ?? []}
            boardMembers={rows}
            addable={addable}
            canEmail={canEmail}
            ownEmail={access?.email ?? null}
            onGrant={(userId, r) => run('add', () => api.putMember(board.id, userId, r))}
            onLinkCreated={() => invitations.reload()}
          />
        )}

        {canManage && (requests.data?.length ?? 0) > 0 && (
          <AccessRequests
            requests={requests.data ?? []}
            canApprove={canShare}
            onDecided={() => {
              requests.reload()
              members.reload()
              changed()
            }}
          />
        )}

        <section className="dr-share__section" aria-labelledby="dr-share-people" data-testid="share-people">
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
          {members.data && ownerNote && (
            <p
              className="dr-share__hint dr-sharing__owner-note"
              id={ownerNoteId}
              data-testid="member-owner-note"
            >
              {OWNER_NEEDS_CREATOR_NOTE}
            </p>
          )}
          {members.data && (
            <ul className="dr-members" data-testid="member-list">
              {people.map(({ member: m, ...row }) => (
                <MemberRow
                  key={m.user.id}
                  member={m}
                  workspaceName={workspace.name}
                  isSelf={m.user.id === selfUserId}
                  editable={row.editable}
                  guest={row.guest}
                  canShare={canShare}
                  ownerNoteId={rowNeedsOwnerNote(row, canShare) ? ownerNoteId : undefined}
                  transferable={canTransfer && m.user.id !== selfUserId && m.role !== 'owner' && !row.guest}
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

        {/* P-022: the link and who can open it with it, right under who has access (PRI-07: and an open link,
            for people who cannot manage access). */}
        <BoardLink
          board={board}
          workspaceName={workspace.name}
          canRaise={canShare}
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

        {/* DANA-03 / K5-5: client and workshop links, invite by email and one-time links, one click away.
            The summary names what is open inside; an open link unfolds it on the first load (a
            facilitator's "+1 h" stays at hand). */}
        {canShare && (
          <GuestsAndClients
            reviewLinks={invitations.data ? reviewLinks.length : null}
            workshopLinks={invitations.data ? workshopLinks.length : null}
            unusedInvites={oneTimeInvites.length}
            linksAllowed={mayCreateLinks}
            openAsk={workshopAsk}
          >
            {/* a running workshop link (a live session) first, nearest the top */}
            {workshopFirst && workshopSection}
            {/* DANA-03 / F3: the one obvious path for a client. A review link that lets people comment for
                14 days and join with just a name; one button creates and copies it. */}
            {(mayCreateLinks || reviewLinks.length > 0) && (
              <ClientLinkSection
                boardId={board.id}
                links={reviewLinks}
                canCreate={mayCreateLinks}
                onChange={() => {
                  invitations.reload()
                  members.reload()
                  changed()
                }}
              />
            )}
            {mayCreateLinks && invitations.data && workshopLinks.length === 0 && (
              <WorkshopShortcut onOpen={() => setWorkshopAsk((n) => n + 1)} />
            )}
            {!workshopFirst && workshopSection}
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
              canCreate
              ownEmail={access?.email ?? null}
              onChange={() => invitations.reload()}
            />
          </GuestsAndClients>
        )}

        {/* Domain access: what is open, for someone who may only revoke it, in view (nothing to unfold). */}
        {reduceOnly && reviewLinks.length > 0 && (
          <ClientLinkSection
            boardId={board.id}
            links={reviewLinks}
            canCreate={false}
            onChange={() => {
              invitations.reload()
              members.reload()
              changed()
            }}
          />
        )}
        {reduceOnly && workshopLinks.length > 0 && (
          <WorkshopLinksSection
            boardId={board.id}
            links={workshopLinks}
            canCreate={false}
            onChange={() => {
              invitations.reload()
              members.reload()
              changed()
            }}
          />
        )}
        {reduceOnly && oneTimeInvites.length > 0 && (
          <InviteLinkSection
            boardId={board.id}
            invitations={oneTimeInvites}
            canCreate={false}
            ownEmail={access?.email ?? null}
            onChange={() => invitations.reload()}
          />
        )}

        {/* K5-5: the export setting, folded; open from the start for someone who may only reduce access. */}
        <Advanced boardId={board.id} defaultOpen={reduceOnly}>
          <ExportPolicySection
            boardId={board.id}
            role={effectiveRole}
            canManage={canManage}
            canCreateLinks={canShare}
          />
        </Advanced>

        {/* authz-006: the workspace's owners and admins manage its members (roles, removal) from here */}
        {canManage && wsMembers.data && (
          <WorkspaceMembersSection
            workspace={workspace}
            members={wsMembers.data}
            selfUserId={selfUserId}
            creator={creator}
            onChanged={(next) => {
              wsMembers.update(() => next)
              // a removal takes their grants on this board too; a role change can move their access here
              members.reload()
              changed()
            }}
          />
        )}
      </div>
    </Dialog>
  )
}

// ---- invite people -------------------------------------------------------------------------------

/** K5-5: a touch screen: the dialog does not open on a text field (that would raise the soft keyboard). */
function coarsePointer(): boolean {
  try {
    return typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches
  } catch {
    return false
  }
}

/** Exported for its markup test (features/sharing/invite-field.test.ts); the dialog is its one user. */
export function InvitePeople({
  boardId,
  workspaceName,
  workspaceMembers,
  boardMembers,
  addable,
  canEmail,
  ownEmail,
  onGrant,
  onLinkCreated,
  initialText = '',
  initialOpen = false,
}: {
  boardId: string
  workspaceName: string
  workspaceMembers: readonly WorkspaceMember[]
  boardMembers: readonly BoardMember[]
  /** Workspace members who can still be given access: the list a click on the empty field opens (P-022). */
  addable: readonly WorkspaceMember[]
  /** This server can email invitations (the "Invite by email" form below does). */
  canEmail: boolean
  /** The signed-in account's own address (`Me.access.email`): never locked a link to (fixer round 3). */
  ownEmail: string | null
  /** Resolves false when the grant failed (the dialog shows the server's reason). */
  onGrant(userId: string, role: BoardRole): Promise<boolean>
  onLinkCreated(): void
  /** What the field starts with (the markup test; the dialog starts empty). */
  initialText?: string
  /** The empty field starts with its list open (the markup test; the dialog starts closed). */
  initialOpen?: boolean
}) {
  const inputId = useId()
  const listId = useId()
  const hintId = useId()
  const roleId = useId()
  const inputRef = useRef<HTMLInputElement>(null)
  const roleRef = useRef<HTMLSelectElement>(null)
  const [text, setText] = useState(initialText)
  // K5-5: someone picked from the list (by id: two people may share a name), while the field still says them
  const [picked, setPicked] = useState<{ id: string; text: string } | null>(null)
  const [list, setList] = useState<SuggestState>(
    initialText.trim() || initialOpen ? { open: true, active: 0 } : CLOSED,
  )
  const [role, setRole] = useState<Exclude<BoardRole, 'owner'>>('editor')
  const [roleTouched, setRoleTouched] = useState(false)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<{ tone: 'info' | 'error'; text: string } | null>(null)
  const [link, setLink] = useState<{ url: string; email: string; role: BoardRole; expiresAt: string } | null>(
    null,
  )
  // null: the automatic copy has not settled yet (nothing is said about it meanwhile); false: it did not copy
  const [copied, setCopied] = useState<boolean | null>(null)
  const pickedMember =
    picked && picked.text === text ? workspaceMembers.find((m) => m.user.id === picked.id) : null
  const target: InviteTarget = pickedMember
    ? targetFor(pickedMember, boardMembers)
    : parseInviteTarget(text, workspaceMembers, boardMembers)
  // P-022: an empty field lists everyone who can be given access (the "Or pick someone from the workspace" row's job)
  const suggestions = target.kind === 'partial' ? target.matches : text.trim() === '' ? addable : []
  const { confirm, box } = useOutsideAsk()
  // Fixer round 3 (§21): said at once, while typing, and nothing is created for it.
  const ownAddress = target.kind === 'email' && isOwnAddress(target.email, ownEmail)
  const hasAccess = (userId: string) => boardMembers.some((b) => b.user.id === userId)

  // Default role (checklist decision 2): edit for workspace members, comment for everyone else.
  useEffect(() => {
    if (roleTouched) return
    setRole(target.kind === 'email' || target.kind === 'unknown' ? 'commenter' : 'editor')
  }, [target.kind, roleTouched])

  // K5-5: on a touch screen the dialog does not open on this field, which would raise the keyboard over it
  // (ui/Dialog.tsx starts on the first field of its body, after this runs: the next frame moves it on).
  useEffect(() => {
    if (!coarsePointer()) return
    const frame = requestAnimationFrame(() => {
      if (document.activeElement === inputRef.current) roleRef.current?.focus({ preventScroll: true })
    })
    return () => cancelAnimationFrame(frame)
  }, [])

  const pick = (m: WorkspaceMember) => {
    const next = pickedText(m)
    setText(next)
    setPicked({ id: m.user.id, text: next })
    setList(CLOSED)
    setNotice(null)
    inputRef.current?.focus()
  }

  const submit = async () => {
    setNotice(null)
    setLink(null)
    setCopied(null)
    // Domain access (D13): an address gets a single-use link that only that verified address can
    // accept; a name that is neither an address nor someone in the workspace gets nothing. K5-5: what
    // the hint already says is not said again (the hint is the one line about what is typed).
    const plan = invitePlan(target, ownEmail)
    switch (plan.kind) {
      case 'none':
      case 'already':
      case 'ask-email':
        inputRef.current?.focus()
        return
      case 'pick': {
        // one person starts with that: Invite picks them (granting is the next press); several: the list
        const [only] = plan.matches
        if (plan.matches.length === 1 && only) pick(only)
        else {
          setList({ open: true, active: 0 })
          inputRef.current?.focus()
        }
        return
      }
      case 'invalid-email':
      case 'own-address':
        setNotice({ tone: 'error', text: plan.message })
        return
    }
    // Wave J: someone outside Dark Burn / TPG is asked about first (once per person or address).
    if (plan.kind === 'grant' && !(await confirmPerson(confirm, plan.member, 'Give access'))) return
    if (plan.kind === 'locked-link') {
      const asked = await confirmAddress(boardId, plan.email, confirm)
      if (asked.refused) {
        setNotice({ tone: 'error', text: asked.refused })
        return
      }
      if (!asked.ok) return
    }
    setBusy(true)
    try {
      if (plan.kind === 'grant') {
        const ok = await onGrant(plan.member.user.id, role)
        if (!ok) return // the reason is shown with the people list
        setNotice({ tone: 'info', text: `${plan.member.user.name} can now open this board.` })
      } else {
        const inv: InvitationCreated = await api.createBoardInvitation(boardId, { role, email: plan.email })
        const url = inv.url.startsWith('/') ? absoluteUrl(inv.url) : inv.url
        setLink({ url, email: plan.email, role, expiresAt: inv.expiresAt })
        setCopied(await copyBounded(url))
        onLinkCreated()
      }
      setText('')
      setPicked(null)
      setRoleTouched(false)
    } catch (e) {
      setNotice({ tone: 'error', text: isApiError(e) ? e.message : 'That did not work. Try again.' })
    } finally {
      setBusy(false)
    }
  }

  const hint = inviteHintText(target, {
    workspaceName,
    canEmail,
    ownAddress,
    notice: notice?.text ?? null,
  })

  return (
    <section className="dr-share__section" aria-labelledby={`${inputId}-h`} data-testid="share-invite">
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
        <InviteInput
          id={inputId}
          listId={listId}
          hintId={hintId}
          inputRef={inputRef}
          value={text}
          state={list}
          count={suggestions.length}
          onChange={(next) => {
            setText(next)
            setNotice(null)
            // the list follows what is typed: open while it starts someone's name or handle
            setList(next.trim() ? { open: true, active: 0 } : CLOSED)
          }}
          onKey={(e) => {
            // an input method composing (Enter confirms its text, not a pick)
            if (e.nativeEvent.isComposing) return
            const r = suggestionKey(list, e.key, suggestions.length)
            if (r.handled) {
              e.preventDefault()
              // Escape closes the list, not the dialog
              e.stopPropagation()
            }
            setList(r.state)
            const m = r.pick === null ? null : suggestions[r.pick]
            if (m) pick(m)
          }}
          onOpen={() => {
            if (text.trim() === '' && addable.length > 0) setList({ open: true, active: 0 })
          }}
          onBlur={() => setList((l) => ({ ...l, open: false }))}
        />
        <label htmlFor={roleId} className="dr-sr-only">
          Role for the person you invite
        </label>
        <select
          ref={roleRef}
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
          {target.kind === 'email' ? 'Create invite link' : 'Invite'}
        </button>
        <SuggestionList
          id={listId}
          members={suggestions}
          state={list}
          hasAccess={hasAccess}
          onPick={pick}
          onHover={(i) => setList({ open: true, active: i })}
        />
      </form>
      {box}
      {/* K5-5: one line about what is typed (fixer round 4, §22: the own-address sentence is the alert
          below after a submit, never both). */}
      <InviteHint id={hintId} text={hint} />
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
              aria-label={`Invite link for ${link.email}`}
              value={link.url}
              readOnly
              onFocus={(e) => e.currentTarget.select()}
            />
            <button
              type="button"
              className="dr-btn"
              onClick={async () => setCopied(await copyBounded(link.url))}
            >
              {copied ? 'Copied' : 'Copy'}
            </button>
          </div>
          <p className="dr-share__hint" role="status" data-testid="share-invite-lock-note">
            {copyNote(copied, 'Copied. ', 'Copy')}
            {lockedLinkNote(link, formatDateTime)}
          </p>
        </div>
      )}
    </section>
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
  const { confirm, box } = useOutsideAsk()

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
    // Wave J: an address outside Dark Burn / TPG is asked about first (or refused while internal only).
    const asked = await confirmAddress(boardId, checked.email, confirm)
    if (asked.refused) {
      setFailure(asked.refused)
      return
    }
    if (!asked.ok) return
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
      {box}
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
          <span className="dr-share__hint" data-testid="share-email-copy-failed">
            {copyFailedText('“Copy link”')}
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
            onClick={async () => setCopied(await copyBounded(link))}
          >
            {copied ? 'Copied' : 'Copy link'}
          </button>
        </div>
      )}
    </section>
  )
}

// ---- access requests -----------------------------------------------------------------------------

function AccessRequests({
  requests,
  canApprove,
  onDecided,
}: {
  requests: readonly AccessRequest[]
  /** Domain access: only creators approve (it hands out access); anyone who manages access may deny. */
  canApprove: boolean
  onDecided(): void
}) {
  return (
    <section className="dr-share__section dr-sharing__requests" aria-labelledby="dr-share-requests">
      <h3 id="dr-share-requests" className="dr-share__heading">
        Access requests <span className="dr-sharing__count">{requests.length}</span>
      </h3>
      <ul className="dr-members" data-testid="access-request-list">
        {requests.map((r) => (
          <AccessRequestRow key={r.id} request={r} canApprove={canApprove} onDecided={onDecided} />
        ))}
      </ul>
    </section>
  )
}

function AccessRequestRow({
  request,
  canApprove,
  onDecided,
}: {
  request: AccessRequest
  canApprove: boolean
  onDecided(): void
}) {
  const roleId = useId()
  const [role, setRole] = useState<RequestableRole>(request.roleRequested)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const { user } = request
  const { confirm, box } = useOutsideAsk()
  const decide = async (approve: boolean) => {
    // Wave J: approving someone outside Dark Burn / TPG is asked about first (denying never is).
    if (approve && !(await confirmPerson(confirm, request, 'Approve'))) return
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
        <span className="dr-member__name">
          {user.name}
          <OutsideStatusTag outside={request.outside} domain={request.emailDomain} />
        </span>
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
        {box}
        {error && (
          <span className="dr-share__error" role="alert">
            {error}
          </span>
        )}
      </div>
      <div className="dr-member__actions">
        {canApprove && (
          <>
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
          </>
        )}
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

// ---- the board link ------------------------------------------------------------------------------

/**
 * P-022: "Board link": who can open it with the link (the board's workspace access: private, or everyone in the
 * workspace can view or edit) and Copy board link, one section (they were two, "Workspace access" under the people and
 * "Copy board link" at the foot). Exported for its markup test.
 */
export function BoardLink({
  board,
  workspaceName,
  editable,
  canRaise,
  linkNote = null,
  onChange,
}: {
  board: Board
  workspaceName: string
  editable: boolean
  /** Domain access: only creators widen workspace access; anyone who may change it can narrow it. */
  canRaise: boolean
  /** For people who cannot manage access: an open link also lets people in (PRI-07). */
  linkNote?: string | null
  onChange(v: BoardVisibility): Promise<void>
}) {
  const id = useId()
  const [pending, setPending] = useState(false)
  const [copied, setCopied] = useState<boolean | null>(null)
  const url = absoluteUrl(boardPath(board.id))
  const current = VISIBILITY_OPTIONS.find((o) => o.value === board.visibility)
  return (
    <section
      className="dr-share__section dr-sharing__boardlink"
      aria-labelledby={`${id}-h`}
      data-testid="share-link"
    >
      <h3 id={`${id}-h`} className="dr-share__heading">
        Board link
      </h3>
      <div className="dr-sharing__boardlink-row" data-testid="share-visibility">
        <span className="dr-share__visicon" aria-hidden="true" data-visibility={board.visibility} />
        <label htmlFor={id} className="dr-sr-only">
          Who can open the board link
        </label>
        <select
          id={id}
          className="dr-input dr-select dr-sharing__boardlink-select"
          data-testid="visibility-select"
          value={board.visibility}
          disabled={!editable || pending}
          onChange={async (e) => {
            setPending(true)
            await onChange(e.target.value as BoardVisibility)
            setPending(false)
          }}
        >
          {visibilityChoices(board.visibility, canRaise).map((o) => (
            <option key={o.value} value={o.value} disabled={o.disabled}>
              {o.label}
            </option>
          ))}
        </select>
        <span className="dr-sharing__boardlink-copy" data-testid="share-copy-section">
          <button
            type="button"
            className="dr-btn"
            data-testid="share-copy-link"
            onClick={async () => setCopied(await copyBounded(url))}
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
        </span>
      </div>
      <p className="dr-share__hint dr-sharing__boardlink-hint" role="status">
        {copied === false
          ? boardLinkCopyFailed(url)
          : `${current?.describe(workspaceName) ?? ''} Anyone else who opens the link can request access.`}
      </p>
      {linkNote && (
        <p className="dr-share__hint dr-sharing__linknote" data-testid="share-link-note">
          {linkNote}
        </p>
      )}
    </section>
  )
}

// ---- people --------------------------------------------------------------------------------------

// ---- workspace members (authz-006) ---------------------------------------------------------------

const WS_ROLES: readonly WorkspaceRole[] = ['owner', 'admin', 'member', 'guest']
const WS_ROLE_LABEL: Record<WorkspaceRole, string> = {
  owner: 'Owner',
  admin: 'Admin',
  member: 'Member',
  guest: 'Guest',
}
const wsRank = (r: WorkspaceRole) => WS_ROLES.indexOf(r)

/**
 * The roles a workspace owner or admin may pick for someone (the server enforces each rule): only an
 * owner makes an owner; the last owner keeps the role; someone who is not a creator only lowers
 * (domain access D4: raising hands out access). Admin and owner also go to creators only (D5): the
 * server answers that one, as it knows the person's addresses.
 */
function workspaceRoleChoices(opts: {
  current: WorkspaceRole
  self: WorkspaceRole
  creator: boolean
  lastOwner: boolean
}): { role: WorkspaceRole; disabled: boolean; title?: string }[] {
  return WS_ROLES.map((role) => {
    if (role === opts.current) return { role, disabled: false }
    if (opts.current === 'owner' && opts.lastOwner)
      return { role, disabled: true, title: 'A workspace needs at least one owner' }
    if (role === 'owner' && opts.self !== 'owner')
      return { role, disabled: true, title: 'Only a workspace owner can make someone an owner' }
    if (wsRank(role) < wsRank(opts.current) && !opts.creator)
      return { role, disabled: true, title: 'You can lower roles here, not raise them' }
    return { role, disabled: false }
  })
}

/**
 * "Workspace members", for the workspace's owners and admins: everyone in the workspace with their role,
 * to change it or to remove someone (offboarding: they lose every board of the workspace, the grants
 * they had on its boards included). Collapsed by default: most visits to the Share dialog are about
 * this board.
 */
function WorkspaceMembersSection({
  workspace,
  members,
  selfUserId,
  creator,
  onChanged,
}: {
  workspace: { id: string; name: string }
  members: readonly WorkspaceMember[]
  selfUserId: string
  creator: boolean
  /** The answer of a change (the workspace's updated list). */
  onChanged(next: WorkspaceMember[]): void
}) {
  const headingId = useId()
  const [pending, setPending] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [confirming, setConfirming] = useState<string | null>(null)
  const { confirm, box } = useOutsideAsk()
  const self = members.find((m) => m.user.id === selfUserId)?.role
  if (self !== 'owner' && self !== 'admin') return null
  const owners = members.filter((m) => m.role === 'owner').length
  const base = `/api/workspaces/${encodeURIComponent(workspace.id)}/members/`
  const run = async (userId: string, method: 'PATCH' | 'DELETE', role?: WorkspaceRole) => {
    setError(null)
    setPending(userId)
    try {
      const next = await api.request(method, `${base}${encodeURIComponent(userId)}`, {
        ...(role ? { body: { role } } : {}),
        schema: ListWorkspaceMembersResponse,
      })
      onChanged(next.members)
    } catch (e) {
      setError(isApiError(e) ? e.message : 'That change was not saved. Try again.')
    } finally {
      setPending(null)
    }
  }
  return (
    <details className="dr-share__section dr-sharing__more" data-testid="workspace-members">
      <summary className="dr-sharing__more-summary" data-testid="workspace-members-toggle">
        <span className="dr-sharing__more-title" id={headingId}>
          Workspace members
        </span>
        <span className="dr-sharing__more-sub">
          {members.length === 1 ? '1 person' : `${members.length} people`} in {workspace.name}
        </span>
      </summary>
      {error && (
        <p className="dr-share__error" role="alert" data-testid="workspace-members-error">
          {error}
        </p>
      )}
      {box}
      <ul className="dr-members" aria-labelledby={headingId} data-testid="workspace-member-list">
        {members.map((m) => {
          const isSelf = m.user.id === selfUserId
          const lastOwner = m.role === 'owner' && owners <= 1
          const editable = !isSelf && (self === 'owner' || m.role !== 'owner')
          const busy = pending === m.user.id
          return (
            <li
              key={m.user.id}
              className="dr-member"
              data-testid="workspace-member-row"
              data-user-id={m.user.id}
              data-role={m.role}
              aria-busy={busy || undefined}
            >
              <Avatar user={m.user} />
              <div className="dr-member__text">
                <span className="dr-member__name">
                  {m.user.name}
                  {isSelf && <span className="dr-member__you"> (you)</span>}
                  <OutsideStatusTag outside={m.outside} domain={m.emailDomain} />
                </span>
                <span className="dr-member__sub">{m.user.handle ? `@${m.user.handle}` : ''}</span>
                {confirming === m.user.id && (
                  <fieldset className="dr-sharing__confirm" data-testid="workspace-member-remove-box">
                    <legend className="dr-sr-only">Remove {m.user.name}</legend>
                    Remove {m.user.name} from {workspace.name}? They lose access to its boards, the ones
                    shared with them included.{' '}
                    <button
                      type="button"
                      className="dr-btn dr-btn--sm dr-sharing__danger"
                      data-testid="workspace-member-remove-confirm"
                      // biome-ignore lint/a11y/noAutofocus: the confirmation the remove button just asked for
                      autoFocus
                      onClick={() => {
                        setConfirming(null)
                        void run(m.user.id, 'DELETE')
                      }}
                    >
                      Remove
                    </button>{' '}
                    <button type="button" className="dr-btn dr-btn--sm" onClick={() => setConfirming(null)}>
                      Cancel
                    </button>
                  </fieldset>
                )}
              </div>
              {editable ? (
                <div className="dr-member__actions">
                  <select
                    className="dr-input dr-select dr-select--compact"
                    data-testid="workspace-member-role"
                    aria-label={`Workspace role for ${m.user.name}`}
                    value={m.role}
                    disabled={busy}
                    onChange={async (e) => {
                      const next = e.target.value as WorkspaceRole
                      // Wave J: raising someone outside Dark Burn / TPG is asked about first.
                      if (wsRank(next) < wsRank(m.role) && !(await confirmPerson(confirm, m, 'Change role')))
                        return
                      void run(m.user.id, 'PATCH', next)
                    }}
                  >
                    {workspaceRoleChoices({ current: m.role, self, creator, lastOwner }).map((c) => (
                      <option key={c.role} value={c.role} disabled={c.disabled} title={c.title}>
                        {WS_ROLE_LABEL[c.role]}
                      </option>
                    ))}
                  </select>
                  <button
                    type="button"
                    className="dr-iconbtn"
                    data-testid="workspace-member-remove"
                    aria-label={`Remove ${m.user.name} from ${workspace.name}`}
                    title={
                      lastOwner ? 'A workspace needs at least one owner' : `Remove from ${workspace.name}`
                    }
                    disabled={busy || lastOwner || confirming === m.user.id}
                    onClick={() => setConfirming(m.user.id)}
                  >
                    <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
                      <path
                        d="M6 6l12 12M18 6L6 18"
                        stroke="currentColor"
                        strokeWidth="2"
                        strokeLinecap="round"
                      />
                    </svg>
                  </button>
                </div>
              ) : (
                <span className="dr-member__role" data-testid="workspace-member-role">
                  {WS_ROLE_LABEL[m.role]}
                </span>
              )}
            </li>
          )
        })}
      </ul>
    </details>
  )
}

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
  canShare,
  ownerNoteId,
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
  /** Domain access: the caller may raise roles (a creator); otherwise the menu only lowers. */
  canShare: boolean
  /**
   * Domain access: the id of the list's note saying why Owner is off for this person (they cannot own
   * boards); the role menu and the transfer button point to it. Undefined when it does not apply.
   */
  ownerNoteId?: string
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
  const { confirm, box } = useOutsideAsk()
  /** Wave J: a new or higher grant for someone outside Dark Burn / TPG is asked about first. */
  const changeRole = async (next: BoardRole) => {
    const current = rowDetail(member)?.grant ?? (member.source === 'grant' ? member.role : null)
    if (!guest && raisesAccess(current, next) && !(await confirmPerson(confirm, member, 'Give access')))
      return
    onRole(next)
  }
  const [baseName, marker] = splitGuestMarker(user.name)
  const detail = rowDetail(member)
  const source = detail
    ? accessSource(detail, workspaceName, (iso, kind) => (kind === 'time' ? shortTime(iso) : shortDate(iso)))
    : member.source === 'workspace'
      ? 'Access through the workspace'
      : ''
  const fallback = detail ? removalNote(detail) : null
  // A workspace-derived role with a lower direct grant: the select edits the grant, not the effective role.
  const selectValue = rowSelectValue(member)
  // Domain access: someone confirmed not to be a creator cannot own boards (the server answers 409).
  const cannotOwn = member.canOwn === false
  const roleChoices = memberRoleChoices({ current: selectValue, canShare, canOwn: member.canOwn, guest })
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
            <OutsideStatusTag outside={member.outside} domain={member.emailDomain} guest={guest} />
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
        {box}
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
            aria-describedby={ownerNoteId}
            onChange={(e) => void changeRole(e.target.value as BoardRole)}
          >
            {roleChoices.map((c) => (
              <option key={c.role} value={c.role} disabled={c.disabled} title={c.title}>
                {ROLE_OPTION_LABEL[c.role]}
              </option>
            ))}
          </select>
          {transferable && !confirming && (
            <button
              type="button"
              className="dr-iconbtn"
              data-testid="member-transfer"
              aria-label={`Transfer ownership to ${user.name}`}
              title={cannotOwn ? OWNER_NEEDS_CREATOR : 'Transfer ownership'}
              aria-describedby={ownerNoteId}
              disabled={pending || cannotOwn}
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

/**
 * "Link for one person" (domain access, D2/D13): a single-use link locked to one email address. Only an
 * account with that verified address can accept it; anyone else who opens it is turned away. Lobby
 * sends no email for it. Someone who may only reduce access (not a creator) sees the pending ones, to
 * revoke them.
 */
function InviteLinkSection({
  boardId,
  invitations,
  canCreate,
  ownEmail,
  onChange,
}: {
  boardId: string
  invitations: readonly PendingInvitation[]
  canCreate: boolean
  /** The signed-in account's own address: never locked a link to (fixer round 3, §21). */
  ownEmail: string | null
  onChange(): void
}) {
  const roleId = useId()
  const linkId = useId()
  const emailId = useId()
  const errorId = useId()
  const emailRef = useRef<HTMLInputElement>(null)
  const [email, setEmail] = useState('')
  const [fieldError, setFieldError] = useState<string | null>(null)
  const [role, setRole] = useState<Exclude<BoardRole, 'owner'>>('viewer')
  const [created, setCreated] = useState<
    (InvitationCreated & { email: string; role: Exclude<BoardRole, 'owner'> }) | null
  >(null)
  // null: the automatic copy has not settled yet (nothing is said about it meanwhile); false: it did not copy
  const [copied, setCopied] = useState<boolean | null>(null)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const { confirm, box } = useOutsideAsk()

  const url = created ? (created.url.startsWith('/') ? absoluteUrl(created.url) : created.url) : ''

  const create = async () => {
    setError(null)
    setCopied(null)
    const checked = checkInviteEmail(email)
    if (!checked.ok) {
      setFieldError(checked.message)
      emailRef.current?.focus()
      return
    }
    if (isOwnAddress(checked.email, ownEmail)) {
      setFieldError(OWN_ADDRESS_MESSAGE)
      emailRef.current?.focus()
      return
    }
    setFieldError(null)
    // Wave J: an address outside Dark Burn / TPG is asked about first (or refused while internal only).
    const asked = await confirmAddress(boardId, checked.email, confirm)
    if (asked.refused) {
      setError(asked.refused)
      return
    }
    if (!asked.ok) return
    setPending(true)
    try {
      const inv = await api.createBoardInvitation(boardId, { role, email: checked.email })
      setCreated({ ...inv, email: checked.email, role })
      setEmail('')
      setCopied(await copyBounded(inv.url.startsWith('/') ? absoluteUrl(inv.url) : inv.url))
      onChange()
    } catch (e) {
      // A 400 (or 409 INVITATION_TO_SELF, another address of the caller's) is about the address (the
      // server's words); anything else is about the link.
      if (isApiError(e) && (e.kind === 'invalid' || e.code === DOMAIN_ACCESS_CODES.invitationToSelf)) {
        setFieldError(e.message.replace(/^email: /, ''))
        emailRef.current?.focus()
      } else setError(isApiError(e) ? e.message : 'The invite link could not be created.')
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
    <section className="dr-share__section" aria-labelledby={`${roleId}-h`} data-testid="one-person-link">
      <h3 id={`${roleId}-h`} className="dr-share__heading">
        {canCreate ? 'Link for one person' : 'Unused invitations'}
      </h3>
      {canCreate && (
        <>
          <form
            className="dr-row dr-row--wrap"
            noValidate
            onSubmit={(e) => {
              e.preventDefault()
              void create()
            }}
          >
            <label htmlFor={emailId} className="dr-sr-only">
              Email address of the person the link is for
            </label>
            <input
              ref={emailRef}
              id={emailId}
              type="email"
              inputMode="email"
              required
              className="dr-input dr-sharing__invite-input"
              data-testid="one-person-link-email"
              placeholder="Their email address"
              autoComplete="off"
              autoCapitalize="none"
              spellCheck={false}
              value={email}
              aria-invalid={fieldError ? true : undefined}
              aria-describedby={fieldError ? errorId : undefined}
              onChange={(e) => {
                setEmail(e.target.value)
                // Fixer round 3: the inviter's own address is named at once, before anything is sent.
                setFieldError(isOwnAddress(e.target.value, ownEmail) ? OWN_ADDRESS_MESSAGE : null)
              }}
            />
            <label htmlFor={roleId} className="dr-sr-only">
              Role for the person who uses the link
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
            <button type="submit" className="dr-btn" data-testid="invite-create" disabled={pending}>
              {created ? 'Create another link' : 'Create invite link'}
            </button>
          </form>
          {box}
          {fieldError && (
            <p id={errorId} className="dr-field-error" role="alert" data-testid="one-person-link-error">
              {fieldError}
            </p>
          )}
        </>
      )}
      {error && (
        <p className="dr-share__error" role="alert">
          {error}
        </p>
      )}
      {created && (
        <div className="dr-invite" data-testid="invite-result">
          <label htmlFor={linkId} className="dr-sr-only">
            Invite link for {created.email}
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
              onClick={async () => setCopied(await copyBounded(url))}
            >
              {copied ? 'Copied' : 'Copy'}
            </button>
          </div>
          <p className="dr-share__hint" role="status" data-testid="invite-created-note">
            {copyNote(copied, 'Copied to your clipboard. ', 'Copy')}This link is shown only once.{' '}
            {lockedLinkNote(created, formatDateTime)}{' '}
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
              <span className="dr-sharing__link-text">{pendingInviteLabel(i, shortDate)}</span>
              <button
                type="button"
                className="dr-linkbtn dr-sharing__revoke"
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
  canCreate,
  onChange,
}: {
  boardId: string
  /** R2-11: bumped by "Workshop link (guests can edit)": let guests in, and bring Create into view. */
  focusAsk?: number
  links: readonly PendingInvitation[]
  /** Domain access: creating and extending are for creators; everyone who manages access may revoke. */
  canCreate: boolean
  onChange(): void
}) {
  const hoursId = useId()
  const [hours, setHours] = useState<number>(WORKSHOP_LINK_DEFAULT_HOURS)
  const [allowGuests, setAllowGuests] = useState<boolean>(WORKSHOP_LINK_GUESTS_DEFAULT)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // copied: null while the copy is being tried (it never blocks the link from showing: share-copy.ts).
  const [justCreated, setJustCreated] = useState<{ id: string; copied: boolean | null } | null>(null)
  // A11Y-01: what a screen reader hears after Create (the button keeps the keyboard).
  const [said, setSaid] = useState('')
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
    if (pending) return
    setPending(true)
    setError(null)
    setSaid('')
    let link: ReviewLinkCreated
    try {
      link = await sharing.createReviewLink(boardId, {
        role: 'editor',
        expiresInHours: hours,
        allowGuests,
      })
    } catch (e) {
      setError(isApiError(e) ? e.message : 'The workshop link could not be created.')
      return
    } finally {
      setPending(false)
    }
    // G2: the link exists. Show it now; the clipboard (which can refuse or never answer when this window
    // is not focused) only decides which sentence goes with it, never whether Create has finished.
    setJustCreated({ id: link.id, copied: null })
    onChange()
    const copied = await copyBounded(link.url)
    setJustCreated({ id: link.id, copied })
    setSaid(createdSaying('Workshop link', copied))
  }

  return (
    <section
      ref={sectionRef}
      className="dr-share__section"
      aria-labelledby={`${hoursId}-h`}
      data-testid="workshop-links"
    >
      <h3 id={`${hoursId}-h`} className="dr-share__heading">
        {canCreate ? 'Workshop link' : 'Open workshop links'}
      </h3>
      {canCreate && (
        <>
          <p className="dr-share__hint" data-testid="workshop-link-hint">
            {workshopLinkHint(allowGuests, links.length > 0)}
          </p>
          {/* R15: the guest choice comes before Create, and applies to the link it makes (G2: the next one
              once a link is open; a link that exists has its own box in its row). */}
          <GuestsOption
            testId="workshop-link-guests"
            checked={allowGuests}
            onChange={setAllowGuests}
            openLinks={links.length}
          />
        </>
      )}
      {canCreate && (
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
            aria-disabled={pending || undefined}
            aria-busy={pending || undefined}
            onClick={() => void create()}
          >
            {pending ? 'Creating…' : 'Create workshop link'}
          </button>
        </div>
      )}
      <p className="dr-sr-only" role="status" data-testid="workshop-link-status">
        {said}
      </p>
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
              canShare={canCreate}
              copiedOnCreate={justCreated?.id === l.id ? justCreated.copied : null}
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
  canCreate,
  onChange,
}: {
  boardId: string
  links: readonly PendingInvitation[]
  /** Domain access: creating is for creators; everyone who manages access may revoke. */
  canCreate: boolean
  onChange(): void
}) {
  const roleId = useId()
  const daysId = useId()
  const [role, setRole] = useState<'viewer' | 'commenter'>(CLIENT_LINK_DEFAULTS.role)
  const [days, setDays] = useState<number>(REVIEW_LINK_DEFAULT_DAY)
  const [allowGuests, setAllowGuests] = useState<boolean>(CLIENT_LINK_DEFAULTS.allowGuests)
  // wave S (WS4): "Open as review page": the link lands on the board's review page (?view=review). Offered only
  // while the review page switch is on; ticked for you when the board already has review items.
  const reviewPageOn = reviewFlags().reviewPage
  const [reviewPage, setReviewPage] = useState(false)
  const reviewPageTouched = useRef(false)
  useEffect(() => {
    if (!reviewPageOn) return
    let live = true
    void openAsReviewPageDefault(boardId).then((on) => {
      if (live && !reviewPageTouched.current) setReviewPage(on)
    })
    return () => {
      live = false
    }
  }, [reviewPageOn, boardId])
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // copied: null while the copy is being tried (it never blocks the link from showing: share-copy.ts).
  const [justCreated, setJustCreated] = useState<{ id: string; copied: boolean | null } | null>(null)
  // A11Y-01: what a screen reader hears after Create (the button keeps the keyboard).
  const [said, setSaid] = useState('')

  const create = async () => {
    if (pending) return
    setPending(true)
    setError(null)
    setSaid('')
    let link: ReviewLinkCreated
    try {
      link = await sharing.createReviewLink(boardId, {
        role,
        expiresInDays: days,
        allowGuests,
        ...(reviewPageOn && reviewPage ? { landing: 'review' as const } : {}),
      })
    } catch (e) {
      setError(isApiError(e) ? e.message : 'The review link could not be created.')
      return
    } finally {
      setPending(false)
    }
    // G2: the link exists. Show it now; the clipboard only decides which sentence goes with it.
    setJustCreated({ id: link.id, copied: null })
    onChange()
    // DANA2-01: the first client link may have turned exporting off. The board event says so too,
    // but this dialog also opens from the dashboard, where no board events arrive.
    refreshExportPolicy(api, boardId).catch(() => {})
    const copied = await copyBounded(link.url)
    setJustCreated({ id: link.id, copied })
    setSaid(createdSaying('Client link', copied))
  }

  return (
    <section
      className="dr-share__section dr-sharing__client"
      aria-labelledby={`${roleId}-h`}
      data-testid="share-client"
    >
      <h3 id={`${roleId}-h`} className="dr-share__heading dr-sharing__client-heading">
        {canCreate ? 'Share with a client' : 'Open review links'}
      </h3>
      {canCreate && (
        <>
          <p className="dr-share__hint" data-testid="review-link-hint">
            {clientLinkHint(role, allowGuests, links.length > 0)}
          </p>
          <GuestsOption
            testId="review-link-guests"
            checked={allowGuests}
            onChange={setAllowGuests}
            openLinks={links.length}
          />
          {reviewPageOn && (
            <div className="dr-sharing__guests">
              <label className="dr-sharing__check">
                <input
                  type="checkbox"
                  data-testid="review-link-landing"
                  checked={reviewPage}
                  aria-describedby={`${roleId}-landing`}
                  onChange={(e) => {
                    reviewPageTouched.current = true
                    setReviewPage(e.target.checked)
                  }}
                />
                Open as review page
              </label>
              <p id={`${roleId}-landing`} className="dr-share__hint">
                The link opens the items to review one by one, with their status and comments, instead of the
                whole board.
              </p>
            </div>
          )}
          <ClientExportLine boardId={boardId} />
        </>
      )}
      {canCreate && (
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
            aria-disabled={pending || undefined}
            aria-busy={pending || undefined}
            onClick={() => void create()}
          >
            {pending ? 'Creating…' : 'Create and copy link'}
          </button>
        </div>
      )}
      <p className="dr-sr-only" role="status" data-testid="review-link-status">
        {said}
      </p>
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
              canShare={canCreate}
              copiedOnCreate={justCreated?.id === l.id ? justCreated.copied : null}
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
 * DANA-03 / K5-5: "Guests and clients": the client review link, the workshop link, invite by email and
 * one-time invite links, behind one native disclosure (keyboard and screen readers get its expanded state
 * for free). Its summary names what is open inside. It opens by itself once, on the first load, when a
 * client or workshop link is open (a running link is never folded away; a running workshop link comes
 * first and is scrolled into view); the person's own toggling wins after that. Test ids are the ones of "More ways
 * to share" (share-more, share-more-toggle, share-more-summary), which it replaces.
 */
function GuestsAndClients({
  reviewLinks,
  workshopLinks,
  unusedInvites,
  linksAllowed,
  openAsk = 0,
  children,
}: {
  /** Open client (review) links; null until the invitations have loaded. */
  reviewLinks: number | null
  /** Open workshop links; null until the invitations have loaded. */
  workshopLinks: number | null
  unusedInvites: number
  /** False on an Internal-only board: the summary offers no client or workshop link. */
  linksAllowed: boolean
  /** R2-11: bumped by "Workshop link (guests can edit)": open. */
  openAsk?: number
  children: ReactNode
}) {
  const [open, setOpen] = useState(false)
  // Whether the first load has decided the opening state (from then on, only the person toggles it).
  const [settled, setSettled] = useState(false)
  const ref = useRef<HTMLDetailsElement>(null)
  useEffect(() => {
    if (settled || workshopLinks === null || reviewLinks === null) return
    setSettled(true)
    // a link that is open is never folded away as the dialog opens (to revoke it, extend it, copy it)
    if (workshopLinks + reviewLinks === 0) return
    setOpen(true)
    if (workshopLinks === 0) return
    // F13: a facilitator's running workshop link (and its "+1 h") is in view as the dialog opens
    const frame = requestAnimationFrame(() =>
      ref.current?.querySelector('[data-testid="workshop-link-row"]')?.scrollIntoView({ block: 'nearest' }),
    )
    return () => cancelAnimationFrame(frame)
  }, [settled, workshopLinks, reviewLinks])
  useEffect(() => {
    if (openAsk <= 0) return
    setSettled(true)
    setOpen(true)
  }, [openAsk])
  return (
    <details
      ref={ref}
      className="dr-share__section dr-sharing__more"
      data-testid="share-more"
      data-loaded={settled}
      open={open}
      onToggle={(e) => setOpen(e.currentTarget.open)}
    >
      <summary className="dr-sharing__more-summary" data-testid="share-more-toggle">
        <span className="dr-sharing__more-title">{GUESTS_SECTION_TITLE}</span>
        <span className="dr-sharing__more-sub" data-testid="share-more-summary">
          {guestsSummary(
            { reviewLinks: reviewLinks ?? 0, workshopLinks: workshopLinks ?? 0, unusedInvites },
            { linksAllowed },
          )}
        </span>
      </summary>
      {children}
    </details>
  )
}

/**
 * K5-5: "Advanced": the export and download setting, folded (most visits to this dialog are about people);
 * its summary says the setting. Open from the start for someone who may only reduce access (every lever
 * they have in view). The client card's "Change" opens it (ExportPolicySection.tsx ClientExportLine).
 */
function Advanced({
  boardId,
  defaultOpen,
  children,
}: {
  boardId: string
  defaultOpen: boolean
  children: ReactNode
}) {
  const [open, setOpen] = useState(defaultOpen)
  const state = exportStateOf(boardId)
  const policy = useValue('dr-share-advanced-policy', () => state.policy.get(), [state])
  return (
    <details
      className="dr-share__section dr-sharing__more"
      data-testid="share-advanced"
      open={open}
      onToggle={(e) => setOpen(e.currentTarget.open)}
    >
      <summary className="dr-sharing__more-summary" data-testid="share-advanced-toggle">
        <span className="dr-sharing__more-title">{ADVANCED_SECTION_TITLE}</span>
        <span className="dr-sharing__more-sub" data-testid="share-advanced-summary">
          {advancedSummary(policy)}
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
  openLinks = 0,
}: {
  testId: string
  checked: boolean
  onChange(next: boolean): void
  /**
   * G2: links of this kind that are already open. The box is for the link Create makes, so with one open
   * it says "next link" (a link that exists has its own box in its row) instead of reading as if ticking
   * it changed the link that is already shared.
   */
  openLinks?: number
}) {
  const hintId = useId()
  return (
    <div className="dr-sharing__guests" data-next-link={openLinks > 0 || undefined}>
      <label className="dr-sharing__check">
        <input
          type="checkbox"
          data-testid={testId}
          checked={checked}
          aria-describedby={hintId}
          onChange={(e) => onChange(e.target.checked)}
        />
        {guestsOptionLabel(openLinks)}
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
  canShare,
  onChange,
}: {
  boardId: string
  link: PendingInvitation
  /**
   * What happened to the copy Create tried for this link: true copied, false did not (G2: it said so and
   * the Copy button is right here), null not tried (or still trying: the link shows without waiting).
   */
  copiedOnCreate: boolean | null
  /** A workshop (edit) link: ends at a time of day, and offers "+1 h". */
  workshop?: boolean
  /**
   * Domain access: extending and copying the link hand out access, so they are for creators (the api
   * sends `url: null` to anyone else and refuses the extension). Revoke stays for every manager.
   */
  canShare: boolean
  onChange(): void
}) {
  const [copied, setCopied] = useState(copiedOnCreate === true)
  const [copyFailed, setCopyFailed] = useState(copiedOnCreate === false)
  const [confirming, setConfirming] = useState(false)
  const [removeAccess, setRemoveAccess] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // G2: this link's own "join with just a name" box. `guestsAsked` is what was just chosen, held until the
  // list reloads with the server's answer (the box must not jump back while that request is in flight).
  const [guestsAsked, setGuestsAsked] = useState<boolean | null>(null)
  const [guestsBusy, setGuestsBusy] = useState(false)
  const [guestsSaid, setGuestsSaid] = useState('')
  const guestsOn = guestsAsked ?? link.allowGuests
  const guestsHintId = useId()
  useEffect(() => {
    setGuestsAsked(null)
  }, [link.allowGuests])
  // The copy Create tried finishes after this row appeared (the link shows without waiting for it).
  useEffect(() => {
    if (copiedOnCreate === null) return
    setCopied(copiedOnCreate)
    setCopyFailed(!copiedOnCreate)
  }, [copiedOnCreate])
  const kindName = workshop ? 'workshop link' : 'review link'
  const copy = async () => {
    const ok = await copyBounded(link.url ?? '')
    setCopied(ok)
    setCopyFailed(!ok)
  }
  const setGuests = async (next: boolean) => {
    if (guestsBusy) return
    setGuestsBusy(true)
    setGuestsAsked(next)
    setGuestsSaid('')
    setError(null)
    try {
      await sharing.setReviewLinkGuests(boardId, link.id, next)
      setGuestsSaid(guestsToggleSaying(next))
      onChange()
    } catch (e) {
      setGuestsAsked(null)
      setError(isApiError(e) ? e.message : 'The link could not be changed.')
    } finally {
      setGuestsBusy(false)
    }
  }
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
      data-allow-guests={guestsOn}
    >
      <div className="dr-sharing__link-main">
        {/* F13: what the link is, then its actions on the same line ("+1 h" and "Revoke…" at their own
            size, never stretched across the row); the URL and Copy below. */}
        <div className="dr-sharing__link-head">
          <span className="dr-sharing__link-text">
            <strong>{ROLE_OPTION_LABEL[link.role]}</strong> · until{' '}
            {workshop ? shortTime(link.expiresAt) : shortDate(link.expiresAt)} · {joined}
            {link.maxUses ? ` (max ${link.maxUses})` : ''}
            {guestsOn && (
              <>
                {' · '}
                <span data-testid="link-guests-allowed">guests can join with a name</span>
              </>
            )}
            {link.landing === 'review' && (
              <>
                {' · '}
                <span data-testid="link-opens-review">opens the review page</span>
              </>
            )}
          </span>
          <span className="dr-sharing__link-actions">
            {workshop && canShare && (
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
        {!canShare ? null : link.url ? (
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
              onClick={() => void copy()}
            >
              {copied ? 'Copied' : 'Copy'}
            </button>
          </div>
        ) : (
          <span className="dr-share__hint">This link can’t be shown again. Create a new one to share.</span>
        )}
        {canShare && link.url && copyFailed && (
          <span className="dr-share__hint" data-testid="review-link-copy-failed">
            {copyFailedText('Copy')}
          </span>
        )}
        {/* G2: this link's own guest box. Turning it on lets anyone with the link in with just a name, so
            only people who may share can; any manager can turn it off. The server checks both. */}
        {(canShare || guestsOn) && (
          <div className="dr-sharing__guests dr-sharing__guests--link">
            <label className="dr-sharing__check">
              <input
                type="checkbox"
                data-testid="review-link-guests-toggle"
                checked={guestsOn}
                disabled={guestsBusy || (!canShare && !guestsOn)}
                aria-describedby={guestsHintId}
                onChange={(e) => void setGuests(e.target.checked)}
              />
              {GUESTS_TOGGLE_LABEL}
            </label>
            <span
              id={guestsHintId}
              className="dr-share__hint"
              role="status"
              data-testid="review-link-guests-note"
            >
              {guestsSaid}
            </span>
          </div>
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
