// FROZEN (wave S foundation, 2026-10-16): the response schemas a web build of LOBBY_CLIENT_REV 2 (main 9c359183, the
// build before wave S) parses, copied as they were in packages/contracts/src/{comments,chat-hooks,thumbnails}.ts at
// that commit. Never edit them: they stand for the tabs of that build that stay open for days after a deploy.
//
// A revision-3 api must answer a request that declares revision 2 (or none) so that THESE parse: no 'review_status'
// bell item (NotificationKind is an enum: one unknown value fails the whole list), no 'review_status' chat kind (the
// same for ChatPrefsResponse). New optional fields are fine where the old schema is a z.object (unknown keys are
// stripped): CommentThread.spot, NotificationItem.review, the board list's review counts. The tests that hold the api
// to this: packages/contracts/src/wave-s.test.ts and apps/api/test/features/review/client-rev3.test.ts.

import { z } from 'zod'

const prefixedId = (p: string) => z.string().regex(new RegExp(`^${p}_[0-9A-Za-z]{10,40}$`))
const userIdSchema = prefixedId('usr')
const boardIdSchema = z.string().regex(/^[a-z0-9][a-z0-9_-]{2,63}$/)
const isoDate = z.string()
const CommentShapeRef = z.string().regex(/^shape:[A-Za-z0-9_.:-]{1,120}$/)
const CommentPageRef = z.string().regex(/^page:[A-Za-z0-9_.:-]{1,120}$/)
const coord = z.number().min(-1e7).max(1e7)
const unit = z.number().min(0).max(1)

const CommentAnchor = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('point'), x: coord, y: coord, pageId: CommentPageRef.optional() }),
  z.strictObject({ kind: z.literal('shape'), shapeId: CommentShapeRef, u: unit, v: unit }),
  z.strictObject({
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
  }),
])

const CommentUserRef = z.object({
  id: userIdSchema,
  name: z.string(),
  color: z.string(),
  external: z.boolean().optional(),
})

const ThreadComment = z.object({
  id: prefixedId('cmt'),
  threadId: prefixedId('thr'),
  author: CommentUserRef,
  body: z.string(),
  mentions: z.array(userIdSchema),
  createdAt: isoDate,
  editedAt: isoDate.nullable(),
})

export const Rev2CommentThread = z.object({
  id: prefixedId('thr'),
  boardId: boardIdSchema,
  anchor: CommentAnchor,
  status: z.enum(['open', 'resolved']),
  createdBy: CommentUserRef,
  createdAt: isoDate,
  updatedAt: isoDate,
  resolvedBy: CommentUserRef.nullable(),
  resolvedAt: isoDate.nullable(),
  visibility: z.enum(['everyone', 'team']).default('everyone'),
  comments: z.array(ThreadComment),
})

export const Rev2ListThreadsResponse = z.object({
  threads: z.array(Rev2CommentThread),
  reads: z.record(z.string(), isoDate),
  privacy: z.object({ teamOnly: z.boolean(), teamOnlyDefault: z.boolean() }).optional(),
})

export const Rev2NotificationKind = z.enum([
  'mention',
  'reply',
  'resolved',
  'access_request',
  'new_comment',
  'access_granted',
  'outsider_joined',
])

export const Rev2NotificationItem = z.object({
  id: prefixedId('ntf'),
  kind: Rev2NotificationKind,
  boardId: boardIdSchema,
  boardTitle: z.string(),
  threadId: prefixedId('thr').nullable(),
  commentId: prefixedId('cmt').nullable(),
  actor: CommentUserRef.nullable(),
  snippet: z.string().nullable(),
  accessRequest: z
    .object({
      role: z.enum(['editor', 'commenter', 'viewer']),
      message: z.string().nullable(),
      status: z.enum(['pending', 'approved', 'denied']),
    })
    .nullable()
    .optional(),
  accessGranted: z
    .object({ role: z.enum(['editor', 'commenter', 'viewer']) })
    .nullable()
    .optional(),
  outsiderJoined: z.object({ emailDomain: z.string().nullable() }).nullable().optional(),
  createdAt: isoDate,
  readAt: isoDate.nullable(),
})

export const Rev2ListNotificationsResponse = z.object({
  notifications: z.array(Rev2NotificationItem),
  unreadCount: z.number().int().min(0),
  seq: z.number().int().min(0).optional(),
})

export const Rev2ChatHookKind = z.enum([
  'mention',
  'reply',
  'new_comment',
  'access_request',
  'outsider_joined',
])

export const Rev2ChatPrefsResponse = z.object({
  hooks: z.array(
    z.object({
      id: z.string().regex(/^chk_[0-9A-Za-z]{10,40}$/),
      name: z.string(),
      provider: z.enum(['slack', 'teams']),
      disabled: z.boolean(),
    }),
  ),
  prefs: z.array(
    z.object({ hookId: z.string().regex(/^chk_[0-9A-Za-z]{10,40}$/), kinds: z.array(Rev2ChatHookKind) }),
  ),
})
