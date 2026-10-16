// FROZEN FIXTURE, never edit. This is
//   packages/canvas-schema/src/reactions.ts
// of commit 6769e07 (the web deployed on staging since wave S: CONTRACTS_REV 13), as
// `git show 6769e07:<that path>` gives it (blob 956d5144fdf4). The deployed web parses every server
// frame with these schemas (its socket transport, apps/web/src/canvas/sync/transport/socket.ts at that
// commit: `ServerMessage.safeParse` on each text frame, the gzip snapshot through `decodeSnapshotFrame`),
// so the stale-pair tests parse the room's frames with them (docs/EXCALIDRAW-CONTRACTS.md §0b, the
// per-reader downgrade rule). Changed from the commit:
// these header lines, and its `@draftroom/contracts` import, which reads the frozen copy
// beside it (contracts-workshops.ts).
/**
 * Wave N (LM-10): emoji reactions on sticky notes, as identity-bound `customData.lobby` keys
 * `react:<code>:<uid>` = true (custom-data.ts LOBBY_KEY_SPECS; CONTRACTS_REV 13, protocol.ts REACTIONS_REV).
 * `<code>` is one of @draftroom/contracts REACTION_CODES (up, heart, laugh, party, think, clap); `<uid>` is the
 * reacting person's uid (the Uid check: 1 to MAX_UID_CHARS characters). Only that person adds or removes their
 * key (an owner may also remove anyone's, for "Clear reactions"); the sync decides (apps/sync/src/room/
 * custom-data.ts). A key's value is `true` only: the order of reactions is not stored.
 *
 * Pure: no engine code, no imports from custom-data.ts (which imports this module).
 */
import { REACTION_CODES, type ReactionCode } from './contracts-workshops.ts'
import { MAX_UID_CHARS } from './limits.ts'

export const REACTION_KEY_PREFIX = 'react:'
/** custom-data.ts PLUS_ONE_KEY_PREFIX, repeated here so this module does not import custom-data.ts (a cycle). */
const PLUS_ONE_PREFIX = 'plusOne:'

const CODES: ReadonlySet<string> = new Set(REACTION_CODES)

/** Whether `uid` passes the key registry's Uid check (1 to MAX_UID_CHARS characters). */
const uidOk = (uid: string): boolean => uid.length >= 1 && uid.length <= MAX_UID_CHARS

/** The key of `uid`'s reaction `code` on a note. */
export const reactionKey = (code: ReactionCode, uid: string): string => `${REACTION_KEY_PREFIX}${code}:${uid}`

/**
 * `{code, uid}` of a `react:<code>:<uid>` key, or null when the key is not one: an unknown code, an empty or too
 * long uid, or no `react:` prefix. The uid is everything after the code's colon (it may itself hold colons).
 */
export function parseReactionKey(key: string): { code: ReactionCode; uid: string } | null {
  if (!key.startsWith(REACTION_KEY_PREFIX)) return null
  const rest = key.slice(REACTION_KEY_PREFIX.length)
  const colon = rest.indexOf(':')
  if (colon <= 0) return null
  const code = rest.slice(0, colon)
  const uid = rest.slice(colon + 1)
  if (!CODES.has(code) || !uidOk(uid)) return null
  return { code: code as ReactionCode, uid }
}

/**
 * The uid an identity-bound key belongs to, for every identity-bound key class: `plusOne:<uid>` and
 * `react:<code>:<uid>`; null for any other key (or a malformed one). The sync's identity check and lock exemption
 * use it, and so do the archive strips (identity-bound keys mean nothing across deployments).
 */
export function identityUidOf(key: string): string | null {
  if (key.startsWith(PLUS_ONE_PREFIX)) {
    const uid = key.slice(PLUS_ONE_PREFIX.length)
    return uid.length > 0 ? uid : null
  }
  return parseReactionKey(key)?.uid ?? null
}

/** Whether `key` is a reaction key (well formed or not: the prefix decides the key class). */
export const isReactionKey = (key: string): boolean => key.startsWith(REACTION_KEY_PREFIX)

/**
 * A note's reactions from its `customData.lobby` (keys whose value is `true` and that parse), by code in
 * REACTION_CODES order, each with its uids sorted (the order is not stored). Codes nobody used are left out.
 */
export function reactionsOf(
  lobby: Readonly<Record<string, unknown>> | undefined,
): { code: ReactionCode; uids: string[] }[] {
  if (!lobby) return []
  const by = new Map<ReactionCode, string[]>()
  for (const [k, v] of Object.entries(lobby)) {
    if (v !== true) continue
    const r = parseReactionKey(k)
    if (!r) continue
    const list = by.get(r.code)
    if (list) list.push(r.uid)
    else by.set(r.code, [r.uid])
  }
  const out: { code: ReactionCode; uids: string[] }[] = []
  for (const code of REACTION_CODES) {
    const uids = by.get(code)
    if (uids) out.push({ code, uids: uids.sort() })
  }
  return out
}
