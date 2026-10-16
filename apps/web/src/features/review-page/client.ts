// OWNER: WS4 (wave S, the client review page). The review page's reads and its one write are WS1's review client
// (features/review/client.ts; docs/WAVE-S-CONTRACTS.md §2.3), re-exported here so the page, the summary PDF and their
// tests keep one import path. Same signatures: the reads never throw (any failure answers empty); the write rejects
// with ReviewRequestError (`code`: 'unavailable', or the api's: STATUS_CHANGED with `item`, NEWER_VERSION with
// `latestVersionId`, VERSION_REQUIRED, REVIEW_RATE_LIMITED, …; `detail`: the api's own user-safe words).
export {
  EMPTY_REVIEW,
  getReview,
  listReviewEvents,
  ReviewRequestError,
  setReviewStatus,
} from '../review/client.ts'
