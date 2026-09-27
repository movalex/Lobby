// Shared setup for the comments API tests: one Dev Studio board with a person per role, a workspace
// member without access to it, and an outsider board in another workspace. Board events are recorded.

import type { CommentThread, ListNotificationsResponse } from '@draftroom/contracts'
import { ListNotificationsResponse as NotificationsSchema, ThreadResponse } from '@draftroom/contracts'
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
