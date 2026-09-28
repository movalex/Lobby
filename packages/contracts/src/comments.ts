// API schemas for the comments feature (docs/FEATURES-M2-CONTRACTS.md, "comments"). Owned by the
// comments engineer. Browser-safe (zod only), shared by apps/api (validates input, shapes output) and
// apps/web (parses responses and board events).
//
// Deliberately self-contained: index.ts re-exports this module (`export *`), so importing from
// './index.ts' here would be a circular import evaluated before index.ts initializes. Every exported
// name is prefixed (Comment*/Thread*/Notification*/Mention*) so it cannot collide with other modules.

import { z } from 'zod'

// ---- ids ---------------------------------------------------------------------------------------

const prefixedId = (p: string) => z.string().regex(new RegExp(`^${p}_[0-9A-Za-z]{10,40}$`))
const userIdSchema = prefixedId('usr')
const boardIdSchema = z.string().regex(/^[a-z0-9][a-z0-9_-]{2,63}$/)
const isoDate = z.string()

export const CommentThreadId = prefixedId('thr')
export const CommentId = prefixedId('cmt')
export const NotificationId = prefixedId('ntf')

/** tldraw record ids: `shape:<id>` / `page:<id>` (tldraw uses [A-Za-z0-9_-]; templates may add more). */
export const CommentShapeRef = z.string().regex(/^shape:[A-Za-z0-9_.:-]{1,120}$/)
export const CommentPageRef = z.string().regex(/^page:[A-Za-z0-9_.:-]{1,120}$/)

// ---- anchors -----------------------------------------------------------------------------------

/** Page coordinates are bounded so a hostile client cannot store absurd values. */
const coord = z.number().min(-1e7).max(1e7)
const unit = z.number().min(0).max(1)

/**
 * A pin at a board position. `pageId` (optional extension of the contract) keeps the pin on the page
 * it was placed on; pins without it show on every page.
 */
export const CommentPointAnchor = z.strictObject({
  kind: z.literal('point'),
  x: coord,
  y: coord,
  pageId: CommentPageRef.optional(),
})

/**
 * Attached to a shape: (u, v) in [0, 1] relative to the shape's own bounds (equal to its page bounds
 * when the shape is not rotated), so the pin follows the shape as it moves, resizes and rotates.
 */
export const CommentShapeAnchor = z.strictObject({
  kind: z.literal('shape'),
  shapeId: CommentShapeRef,
  u: unit,
  v: unit,
})

/** Attached to a file card, optionally at a PDF page or a video time (FIL-11). */
export const CommentAssetAnchor = z.strictObject({
  kind: z.literal('asset'),
  shapeId: CommentShapeRef,
  assetId: prefixedId('ast'),
  versionId: prefixedId('ver'),
  page: z.number().int().min(1).max(100_000).optional(),
  timeMs: z
    .number()
    .int()
    .min(0)
    .max(24 * 3600_000)
    .optional(),
})

export const CommentAnchor = z.discriminatedUnion('kind', [
  CommentPointAnchor,
  CommentShapeAnchor,
  CommentAssetAnchor,
])
export type CommentAnchor = z.infer<typeof CommentAnchor>
export type CommentPointAnchor = z.infer<typeof CommentPointAnchor>
export type CommentShapeAnchor = z.infer<typeof CommentShapeAnchor>
export type CommentAssetAnchor = z.infer<typeof CommentAssetAnchor>

// ---- bodies and mentions -------------------------------------------------------------------------

export const COMMENT_BODY_MAX = 5000

/** Plain text (comments are never rich text). Trimmed; 1..5000 characters. */
export const CommentBody = z
  .string()
  .transform((s) => s.replace(/\r\n?/g, '\n').trim())
  .pipe(z.string().min(1, 'Write something first.').max(COMMENT_BODY_MAX))

/**
 * Mention token inside a comment body: `@[Display Name](usr_…)`. The display name may not contain
 * `[`, `]` or a newline. The server normalizes the name to the user's real name for people who can
 * view the board and turns every other token into plain `@Name` text (so nobody can fake a mention).
 */
export const MENTION_TOKEN_RE = /@\[([^\]\n[]{1,80})\]\((usr_[0-9A-Za-z]{10,40})\)/g

export interface MentionToken {
  name: string
  userId: string
  /** Offset of the token's `@` in the body, and the token's length. */
  index: number
  length: number
}

export function parseMentionTokens(body: string): MentionToken[] {
  const out: MentionToken[] = []
  for (const m of body.matchAll(new RegExp(MENTION_TOKEN_RE.source, 'g'))) {
    out.push({ name: m[1] ?? '', userId: m[2] ?? '', index: m.index ?? 0, length: m[0].length })
  }
  return out
}

/** Distinct mentioned user ids, in order of first appearance. */
export function mentionedUserIds(body: string): string[] {
  return [...new Set(parseMentionTokens(body).map((t) => t.userId))]
}

/** A display name made safe for a token (no brackets/newlines, 1..80 characters). */
export function mentionTokenFor(name: string, userId: string): string {
  const clean =
    name
      .replace(/[[\]\n\r]/g, ' ')
      .trim()
      .slice(0, 80) || 'someone'
  return `@[${clean}](${userId})`
}

/**
 * Rewrites every mention token: `keep(userId)` returns the name to use (the user's real name) or null
 * to turn the token into plain `@Name` text.
 */
