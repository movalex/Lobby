// Typed calls for the comments routes (docs/FEATURES-M2-CONTRACTS.md, "comments"), through the app's
// ApiClient.request (same-origin JSON, responses validated against @draftroom/contracts).

import {
  type CommentAnchor,
  type CommentThread,
  type CommentThreadVisibility,
  ListNotificationsResponse,
  ListThreadsResponse,
  ThreadReadResponse,
  ThreadResponse,
} from '@draftroom/contracts'
import type { ApiClient } from '../../api/client.ts'
import type { Mentionable } from './mentions.ts'

export interface CommentsApi {
  listThreads(boardId: string, signal?: AbortSignal): Promise<ListThreadsResponse>
  createThread(
    boardId: string,
    anchor: CommentAnchor,
    body: string,
    visibility?: CommentThreadVisibility,
  ): Promise<CommentThread>
  /** F10: a team member makes a thread team-only or visible to everyone. */
  setVisibility(threadId: string, visibility: CommentThreadVisibility): Promise<CommentThread>
  reply(threadId: string, body: string): Promise<CommentThread>
  edit(commentId: string, body: string): Promise<CommentThread>
  remove(commentId: string): Promise<void>
  setStatus(threadId: string, action: 'resolve' | 'reopen'): Promise<CommentThread>
  markRead(threadId: string): Promise<{ threadId: string; readAt: string }>
  notifications(signal?: AbortSignal): Promise<ListNotificationsResponse>
  markNotificationsRead(sel: { ids: string[] } | { all: true }): Promise<void>
  mentionables(boardId: string): Promise<Mentionable[]>
}

const enc = encodeURIComponent

export function createCommentsApi(client: ApiClient): CommentsApi {
  const { request } = client
  return {
    listThreads: (boardId, signal) =>
      request('GET', `/api/boards/${enc(boardId)}/threads?status=all`, {
        schema: ListThreadsResponse,
        signal,
      }),
    createThread: async (boardId, anchor, body, visibility) =>
      (
        await request('POST', `/api/boards/${enc(boardId)}/threads`, {
          body: visibility === 'team' ? { anchor, body, visibility } : { anchor, body },
          schema: ThreadResponse,
        })
      ).thread,
    reply: async (threadId, body) =>
      (
        await request('POST', `/api/threads/${enc(threadId)}/comments`, {
          body: { body },
          schema: ThreadResponse,
        })
      ).thread,
    edit: async (commentId, body) =>
      (await request('PATCH', `/api/comments/${enc(commentId)}`, { body: { body }, schema: ThreadResponse }))
        .thread,
    remove: (commentId) => request('DELETE', `/api/comments/${enc(commentId)}`, { schema: null }),
    setVisibility: async (threadId, visibility) =>
      (
        await request('POST', `/api/threads/${enc(threadId)}/visibility`, {
          body: { visibility },
          schema: ThreadResponse,
        })
      ).thread,
    setStatus: async (threadId, action) =>
      (await request('POST', `/api/threads/${enc(threadId)}/${action}`, { schema: ThreadResponse })).thread,
    markRead: (threadId) =>
      request('POST', `/api/threads/${enc(threadId)}/read`, { schema: ThreadReadResponse }),
    notifications: (signal) =>
      request('GET', '/api/me/notifications', { schema: ListNotificationsResponse, signal }),
    markNotificationsRead: (sel) =>
      request('POST', '/api/me/notifications/read', { body: sel, schema: null }),
    mentionables: async (boardId) =>
      (await client.listMembers(boardId)).map((m) => ({
        userId: m.user.id,
        name: m.user.name,
        handle: m.user.handle,
      })),
  }
}
