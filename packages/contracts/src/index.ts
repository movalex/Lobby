// HTTP API request/response shapes (docs/M1-CONTRACTS.md §5). Browser-safe; shared by apps/api
// (validates inputs, shapes outputs) and apps/web (parses responses). Extend, never silently change.

import { BOARD_ROLES, BOARD_STATUSES, BOARD_VISIBILITIES, WORKSPACE_ROLES } from '@draftroom/permissions'
import { z } from 'zod'
import { AccountEmail, ME_ACCESS_LEGACY, MeAccess } from './domain-access.ts'
import { cleanDisplayText, OutsideFields } from './outside.ts'

export const BoardRole = z.enum(BOARD_ROLES)
export const WorkspaceRole = z.enum(WORKSPACE_ROLES)
export const BoardVisibility = z.enum(BOARD_VISIBILITIES)
export const BoardStatus = z.enum(BOARD_STATUSES)

export const BOARD_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{2,63}$/
export const BoardId = z.string().regex(BOARD_ID_PATTERN)
const prefixed = (p: string) => z.string().regex(new RegExp(`^${p}_[0-9A-Za-z]{10,40}$`))
export const UserId = prefixed('usr')
export const WorkspaceId = prefixed('wsp')
export const ProjectId = prefixed('prj')
export const InvitationId = prefixed('inv')

export const DevHandle = z.string().regex(/^[a-z0-9-]{1,32}$/)
const Title = z.string().trim().min(1).max(120)
const Name = z.string().trim().min(1).max(80)
const IsoDate = z.string()

// ---- entities ------------------------------------------------------------------------------------

export const User = z.object({
  id: UserId,
  name: z.string(),
  handle: z.string().nullable(),
  color: z.string(),
  avatarUrl: z.string().nullable(),
})
export type User = z.infer<typeof User>

export const WorkspaceSummary = z.object({ id: WorkspaceId, name: z.string(), role: WorkspaceRole })
export type WorkspaceSummary = z.infer<typeof WorkspaceSummary>

export const Project = z.object({
  id: ProjectId,
  workspaceId: WorkspaceId,
  name: z.string(),
  createdAt: IsoDate,
  archivedAt: IsoDate.nullable(),
})
export type Project = z.infer<typeof Project>

export const Board = z.object({
  id: BoardId,
  workspaceId: WorkspaceId,
  projectId: ProjectId.nullable(),
  title: z.string(),
  visibility: BoardVisibility,
  status: BoardStatus,
  trashedAt: IsoDate.nullable(),
  createdBy: UserId,
  createdAt: IsoDate,
  updatedAt: IsoDate,
  lastOpenedAt: IsoDate.nullable(),
  /**
   * Bridge release R0 (docs/EXCALIDRAW-MIGRATION.md §5.10): the board was made on the new canvas
   * (Excalidraw), so this build shows it with a "new canvas" badge and cannot open, duplicate or export
   * it (NEW_CANVAS_BOARD_MESSAGE). Absent on every other board.
   */
  newCanvas: z.literal(true).optional(),
})
export type Board = z.infer<typeof Board>

/** A board as the caller sees it: always carries the caller's effective role. */
export const BoardWithRole = Board.extend({ role: BoardRole })
export type BoardWithRole = z.infer<typeof BoardWithRole>

export const BoardMember = z.object({
  user: User,
  role: BoardRole,
  source: z.enum(['grant', 'workspace']),
})
export type BoardMember = z.infer<typeof BoardMember>

/**
 * Wave J (./outside.ts): `outside`, `emailDomain` and `emailHint` only for callers who manage the
 * workspace (owners and admins), or who manage the board named by `?boardId=` (the Share dialog's
 * "pick someone from the workspace" list and typed @handles: the External tag and the one-time confirm).
 */
export const WorkspaceMember = z.object({ user: User, role: WorkspaceRole, ...OutsideFields })
export type WorkspaceMember = z.infer<typeof WorkspaceMember>

/**
 * GET /api/workspaces/:wid/members, and the answer of PATCH and DELETE
 * /api/workspaces/:wid/members/:uid (authz-006): the workspace's people (name-only guests left out),
 * owners first.
 */
export const ListWorkspaceMembersResponse = z.object({ members: z.array(WorkspaceMember) })
export type ListWorkspaceMembersResponse = z.infer<typeof ListWorkspaceMembersResponse>

/**
 * PATCH /api/workspaces/:wid/members/:uid (authz-006): a member's workspace role. Owners and admins manage
 * the members; only an owner changes or removes an owner, or makes one; the last owner, and the person
 * whose personal workspace it is, stay owners. Raising a role is creator-only, and admin and owner go to
 * creators only (docs/DOMAIN-ACCESS-CONTRACTS.md D4, D5); lowering stays open to every manager.
 * DELETE removes the member and every board grant they hold in the workspace, in one transaction.
 */
