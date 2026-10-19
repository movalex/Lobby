// OWNER: WS3 (wave V). The join code calls (@draftroom/contracts join-codes.ts), through the app's ApiClient (same
// origin, JSON, contracts-validated). No request leaves Lobby's origin.
import {
  type CreateReviewLinkInput,
  JoinCodeResponse,
  joinCodeCreatePath,
  joinCodeResolvePath,
  ListInvitationsResponse,
  ResolvedJoinCode,
  ReviewLinkCreated,
} from '@draftroom/contracts'
import type { ApiClient } from '../../api/client.ts'

const enc = encodeURIComponent

export function joinApi(api: Pick<ApiClient, 'request'>) {
  const r = api.request
  return {
    /** A workshop link's code, made on first ask (creators who manage access; 404 for other links). */
    code: async (boardId: string, linkId: string) =>
      (await r('POST', joinCodeCreatePath(boardId, linkId), { schema: JoinCodeResponse })).joinCode,
    /** A code to its link's token (no session needed); one 404 for anything that does not work. */
    resolve: async (code: string, signal?: AbortSignal) =>
      (await r('GET', joinCodeResolvePath(code), { schema: ResolvedJoinCode, signal })).token,
    /** The board's pending links (managers), for the Facilitate menu's card. */
    invitations: async (boardId: string, signal?: AbortSignal) =>
      (await r('GET', `/api/boards/${enc(boardId)}/invitations`, { schema: ListInvitationsResponse, signal }))
        .invitations,
    /** A new workshop link (creators), for the card when the board has none open. */
    createWorkshopLink: (boardId: string, input: CreateReviewLinkInput) =>
      r('POST', `/api/boards/${enc(boardId)}/review-links`, { body: input, schema: ReviewLinkCreated }),
  }
}
