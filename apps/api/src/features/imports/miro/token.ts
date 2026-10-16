// The token of a Miro route (wave R, WS1): taken out of the parsed body by hand (contracts splitMiroToken: never a
// schema, an issue or a message), removed from the body object and wrapped as a RedactedSecret; and the answers a
// MiroError becomes. Shared by the Miro routes (./index.ts) and the job routes' resume (../routes.ts).
import { MIRO_CODE_MESSAGES, MIRO_CODES, splitMiroToken } from '@draftroom/contracts'
import { isRecord } from '@draftroom/miro-import/sources'
import type { FastifyRequest } from 'fastify'
import { RedactedSecret, withSecrets } from '../../../egress/index.ts'
import { ApiError } from '../../../errors.ts'
import { type MiroCode, MiroError } from './client.ts'

const STATUS: Readonly<Record<MiroCode, number>> = {
  MIRO_TOKEN_INVALID: 400,
  MIRO_SCOPE_MISSING: 400,
  MIRO_BOARD_NOT_VISIBLE: 404,
  MIRO_RATE_LIMITED: 429,
  MIRO_UNAVAILABLE: 502,
}

/** A Miro code as the route's answer (the message the dialog shows). */
export const miroApiError = (code: MiroCode) => new ApiError(STATUS[code], code, MIRO_CODE_MESSAGES[code])

/** MiroErrors as their answers; everything else as it is (withSecrets scrubs it first). */
export async function answering<T>(token: RedactedSecret, fn: () => Promise<T>): Promise<T> {
  return withSecrets([token], async () => {
    try {
      return await fn()
    } catch (e) {
      if (e instanceof MiroError) throw miroApiError(e.code)
      throw e
    }
  })
}

export interface TakenToken {
  /** the token, or null when the body had none (or one that cannot be a token: `invalid`) */
  readonly secret: RedactedSecret | null
  /** the body had a `token` that cannot be one (never quoted) */
  readonly invalid: boolean
  /** the body without `token`, for the route's schema */
  readonly rest: Record<string, unknown>
}

/**
 * The body's token as a RedactedSecret, removed from the body object at once, and the rest for the route's schema.
 * Nothing is refused here: the route refuses (`tokenRefusal`) after it checked who is asking.
 */
export function takeMiroToken(req: FastifyRequest): TakenToken {
  const had = isRecord(req.body) && 'token' in req.body
  const { token, rest } = splitMiroToken(req.body)
  if (isRecord(req.body)) delete req.body.token
  return { secret: token ? new RedactedSecret(token) : null, invalid: had && !token, rest }
}

/** MIRO_TOKEN_INVALID for a missing (when one is needed) or malformed token. */
export const tokenRefusal = () => miroApiError(MIRO_CODES.tokenInvalid)
