// Wave M (W2, M2-5, S6): the end-of-moment feedback prompt's rules (pure, Node-tested). "How did this go in Lobby? [Good]
// [Something got in the way]", one line, after a facilitated moment: the presenter's presentation stop, a vote reveal or
// "Results to board" by the vote's starter, the run of show's last section ending. The feedback box has had no
// messages in 50 hours of use; asking at a natural end, and at most once a week, is the least naggy way to ask.
//
// What this module decides, and nothing else (the prompt itself is ./FeedbackPrompt.tsx; the words it sends are the
// contracts' feedback.ts FEEDBACK_PROMPT_* texts; no route or api change):
//  - who a moment belongs to (`ownsMoment`): only the person who ran it is asked, never someone who watched;
//  - whether this person may be asked now (`decideFeedbackPrompt`): never a name-only guest, never while this tab holds a
//    text lease or has a text editor open (it would take the keyboard from words in progress), not for a moment that is
//    older than a few minutes, and at most once per person per 7 days;
//  - the throttle (`promptDue`, `notePromptShown`): the day it was last shown, kept per person in localStorage (every
//    read and write in try/catch); where storage is unavailable, at most once per tab session.

import type { FeedbackContext, FeedbackPromptMoment } from '@draftroom/contracts'
import { buildContext, type ContextSources } from './model.ts'

/** At most once per person per this long. */
export const PROMPT_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000
/** A moment older than this when the prompt could be shown is stale (the person has moved on): it is dropped. */
export const PROMPT_MOMENT_TTL_MS = 10 * 60 * 1000
/** An unanswered prompt goes by itself after this long. */
export const PROMPT_VISIBLE_MS = 45_000

export type PromptStorage = Pick<Storage, 'getItem' | 'setItem'>

export const promptKey = (userId: string) => `lobby-feedback-prompt:${userId}`

const browserStorage = (): PromptStorage | null => {
  try {
    return globalThis.localStorage ?? null
  } catch {
    return null
  }
}

/** The people this tab has already asked (storage that refuses still holds: once per tab session). */
const askedInThisTab = new Set<string>()

/** Forgets what this tab remembered (tests). */
export const resetPromptForTests = () => askedInThisTab.clear()

/** When `userId` was last asked, from storage (ms since the epoch), or null: never, or storage cannot say. */
export function lastPromptAt(
  userId: string,
  storage: PromptStorage | null = browserStorage(),
): number | null {
  try {
    const raw = storage?.getItem(promptKey(userId))
    const n = raw ? Number(raw) : Number.NaN
    return Number.isFinite(n) && n > 0 ? n : null
  } catch {
    return null
  }
}

/**
 * Whether `userId` may be asked at `now`: not already asked in this tab, and the last time (storage) is at least 7 days
 * back. A last time in the future (a clock set back) counts as not yet: the week runs from it.
 */
export function promptDue(
  userId: string,
  now: number,
  storage: PromptStorage | null = browserStorage(),
): boolean {
  if (askedInThisTab.has(userId)) return false
  const last = lastPromptAt(userId, storage)
  return last === null || now - last >= PROMPT_INTERVAL_MS
}

/** Records that `userId` was asked at `now` (in this tab, and in storage when it takes it). */
export function notePromptShown(
  userId: string,
  now: number,
  storage: PromptStorage | null = browserStorage(),
): void {
  askedInThisTab.add(userId)
  try {
    storage?.setItem(promptKey(userId), String(now))
  } catch {
    // blocked or full: this tab remembers, and no later tab is stopped by it
  }
}

// ---- who a moment belongs to ----------------------------------------------------------------------------------------

export interface MomentFacts {
  /** this person's user id */
  readonly me: string
  /** who started the vote the moment is about (a user id), or null: unknown or none */
  readonly voteStarter: string | null
  /** who presents to everyone (a user id), or null */
  readonly presenter: string | null
}

/**
 * Whether this person ran the moment: the vote's starter for a reveal and for "Results to board", the presenter for a
 * presentation's stop and the run of show. Everyone else, a plain editor and an owner who only watched included, is
 * never asked: the prompt is for the person whose meeting it was.
 */
export function ownsMoment(moment: FeedbackPromptMoment, f: MomentFacts): boolean {
  switch (moment) {
    case 'vote-reveal':
    case 'results-to-board':
      return f.voteStarter !== null && f.voteStarter === f.me
    case 'presentation-stop':
    case 'run-of-show-end':
      return f.presenter !== null && f.presenter === f.me
  }
}

// ---- while someone is typing ----------------------------------------------------------------------------------------

/** One text lease as the engine reports it (sid of its holder). */
export interface LeaseHolderLike {
  readonly sid: string
}

/**
 * Whether this tab holds a text lease or has a text editor open: words are in progress and the prompt must not come
 * (a prompt that took the focus, or moved the board, in the middle of a note). `editingId` is the open editor's
 * element, `holders` every lease on the board and `mySid` this tab's session.
 */
export function holdsTextLease(input: {
  readonly editingId: string | null
  readonly holders: ReadonlyMap<string, LeaseHolderLike> | null
  readonly mySid: string | null
}): boolean {
  if (input.editingId !== null) return true
  if (!input.holders || !input.mySid) return false
  for (const h of input.holders.values()) if (h.sid === input.mySid) return true
  return false
}

// ---- the decision ------------------------------------------------------------------------------------------------------

export type PromptDecision =
  /** put it in front of the person now */
  | 'show'
  /** not now (words are in progress): the moment is kept, and asked again when that changes */
  | 'wait'
  /** never for this moment: a guest, asked this week, stale */
  | 'drop'

export interface PromptSituation {
  /** a name-only guest; null: this tab does not know the person's kind yet (N1: the moment waits for it) */
  readonly guest: boolean | null
  /** this tab holds a text lease or has a text editor open (`holdsTextLease`) */
  readonly typing: boolean
  /** the throttle allows it (`promptDue`) */
  readonly due: boolean
  /** when the moment was noted, and now (ms) */
  readonly noted: number
  readonly now: number
}

/**
 * Whether to ask now, later or not at all. The order is the order of the reasons: who, how long ago, how often, how busy.
 * A kind that is not known yet (`guest: null`, /api/me has not answered) is a reason to wait, not to drop: it is dropped
 * only when the moment is stale or the week's ask is used, as for anyone.
 */
export function decideFeedbackPrompt(s: PromptSituation): PromptDecision {
  if (s.guest === true) return 'drop'
  if (s.now - s.noted > PROMPT_MOMENT_TTL_MS) return 'drop'
  if (!s.due) return 'drop'
  if (s.guest === null || s.typing) return 'wait'
  return 'show'
}

/**
 * The context block a one-click "Good" sends. The dialog lists its block before anything is sent; the prompt shows
 * nothing of it, so it carries the board's id (not private) and never its title (a private word of the board).
 */
export function promptGoodContext(s: Omit<ContextSources, 'board'> & { boardId: string }): FeedbackContext {
  const { boardId, ...rest } = s
  return buildContext({ ...rest, board: { id: boardId, title: null } })
}
