// When the AI tools that build on the board (Expand with AI, Mind map from a prompt) are offered (pure). The
// api decides everything and enforces every limit; this only follows what AiStatus says, so a person is never
// shown a button that cannot work:
//  - AI must be on for this person on this board, and allowed to add to it (`canInsert`);
//  - the person must be able to edit;
//  - when the workspace's budget for the day is used up (workspace owners are told; the api's answer says so to
//    everyone else) the tools are hidden rather than left to fail.

import type { AiStatus } from '@draftroom/contracts'

/** The day's budget is used up (AiStatus only carries it for workspace owners). */
export const budgetSpent = (status: AiStatus | null | undefined): boolean =>
  (status?.budget?.usedPercent ?? 0) >= 100

/** Whether to offer the tools that write results onto the board. */
export function canBuildWithAi(status: AiStatus | null | undefined, readOnly: boolean): boolean {
  return !!status && status.enabled && status.canInsert && !readOnly && !budgetSpent(status)
}
