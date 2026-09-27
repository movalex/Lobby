// Typed calls for the sharing feature (docs/FEATURES-M2-CONTRACTS.md, dashboard-share): access
// requests, review links, pending invitations, the sharing state and transfer of ownership. They go
// through the app's ApiClient.request (same-origin, JSON, contracts-validated).

import {
  AccessRequestDecided,
  AccessRequestSent,
  type CreateReviewLinkInput,
  ListAccessRequestsResponse,
  ListInvitationsResponse,
  ListMembersResponse,
  ListShareMembersResponse,
  MyAccessRequestResponse,
  type RequestableRole,
  ReviewLinkCreated,
  ReviewLinkRevoked,
  ShareState,
} from '@draftroom/contracts'
import type { ApiClient } from '../../api/client.ts'

const enc = encodeURIComponent

export function sharingApi(api: ApiClient) {
  const r = api.request
  return {
    shareState: (boardId: string, signal?: AbortSignal) =>
      r('GET', `/api/boards/${enc(boardId)}/sharing`, { schema: ShareState, signal }),
    shareMembers: async (boardId: string, signal?: AbortSignal) =>
      (
        await r('GET', `/api/boards/${enc(boardId)}/sharing/members`, {
          schema: ListShareMembersResponse,
          signal,
        })
      ).members,
    transferOwnership: async (boardId: string, userId: string) =>
      (
        await r('POST', `/api/boards/${enc(boardId)}/transfer-ownership`, {
          body: { userId },
          schema: ListMembersResponse,
        })
      ).members,

    requestAccess: (boardId: string, role: RequestableRole, message?: string) =>
      r('POST', `/api/boards/${enc(boardId)}/access-requests`, {
        body: message?.trim() ? { role, message: message.trim() } : { role },
        schema: AccessRequestSent,
      }),
    myAccessRequest: async (boardId: string, signal?: AbortSignal) =>
      (
        await r('GET', `/api/boards/${enc(boardId)}/access-requests/mine`, {
          schema: MyAccessRequestResponse,
          signal,
        })
      ).request,
    accessRequests: async (boardId: string, signal?: AbortSignal) =>
      (
        await r('GET', `/api/boards/${enc(boardId)}/access-requests`, {
          schema: ListAccessRequestsResponse,
          signal,
        })
      ).requests,
    approveAccessRequest: async (requestId: string, role?: RequestableRole) =>
      (
        await r('POST', `/api/access-requests/${enc(requestId)}/approve`, {
          body: role ? { role } : {},
          schema: AccessRequestDecided,
        })
      ).request,
    denyAccessRequest: async (requestId: string) =>
      (await r('POST', `/api/access-requests/${enc(requestId)}/deny`, { schema: AccessRequestDecided }))
        .request,

    invitations: async (boardId: string, signal?: AbortSignal) =>
      (await r('GET', `/api/boards/${enc(boardId)}/invitations`, { schema: ListInvitationsResponse, signal }))
        .invitations,
    createReviewLink: (boardId: string, input: CreateReviewLinkInput) =>
      r('POST', `/api/boards/${enc(boardId)}/review-links`, { body: input, schema: ReviewLinkCreated }),
    revokeReviewLink: (boardId: string, invitationId: string, removeAccess: boolean) =>
      r('POST', `/api/boards/${enc(boardId)}/review-links/${enc(invitationId)}/revoke`, {
        body: { removeAccess },
        schema: ReviewLinkRevoked,
      }),
  }
}

export type SharingApi = ReturnType<typeof sharingApi>

/** Window events that tie the board header badge and the Share dialog together. */
export const OPEN_SHARE_EVENT = 'draftroom:open-share'
export const SHARE_CHANGED_EVENT = 'draftroom:share-changed'

/** Asks the board page to open its Share dialog (BoardPage listens for this). */
export function openShareDialog() {
  window.dispatchEvent(new CustomEvent(OPEN_SHARE_EVENT))
}

/** Tells the badge (and anything else showing sharing state) to refetch. */
export function announceShareChanged(boardId: string) {
  window.dispatchEvent(new CustomEvent(SHARE_CHANGED_EVENT, { detail: { boardId } }))
}
