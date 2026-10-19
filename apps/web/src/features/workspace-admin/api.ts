// OWNER: WS5 (wave W, the workspace admin page). The page's requests: the seven admin reads (contracts
// workspace-admin.ts), and the EXISTING routes every change goes through (the page has no write route of its own):
//   a role:            PATCH  /api/workspaces/:wid/members/:uid   (the creator and last-owner rules stay there)
//   a removal:         DELETE /api/workspaces/:wid/members/:uid
//   an invitation:     DELETE /api/invitations/:id
//   a link:            POST   /api/boards/:bid/review-links/:id/revoke {removeAccess}, …/extend {hours}
//   a guest off a board: DELETE /api/boards/:bid/members/:uid
// Same origin, the session cookie; every answer parsed with its contract schema. A 404 from a read means the caller
// may not see the page (or it is off): the page then shows the unknown-address screen.
import {
  type AdminAuditQuery,
  AdminAuditResponse,
  type AdminInvitationsQuery,
  AdminInvitationsResponse,
  type AdminLinksQuery,
  AdminLinksResponse,
  AdminMembersResponse,
  AdminRetentionResponse,
  AdminStorageResponse,
  adminPath,
  ReviewLinkExtended,
  ReviewLinkRevoked,
} from '@draftroom/contracts'
import type { z } from 'zod'
import { type ApiClient, api as defaultApi } from '../../api/client.ts'

type Requester = Pick<ApiClient, 'request'>
export type WorkspaceRole = 'owner' | 'admin' | 'member' | 'guest'
const enc = encodeURIComponent

/** `?a=1&b=2` of the given values, or '' when none is. */
function search(params: Record<string, string | undefined>): string {
  const qs = new URLSearchParams()
  for (const [k, v] of Object.entries(params)) if (v !== undefined) qs.set(k, v)
  const s = qs.toString()
  return s ? `?${s}` : ''
}

export function adminApi(workspaceId: string, client: Requester = defaultApi) {
  const r = client.request
  const read = <S extends z.ZodType>(tail: string, schema: S, signal?: AbortSignal) =>
    r('GET', adminPath(workspaceId, tail), { schema, signal })
  return {
    members: (signal?: AbortSignal) => read('members', AdminMembersResponse, signal),
    /** the newest page, or the page after `before` (the answer's `next`) */
    invitations: (query: AdminInvitationsQuery = {}, signal?: AbortSignal) =>
      read(`invitations${search({ before: query.before })}`, AdminInvitationsResponse, signal),
    storage: (by: 'board' | 'uploader', signal?: AbortSignal) =>
      read(`storage/by-${by}`, AdminStorageResponse, signal),
    audit: (query: AdminAuditQuery, signal?: AbortSignal) => {
      const qs = new URLSearchParams()
      if (query.before !== undefined) qs.set('before', String(query.before))
      if (query.action) qs.set('action', query.action)
      if (query.actor) qs.set('actor', query.actor)
      if (query.limit !== undefined) qs.set('limit', String(query.limit))
      const s = qs.toString()
      return read(`audit${s ? `?${s}` : ''}`, AdminAuditResponse, signal)
    },
    /** both newest pages; with a cursor, only that list's next page (the other comes back empty) */
    links: (query: AdminLinksQuery = {}, signal?: AbortSignal) =>
      read(
        `links${search({ linksBefore: query.linksBefore, guestsBefore: query.guestsBefore })}`,
        AdminLinksResponse,
        signal,
      ),
    retention: (signal?: AbortSignal) => read('retention', AdminRetentionResponse, signal),

    // ---- the existing routes ----
    setRole: (userId: string, role: WorkspaceRole) =>
      r('PATCH', `/api/workspaces/${enc(workspaceId)}/members/${enc(userId)}`, {
        body: { role },
        schema: null,
      }),
    removeMember: (userId: string) =>
      r('DELETE', `/api/workspaces/${enc(workspaceId)}/members/${enc(userId)}`, { schema: null }),
    revokeInvitation: (invitationId: string) =>
      r('DELETE', `/api/invitations/${enc(invitationId)}`, { schema: null }),
    revokeLink: (boardId: string, linkId: string, removeAccess: boolean) =>
      r('POST', `/api/boards/${enc(boardId)}/review-links/${enc(linkId)}/revoke`, {
        body: { removeAccess },
        schema: ReviewLinkRevoked,
      }),
    extendLink: (boardId: string, linkId: string) =>
      r('POST', `/api/boards/${enc(boardId)}/review-links/${enc(linkId)}/extend`, {
        body: { hours: 1 },
        schema: ReviewLinkExtended,
      }),
    removeFromBoard: (boardId: string, userId: string) =>
      r('DELETE', `/api/boards/${enc(boardId)}/members/${enc(userId)}`, { schema: null }),
  }
}

export type AdminApi = ReturnType<typeof adminApi>
