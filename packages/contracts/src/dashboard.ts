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
/** Workshop links (role editor, RETRO-04a) live a few hours: default 3, never more than 24 in all. */
export const WORKSHOP_LINK_DEFAULT_HOURS = 3
export const WORKSHOP_LINK_MAX_HOURS = 24

/**
 * Multi-use links: review links hand out viewer or commenter access (default: comment) for up to 30
 * days; a workshop link hands out editor access for up to 24 hours. Never ownership.
 */
export const ReviewLinkRole = z.enum(['viewer', 'commenter', 'editor'])
export type ReviewLinkRole = z.infer<typeof ReviewLinkRole>

export const CreateReviewLinkInput = z
  .object({
    role: ReviewLinkRole.default('commenter'),
    /** Review links (default 14). A workshop link may use 1 (= 24 h) at most. */
    expiresInDays: z.number().int().min(1).max(REVIEW_LINK_MAX_DAYS).optional(),
    /** Workshop links (default 3); also accepted for review links. Takes precedence over days. */
    expiresInHours: z
      .number()
      .int()
      .min(1)
      .max(REVIEW_LINK_MAX_DAYS * 24)
      .optional(),
    /** null = unlimited (until expiry or revocation). */
    maxUses: z.number().int().min(1).max(REVIEW_LINK_MAX_USES).nullable().default(null),
  })
  .superRefine((v, ctx) => {
    if (v.role !== 'editor') return
    const hours = v.expiresInHours ?? (v.expiresInDays === undefined ? undefined : v.expiresInDays * 24)
    if (hours !== undefined && hours > WORKSHOP_LINK_MAX_HOURS)
      ctx.addIssue({
        code: 'custom',
        path: [v.expiresInHours === undefined ? 'expiresInDays' : 'expiresInHours'],
        message: `Workshop (edit) links expire within ${WORKSHOP_LINK_MAX_HOURS} hours.`,
      })
  })
export type CreateReviewLinkInput = z.input<typeof CreateReviewLinkInput>

/** How long a link with `role` lasts when created from `input` (ms). */
export function reviewLinkLifetimeMs(input: {
  role: ReviewLinkRole
  expiresInDays?: number
  expiresInHours?: number
}): number {
  const HOUR = 60 * 60 * 1000
  if (input.expiresInHours !== undefined) return input.expiresInHours * HOUR
  if (input.expiresInDays !== undefined) return input.expiresInDays * 24 * HOUR
  return input.role === 'editor' ? WORKSHOP_LINK_DEFAULT_HOURS * HOUR : REVIEW_LINK_DEFAULT_DAYS * 24 * HOUR
}

/** The longest a link with `role` may stay open, counted from its creation (ms). */
export const reviewLinkMaxLifetimeMs = (role: ReviewLinkRole) =>
  (role === 'editor' ? WORKSHOP_LINK_MAX_HOURS : REVIEW_LINK_MAX_DAYS * 24) * 60 * 60 * 1000

/** "+1 h" on an open link (workshop links mostly); capped at the role's maximum lifetime. */
export const ExtendReviewLinkInput = z.object({
  hours: z.number().int().min(1).max(WORKSHOP_LINK_MAX_HOURS).default(1),
})
export type ExtendReviewLinkInput = z.input<typeof ExtendReviewLinkInput>
export const ReviewLinkExtended = z.object({ expiresAt: IsoDate, maxExpiresAt: IsoDate })
export type ReviewLinkExtended = z.infer<typeof ReviewLinkExtended>

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
  /** Multi-use links: the latest `expiresAt` an extension can reach (created + the role's cap). */
  maxExpiresAt: IsoDate.nullable().default(null),
})
export type PendingInvitation = z.infer<typeof PendingInvitation>

export const ListInvitationsResponse = z.object({ invitations: z.array(PendingInvitation) })

export const RevokeReviewLinkInput = z.object({
  /** Also remove the access of people who joined through this link (default true). */
  removeAccess: z.boolean().default(true),
})
export const ReviewLinkRevoked = z.object({ removed: z.number().int() })

/**
 * The body of a 410 from GET /api/invitations/:token and its accept route (PRI-04): the usual error,
 * plus who sent the link (the token holder saw that while it was valid) and, only for a signed-in
 * caller who can open the board right now, its id, so the page can open the board instead of a dead
 * end. Nobody else learns anything about the board.
 */
export const InvitationGoneBody = z.object({
  error: z.object({ code: z.string(), message: z.string() }),
  gone: z.object({
    invitedBy: z.object({ name: z.string() }).nullable(),
    boardId: z.string().nullable(),
  }),
})
export type InvitationGoneBody = z.infer<typeof InvitationGoneBody>

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

// ---- invite by email -----------------------------------------------------------------------------

/** The longest address SMTP can carry (RFC 5321: a 256-octet path, angle brackets included). */
export const INVITE_EMAIL_MAX_LENGTH = 254

/**
 * An address to invite: trimmed and lowercased (Clerk compares addresses without case; one spelling
 * per person keeps lookups, invitations and rate limits consistent).
 */
export const InviteEmail = z
  .string()
  .trim()
  .toLowerCase()
  .min(1, 'Enter an email address.')
  .max(INVITE_EMAIL_MAX_LENGTH, 'That email address is too long.')
  .pipe(z.email('Enter a valid email address.'))

/** `POST /api/boards/:bid/invitations/email`: never ownership (the same cap as invite links). */
export const EmailInviteInput = z.object({ email: InviteEmail, role: RequestableRole })
export type EmailInviteInput = z.input<typeof EmailInviteInput>

/**
 * Why an email invitation came back as a link to copy instead:
 * - `email_not_configured`: this server signs people in without Clerk (development): no email is sent;
 * - `existing_account`: the address belongs to a sign-in account that has not opened Draftroom yet
 *   (Clerk emails invitations only to new people);
 * - `invalid_email`: the email service refused the address;
 * - `rate_limited`: the email service is limiting invitations right now;
 * - `provider_error`: the email service failed or did not answer.
 */
export const EmailInviteFallbackReason = z.enum([
  'email_not_configured',
  'existing_account',
  'invalid_email',
  'rate_limited',
  'provider_error',
])
export type EmailInviteFallbackReason = z.infer<typeof EmailInviteFallbackReason>

/**
 * - `granted`: the address belongs to someone who already uses Draftroom: they have the board role
 *   now (`role` is their access afterwards; `alreadyHadAccess`: nothing changed, since an invite
 *   never lowers a role);
 * - `emailed`: a single-use invite link went to the address by email (the link is not shown here);
 * - `link`: no email went out (`reason`); the single-use link is for the inviter to send.
 */
export const EmailInviteResult = z.discriminatedUnion('mode', [
  z.object({
    mode: z.literal('granted'),
    get user() {
      return User
    },
    role: Role,
    alreadyHadAccess: z.boolean(),
  }),
  z.object({
    mode: z.literal('emailed'),
    email: z.string(),
    get invitationId() {
      return InvitationId
    },
    expiresAt: IsoDate,
  }),
  z.object({
    mode: z.literal('link'),
    reason: EmailInviteFallbackReason,
    email: z.string(),
    get invitationId() {
      return InvitationId
    },
    url: z.string(),
    expiresAt: IsoDate,
  }),
])
export type EmailInviteResult = z.infer<typeof EmailInviteResult>
