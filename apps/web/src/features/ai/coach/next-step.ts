// OWNER: W2 (wave L, L2-4). The session coach's rules (pure): from the workshop's state (what the board event
// stream said: WORKSHOP_EVENTS and the private brainstorm's), the board's facts (./facts.ts) and the person's role,
// the one next step to offer, or none. The pilot's signal: a vote with three people present got no ballots, and
// a brainstorm got no notes; the coach chains the tools that already exist, one chip at a time:
//   1. a revealed brainstorm, or 8 or more ungrouped team notes in one frame: "Group these N notes into themes";
//   2. theme labels and no vote yet: "Start a 3-dot vote on the themes";
//   3. a revealed vote (and no action items yet): "Turn the top 5 into action items";
//   4. action items on the board: "Wrap up";
//   and nothing once a recap is on the board, or while a vote is still open or closed but not revealed.
// Facilitators only (editors with an account); never a viewer, a guest, or someone following in present mode.
// Steps 1 and 3 run AI: they are offered only while AI may add to this board for this person (on here, allowed
// to insert, budget left: ../ported/gate.ts canBuildWithAi; unknown until the status read lands). The vote and
// Wrap up (which has a recap without AI) need no AI.

/** Ungrouped team notes in one frame that make the coach offer themes. */
export const COACH_THEMES_MIN_NOTES = 8
/** A revealed brainstorm needs at least this many ungrouped notes in its frame to be worth grouping. */
export const COACH_BRAINSTORM_MIN_NOTES = 2
/** Dots per person the coach's vote starts with. */
export const COACH_VOTE_DOTS = 3
/** Items the vote-weighted action items take from the top of the results. */
export const COACH_TOP_N = 5

export interface CoachWorkshop {
  /** the latest private brainstorm the stream told of */
  readonly brainstorm: {
    readonly status: 'open' | 'revealed' | 'placed' | 'cancelled'
    readonly frameId: string
  } | null
  /** the latest vote */
  readonly vote: {
    readonly sessionId: string
    readonly status: 'open' | 'closed' | 'revealed'
    /** a revealed vote's results, in rank order (refs `shape:<id>`) */
    readonly top: readonly string[]
  } | null
}

export interface CoachFrameNotes {
  /** a frame's element id, or null for the open canvas */
  readonly frameId: string | null
  /** the team's notes there that no AI theme groups yet (element ids) */
  readonly ungrouped: readonly string[]
}

export interface CoachFacts {
  readonly frames: readonly CoachFrameNotes[]
  /** AI theme labels on the board */
  readonly themeLabels: number
  /** the notes grouped under them (element ids), what the vote is on */
  readonly themeNotes: readonly string[]
  /** AI action items on the board */
  readonly actionItems: number
  /** a recap (a Recap frame) on the board */
  readonly recap: boolean
}

export interface CoachRole {
  /** an editor with an account (not a viewer, commenter or name-only guest) */
  readonly facilitator: boolean
  /** following someone (present mode's followers) */
  readonly following: boolean
  /** AI may add to this board for this person now (canBuildWithAi; false while the status is unknown) */
  readonly ai: boolean
}

export type CoachStep =
  | { readonly id: 'themes'; readonly label: string; readonly notes: readonly string[] }
  | { readonly id: 'vote'; readonly label: string; readonly refs: readonly string[] }
  | {
      readonly id: 'actions'
      readonly label: string
      readonly voteSessionId: string
      readonly refs: readonly string[]
    }
  | { readonly id: 'wrapup'; readonly label: string }

const ref = (id: string) => `shape:${id}`

/** The next step (see the header), or null. */
export function nextStep(ws: CoachWorkshop, facts: CoachFacts, role: CoachRole): CoachStep | null {
  if (!role.facilitator || role.following) return null
  if (facts.recap) return null
  // 1. themes: a revealed brainstorm's frame, else the frame with the most ungrouped team notes past the bar
  const bs = ws.brainstorm
  const fromBrainstorm =
    bs && (bs.status === 'revealed' || bs.status === 'placed')
      ? facts.frames.find((f) => f.frameId === bs.frameId && f.ungrouped.length >= COACH_BRAINSTORM_MIN_NOTES)
      : undefined
  const crowded = [...facts.frames]
    .filter((f) => f.ungrouped.length >= COACH_THEMES_MIN_NOTES)
    .sort((a, b) => b.ungrouped.length - a.ungrouped.length)[0]
  const group = fromBrainstorm ?? crowded
  if (group && role.ai)
    return {
      id: 'themes',
      label: `Group these ${group.ungrouped.length} notes into themes`,
      notes: group.ungrouped,
    }
  // 2. a vote on the themes
  if (facts.themeLabels > 0 && ws.vote === null && facts.themeNotes.length > 0)
    return {
      id: 'vote',
      label: `Start a ${COACH_VOTE_DOTS}-dot vote on the themes`,
      refs: facts.themeNotes.slice(0, 200).map(ref),
    }
  // 3. the room chose: action items from the winners, ordered by votes
  if (ws.vote?.status === 'revealed' && facts.actionItems === 0 && role.ai)
    return {
      id: 'actions',
      label: `Turn the top ${COACH_TOP_N} into action items`,
      voteSessionId: ws.vote.sessionId,
      refs: ws.vote.top.slice(0, COACH_TOP_N),
    }
  // 4. wrap up
  if (facts.actionItems > 0) return { id: 'wrapup', label: 'Wrap up' }
  return null
}

/** The key a dismissal is stored under: the step, and for action items the vote it is about. */
export function stepKey(step: CoachStep): string {
  return step.id === 'actions' ? `actions:${step.voteSessionId}` : step.id
}
