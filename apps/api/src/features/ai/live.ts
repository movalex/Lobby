// Live AI awareness (wave L, L1-1; contracts ai.ts AI_EVENTS): the ephemeral board events `ai.working` and
// `ai.done` that let everyone on a board see "Sam is using AI here". Published on the board event hub by
// run() in index.ts: `ai.working` once the gate passed and the ledger reserved the call, `ai.done` after
// it settled, whether it succeeded or failed; neither for a refused call. Never stored, never in presence.
//
// The payloads carry no board content, no prompt, no question and no answer: the run id, the runner's
// board display name (what their cursor already shows everyone), the action, and where (the caller's
// `at`, clamped to canvas-schema's COORD_LIMIT, or null). Old web builds ignore unknown event types
// (K6-5's throw-safe listeners).

import { COORD_LIMIT } from '@draftroom/canvas-schema/limits'
import { AI_EVENTS, type AiAction, type AiDoneEvent, type AiRect, AiWorkingEvent } from '@draftroom/contracts'
import type { EventHub } from '../../events/hub.ts'

const clamp = (v: number) => Math.max(-COORD_LIMIT, Math.min(COORD_LIMIT, v))

/** The caller's `at` with both corners inside ±COORD_LIMIT (the size shrinks to fit), or null without one. */
export function clampRect(at: AiRect | undefined): AiRect | null {
  if (!at) return null
  const x = clamp(at.x)
  const y = clamp(at.y)
  return { x, y, w: clamp(at.x + at.w) - x, h: clamp(at.y + at.h) - y }
}

/** Longest name put on the wire (AiWorkingEvent.name). */
const NAME_MAX = 200

export function publishWorking(
  events: EventHub,
  boardId: string,
  e: { runId: string; name: string; action: AiAction; rect: AiRect | null },
): void {
  // Parsed (not just typed): only the four fields leave, whatever a caller adds.
  const data = AiWorkingEvent.parse({ ...e, name: e.name.slice(0, NAME_MAX) })
  events.publish(boardId, { type: AI_EVENTS.working, data })
}

export function publishDone(events: EventHub, boardId: string, runId: string): void {
  const data: AiDoneEvent = { runId }
  events.publish(boardId, { type: AI_EVENTS.done, data })
}