export const PatchWorkspaceMemberInput = z.object({ role: WorkspaceRole })
export type PatchWorkspaceMemberInput = z.infer<typeof PatchWorkspaceMemberInput>

/** The refusals of those routes that the web tells apart (the messages say what to do). */
export const WORKSPACE_MEMBER_CODES = {
  /** 409: the workspace would have no owner left. */
  lastOwner: 'LAST_OWNER',
  /** 403: an admin asked to change, remove or make an owner. */
  ownerOnly: 'OWNER_ONLY',
  /** 409: the person whose personal workspace it is stays its owner. */
  personalOwner: 'PERSONAL_WORKSPACE_OWNER',
} as const

// ---- auth ----------------------------------------------------------------------------------------

export const AuthConfig = z.object({
  providers: z.array(z.enum(['dev', 'clerk', 'email'])),
  clerkPublishableKey: z.string().optional(),
  /** Open email sign-in only (docs/OPEN-SIGNIN.md): the shared workspace everyone joins. */
  sharedWorkspaceName: z.string().optional(),
  /** Open sign-in only: which ways in the page offers (a typed address and/or Google). */
  openSigninMethods: z.array(z.enum(['email', 'google'])).optional(),
  /** Open sign-in with Google: the public OAuth client id for Google Identity Services. */
  googleClientId: z.string().optional(),
})
export type AuthConfig = z.infer<typeof AuthConfig>

/**
 * Open email sign-in (docs/OPEN-SIGNIN.md): any address and a display name, no verification. Only on a
 * server started with AUTH_PROVIDER=email and DRAFTROOM_OPEN_SIGNIN=1.
 */
export const EmailLoginInput = z.object({
  email: AccountEmail,
  /** Wave J: control, bidi and zero-width characters are removed on input (outside.ts cleanDisplayText). */
  name: z.string().transform(cleanDisplayText).pipe(Name),
})
export type EmailLoginInput = z.infer<typeof EmailLoginInput>

/** Open sign-in with Google (docs/OPEN-SIGNIN.md "Google"): the ID token Google Identity Services gave the page. */
export const GoogleLoginInput = z.object({ credential: z.string().min(1).max(4096) })
export type GoogleLoginInput = z.infer<typeof GoogleLoginInput>

/**
 * Partner boards (docs/OPEN-SIGNIN.md): an outside app's stable key for one board in the shared
 * workspace, e.g. `theaitre:production:42`. Lowercase, so it never depends on how the caller spells it.
 */
export const PARTNER_REF_PATTERN = /^[a-z0-9][a-z0-9:._-]{0,119}$/
export const PartnerBoardInput = z.object({ title: Title })
export type PartnerBoardInput = z.infer<typeof PartnerBoardInput>
export const PartnerBoard = z.object({
  boardId: BoardId,
  ref: z.string().regex(PARTNER_REF_PATTERN),
  title: z.string(),
  /** The board page on PUBLIC_ORIGIN. */
  url: z.string(),
  /** True when this call created the board. */
  created: z.boolean(),
})
export type PartnerBoard = z.infer<typeof PartnerBoard>

/**
 * `email` (domain access, docs/DOMAIN-ACCESS-CONTRACTS.md §3.3): trusted as verified, by the dev-guarded
 * route only. Without it the account gets `<handle>@dev.invalid`, a creator while the api runs the dev
 * provider.
 */
export const DevLoginInput = z.object({
  handle: DevHandle,
  /** Wave J: control, bidi and zero-width characters are removed on input (outside.ts cleanDisplayText). */
  name: z.string().transform(cleanDisplayText).pipe(Name).optional(),
  email: AccountEmail.optional(),
})
export type DevLoginInput = z.infer<typeof DevLoginInput>

/**
 * `access` (domain access): whether the caller is a creator, and why. The inferred output type makes it
 * required, so every api place that builds a `Me` must set it; an older api's response parses with
 * ME_ACCESS_LEGACY.
 */
export const Me = z.object({
  user: User,
  workspaces: z.array(WorkspaceSummary),
  access: MeAccess.default(ME_ACCESS_LEGACY),
})
export type Me = z.infer<typeof Me>

/**
 * What "sign out everywhere" did with the identity provider's own sessions: 'revoked' (ended, e.g.
 * Clerk sessions on other devices), 'failed' (could not reach the provider: those sessions may still
 * sign the person back in on other devices), 'none' (the provider keeps no sessions: dev sign-in).
 */
export const ProviderSessionsRevoked = z.object({
  status: z.enum(['revoked', 'failed', 'none']),
  revoked: z.number().int().nonnegative(),
})
export type ProviderSessionsRevoked = z.infer<typeof ProviderSessionsRevoked>

/**
 * POST /api/auth/sessions/revoke-all ("sign out everywhere", docs/SECURITY-REVIEW-2026-09-27.md
 * SCA-4): ends every Draftroom session of the signed-in person, this one included (the cookie is
 * cleared), and their open board event streams.
 */
