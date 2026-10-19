// OWNER: the wave V foundation (the lead): the switches of wave V, "Live sessions+" (docs/WAVE-V-CONTRACTS.md §6.1).
// With every switch off (a web switch, or the api's it needs) a user sees exactly the build before wave V: no poll, scale or word cloud entry, answer sheet,
// results panel or chart; no join card, QR, code field or /j/ page; no breakout panel, chip or broadcast; no session
// summary section or CSV. Each workstream turns its own switch on in the change that makes its feature live (one line,
// through the lead).
//
// A web switch alone never offers anything that needs the api: the api must run the feature too (its kill switch, told
// in GET /api/auth/config `live`; an api before wave V tells nothing, read as all off). `liveEnabled(flag)` asks both
// when the offer is drawn. The session summary needs no api switch of its own: it shows what the board has.
//
// A dev-auth build (local dev and the e2e build; never a production bundle: DEV_AUTH_ENABLED) may turn a switch on for
// its page: localStorage LIVE_FLAG_KEYS[name] = '1' (or '0' to force it off), read when asked (try/catch: a blocked
// store keeps the shipped value). The v1-* to v4-* specs set them with an init script.
import { LIVE_SWITCHES_OFF, type LiveSwitch, type LiveSwitches } from '@draftroom/contracts'
import { DEV_AUTH_ENABLED } from '../../lib/identity.ts'
import { atom } from '../../lib/signals.ts'

export interface LiveFlags {
  /** WS2: polls, scales and word clouds (setup, answer sheet, results, moderation, Results to board) */
  readonly activities: boolean
  /** WS3: the join card (QR, the short code), "Show QR" in the Share dialog, /j/:code and "Have a code?" */
  readonly joinCodes: boolean
  /** WS4: breakouts (the facilitator panel, the chip, Go to my frame, broadcasts, group summons) */
  readonly breakouts: boolean
  /** WS5: the session summary (Wrap up's new sections, the Export dialog's session CSV) */
  readonly summary: boolean
}

export type LiveFlag = keyof LiveFlags

// The wave V foundation shipped every switch off; the integration turned all four on. Each still needs its api switch
// (liveEnabled; render.yaml keeps the api's off until the deploy's step 3, docs/WAVE-V-CONTRACTS.md §9), so a web with
// these on offers nothing an api has not switched on.
export const LIVE_FLAGS: LiveFlags = {
  activities: true,
  joinCodes: true,
  breakouts: true,
  summary: true,
}

export const LIVE_FLAG_KEYS: Readonly<Record<LiveFlag, string>> = {
  activities: 'lobby.liveActivities',
  joinCodes: 'lobby.liveJoinCodes',
  breakouts: 'lobby.liveBreakouts',
  summary: 'lobby.liveSummary',
}

/** The api switch each web switch needs (null: none). */
export const LIVE_FLAG_SERVER: Readonly<Record<LiveFlag, LiveSwitch | null>> = {
  activities: 'activities',
  joinCodes: 'joinCodes',
  breakouts: 'breakouts',
  summary: null,
}

const NAMES = Object.keys(LIVE_FLAGS) as LiveFlag[]

/** The switches of this page: the shipped ones, or a dev-auth page's overrides (each read in try/catch). */
export function liveFlags(
  devAuth: boolean = DEV_AUTH_ENABLED,
  read: (key: string) => string | null | undefined = (key) => globalThis.localStorage?.getItem(key),
): LiveFlags {
  if (!devAuth) return LIVE_FLAGS
  const one = (name: LiveFlag): boolean => {
    try {
      const v = read(LIVE_FLAG_KEYS[name])
      return v === '1' ? true : v === '0' ? false : LIVE_FLAGS[name]
    } catch {
      return LIVE_FLAGS[name]
    }
  }
  return Object.fromEntries(NAMES.map((n) => [n, one(n)])) as unknown as LiveFlags
}

/**
 * What this api runs (GET /api/auth/config `live`), set by the session once the config arrives (auth/session.tsx);
 * all off until then, and for an api before wave V. A signal: an offer drawn before the config arrived redraws.
 */
export const liveSwitches = atom<LiveSwitches>('lobby-live-switches', LIVE_SWITCHES_OFF)

/** The session's setter (auth/session.tsx): an absent or malformed `live` is all off. */
export function setLiveSwitches(live: Partial<LiveSwitches> | null | undefined): void {
  liveSwitches.set({
    activities: live?.activities === true,
    joinCodes: live?.joinCodes === true,
    breakouts: live?.breakouts === true,
  })
}

/**
 * Whether this page offers `flag`'s feature: its web switch AND (when it needs one) the api's. Asked when the offer is
 * drawn (inside a useValue selector it redraws when the api's answer arrives). The api still decides every request: an
 * api whose switch is off answers 404, which the feature reads as "not here".
 */
export function liveEnabled(
  flag: LiveFlag,
  flags: LiveFlags = liveFlags(),
  server: LiveSwitches = liveSwitches.get(),
): boolean {
  const needs = LIVE_FLAG_SERVER[flag]
  return flags[flag] && (needs === null || server[needs] === true)
}
