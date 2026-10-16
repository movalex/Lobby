// OWNER: WS4 (wave S, the client review page). Where a review link lands: the Share dialog's "Open as review page"
// default, and the path the invite page opens after accepting or joining (docs/WAVE-S-CONTRACTS.md §6).
import { type ReviewLanding, reviewLandingPath } from '@draftroom/contracts'
import { reviewFlags } from '../review/flags.ts'
import { getReview } from './client.ts'

/** The Share dialog's default for "Open as review page": on when the board already has review items. */
export async function openAsReviewPageDefault(boardId: string): Promise<boolean> {
  try {
    return (await getReview(boardId)).items.length > 0
  } catch {
    return false
  }
}

/**
 * The path an accepted or joined link opens: the review page for a link that lands there while the review page switch
 * is on, else the board (a link from an older api says nothing: the board).
 */
export function landingPathFor(boardId: string, landing: ReviewLanding | undefined): string {
  return reviewLandingPath(boardId, landing === 'review' && reviewFlags().reviewPage ? 'review' : 'board')
}
