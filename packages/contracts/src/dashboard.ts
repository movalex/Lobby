// API schemas for the dashboard-share feature (docs/FEATURES-M2-CONTRACTS.md): starred boards, access
// requests, review links (multi-use board invitations), invitation listing and the sharing state.
// Owned by the dashboard-share engineer.
//
// index.ts re-exports this module, and this module reuses a few M1 entity schemas from index.ts. To
// keep that import cycle safe, every use of an index.ts schema sits inside a getter (zod evaluates
// object-shape getters lazily, on first parse), never at module top level.

import { BOARD_ROLES, BOARD_VISIBILITIES, WORKSPACE_ROLES } from '@draftroom/permissions'
import { z } from 'zod'
import { BoardWithRole, InvitationId, User, UserId } from './index.ts'

const IsoDate = z.string()
const Role = z.enum(BOARD_ROLES)

// ---- ids -----------------------------------------------------------------------------------------

export const ACCESS_REQUEST_ID_PATTERN = /^acr_[0-9A-Za-z]{10,40}$/
export const AccessRequestId = z.string().regex(ACCESS_REQUEST_ID_PATTERN)

// ---- stars ---------------------------------------------------------------------------------------

export const StarResponse = z.object({ boardId: z.string(), starred: z.boolean() })
export type StarResponse = z.infer<typeof StarResponse>

/**
 * `GET /api/workspaces/:wid/boards` answers M1's list with a `starred` flag on every board (added by
 * the dashboard feature); `GET /api/workspaces/:wid/boards/starred` answers only the starred ones.
 * `starred` defaults to false so an older server's response still parses.
 */
export const ListBoardsWithStarsResponse = z.object({
  get boards() {
    return z.array(BoardWithRole.extend({ starred: z.boolean().default(false) }))
  },
})
export type BoardWithStar = z.infer<typeof ListBoardsWithStarsResponse>['boards'][number]

// ---- access requests -----------------------------------------------------------------------------

/** Roles someone can ask for (never ownership). */
export const RequestableRole = Role.exclude(['owner'])
export type RequestableRole = z.infer<typeof RequestableRole>

export const ACCESS_REQUEST_MESSAGE_MAX = 300

export const CreateAccessRequestInput = z.object({
  role: RequestableRole.default('editor'),
  /** Optional note for the owners; blank means none. */
  message: z.string().trim().max(ACCESS_REQUEST_MESSAGE_MAX).optional(),
})
export type CreateAccessRequestInput = z.input<typeof CreateAccessRequestInput>

/**
 * The same answer whether or not the board exists (or the request was recorded, or rate limited per
 * board): a request never reveals a board to someone who cannot see it.
 */
export const AccessRequestSent = z.object({ status: z.literal('sent') })

export const AccessRequestStatus = z.enum(['pending', 'approved', 'denied'])
export type AccessRequestStatus = z.infer<typeof AccessRequestStatus>

export const AccessRequest = z.object({
  id: AccessRequestId,
  boardId: z.string(),
  get user() {
    return User
  },
  roleRequested: RequestableRole,
  message: z.string().nullable(),
  status: AccessRequestStatus,
  createdAt: IsoDate,
  updatedAt: IsoDate,
  /** The requester's current role on the board (null: no access yet). */
  currentRole: Role.nullable(),
  decidedAt: IsoDate.nullable(),
  roleGranted: RequestableRole.nullable(),
})
export type AccessRequest = z.infer<typeof AccessRequest>

export const ListAccessRequestsResponse = z.object({ requests: z.array(AccessRequest) })

/** Approve may grant a different role than the one asked for (never ownership). */
export const ApproveAccessRequestInput = z.object({ role: RequestableRole.optional() })

export const AccessRequestDecided = z.object({ request: AccessRequest })

