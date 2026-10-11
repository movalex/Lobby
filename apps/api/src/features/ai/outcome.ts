// What a model call's outcome means for the person and for the budgets (moved out of index.ts in wave N so the
// board's AI run and Capture the room, capture.ts, answer failures in the same words and charge them the same way).

import { AI_ERROR_CODES } from '@draftroom/contracts'
import { ApiError } from '../../errors.ts'
import type { ChatOutcome } from './openai.ts'

export const badOutput = () =>
  new ApiError(502, AI_ERROR_CODES.badOutput, 'The AI’s answer couldn’t be used. Try again.')

export function upstreamError(outcome: Extract<ChatOutcome, { ok: false }>): ApiError {
  switch (outcome.kind) {
    case 'timeout':
      return new ApiError(504, AI_ERROR_CODES.upstream, 'OpenAI took too long to answer. Try again.')
    case 'network':
      return new ApiError(502, AI_ERROR_CODES.upstream, 'Lobby couldn’t reach OpenAI. Try again in a moment.')
    case 'http':
      if (outcome.status === 429)
        return new ApiError(502, AI_ERROR_CODES.upstream, 'OpenAI is busy right now. Try again in a minute.')
      if (outcome.status === 401 || outcome.status === 403)
        return new ApiError(
          502,
          AI_ERROR_CODES.upstream,
          'OpenAI refused Lobby’s key. Ask whoever runs Lobby to check the AI settings.',
        )
      return new ApiError(502, AI_ERROR_CODES.upstream, 'OpenAI couldn’t answer just now. Try again.')
    case 'refused':
      return new ApiError(422, AI_ERROR_CODES.refused, 'The AI declined to answer this one.')
    default:
      return new ApiError(502, AI_ERROR_CODES.badOutput, 'The AI’s answer couldn’t be used. Try again.')
  }
}

/**
 * What a call counts toward the budgets: what OpenAI reported, nothing for a refusal before any generation, and its
 * whole reservation when nobody can tell (a timeout, a dropped connection, a 5xx, an answer without usage).
 */
export function chargedFor(outcome: ChatOutcome, reserved: number): number {
  if (outcome.billing === 'usage' && outcome.usage) return outcome.usage.total
  if (outcome.billing === 'none') return 0
  return reserved
}

/** A call that threw instead of answering (it never should: openai.ts turns every failure into an outcome). */
export const NETWORK_OUTCOME: ChatOutcome = {
  ok: false,
  kind: 'network',
  status: null,
  usage: null,
  billing: 'unknown',
}
