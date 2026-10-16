// OWNER: WS1 (wave S, review status; WS4's review page and summary use it as it is). The web side of the review
// routes (@draftroom/contracts review.ts; docs/WAVE-S-CONTRACTS.md §2).
//
// Frozen signatures (same origin, the session cookie, LOBBY_CLIENT_HEADER; every answer parsed with its contract
// schema). The reads never throw: a 404 from an api without the routes, a refusal, an unreadable body or a network
// error answers empty (and a 404 for the board the page has open turns `reviewAvailable()` false for the tab):
//   reviewAvailable(): boolean                                           whether the board offers any review UI
//   getReview(boardId): Promise<GetReviewResponse>                       empty: EMPTY_REVIEW
//   listReviewEvents(boardId, itemId, before?): Promise<ListReviewEventsResponse>
// The writes reject with ReviewRequestError (`code`: 'unavailable', or the api's: ALREADY_IN_REVIEW, STATUS_CHANGED
// with `item`, NEWER_VERSION with `latestVersionId`, VERSION_REQUIRED, ROUND_OPEN, REVIEW_FULL, …; `message` the api's
// own user-safe words when it gave them):
//   addReviewItem(boardId, input) / patchReviewItem(boardId, itemId, input) / removeReviewItem(boardId, itemId)
//   setReviewStatus(boardId, itemId, input): Promise<SetReviewStatusResponse>
//   startReviewRound(boardId, input) / closeReviewRound(boardId, roundId): Promise<ReviewRoundResponse>
//
// Nothing is stored here but whether the routes answered; nothing is logged.
import {
  type AddReviewItemInput,
  GetReviewResponse,
  ListReviewEventsResponse,
  LOBBY_CLIENT_HEADER,
  LOBBY_CLIENT_REV,
  type PatchReviewItemInput,
  ReviewItem,
  ReviewItemResponse,
  ReviewRoundResponse,
  reviewEventsPath,
  reviewItemPath,
  reviewItemsPath,
  reviewPath,
  reviewRoundClosePath,
  reviewRoundsPath,
  reviewStatusPath,
  type SetReviewStatusInput,
  SetReviewStatusResponse,
  type StartReviewRoundInput,
} from '@draftroom/contracts'
import type { z } from 'zod'

/** A review request that did not happen: 'unavailable' (no api routes, offline) or the api's error code. */
export class ReviewRequestError extends Error {
  readonly code: string
  readonly status: number | null
  /** STATUS_CHANGED: the item as it is now ("Ana (guest) just requested changes") */
  readonly item: ReviewItem | null
  /** NEWER_VERSION: the version a status must be about */
  readonly latestVersionId: string | null
  /** the api's own user-safe message, when it gave one */
  readonly detail: string | null
  constructor(
    code: string,
    status: number | null = null,
    extra: { item?: ReviewItem; latestVersionId?: string; detail?: string } = {},
  ) {
    super(`review request failed: ${code}`)
    this.name = 'ReviewRequestError'
    this.code = code
    this.status = status
    this.item = extra.item ?? null
    this.latestVersionId = extra.latestVersionId ?? null
    this.detail = extra.detail ?? null
  }
}

export const EMPTY_REVIEW: GetReviewResponse = {
  items: [],
  rounds: [],
  openRoundId: null,
  can: { setStatus: false, manage: false },
}

let off = false

/** Whether this tab offers review UI: true until the api answered that the review routes are not here. */
export function reviewAvailable(): boolean {
  return !off
}

/** Test seam: forget what this tab learned about the routes. */
export function resetReviewAvailability(): void {
  off = false
}

const HEADERS = { accept: 'application/json', [LOBBY_CLIENT_HEADER]: String(LOBBY_CLIENT_REV) }

