// OWNER: WS1 (wave S, review status; landed as a stub by the wave S foundation: WS1 makes it live against its routes,
// WS4's review page and summary use it as it is). The web side of the review routes (@draftroom/contracts review.ts;
// docs/WAVE-S-CONTRACTS.md §2).
//
// Frozen signatures (same origin, the session cookie, LOBBY_CLIENT_HEADER through the api client; every answer parsed
// with its contract schema). The reads never throw: a 404 from an api without the routes, a refusal, an unreadable
// body or a network error answers empty (`reviewAvailable()` then says false for the tab):
//   reviewAvailable(): boolean                                           whether the board offers any review UI
//   getReview(boardId): Promise<GetReviewResponse>                       empty: EMPTY_REVIEW
//   listReviewEvents(boardId, itemId, before?): Promise<ListReviewEventsResponse>
// The writes reject with ReviewRequestError (`code`: 'unavailable', or the api's: ALREADY_IN_REVIEW, STATUS_CHANGED
// with `item`, NEWER_VERSION with `latestVersionId`, VERSION_REQUIRED, ROUND_OPEN, REVIEW_FULL, …):
//   addReviewItem(boardId, input) / patchReviewItem(boardId, itemId, input) / removeReviewItem(boardId, itemId)
//   setReviewStatus(boardId, itemId, input): Promise<SetReviewStatusResponse>
//   startReviewRound(boardId, input) / closeReviewRound(boardId, roundId): Promise<ReviewRoundResponse>
//
// Until WS1 ships, every read answers empty and every write rejects 'unavailable', without a request.
import type {
  AddReviewItemInput,
  GetReviewResponse,
  ListReviewEventsResponse,
  PatchReviewItemInput,
  ReviewItem,
  ReviewItemResponse,
  ReviewRoundResponse,
  SetReviewStatusInput,
  SetReviewStatusResponse,
  StartReviewRoundInput,
} from '@draftroom/contracts'

/** A review request that did not happen: 'unavailable' (no api routes, offline) or the api's error code. */
export class ReviewRequestError extends Error {
  readonly code: string
  readonly status: number | null
  /** STATUS_CHANGED: the item as it is now ("Ana (guest) just requested changes") */
  readonly item: ReviewItem | null
  /** NEWER_VERSION: the version a status must be about */
  readonly latestVersionId: string | null
  constructor(
    code: string,
    status: number | null = null,
    extra: { item?: ReviewItem; latestVersionId?: string } = {},
  ) {
    super(`review request failed: ${code}`)
    this.name = 'ReviewRequestError'
    this.code = code
    this.status = status
    this.item = extra.item ?? null
    this.latestVersionId = extra.latestVersionId ?? null
  }
}

export const EMPTY_REVIEW: GetReviewResponse = {
  items: [],
  rounds: [],
  openRoundId: null,
  can: { setStatus: false, manage: false },
}

const unavailable = <T>(): Promise<T> => Promise.reject(new ReviewRequestError('unavailable'))

/** Whether this tab offers review UI: false until WS1 makes the client live (and while the routes are absent). */
export function reviewAvailable(): boolean {
  return false
}

export async function getReview(_boardId: string): Promise<GetReviewResponse> {
  return EMPTY_REVIEW
}

export async function listReviewEvents(
  _boardId: string,
  _itemId: string,
  _before?: number,
): Promise<ListReviewEventsResponse> {
  return { events: [], nextBefore: null }
}

export function addReviewItem(_boardId: string, _input: AddReviewItemInput): Promise<ReviewItemResponse> {
  return unavailable()
}

export function patchReviewItem(
  _boardId: string,
  _itemId: string,
  _input: PatchReviewItemInput,
): Promise<ReviewItemResponse> {
  return unavailable()
}

export function removeReviewItem(_boardId: string, _itemId: string): Promise<void> {
  return unavailable()
}

export function setReviewStatus(
  _boardId: string,
  _itemId: string,
  _input: SetReviewStatusInput,
): Promise<SetReviewStatusResponse> {
  return unavailable()
}

export function startReviewRound(
  _boardId: string,
  _input: StartReviewRoundInput,
): Promise<ReviewRoundResponse> {
  return unavailable()
}

export function closeReviewRound(_boardId: string, _roundId: string): Promise<ReviewRoundResponse> {
  return unavailable()
}
