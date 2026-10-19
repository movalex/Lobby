// OWNER: WS4 (wave V, breakouts). The web side of the breakout routes (@draftroom/contracts breakouts.ts), through the
// board page's api client (same origin, the session cookie, contracts-validated answers). Every call answers
// `{ok: true, state}` or `{ok: false, …}` with a sentence to show; nothing throws. An api whose DRAFTROOM_BREAKOUTS is
// off answers 404 for every route: `unavailable`, and the feature offers nothing.
import {
  type AssignBreakoutInput,
  type BreakoutBroadcastInput,
  BreakoutState,
  type BreakoutSummonInput,
  breakoutActionPath,
  breakoutsPath,
  type StartBreakoutsInput,
} from '@draftroom/contracts'
import { type ApiClient, isApiError } from '../../api/client.ts'

export type Outcome<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly unavailable: boolean; readonly code: string; readonly message: string }

const MESSAGES: Record<string, string> = {
  BREAKOUTS_RUNNING: 'Breakouts are already running on this board.',
  BREAKOUTS_ENDED: 'These breakouts have ended.',
  PRESENTING: 'Someone is presenting to everyone. End the presentation first.',
  SPOTLIGHT: 'A spotlight is on. End it first.',
  BREAKOUT_GROUP_FULL: 'That group is full. Pick another one.',
  BREAKOUT_NOT_CHOOSE: 'The facilitator picks the groups in these breakouts.',
  GUEST_ACCOUNT_REQUIRED: 'Guests take part, but breakouts are run by editors with an account.',
  RATE_LIMITED: 'That was a moment ago. Wait a few seconds and try again.',
  BOARD_ARCHIVED: 'This board is archived.',
}

async function call<T>(fn: () => Promise<T>): Promise<Outcome<T>> {
  try {
    return { ok: true, value: await fn() }
  } catch (e) {
    if (!isApiError(e))
      return { ok: false, unavailable: false, code: 'ERROR', message: 'Something went wrong. Try again.' }
    const unavailable = e.status === 404 && e.code === 'NOT_FOUND'
    return {
      ok: false,
      unavailable,
      code: e.code,
      message:
        MESSAGES[e.code] ??
        (unavailable ? 'Breakouts are not available here.' : e.message || 'Something went wrong. Try again.'),
    }
  }
}

export interface BreakoutsClient {
  state(boardId: string, signal?: AbortSignal): Promise<Outcome<BreakoutState>>
  start(boardId: string, input: StartBreakoutsInput): Promise<Outcome<BreakoutState>>
  assign(brk: string, moves: AssignBreakoutInput['moves']): Promise<Outcome<BreakoutState>>
  shuffle(brk: string): Promise<Outcome<BreakoutState>>
  join(brk: string, groupId: string): Promise<Outcome<BreakoutState>>
  extend(brk: string, addMs: number): Promise<Outcome<BreakoutState>>
  end(brk: string): Promise<Outcome<BreakoutState>>
  broadcast(brk: string, input: BreakoutBroadcastInput): Promise<Outcome<void>>
  summon(brk: string, input: BreakoutSummonInput): Promise<Outcome<void>>
}

export function breakoutsClient(api: Pick<ApiClient, 'request'>): BreakoutsClient {
  const post = (brk: string, action: Parameters<typeof breakoutActionPath>[1], body: unknown = {}) =>
    call(() => api.request('POST', breakoutActionPath(brk, action), { body, schema: BreakoutState }))
  return {
    state: (boardId, signal) =>
      call(() =>
        api.request('GET', breakoutsPath(boardId), { schema: BreakoutState, ...(signal ? { signal } : {}) }),
      ),
    start: (boardId, input) =>
      call(() => api.request('POST', breakoutsPath(boardId), { body: input, schema: BreakoutState })),
    assign: (brk, moves) => post(brk, 'assign', { moves }),
    shuffle: (brk) => post(brk, 'shuffle'),
    join: (brk, groupId) => post(brk, 'join', { groupId }),
    extend: (brk, addMs) => post(brk, 'extend', { addMs }),
    end: (brk) => post(brk, 'end'),
    broadcast: (brk, input) =>
      call(() => api.request('POST', breakoutActionPath(brk, 'broadcast'), { body: input, schema: null })),
    summon: (brk, input) =>
      call(() => api.request('POST', breakoutActionPath(brk, 'summon'), { body: input, schema: null })),
  }
}
