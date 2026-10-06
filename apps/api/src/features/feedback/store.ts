// The feedback table (migration 0026): inserts, the keyset-paged list and the status change. SQL only; the
// routes (./index.ts) decide who may call what. Nothing here logs: rows hold what people typed.

import {
  FeedbackContext,
  type FeedbackInternalItem,
  type FeedbackItem,
  type FeedbackKind,
  type FeedbackStatus,
} from '@draftroom/contracts'
import type { Queryable } from '@draftroom/db'
import { ApiError } from '../../errors.ts'

const BASE62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'

/** `fbk_` + 20 base62 characters (the generator shape of @draftroom/db newId). */
export function newFeedbackId(): string {
  const limit = 256 - (256 % BASE62.length)
  let out = ''
  while (out.length < 20) {
    const bytes = new Uint8Array(32)
    crypto.getRandomValues(bytes)
    for (const b of bytes) {
      if (b >= limit) continue
      out += BASE62[b % BASE62.length]
      if (out.length === 20) break
    }
  }
  return `fbk_${out}`
}

interface FeedbackRow {
  id: string
  created_at: Date
  user_id: string
  user_name: string
  user_kind: string
  context: unknown
  text: string
  expected: string | null
  status: string
  status_at: Date | null
}

const COLUMNS = 'id, created_at, user_id, user_name, user_kind, context, text, expected, status, status_at'

const EMPTY_CONTEXT: FeedbackContext = {
  path: '(unknown)',
  boardId: null,
  boardTitle: null,
  userAgent: '',
  viewport: { width: 0, height: 0 },
  build: 'unknown',
  at: '',
}

function contextOf(raw: unknown): FeedbackContext {
  let value = raw
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value)
    } catch {
      return EMPTY_CONTEXT
    }
  }
  const parsed = FeedbackContext.safeParse(value)
  return parsed.success ? parsed.data : EMPTY_CONTEXT
}

const kindOf = (v: string): FeedbackKind => (v === 'guest' ? 'guest' : 'account')
const statusOf = (v: string): FeedbackStatus => (v === 'done' ? 'done' : 'open')

export function toItem(r: FeedbackRow): FeedbackItem {
  return {
    id: r.id,
    createdAt: r.created_at.toISOString(),
    userId: r.user_id,
    name: r.user_name,
    kind: kindOf(r.user_kind),
    text: r.text,
    expected: r.expected,
    context: contextOf(r.context),
    status: statusOf(r.status),
    statusAt: r.status_at ? r.status_at.toISOString() : null,
  }
}

/** The internal read's shape: ids, text and context; no display name. */
export function toInternalItem(i: FeedbackItem): FeedbackInternalItem {
  return {
    id: i.id,
    createdAt: i.createdAt,
    status: i.status,
    kind: i.kind,
    userId: i.userId,
    text: i.text,
    expected: i.expected,
    context: i.context,
  }
}

export interface NewFeedback {
  id: string
  createdAt: Date
  userId: string
  userName: string
  userKind: FeedbackKind
  context: FeedbackContext
  text: string
  expected: string | null
}

export async function insertFeedback(q: Queryable, f: NewFeedback): Promise<void> {
  await q.query(
    `INSERT INTO feedback (id, created_at, user_id, user_name, user_kind, context, text, expected)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8)`,
    [f.id, f.createdAt, f.userId, f.userName, f.userKind, JSON.stringify(f.context), f.text, f.expected],
  )
}

const CURSOR_RE = /^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z)\|(fbk_[0-9A-Za-z]{10,40})$/

const encodeCursor = (r: { created_at: Date; id: string }) =>
  Buffer.from(`${r.created_at.toISOString()}|${r.id}`).toString('base64url')

function decodeCursor(cursor: string): { at: Date; id: string } {
  const m = CURSOR_RE.exec(Buffer.from(cursor, 'base64url').toString('utf8'))
  const at = m?.[1] ? new Date(m[1]) : null
  if (!m?.[2] || !at || !Number.isFinite(at.getTime()))
    throw new ApiError(400, 'BAD_REQUEST', 'That page cursor is not valid.')
  return { at, id: m[2] }
}

export interface ListOptions {
  status: FeedbackStatus | 'all'
  limit: number
  cursor?: string | undefined
}

/** Newest first, paged by (created_at, id): a message sent while someone pages never shifts a page. */
export async function listFeedback(
  q: Queryable,
  opts: ListOptions,
): Promise<{ items: FeedbackItem[]; next: string | null }> {
  const where: string[] = []
  const params: unknown[] = []
  if (opts.status !== 'all') {
    params.push(opts.status)
    where.push(`status = $${params.length}`)
  }
  if (opts.cursor) {
    const c = decodeCursor(opts.cursor)
    params.push(c.at, c.id)
    where.push(`(created_at, id) < ($${params.length - 1}::timestamptz, $${params.length}::text)`)
  }
  params.push(opts.limit + 1)
  const rows = (
    await q.query<FeedbackRow>(
      `SELECT ${COLUMNS} FROM feedback ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
        ORDER BY created_at DESC, id DESC LIMIT $${params.length}`,
      params,
    )
  ).rows
  const page = rows.slice(0, opts.limit)
  const last = page.at(-1)
  return {
    items: page.map(toItem),
    next: rows.length > opts.limit && last ? encodeCursor(last) : null,
  }
}

export async function getFeedback(q: Queryable, id: string): Promise<FeedbackItem | null> {
  const row = await q.maybeOne<FeedbackRow>(`SELECT ${COLUMNS} FROM feedback WHERE id = $1`, [id])
  return row ? toItem(row) : null
}

/**
 * Marks it done (or open again) and records who and when. Idempotent: a message that already has the
 * status is returned as it is, its time and author untouched. null when there is no such message.
 */
export async function setFeedbackStatus(
  q: Queryable,
  id: string,
  status: FeedbackStatus,
  by: string,
  at: Date,
): Promise<FeedbackItem | null> {
  const changed = await q.maybeOne<FeedbackRow>(
    `UPDATE feedback SET status = $2, status_at = $3, status_by = $4
      WHERE id = $1 AND status <> $2 RETURNING ${COLUMNS}`,
    [id, status, at, by],
  )
  return changed ? toItem(changed) : getFeedback(q, id)
}
