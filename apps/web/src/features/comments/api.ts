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
import { openStateOrRoute } from '../../lib/open-state.ts'
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
  /**
   * The bell. `since` (wave M, M5-3): the `seq` of the last answer this client applied (0 when none); the api then
   * answers 204 when nothing was added or removed since, which resolves null (keep what you have). An api from
   * before wave M ignores `since` and always answers the list (without `seq`).
   */
  notifications(signal?: AbortSignal, since?: number): Promise<ListNotificationsResponse | null>
  markNotificationsRead(sel: { ids: string[] } | { all: true }): Promise<void>
  mentionables(boardId: string): Promise<Mentionable[]>
}

const enc = encodeURIComponent

export function createCommentsApi(client: ApiClient): CommentsApi {
  const { request } = client
  return {
    // M5-1: the first load (at the stream's first hello) takes the board-open read's part, waiting for it while it is
    // on its way; every later load (events, resyncs, the privacy refresh) asks the route
    listThreads: (boardId, signal) =>
      openStateOrRoute(
        boardId,
        'threads',
        () =>
          request('GET', `/api/boards/${enc(boardId)}/threads?status=all`, {
            schema: ListThreadsResponse,
            signal,
          }),
        signal,
      ),
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
    notifications: async (signal, since) => {
      const path =
        since === undefined
          ? '/api/me/notifications'
          : `/api/me/notifications?since=${Math.max(0, Math.floor(since))}`
      // a 204 has no body: the optional schema reads it as undefined (nothing new)
      const res = await request('GET', path, { schema: ListNotificationsResponse.optional(), signal })
      return res ?? null
    },
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
