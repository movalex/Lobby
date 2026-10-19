// Wave W, the workspace admin page (WS5; docs/WAVE-W-CONTRACTS.md §7). OWNER: the wave W lead (packages/contracts is
// lead-only). `/w/:wid/admin` in the web, five tabs, each backed by an owner/admin route under
// /api/workspaces/:wid/admin/ (apps/api/src/features/workspace-admin/**). Everyone else, a member, a workspace guest, a
// name-only guest, someone of another workspace, gets the unknown route's 404 (never a 403: the page does not tell
// anyone it exists), and so does everyone while DRAFTROOM_WORKSPACE_ADMIN is off.
//
// The page CHANGES nothing by itself: a role change, a removal, a revoke or an extend calls the EXISTING routes (the
// creator rule, the last-owner rule and the per-board link rules stay where they are), and retention is read-only
// (nothing here deletes data). New responses only: `action` and the retention ids are free strings, so a later audit
// action or retention fact never needs a LOBBY_CLIENT_REV bump.
//
// Do not import values from ./index.ts here: index.ts re-exports this module.

import { z } from 'zod'
import { OutsideFields } from './outside.ts'

const prefixed = (p: string) => z.string().regex(new RegExp(`^${p}_[0-9A-Za-z]{10,40}$`))
const UserIdLike = prefixed('usr')
const BoardIdLike = z.string().regex(/^[a-z0-9][a-z0-9_-]{2,63}$/)
const IsoDate = z.string()
const Count = z.number().int().min(0)
const Bytes = z.number().int().min(0)

/** The admin routes (pending until WS5 lands them; gated by DRAFTROOM_WORKSPACE_ADMIN; owner/admin only). */
export const ADMIN_ROUTE_KEYS = {
  members: 'GET /api/workspaces/:wid/admin/members',
  invitations: 'GET /api/workspaces/:wid/admin/invitations',
  storageByBoard: 'GET /api/workspaces/:wid/admin/storage/by-board',
  storageByUploader: 'GET /api/workspaces/:wid/admin/storage/by-uploader',
  audit: 'GET /api/workspaces/:wid/admin/audit',
  links: 'GET /api/workspaces/:wid/admin/links',
  retention: 'GET /api/workspaces/:wid/admin/retention',
} as const
export type AdminRouteName = keyof typeof ADMIN_ROUTE_KEYS

export const adminPath = (workspaceId: string, tail: string) =>
  `/api/workspaces/${workspaceId}/admin/${tail.replace(/^\/+/, '')}`

/** The web route of the page. */
export const adminWebPath = (workspaceId: string) => `/w/${workspaceId}/admin`

export const ADMIN_TABS = ['members', 'storage', 'audit', 'links', 'retention'] as const
export type AdminTab = (typeof ADMIN_TABS)[number]

export const ADMIN_LIMITS = {
  /** rows per page of the audit log, invitations and links */
  pageSize: 100,
  /** rows of the by-board and by-uploader storage lists */
  topRows: 50,
  /** boards listed per name-only guest on the links tab (WS5; `grants` counts them all) */
  guestBoards: 20,
  /** requests per user over every admin route */
  rate: { max: 20, timeWindow: 10_000 },
} as const

const Person = z.object({ id: UserIdLike, name: z.string() })

// ---- members --------------------------------------------------------------------------------------------------------

export const AdminMember = z.object({
  user: Person,
  role: z.enum(['owner', 'admin', 'member', 'guest']),
  /** a creator (docs/DOMAIN-ACCESS-CONTRACTS.md): may make boards and hand out access */
  creator: z.boolean(),
  /** boards in this workspace this person holds a direct grant on */
  boardGrants: Count,
  // No "last visit": 0031_board_visits stores visit times on the owner's condition that nobody else ever sees who
  // visited when (only the person's own row is read). docs/WAVE-W-CONTRACTS.md §12 departure 3.
  ...OutsideFields,
})
export type AdminMember = z.infer<typeof AdminMember>
export const AdminMembersResponse = z.object({ members: z.array(AdminMember) })
export type AdminMembersResponse = z.infer<typeof AdminMembersResponse>

/** A pending invitation (workspace or board): the email hint only, never the address or the token. */
export const AdminInvitation = z.object({
  id: prefixed('inv'),
  scope: z.enum(['workspace', 'board']),
  board: z.object({ id: BoardIdLike, title: z.string() }).nullable(),
  role: z.string(),
  emailHint: z.string().nullable(),
  invitedBy: Person.nullable(),
  createdAt: IsoDate,
  expiresAt: IsoDate.nullable(),
})
export type AdminInvitation = z.infer<typeof AdminInvitation>
export const AdminInvitationsResponse = z.object({ invitations: z.array(AdminInvitation), more: z.boolean() })
export type AdminInvitationsResponse = z.infer<typeof AdminInvitationsResponse>

// ---- storage --------------------------------------------------------------------------------------------------------

