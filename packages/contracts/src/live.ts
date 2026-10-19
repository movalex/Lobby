// Wave V, "Live sessions+" (docs/WAVE-V-CONTRACTS.md): what the three features share. OWNER: the wave V lead
// (packages/contracts is lead-only; every workstream reads it).
//
//   - polls, scales and word clouds ("live activities", ./live-activities.ts; WS1 api, WS2 web)
//   - join codes and the QR join card (./join-codes.ts; WS3)
//   - breakouts (./breakouts.ts; WS4)
//
// Each has a kill switch on the api (apps/api/src/config.ts parseLiveSwitches): `on`; `off`, empty or unset = off
// (fail closed); anything else refuses to start. With a switch off every route of its feature answers 404 NOT_FOUND
// exactly like an unknown route (for every caller, nothing read or written: apps/api/src/features/live/switch.ts),
// no event of it is published and no open-state part is sent. The api tells the web which are on in GET
// /api/auth/config (`AuthConfig.live`, optional: an api before wave V sends none, and the web reads that as all off).
//
// Nothing of wave V changes the sync protocol (CONTRACTS_REV stays 14), an element field, a customData key or
// LOBBY_CLIENT_REV (3): state lives in Postgres (migration 0038_live_sessions) and on the board event stream, and
// results reach a board only as ordinary elements the facilitator's own client writes (customData.lobby.kind
// LIVE_ELEMENT_KINDS, a create-only value every reader since rev 11 accepts).
//
// Do not import values from ./index.ts here: index.ts re-exports this module.

import { z } from 'zod'

/** The api's wave V kill switches, by feature. */
export const LIVE_SWITCHES = ['activities', 'joinCodes', 'breakouts'] as const
export type LiveSwitch = (typeof LIVE_SWITCHES)[number]

/** The environment variable of each switch (render.yaml sets them on the api only). */
export const LIVE_SWITCH_ENV: Readonly<Record<LiveSwitch, string>> = {
  activities: 'DRAFTROOM_LIVE_ACTIVITIES',
  joinCodes: 'DRAFTROOM_JOIN_CODES',
  breakouts: 'DRAFTROOM_BREAKOUTS',
}

/** `AuthConfig.live`: which wave V features this api runs. Not strict: a later switch is additive. */
export const LiveSwitches = z.object({
  activities: z.boolean(),
  joinCodes: z.boolean(),
  breakouts: z.boolean(),
})
export type LiveSwitches = z.infer<typeof LiveSwitches>

/** Every switch off: what the web assumes when the api sends no `live` (an api before wave V). */
export const LIVE_SWITCHES_OFF: LiveSwitches = Object.freeze({
  activities: false,
  joinCodes: false,
  breakouts: false,
})

/**
 * Who may call a wave V route (checked server-side by the route; the guard lists add the name-only guest rows):
 *   - `view`: may view the board (`can(role, 'view', status)`: an archived board's readers too);
 *   - `participate`: may view an ACTIVE board: answering an activity, choosing a breakout group (viewers, commenters,
 *     clients on review links and name-only guests take part, as in a dot vote);
 *   - `facilitate`: may edit the board AND has an account (workshops/facilitators.ts requireFacilitatorAccount);
 *     starting an activity or breakouts;
 *   - `manage`: acting on one running activity or breakout: its starter, a board owner, or any editor with an account
 *     once the starter can no longer edit the board (`starterLeft`, as a private brainstorm); always an account;
 *   - `creator`: a creator who may manage the board's access (a join code hands out a link's access, like the link);
 *   - `anyone`: no session needed (resolving a join code: the code is a bearer secret, like the link's token).
 */
export type LiveRule = 'view' | 'participate' | 'facilitate' | 'manage' | 'creator' | 'anyone'

/** The 403 GUEST_ACCOUNT_REQUIRED message of every facilitator route of wave V (apps/api features/guests/guard.ts). */
export const LIVE_FACILITATE_GUESTS_MESSAGE =
  'Guests take part, but polls, word clouds and breakouts are run by editors with an account. Sign in with an account to run one.'

/**
 * The `customData.lobby.kind` of what the facilitator's client places on the board (one `canvas.transact`, one undo
 * step): a poll or scale chart's frame and its parts, a word cloud's frame and its words, and (optional) a frame made by
 * "Make N frames" for breakouts. Create-only, a short lowercase word: every reader since rev 11 accepts it
 * (packages/canvas-schema/src/wave-v-kinds.test.ts proves it against the frozen rev-11, -12 and -13 schemas and the
 * current rev-14 one, which is the deployed web's and sync's).
 */
export const LIVE_ELEMENT_KINDS = {
  pollChart: 'poll-chart',
  wordCloud: 'word-cloud',
  breakoutFrame: 'breakout-frame',
} as const
export type LiveElementKind = (typeof LIVE_ELEMENT_KINDS)[keyof typeof LIVE_ELEMENT_KINDS]

/** The "Make N frames" frames' names ("Group 1"), and a group's default name. */
export const breakoutGroupDefaultName = (n: number) => `Group ${n}`
