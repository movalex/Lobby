// OWNER: W5 (wave L, live meeting). The workshop and present-export command ids other workstreams run by id
// (canvas-ux runCommand(ctx, id, source, args)), with their args. Frozen at the wave L foundation. Registered by
// W5: 'workshops.vote.setup' and 'workshops.spotlight' (workshops/ported/index.tsx COMMANDS; also
// 'workshops.spotlight-end'), and 'present-export.export' (present-export/ported/index.tsx, registered since
// wave 3 without args; it takes `frameIds` now).
// Running an id that is not registered is a no-op (runCommand answers false), so a caller (W2's coach and
// Wrap up) needs no feature check.

export const WORKSHOP_COMMAND_IDS = {
  /** Opens the vote setup, prefilled (L5-3 run-off, L2-4 coach); args VoteSetupArgs */
  voteSetup: 'workshops.vote.setup',
  /** Spotlights these elements for everyone (L5-2); args SpotlightArgs */
  spotlight: 'workshops.spotlight',
  /** The export dialog (PDF among its formats), for these frames when given (L2-3 "Export recap as PDF"); args PresentExportArgs */
  presentExport: 'present-export.export',
} as const

/** 'selection': the vote takes exactly `refs` (shape refs, `shape:<id>`); 'board' and 'frame' as the dialog offers. */
export interface VoteSetupArgs {
  readonly scope: 'board' | 'frame' | 'selection'
  readonly refs?: readonly string[]
  readonly onePerObject?: boolean
}
export interface SpotlightArgs {
  /** element ids (not refs) */
  readonly ids: readonly string[]
}
export interface PresentExportArgs {
  /** element ids of frames */
  readonly frameIds?: readonly string[]
}

/** The most ids or refs one of these commands takes (the vote's selection cap, the spotlight's). */
export const WORKSHOP_COMMAND_MAX_IDS = 200

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null
const strings = (v: unknown): string[] | null =>
  Array.isArray(v) &&
  v.length <= WORKSHOP_COMMAND_MAX_IDS &&
  v.every((s) => typeof s === 'string' && s.length > 0)
    ? (v as string[])
    : null

/** The args of 'workshops.vote.setup', or null when they are not ones it takes (the dialog then opens empty). */
export function voteSetupArgs(args: unknown): VoteSetupArgs | null {
  if (!isObj(args)) return null
  const scope = args.scope
  if (scope !== 'board' && scope !== 'frame' && scope !== 'selection') return null
  const refs = args.refs === undefined ? undefined : strings(args.refs)
  if (refs === null) return null
  if (scope === 'selection' && !refs?.length) return null
  const one = typeof args.onePerObject === 'boolean' ? args.onePerObject : undefined
  return { scope, ...(refs ? { refs } : {}), ...(one !== undefined ? { onePerObject: one } : {}) }
}

export function spotlightArgs(args: unknown): SpotlightArgs | null {
  const ids = isObj(args) ? strings(args.ids) : null
  return ids?.length ? { ids } : null
}

export function presentExportArgs(args: unknown): PresentExportArgs {
  const ids = isObj(args) ? strings(args.frameIds) : null
  return ids?.length ? { frameIds: ids } : {}
}