/** The caller's own pending request on a board they can already view (e.g. a viewer asking for edit). */
export const MyAccessRequestResponse = z.object({
  request: z
    .object({
      id: AccessRequestId,
      roleRequested: RequestableRole,
      status: AccessRequestStatus,
      createdAt: IsoDate,
    })
    .nullable(),
})

// ---- invitations + review links ------------------------------------------------------------------

export const REVIEW_LINK_MAX_DAYS = 30
export const REVIEW_LINK_DEFAULT_DAYS = 14
export const REVIEW_LINK_MAX_USES = 10_000

/** Review links hand out viewer or commenter access only (default: comment). */
export const ReviewLinkRole = z.enum(['viewer', 'commenter'])
export type ReviewLinkRole = z.infer<typeof ReviewLinkRole>

export const CreateReviewLinkInput = z.object({
  role: ReviewLinkRole.default('commenter'),
  expiresInDays: z.number().int().min(1).max(REVIEW_LINK_MAX_DAYS).default(REVIEW_LINK_DEFAULT_DAYS),
  /** null = unlimited (until expiry or revocation). */
  maxUses: z.number().int().min(1).max(REVIEW_LINK_MAX_USES).nullable().default(null),
})
export type CreateReviewLinkInput = z.input<typeof CreateReviewLinkInput>

export const ReviewLinkCreated = z.object({
  get id() {
    return InvitationId
  },
  url: z.string(),
  role: ReviewLinkRole,
  expiresAt: IsoDate,
  maxUses: z.number().int().nullable(),
})
export type ReviewLinkCreated = z.infer<typeof ReviewLinkCreated>

export const PendingInvitation = z.object({
  get id() {
    return InvitationId
  },
  /** `invite`: M1 single-use link (URL shown only once). `review`: multi-use review link. */
  kind: z.enum(['invite', 'review']),
  role: RequestableRole,
  createdAt: IsoDate,
  expiresAt: IsoDate,
  createdBy: z.object({ id: z.string(), name: z.string() }),
  /** People who joined through it (review links; 0 for single-use links). */
  uses: z.number().int(),
  maxUses: z.number().int().nullable(),
  /** Review links only, for people who may manage access; null when it cannot be shown again. */
  url: z.string().nullable(),
})
export type PendingInvitation = z.infer<typeof PendingInvitation>

export const ListInvitationsResponse = z.object({ invitations: z.array(PendingInvitation) })

export const RevokeReviewLinkInput = z.object({
  /** Also remove the access of people who joined through this link (default true). */
  removeAccess: z.boolean().default(true),
})
export const ReviewLinkRevoked = z.object({ removed: z.number().int() })

// ---- sharing state + people ----------------------------------------------------------------------

export const ShareState = z.object({
  visibility: z.enum(BOARD_VISIBILITIES),
  /** Active review links, soonest expiry first (no tokens). */
  links: z.array(z.object({ role: ReviewLinkRole, expiresAt: IsoDate })),
  /** People with a direct grant on the board. */
  directCount: z.number().int(),
  /** Pending access requests; only for people who may manage access (else null). */
  pendingRequests: z.number().int().nullable(),
})
export type ShareState = z.infer<typeof ShareState>

export const ShareMember = z.object({
  get user() {
    return User
  },
  /** Effective role: the highest of the direct grant and workspace-derived access. */
  role: Role,
  source: z.enum(['grant', 'workspace']),
  /** The direct grant on this board, if any. */
  grant: Role.nullable(),
  workspaceRole: z.enum(WORKSPACE_ROLES),
  /** What they would keep if the direct grant were removed (workspace role / visibility). */
  withoutGrant: Role.nullable(),
  /** Their direct grant came from a review link; `linkEndsAt` = when that access ends. */
  viaReviewLink: z.boolean(),
  linkEndsAt: IsoDate.nullable(),
})
export type ShareMember = z.infer<typeof ShareMember>

export const ListShareMembersResponse = z.object({ members: z.array(ShareMember) })

export const TransferOwnershipInput = z.object({
  get userId() {
    return UserId
  },
})