/** One row of the by-board or by-uploader lists: the same sums as files/usage.ts workspaceUsage. */
export const AdminStorageRow = z.object({
  /** a board ({id, title}) or an uploader ({id, name}) */
  board: z.object({ id: BoardIdLike, title: z.string() }).nullable(),
  uploader: Person.nullable(),
  versions: Count,
  bytes: Bytes,
})
export type AdminStorageRow = z.infer<typeof AdminStorageRow>
export const AdminStorageResponse = z.object({
  rows: z.array(AdminStorageRow),
  /** the workspace's total and its quota (the same numbers as GET …/storage) */
  total: z.object({ versions: Count, bytes: Bytes, quotaBytes: Bytes }),
  /** file text kept for search (wave W WS3; 0 until extraction runs) */
  fileTextBytes: Bytes,
})
export type AdminStorageResponse = z.infer<typeof AdminStorageResponse>

// ---- audit ----------------------------------------------------------------------------------------------------------

export const AdminAuditQuery = z.object({
  /** the last id of the previous page (newest first); absent: the newest */
  before: z.coerce.number().int().min(1).optional(),
  action: z
    .string()
    .regex(/^[a-z][a-z_.]{0,63}$/)
    .optional(),
  actor: UserIdLike.optional(),
  limit: z.coerce.number().int().min(1).max(ADMIN_LIMITS.pageSize).optional(),
})
export type AdminAuditQuery = z.infer<typeof AdminAuditQuery>

/** A detail value as shown: a short scalar picked by the action's allowlist (audit-view.ts), never raw jsonb. */
export const AdminAuditDetailValue = z.union([z.string().max(200), z.number(), z.boolean(), z.null()])

export const AdminAuditEvent = z.object({
  /** audit_events.id (bigserial; a number below 2^53) */
  id: z.number().int().min(1),
  at: IsoDate,
  /** the action name (a free string: a new action needs no client bump) */
  action: z.string(),
  actor: Person.nullable(),
  board: z.object({ id: BoardIdLike, title: z.string() }).nullable(),
  detail: z.record(z.string(), AdminAuditDetailValue),
})
export type AdminAuditEvent = z.infer<typeof AdminAuditEvent>
export const AdminAuditResponse = z.object({
  events: z.array(AdminAuditEvent),
  /** pass as `before` for the next page; null at the end */
  nextBefore: z.number().int().min(1).nullable(),
})
export type AdminAuditResponse = z.infer<typeof AdminAuditResponse>

// ---- guest links ----------------------------------------------------------------------------------------------------

export const AdminLink = z.object({
  id: prefixed('inv'),
  board: z.object({ id: BoardIdLike, title: z.string() }),
  kind: z.enum(['review', 'workshop', 'landing', 'other']),
  role: z.string(),
  /** lets people join with a name only */
  allowGuests: z.boolean(),
  /** a workshop link with a join code (wave V); never the code */
  hasJoinCode: z.boolean(),
  createdBy: Person.nullable(),
  createdAt: IsoDate,
  expiresAt: IsoDate.nullable(),
  uses: Count,
  maxUses: Count.nullable(),
})
export type AdminLink = z.infer<typeof AdminLink>

export const AdminGuest = z.object({
  user: Person,
  /** boards this name-only guest holds a grant on */
  grants: Count,
  /**
   * WS5: those boards (at most ADMIN_LIMITS.guestBoards, the newest grants first), so the page can take the guest off
   * one through the existing DELETE /api/boards/:bid/members/:uid
   */
  boards: z.array(z.object({ id: BoardIdLike, title: z.string() })),
  joinedAt: IsoDate,
})
export type AdminGuest = z.infer<typeof AdminGuest>

export const AdminLinksResponse = z.object({
  links: z.array(AdminLink),
  guests: z.array(AdminGuest),
  more: z.boolean(),
})
export type AdminLinksResponse = z.infer<typeof AdminLinksResponse>

// ---- retention (read-only) ------------------------------------------------------------------------------------------

/** One retention fact the api knows (or documents). Read-only: the page offers no control that deletes anything. */
export const AdminRetentionFact = z.object({
  /** a stable id, e.g. `checkpoints.hourly`, `trash`, `asset-gc` (a free string) */
  id: z.string().regex(/^[a-z][a-z0-9.-]{0,63}$/),
  label: z.string(),
  /** what is kept, in words ("48 hours", "Kept until restored") */
  value: z.string(),
  /** where the value comes from: the api's code, its environment, or the docs (sync's backups) */
  source: z.enum(['code', 'env', 'documented']),
})
export type AdminRetentionFact = z.infer<typeof AdminRetentionFact>
export const AdminRetentionResponse = z.object({ facts: z.array(AdminRetentionFact) })
export type AdminRetentionResponse = z.infer<typeof AdminRetentionResponse>

/** The retention facts every admin api answers with (WS5 may add; never remove one without the lead). */
export const ADMIN_RETENTION_FACT_IDS = [
  'trash',
  'checkpoints.hourly',
  'checkpoints.daily',
  'checkpoints.weekly',
  'asset-gc',
  'visits',
  'library.deleted',
  'imports.listed',
  'chat.outbox',
  'audit',
  'board.backups',
] as const