export const RevokeAllSessionsResponse = z.object({
  /** Draftroom sessions ended (every device, this one included). */
  revoked: z.number().int().nonnegative(),
  provider: ProviderSessionsRevoked,
})
export type RevokeAllSessionsResponse = z.infer<typeof RevokeAllSessionsResponse>

// ---- boards --------------------------------------------------------------------------------------

export const ListBoardsQuery = z.object({
  status: BoardStatus.optional(),
  q: z.string().max(120).optional(),
  projectId: ProjectId.optional(),
})
export const ListBoardsResponse = z.object({ boards: z.array(BoardWithRole) })

export const CreateBoardInput = z.object({ title: Title, projectId: ProjectId.nullable().optional() })
export const PatchBoardInput = z
  .object({ title: Title, projectId: ProjectId.nullable(), visibility: BoardVisibility })
  .partial()
  .refine((v) => Object.keys(v).length > 0, 'nothing to update')

export const BoardDetail = z.object({
  board: Board,
  role: BoardRole,
  workspace: z.object({ id: WorkspaceId, name: z.string() }),
})
export type BoardDetail = z.infer<typeof BoardDetail>

export const PutMemberInput = z.object({ role: BoardRole })
export const ListMembersResponse = z.object({ members: z.array(BoardMember) })

export const CreateProjectInput = z.object({ name: Name })
export const PatchProjectInput = z.object({ name: Name.optional(), archived: z.boolean().optional() })

// ---- invitations ---------------------------------------------------------------------------------

/**
 * Single-use invitations are locked to `email` (domain access, contracts doc §6.1): only an account
 * with that verified address can accept one. Required since step B2.
 */
export const CreateWorkspaceInvitationInput = z.object({
  role: z.enum(['admin', 'member', 'guest']),
  email: AccountEmail,
})
export const CreateBoardInvitationInput = z.object({
  role: BoardRole.exclude(['owner']),
  email: AccountEmail,
})
export const InvitationCreated = z.object({ id: InvitationId, url: z.string(), expiresAt: IsoDate })
export type InvitationCreated = z.infer<typeof InvitationCreated>

export const InvitationPreview = z.object({
  workspace: z.object({ id: WorkspaceId, name: z.string() }),
  board: z.object({ id: BoardId, title: z.string() }).nullable(),
  role: z.string(),
  invitedBy: z.object({ name: z.string() }),
  expiresAt: IsoDate,
})
export type InvitationPreview = z.infer<typeof InvitationPreview>

/**
 * GET /api/invitations/:token addition (docs/DOMAIN-ACCESS-CONTRACTS.md §21, fixer round 3): the
 * board of a board invitation is in the trash. Nobody can accept it then (409 BOARD_IN_TRASH, nothing
 * redeemed); once the board is restored the link works again, until it expires. Defaults to false, so
 * an older api's preview still parses.
 */
export const InvitationBoardState = z.object({ boardInTrash: z.boolean().default(false) })
export type InvitationBoardState = z.infer<typeof InvitationBoardState>

/** 409 from accepting an invitation to a board in the trash (the link is not used up). */
export const BOARD_IN_TRASH = {
  code: 'BOARD_IN_TRASH',
  message:
    'This board is in the trash, so the invitation can’t be used right now. It works again if the board is restored before the link expires.',
} as const

export const InvitationAccepted = z.object({ workspaceId: WorkspaceId, boardId: BoardId.nullable() })

// ---- sync tickets ----------------------------------------------------------------------------------

export const TicketResponse = z.object({
  ticket: z.string(),
  expiresAt: z.number(),
  role: BoardRole,
  user: z.object({ id: UserId, name: z.string(), color: z.string() }),
})
export type TicketResponse = z.infer<typeof TicketResponse>

// ---- internal (api <-> sync) -----------------------------------------------------------------------

export const InternalAccessResponse = z.object({ role: BoardRole.nullable() })
export const InternalAccessChanged = z.object({ boardId: BoardId, userId: UserId.optional() })

// ---- errors ----------------------------------------------------------------------------------------

export const ErrorBody = z.object({ error: z.object({ code: z.string(), message: z.string() }) })
export type ErrorBody = z.infer<typeof ErrorBody>

// Feature schemas (docs/FEATURES-M2-CONTRACTS.md): one file per feature, owned by that feature.
export * from './ai.ts'
export * from './comments.ts'
export * from './dashboard.ts'
export * from './domain-access.ts'
export * from './export-control.ts'
export * from './feedback.ts'
export * from './guests.ts'
export * from './history.ts'
export * from './link-preview.ts'
export * from './mindmap.ts'
export * from './outside.ts'
export * from './present-live.ts'
export * from './search.ts'
export * from './storage.ts'
export * from './sync-internal.ts'
export * from './tags.ts'
export * from './thumbnails.ts'
export * from './workshops.ts'
