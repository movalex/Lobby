// What the sort feature calls out to: W2's runAi and showAiPreview (features/ai/ported/public.ts, the one file
// other features import from the AI feature). Held in a replaceable object so a unit test and the dev-auth
// e2e hook (./dev-hook.ts) can stand in for them; nothing else ever replaces them.
import { type AiPreviewChoice, type AiPreviewPlan, runAi, showAiPreview } from '../ai/ported/public.ts'

export interface SortDeps {
  runAi: typeof runAi
  showAiPreview: typeof showAiPreview
}

const real: SortDeps = { runAi, showAiPreview }
let current: SortDeps = real

export const sortDeps = (): SortDeps => current

/** Replaces some or all of the calls (null puts the real ones back). */
export function setSortDeps(deps: Partial<SortDeps> | null): void {
  current = deps === null ? real : { ...real, ...deps }
}

export type { AiPreviewChoice, AiPreviewPlan }
