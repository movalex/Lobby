// OWNER: WS4 (wave S, the client review page). The review page's reads and its one write, against WS1's routes
// (@draftroom/contracts review.ts; docs/WAVE-S-CONTRACTS.md §2.3): same-origin, the session cookie,
// LOBBY_CLIENT_HEADER, every answer parsed with its contract schema.
//
// The signatures and the error type are WS1's frozen ones (features/review/client.ts), so the lead's integration is
// one line: this file re-exports WS1's `getReview`, `listReviewEvents`, `setReviewStatus` and `ReviewRequestError`
// once WS1's client is live. It exists apart because WS1's client is a stub until then (it answers empty and never
// makes a request), and the page, its e2e route doubles and the summary PDF need real calls.
//
// The reads never throw: a 404 from an api without the routes, a refusal, an unreadable body or a network error
// answers empty. The write rejects with ReviewRequestError (`code`: 'unavailable', or the api's: STATUS_CHANGED with
// `item`, NEWER_VERSION with `latestVersionId`, VERSION_REQUIRED, REVIEW_RATE_LIMITED, …).
import {
  GetReviewResponse,
  ListReviewEventsResponse,
  LOBBY_CLIENT_HEADER,
  LOBBY_CLIENT_REV,
  type ReviewItem,
  ReviewNewerVersionBody,
  ReviewStatusChangedBody,
  reviewEventsPath,
  reviewPath,
  reviewStatusPath,
  type SetReviewStatusInput,
  SetReviewStatusResponse,
} from '@draftroom/contracts'

/** A review request that did not happen: 'unavailable' (no api routes, offline) or the api's error code. */
export class ReviewRequestError extends Error {
  readonly code: string
  readonly status: number | null
  /** STATUS_CHANGED: the item as it is now ("Ana (guest) just requested changes") */
  readonly item: ReviewItem | null
  /** NEWER_VERSION: the version a status must be about */
  readonly latestVersionId: string | null
  /** the api's own words, when it sent some */
  readonly apiMessage: string | null
  constructor(
    code: string,
    status: number | null = null,
    extra: { item?: ReviewItem; latestVersionId?: string; message?: string } = {},
  ) {
    super(`review request failed: ${code}`)
    this.name = 'ReviewRequestError'
    this.code = code
    this.status = status
    this.item = extra.item ?? null
    this.latestVersionId = extra.latestVersionId ?? null
    this.apiMessage = extra.message ?? null
  }
}

export const EMPTY_REVIEW: GetReviewResponse = {
  items: [],
  rounds: [],
  openRoundId: null,
  can: { setStatus: false, manage: false },
}

const headers = (body: boolean): Record<string, string> => ({
  accept: 'application/json',
  [LOBBY_CLIENT_HEADER]: String(LOBBY_CLIENT_REV),
  ...(body ? { 'content-type': 'application/json' } : {}),
})

type FetchLike = typeof fetch
let fetchImpl: FetchLike = (...args) => fetch(...args)
/** Test seam: the fetch the page's calls use. */
export function setReviewFetch(f: FetchLike | null): void {
  fetchImpl = f ?? ((...args) => fetch(...args))
}

async function send(method: 'GET' | 'POST', path: string, body?: unknown): Promise<Response> {
  return fetchImpl(path, {
    method,
    headers: headers(body !== undefined),
    body: body === undefined ? undefined : JSON.stringify(body),
    credentials: 'same-origin',
    cache: 'no-store',
  })
}

/** Whether the api has the review routes for this tab: set by the first answer of getReview. */
let available = false
export const reviewPageAvailable = () => available

/** GET /api/boards/:bid/review. Empty (EMPTY_REVIEW) on any failure. */
export async function getReview(boardId: string): Promise<GetReviewResponse> {
  try {
    const res = await send('GET', reviewPath(boardId))
    if (!res.ok) return EMPTY_REVIEW
    const parsed = GetReviewResponse.safeParse(await res.json().catch(() => undefined))
    if (!parsed.success) return EMPTY_REVIEW
    available = true
    return parsed.data
  } catch {
    return EMPTY_REVIEW
  }
}

/** GET …/items/:rvi/events?before=. Empty on any failure. */
export async function listReviewEvents(
  boardId: string,
  itemId: string,
  before?: number,
): Promise<ListReviewEventsResponse> {
  try {
    const res = await send('GET', reviewEventsPath(boardId, itemId, before))
    if (!res.ok) return { events: [], nextBefore: null }
    const parsed = ListReviewEventsResponse.safeParse(await res.json().catch(() => undefined))
    return parsed.success ? parsed.data : { events: [], nextBefore: null }
  } catch {
    return { events: [], nextBefore: null }
  }
}

/** POST …/items/:rvi/status. Rejects with ReviewRequestError. */
export async function setReviewStatus(
  boardId: string,
  itemId: string,
  input: SetReviewStatusInput,
): Promise<SetReviewStatusResponse> {
  let res: Response
  try {
    res = await send('POST', reviewStatusPath(boardId, itemId), input)
  } catch {
    throw new ReviewRequestError('unavailable')
  }
  const raw: unknown = await res.json().catch(() => undefined)
  if (res.ok) {
    const parsed = SetReviewStatusResponse.safeParse(raw)
    if (!parsed.success) throw new ReviewRequestError('unavailable', res.status)
    return parsed.data
  }
  const err = (raw as { error?: { code?: unknown; message?: unknown } } | undefined)?.error
  const code = typeof err?.code === 'string' ? err.code : `HTTP_${res.status}`
  const message = typeof err?.message === 'string' && err.message.length <= 300 ? err.message : undefined
  const changed = ReviewStatusChangedBody.safeParse(raw)
  if (changed.success)
    throw new ReviewRequestError(code, res.status, {
      item: changed.data.item,
      ...(message ? { message } : {}),
    })
  const newer = ReviewNewerVersionBody.safeParse(raw)
  if (newer.success)
    throw new ReviewRequestError(code, res.status, {
      latestVersionId: newer.data.latestVersionId,
      ...(message ? { message } : {}),
    })
  throw new ReviewRequestError(
    res.status === 404 ? 'unavailable' : code,
    res.status,
    message ? { message } : {},
  )
}
