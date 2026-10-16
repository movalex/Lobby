// Shared setup for the comments API tests: one Dev Studio board with a person per role, a workspace
// member without access to it, and an outsider board in another workspace. Board events are recorded.

import type { CommentThread, ListNotificationsResponse } from '@draftroom/contracts'
import { ListNotificationsResponse as NotificationsSchema, ThreadResponse } from '@draftroom/contracts'
import { newId } from '@draftroom/dev-assets'
import { type DeliveredEvent, EventHub } from '../../../src/events/hub.ts'
import { type Client, createBoard, createTestApi, DEV_STUDIO, type TestApi } from '../../helpers.ts'

export interface Fixture {
  api: TestApi
  owner: Client // Dev Studio owner (first login) -> board owner everywhere in Dev Studio
  editor: Client
  commenter: Client
  commenter2: Client
  viewer: Client
  stranger: Client // Dev Studio member without any access to the private board
  boardId: string
  /** A board in the owner's personal workspace (nobody else is a member there). */
  foreignBoardId: string
  events: DeliveredEvent[]
  close(): Promise<void>
}

export async function setup(): Promise<Fixture> {
  const hub = new EventHub()
  const api = await createTestApi({ deps: { events: hub } })
  const owner = await api.login('owner', 'Olive Owner')
  const editor = await api.login('ed', 'Ed Editor')
  const commenter = await api.login('carol', 'Carol Commenter')
  const commenter2 = await api.login('cody', 'Cody Commenter')
  const viewer = await api.login('vic', 'Vic Viewer')
  const stranger = await api.login('stan', 'Stan Stranger')
  const boardId = await createBoard(owner, DEV_STUDIO, 'Review board')
  const foreignBoardId = await createBoard(owner, owner.personalWorkspaceId, 'Private elsewhere')
  for (const [c, role] of [
    [editor, 'editor'],
    [commenter, 'commenter'],
    [commenter2, 'commenter'],
    [viewer, 'viewer'],
  ] as const) {
    const res = await owner.req('PUT', `/api/boards/${boardId}/members/${c.userId}`, { role })
    if (res.statusCode !== 200) throw new Error(`grant failed: ${res.body}`)
  }
  const events: DeliveredEvent[] = []
  hub.subscribe(boardId, (e) => events.push(e))
  hub.subscribe(foreignBoardId, (e) => events.push(e))
  return {
    api,
    owner,
    editor,
    commenter,
    commenter2,
    viewer,
    stranger,
    boardId,
    foreignBoardId,
    events,
    close: () => api.close(),
  }
}

export const point = (x = 10, y = 20) => ({ kind: 'point' as const, x, y })
export const onShape = (shapeId = 'shape:abc123', u = 0.5, v = 0.25) => ({
  kind: 'shape' as const,
  shapeId,
  u,
  v,
})
export const mention = (c: Client, name = c.me.user.name) => `@[${name}](${c.userId})`

export async function createThread(
  c: Client,
  boardId: string,
  body = 'Looks good',
  anchor: object = point(),
): Promise<CommentThread> {
  const res = await c.req('POST', `/api/boards/${boardId}/threads`, { anchor, body })
  if (res.statusCode !== 201) throw new Error(`create thread failed: ${res.statusCode} ${res.body}`)
  return ThreadResponse.parse(res.json()).thread
}

export async function reply(c: Client, threadId: string, body: string): Promise<CommentThread> {
  const res = await c.req('POST', `/api/threads/${threadId}/comments`, { body })
  if (res.statusCode !== 201) throw new Error(`reply failed: ${res.statusCode} ${res.body}`)
  return ThreadResponse.parse(res.json()).thread
}

export async function notificationsOf(c: Client): Promise<ListNotificationsResponse> {
  const res = await c.req('GET', '/api/me/notifications')
  if (res.statusCode !== 200) throw new Error(`notifications failed: ${res.statusCode} ${res.body}`)
  return NotificationsSchema.parse(res.json())
}

export async function countRows(api: TestApi, table: 'comment_threads' | 'comments' | 'notifications') {
  return (await api.db.one<{ n: number }>(`SELECT count(*)::int AS n FROM ${table}`)).n
}

const MIME = {
  image: 'image/png',
  pdf: 'application/pdf',
  video: 'video/mp4',
  other: 'application/zip',
} as const

/**
 * Wave S (WS3): a version row of `kind` uploaded to `boardId` (or a new version of `assetId`), with the probe facts
 * the anchor checks read (pageCount, durationMs). No blob: the checks never read one.
 */
export async function addVersion(
  api: TestApi,
  by: Client,
  boardId: string,
  kind: keyof typeof MIME,
  probe: { pageCount?: number | null; durationMs?: number | null } = {},
  opts: { assetId?: string; workspaceId?: string } = {},
): Promise<{ assetId: string; versionId: string }> {
  const assetId = opts.assetId ?? newId('ast')
  const versionId = newId('ver')
  await api.db.query(
    `INSERT INTO asset_versions (id, asset_id, workspace_id, board_id, name, declared_mime_type, mime_type, kind,
                                 size_bytes, sha256, uploaded_by, status, probe)
     VALUES ($1, $2, $3, $4, $5, $6, $6, $7, 10, $8, $9, 'ready', $10::jsonb)`,
    [
      versionId,
      assetId,
      opts.workspaceId ?? DEV_STUDIO,
      boardId,
      `file.${kind}`,
      MIME[kind],
      kind,
      '0'.repeat(64),
      by.userId,
      JSON.stringify({
        width: null,
        height: null,
        pageCount: probe.pageCount ?? null,
        durationMs: probe.durationMs ?? null,
        videoCodec: null,
        audioCodec: null,
      }),
    ],
  )
  return { assetId, versionId }
}

/** An `asset` anchor on the card `shape:card1` for a version (with an optional page or time). */
export const onFile = (
  v: { assetId: string; versionId: string },
  at: { page?: number; timeMs?: number } = {},
) => ({
  kind: 'asset' as const,
  shapeId: 'shape:card1',
  assetId: v.assetId,
  versionId: v.versionId,
  ...at,
})
