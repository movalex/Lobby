// OWNER: the wave S foundation (the lead): the switches of wave S, client review (docs/WAVE-S-CONTRACTS.md §7). With
// every switch off a user would see exactly the build before wave S: no review panel, badge, menu entry, chip, viewer or
// review page, and "My notifications" offers no review kind. Each workstream turns its own switch on in the change
// that makes its feature live (the api still guards every route, and pending routes answer 404).
//
// A dev-auth build (local dev and the e2e build; never a production bundle: DEV_AUTH_ENABLED) may turn a switch on for
// its page: localStorage REVIEW_FLAG_KEYS[name] = '1' (or '0' to force it off), read when asked (try/catch: a blocked
// store keeps the shipped value). The s1-* to s4-* specs set them with an init script.
import { DEV_AUTH_ENABLED } from '../../lib/identity.ts'

export interface ReviewFlags {
  /** WS1: review status (badges, popover, the review panel, "Mark for review", the bell and chat kind) */
  readonly status: boolean
  /** WS2: versions (the card's version chip and list, "Upload new version" sends X-Lobby-Supersedes, compare) */
  readonly versions: boolean
  /** WS3: media comments (the viewer's video, image and PDF bodies, time and page comments, exports) */
  readonly mediaComments: boolean
  /** WS4: the review page (?view=review), "Open in review view" on links, the summary PDF */
  readonly reviewPage: boolean
}

// The wave S integration turned every switch on (all four workstreams landed). A dev-auth page may still turn one off.
export const REVIEW_FLAGS: ReviewFlags = {
  status: true,
  versions: true,
  mediaComments: true,
  reviewPage: true,
}

export const REVIEW_FLAG_KEYS: Readonly<Record<keyof ReviewFlags, string>> = {
  status: 'lobby.reviewStatus',
  versions: 'lobby.reviewVersions',
  mediaComments: 'lobby.reviewMedia',
  reviewPage: 'lobby.reviewPage',
}

/** The switches of this page: the shipped ones, or a dev-auth page's overrides (each read in try/catch). */
export function reviewFlags(
  devAuth: boolean = DEV_AUTH_ENABLED,
  read: (key: string) => string | null | undefined = (key) => globalThis.localStorage?.getItem(key),
): ReviewFlags {
  if (!devAuth) return REVIEW_FLAGS
  const one = (name: keyof ReviewFlags): boolean => {
    try {
      const v = read(REVIEW_FLAG_KEYS[name])
      return v === '1' ? true : v === '0' ? false : REVIEW_FLAGS[name]
    } catch {
      return REVIEW_FLAGS[name]
    }
  }
  return {
    status: one('status'),
    versions: one('versions'),
    mediaComments: one('mediaComments'),
    reviewPage: one('reviewPage'),
  }
}

/** Whether the viewer (features/review-viewer) may open at all: the switches whose features open it. */
export const reviewViewerEnabled = (f: ReviewFlags = reviewFlags()) => f.versions || f.mediaComments