async function send(method: string, path: string, body?: unknown): Promise<Response> {
  if (typeof fetch !== 'function') throw new ReviewRequestError('unavailable')
  try {
    return await fetch(path, {
      method,
      credentials: 'same-origin',
      cache: 'no-store',
      headers: body === undefined ? HEADERS : { ...HEADERS, 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
  } catch {
    throw new ReviewRequestError('unavailable')
  }
}

async function json(res: Response): Promise<unknown> {
  try {
    return await res.json()
  } catch {
    return null
  }
}

/** A write's answer, parsed; a refusal becomes ReviewRequestError with the api's code and extras. */
async function write<S extends z.ZodType>(
  method: string,
  path: string,
  body: unknown,
  schema: S | null,
): Promise<z.output<S>> {
  const res = await send(method, path, body)
  if (!res.ok) {
    const raw = (await json(res)) as {
      error?: { code?: unknown; message?: unknown }
      item?: unknown
      latestVersionId?: unknown
    } | null
    const code = typeof raw?.error?.code === 'string' ? raw.error.code : `HTTP_${res.status}`
    const message = typeof raw?.error?.message === 'string' ? raw.error.message.slice(0, 300) : undefined
    const item = ReviewItem.safeParse(raw?.item)
    throw new ReviewRequestError(code, res.status, {
      ...(item.success ? { item: item.data } : {}),
      ...(typeof raw?.latestVersionId === 'string' ? { latestVersionId: raw.latestVersionId } : {}),
      ...(message ? { detail: message } : {}),
    })
  }
  if (schema === null) return undefined as z.output<S>
  const parsed = schema.safeParse(await json(res))
  if (!parsed.success) throw new ReviewRequestError('BAD_RESPONSE', res.status)
  return parsed.data
}

export async function getReview(boardId: string): Promise<GetReviewResponse> {
  try {
    const res = await send('GET', reviewPath(boardId))
    if (res.status === 404) {
      // the board page has the board open, so a 404 here means an api without the review routes
      off = true
      return EMPTY_REVIEW
    }
    if (!res.ok) return EMPTY_REVIEW
    const parsed = GetReviewResponse.safeParse(await json(res))
    if (!parsed.success) return EMPTY_REVIEW
    off = false
    return parsed.data
  } catch {
    return EMPTY_REVIEW
  }
}

export async function listReviewEvents(
  boardId: string,
  itemId: string,
  before?: number,
): Promise<ListReviewEventsResponse> {
  const empty: ListReviewEventsResponse = { events: [], nextBefore: null }
  try {
    const res = await send('GET', reviewEventsPath(boardId, itemId, before))
    if (!res.ok) return empty
    const parsed = ListReviewEventsResponse.safeParse(await json(res))
    return parsed.success ? parsed.data : empty
  } catch {
    return empty
  }
}

export function addReviewItem(boardId: string, input: AddReviewItemInput) {
  return write('POST', reviewItemsPath(boardId), input, ReviewItemResponse)
}

export function patchReviewItem(boardId: string, itemId: string, input: PatchReviewItemInput) {
  return write('PATCH', reviewItemPath(boardId, itemId), input, ReviewItemResponse)
}

export async function removeReviewItem(boardId: string, itemId: string): Promise<void> {
  await write('DELETE', reviewItemPath(boardId, itemId), undefined, null)
}

export function setReviewStatus(
  boardId: string,
  itemId: string,
  input: SetReviewStatusInput,
): Promise<SetReviewStatusResponse> {
  return write('POST', reviewStatusPath(boardId, itemId), input, SetReviewStatusResponse)
}

export function startReviewRound(
  boardId: string,
  input: StartReviewRoundInput,
): Promise<ReviewRoundResponse> {
  return write('POST', reviewRoundsPath(boardId), input, ReviewRoundResponse)
}

export function closeReviewRound(boardId: string, roundId: string): Promise<ReviewRoundResponse> {
  return write('POST', reviewRoundClosePath(boardId, roundId), {}, ReviewRoundResponse)
}
