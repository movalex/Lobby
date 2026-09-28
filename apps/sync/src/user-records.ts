// tldraw `user:` records bound to the verified ticket (reviewer finding G-R8).
//
// tldraw 5.4.2 keeps one document-scoped `user` record per person: { id: 'user:<id>', name, color,
// imageUrl, meta } (@tldraw/tlschema TLUser). It syncs to every tab, persists with the board, and is
// where a note's "last edited by" name comes from (Editor.getAttributionDisplayName falls back to it).
// @tldraw/sync-core never checks who writes one, so any editor, a name-only guest on a workshop link
// included, could name `user:<someone>` "Chase Boyajian", or drop the "(guest)" marker from their own.
//
// The rule has two layers because tldraw re-writes its own record whenever the stored one differs
// from its TLUserStore's currentUser (Editor._ensureUserRecord runs in a reaction on that record): a
// skipped or rewritten own record comes straight back, ~14 pushes/s for as long as the tab is open
// (docs/research/saved-indicator.md §7).
//
// 1. The wire: userRecordOpsAllowed, called by InboundFrames (presence.ts) before the room sees a push.
//    - A user record may only be sent under its own id, and nothing but a user record under a
//      `user:` id. (TLSyncRoom files a put under its diff key and never compares it with the record's
//      id; today SQLiteSyncStorage.set asserts they match and the room drops the session with
//      UNKNOWN_ERROR. This refuses it first, as the forgery it is, without relying on that.)
//    - The session's OWN record must carry the ticket's name and color and no image, and a patch may
//      not touch its id or typeName.
//    A violation refuses the whole push and closes the session 4099 INVALID_RECORD, like a forged
//    presence. That close is terminal on the client, so there is neither a push loop nor a reconnect
//    loop; a stale web client that still writes the account name instead of the ticket's (a long
//    guest name is shortened in the ticket) ends on "Reload to continue" and reloads into the fix.
// 2. The room: authorizeUserRecord, a TLRecordAuthorizer next to the text lease. A write to any
//    record but the session's own is skipped. The writer's tab self-corrects and stays connected:
//    tldraw's paste (putContentOntoCurrentPage) creates the user records of the people a pasted note
//    names, and nothing re-writes those afterwards. It checks the own record again as a backstop.
//
// Server writes (the private-notes placement, "Recently deleted" restores, template seeds, backup
// restores) pass through neither: sync-core runs authorizers for client pushes only.
import type { TLRecordAuthorizers } from '@tldraw/sync-core'
import { createUserId, type TLRecord } from '@tldraw/tlschema'
import type { PresenceIdentity } from './presence.ts'
import type { SessionMeta } from './rooms.ts'

/** The ticket carries no picture and Lobby never sets one (a URL there would be anyone's image). */
export const NO_USER_IMAGE = ''

const USER_TYPE = 'user'
const USER_ID_PREFIX = 'user:'
// Wire op names (sync-core diff.ts RecordOpType / ValueOpType, which are @internal there).
const PUT = 'put'
const PATCH = 'patch'

type Obj = Record<string, unknown>
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v)

/**
 * May the room receive this push's document diff? false: it sends a user record under a key that is
 * not its id (or something else under a user id), or it writes the session's own record with
 * anything but the ticket's name, color and no image. Other people's records are left to
 * authorizeUserRecord (skipped in the room). Never throws.
 */
export function userRecordOpsAllowed(diff: unknown, who: PresenceIdentity): boolean {
  // The room walks the own keys of whatever object `diff` is (an array's indices too).
  if (typeof diff !== 'object' || diff === null) return true
  for (const [key, op] of Object.entries(diff)) {
    if (!Array.isArray(op)) continue // the room applies nothing for it
    if (op[0] === PUT && !putAllowed(key, op[1], who)) return false
    if (op[0] === PATCH && key === who.userId && !ownPatchAllowed(op[1], who)) return false
  }
  return true
}

function putAllowed(key: string, record: unknown, who: PresenceIdentity): boolean {
  const isUserRecord = isObj(record) && record.typeName === USER_TYPE
  if (!isUserRecord && !key.startsWith(USER_ID_PREFIX)) return true
  if (!isUserRecord || record.id !== key) return false
  if (key !== who.userId) return true // someone else's: skipped in the room
  return record.name === who.userName && record.color === who.color && record.imageUrl === NO_USER_IMAGE
}

function ownPatchAllowed(patch: unknown, who: PresenceIdentity): boolean {
  if (!isObj(patch)) return true // not a patch sync-core can apply
  if (Object.hasOwn(patch, 'id') || Object.hasOwn(patch, 'typeName')) return false
  // A patch sets a field with put, append or a nested patch: only a put of the ticket's value passes.
  const keeps = (field: string, value: string) => {
    if (!Object.hasOwn(patch, field)) return true
    const op = patch[field]
    return Array.isArray(op) && op[0] === PUT && op[1] === value
  }
  return keeps('name', who.userName) && keeps('color', who.color) && keeps('imageUrl', NO_USER_IMAGE)
}

type UserAuthorizer = NonNullable<TLRecordAuthorizers<TLRecord, SessionMeta>['user']>

/**
 * The room's rule for `user` records (client pushes only): the session's own record, with the
 * ticket's name and color and no image, may be created, updated and removed; everything else is
 * skipped (null), and sync-core's rebase puts the writer's tab back in step.
 */
export const authorizeUserRecord: UserAuthorizer = (args) => {
  // The room's canWrite gate already skips read-only writes; fail closed if that ever changes.
  if (args.session.isReadonly) return null
  const { meta } = args.session
  const own = createUserId(meta.userId)
  if (args.type === 'delete') return args.prev.id === own ? args.prev : null
  // `prev` is what is stored under the key the client wrote to; `next` is what it would become.
  if (args.type === 'update' && args.prev.id !== own) return null
  const { next } = args
  const pinned =
    next.id === own && next.name === meta.name && next.color === meta.color && next.imageUrl === NO_USER_IMAGE
  return pinned ? next : null
}
