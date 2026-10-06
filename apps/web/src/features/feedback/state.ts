// The one place that says "the feedback dialog is open" (wave J5). The dialog itself is rendered once, by
// FeedbackHost at the root of the app, so it does not depend on the menu that opened it (the board's menu
// and the account menu both close when they run an entry) or on the page behind it. The entry points call
// openFeedback; nothing else writes this.

import { atom } from '../../lib/signals.ts'
import type { FeedbackBoard } from './model.ts'

export interface FeedbackRequest {
  /** Bumped on every open, so a second open remounts the dialog with an empty form. */
  readonly seq: number
  readonly board: FeedbackBoard | null
  /**
   * Called once the dialog has closed: gives the keyboard back to where it was (the board's menu closes
   * before the dialog opens, so the dialog has no opener of its own to return to).
   */
  readonly restoreFocus: (() => void) | null
}

export const feedbackRequest = atom<FeedbackRequest | null>('lobby-feedback-request', null)
let seq = 0

/** Opens the dialog; `board` is the board the person is on, when they are on one. */
export function openFeedback(
  board: FeedbackBoard | null = null,
  restoreFocus: (() => void) | null = null,
): void {
  seq += 1
  feedbackRequest.set({ seq, board, restoreFocus })
}

export function closeFeedback(): void {
  feedbackRequest.set(null)
}
