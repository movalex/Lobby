// Raise hand (FAC-08): what to tell whom when the queue changes, and how long someone has waited.
// Pure (unit-tested in Node); Hands.tsx renders it.

import { HAND_AUTO_LOWER_MS, type HandChange } from '@draftroom/contracts'

/** "just now", "2 min", "1 h 5 min" since `iso` (server time, via the store's clock offset). */
export function waitedFor(iso: string, nowMs: number, offsetMs: number): string {
  const ms = Math.max(0, nowMs + offsetMs - Date.parse(iso))
  const min = Math.floor(ms / 60_000)
  if (min < 1) return 'just now'
  if (min < 60) return `${min} min`
  return `${Math.floor(min / 60)} h ${min % 60} min`
}

export interface HandNotice {
  key: string
  text: string
  testId: string
  /** Offer to open the queue (facilitators, when a hand goes up). */
  openQueue: boolean
}

/**
 * The notice for one change, for this person, or null (nothing to say): facilitators hear that a
 * hand went up; a person hears that their hand was lowered by someone else or timed out. Nobody is
 * told about their own actions or a disconnect (they are not there to hear it).
 */
export function handNotice(
  change: HandChange,
  opts: { selfUserId: string; facilitator: boolean; raisedCount: number },
): HandNotice | null {
  const self = change.userId === opts.selfUserId
  if (change.raised) {
    if (self || !opts.facilitator) return null
    return {
      key: 'hand-raised',
      text: `${change.name} raised a hand${opts.raisedCount > 1 ? ` (${opts.raisedCount} hands up)` : ''}.`,
      testId: 'hand-toast',
      openQueue: true,
    }
  }
  if (!self) return null
  if (change.reason === 'lowered_by_facilitator')
    return {
      key: 'hand-lowered',
      text: `${change.byName ?? 'A facilitator'} lowered your hand.`,
      testId: 'hand-lowered-toast',
      openQueue: false,
    }
  if (change.reason === 'cleared' && change.byUserId !== opts.selfUserId)
    return {
      key: 'hand-lowered',
      text: `${change.byName ?? 'A facilitator'} lowered all hands, yours too.`,
      testId: 'hand-lowered-toast',
      openQueue: false,
    }
  if (change.reason === 'expired')
    return {
      key: 'hand-lowered',
      text: `Your hand went down after ${HAND_AUTO_LOWER_MS / 60_000} minutes. Raise it again if you still need to.`,
      testId: 'hand-lowered-toast',
      openQueue: false,
    }
  return null
}