export function rewriteMentionTokens(body: string, keep: (userId: string) => string | null): string {
  return body.replace(new RegExp(MENTION_TOKEN_RE.source, 'g'), (_all, name: string, userId: string) => {
    const real = keep(userId)
    return real === null ? `@${name}` : mentionTokenFor(real, userId)
  })
}

// ---- entities ------------------------------------------------------------------------------------

export const CommentUserRef = z.object({ id: userIdSchema, name: z.string(), color: z.string() })
export type CommentUserRef = z.infer<typeof CommentUserRef>

export const ThreadComment = z.object({
  id: CommentId,
  threadId: CommentThreadId,
  author: CommentUserRef,
  body: z.string(),
  /** Users this comment notified (people who could view the board when it was written). */
  mentions: z.array(userIdSchema),
  createdAt: isoDate,
  editedAt: isoDate.nullable(),
})
export type ThreadComment = z.infer<typeof ThreadComment>

export const CommentThreadStatus = z.enum(['open', 'resolved'])
export type CommentThreadStatus = z.infer<typeof CommentThreadStatus>

/**
 * One thread with its live (not deleted) comments, oldest first. Identical for every viewer of the
 * board (it is published as a board event), so it carries no per-user state; read state comes from
 * ListThreadsResponse.reads and the caller's own POST …/read.
 */
export const CommentThread = z.object({
  id: CommentThreadId,
  boardId: boardIdSchema,
  anchor: CommentAnchor,
  status: CommentThreadStatus,
  createdBy: CommentUserRef,
  createdAt: isoDate,
  updatedAt: isoDate,
  resolvedBy: CommentUserRef.nullable(),
  resolvedAt: isoDate.nullable(),
  comments: z.array(ThreadComment),
})
export type CommentThread = z.infer<typeof CommentThread>

// ---- requests / responses --------------------------------------------------------------------------

export const ListThreadsQuery = z.object({ status: z.enum(['open', 'resolved', 'all']).optional() })

export const ListThreadsResponse = z.object({
  threads: z.array(CommentThread),
  /** The caller's own read marks: threadId -> ISO time they last read it. */
  reads: z.record(z.string(), isoDate),
})
export type ListThreadsResponse = z.infer<typeof ListThreadsResponse>

export const CreateThreadInput = z.strictObject({ anchor: CommentAnchor, body: CommentBody })
export const CreateCommentInput = z.strictObject({ body: CommentBody })
export const EditCommentInput = z.strictObject({ body: CommentBody })

export const ThreadResponse = z.object({ thread: CommentThread })
export type ThreadResponse = z.infer<typeof ThreadResponse>

export const ThreadReadResponse = z.object({ threadId: CommentThreadId, readAt: isoDate })

// ---- board events (after commit, via GET /api/boards/:bid/events) ----------------------------------

export const COMMENTS_THREAD_EVENT = 'comments.thread'
export const COMMENTS_DELETED_EVENT = 'comments.deleted'
export const CommentsThreadEvent = z.object({ thread: CommentThread })
export const CommentsDeletedEvent = z.object({ threadId: CommentThreadId, commentId: CommentId })

// ---- notifications (in-app only: no email is sent) ------------------------------------------------

/**
 * mention: you were @mentioned; reply: someone replied in a thread you follow; resolved: a thread you
 * follow was resolved; access_request: someone asked for access (other features insert these);
 * new_comment (DANA-02): someone started a thread on a board you own (at most a few unread per author).
 */
export const NotificationKind = z.enum(['mention', 'reply', 'resolved', 'access_request', 'new_comment'])
export type NotificationKind = z.infer<typeof NotificationKind>

/** What an access-request notification asks for (the request itself, as it stands now). */
export const NotificationAccessRequest = z.object({
  role: z.enum(['editor', 'commenter', 'viewer']),
  message: z.string().nullable(),
  status: z.enum(['pending', 'approved', 'denied']),
})
export type NotificationAccessRequest = z.infer<typeof NotificationAccessRequest>

export const NotificationItem = z.object({
  id: NotificationId,
  kind: NotificationKind,
  boardId: boardIdSchema,
  boardTitle: z.string(),
  threadId: CommentThreadId.nullable(),
  commentId: CommentId.nullable(),
  actor: CommentUserRef.nullable(),
  /** Start of the comment (plain text, mention tokens as @Name), when there is one. */
  snippet: z.string().nullable(),
  /** access_request only: the requested role and message of that person's latest request. */
  accessRequest: NotificationAccessRequest.nullable().optional(),
  createdAt: isoDate,
  readAt: isoDate.nullable(),
})
export type NotificationItem = z.infer<typeof NotificationItem>

export const ListNotificationsQuery = z.object({ unread: z.enum(['1', 'true']).optional() })
export const ListNotificationsResponse = z.object({
  notifications: z.array(NotificationItem),
  unreadCount: z.number().int().min(0),
})
export type ListNotificationsResponse = z.infer<typeof ListNotificationsResponse>

/** Marks the caller's own notifications read (`all: true` marks every one). */
export const MarkNotificationsReadInput = z
  .strictObject({ ids: z.array(NotificationId).max(500).optional(), all: z.literal(true).optional() })
  .refine((v) => v.all === true || (v.ids?.length ?? 0) > 0, 'ids or all is required')

/** Mention tokens rendered as "@Name" (for snippets, previews and notifications). */
export function commentPlainText(body: string): string {
  return body.replace(new RegExp(MENTION_TOKEN_RE.source, 'g'), (_all, name: string) => `@${name}`)
}
