// The server rules of the five customData classes (docs/EXCALIDRAW-MIGRATION.md §3.3, §2.4.3 step 7).
// The key registry (class, value schema, size) is canvas-schema's custom-data.ts; this file decides who
// may write a key, and when:
//  1. server-owned `customData.lobbyServer`: only the server writes it; a client value is replaced
//     (built fresh on a create; `privateNote` only through place-notes, never from a socket);
//  2. create-only `kind`, `ai`, `privateFrame`: only in the op that creates the element; `by` must be the
//     writer's uid; a later change is INVALID; removal only by the `by` user (for `kind`, the creator) or
//     an owner;
//  3. identity-bound `plusOne:<uid>` and `react:<code>:<uid>` (wave N, CONTRACTS_REV 13), by the key's uid
//     (canvas-schema reactions.ts `identityUidOf`): only where `<uid>` is the writer. A +1 added while a dot
//     vote is open is VOTE_OPEN (UNAVAILABLE while the vote state is still unknown). A reaction never is: it
//     goes on sticky notes only, an owner may also remove anyone's ("Clear reactions"), and while the reactions
//     kill switch is off (DRAFTROOM_REACTIONS) every reaction write is UNAVAILABLE;
//  4. api-validated `file` (canonicalized from the file-refs answer; `versionId` must be the version in
//     `fileId`; `name` is the client's) and `pdfPage` (derived from `fileId`'s `.p<n>`);
//  5. free keys (`tag:*` needs its `tagDef:*` in lb_doc; the others are schema-checked only).
// Wave T (CONTRACTS_REV 14): the planning keys (canvas-schema planning-keys.ts: `card:*`, `sb:*`, `kanban`,
// `timeline`). While the planning kill switch is off (DRAFTROOM_PLANNING) every write of one is UNAVAILABLE (the stored
// keys stay; an undelete's own keys come back with it). With it on, the wave T FOUNDATION still refuses every write of
// one INVALID: their rules (roles, guests, the assignee check through the api's assignee-refs, the audio ref) are WS1's
// (docs/WAVE-T-CONTRACTS.md §3), which replaces `planningPending` below. Their types and cross-key rules are
// checkElement's (planning-keys.ts planningElementProblem), for every writer.
// A locked element takes only the registry's lock-exempt keys (lockExemptKey; merge.ts step 5).

import {
  type Attribution,
  type FileValue,
  type LobbyServer,
  lobbyKeySpec,
  lobbyValueProblem,
  tagKeyOf,
} from '@draftroom/canvas-schema/custom-data'
import { TAG_DEF_KEY_PREFIX } from '@draftroom/canvas-schema/doc'
import { pdfPageOf, versionIdOf } from '@draftroom/canvas-schema/limits'
import { isPlanningKey } from '@draftroom/canvas-schema/planning-keys'
import type { RejectCode } from '@draftroom/canvas-schema/protocol'
import { identityUidOf, isReactionKey } from '@draftroom/canvas-schema/reactions'
import type { FileRefAnswer } from '../file-refs.ts'

export interface Writer {
  readonly uid: string
  readonly name: string
  readonly guest: boolean
  readonly role: 'owner' | 'editor' | 'commenter' | 'viewer'
}

export interface CustomDataContext {
  readonly writer: Writer
  /** the vote state: open, closed, or not known yet (the pull has not answered) */
  readonly voteOpen: boolean | null
  /** a `tagDef:<key>` exists in lb_doc (or in this push's doc writes) */
  readonly tagExists: (tagKey: string) => boolean
  /**
   * Why this push's own write of `tagDef:<key>` was refused (its `docDenied` code), or null. A `tag:<key>`
   * whose definition the same push tried to make answers with that code (a guest over its tag cap gets
   * GUEST_LIMIT on its notes, not INVALID: one Create on 60 selected notes counted 60 toward the abuse close).
   */
  readonly tagDenied?: (tagKey: string) => RejectCode | null
  /** the cached file-refs answer for a bare version id (undefined: the lookup failed or never ran) */
  readonly fileRef: (versionId: string) => FileRefAnswer | undefined
  /**
   * Wave N (N2-5): the reactions kill switch (config.ts DRAFTROOM_REACTIONS). False: every `react:` write is
   * UNAVAILABLE (the keys already stored stay; an undelete's own keys come back with it). Absent: on.
   */
  readonly reactions?: boolean
  /**
   * Wave T: the planning kill switch (config.ts DRAFTROOM_PLANNING). False: every planning key write is UNAVAILABLE
   * (the keys already stored stay; an undelete's own keys come back with it). Absent: on.
   */
  readonly planning?: boolean
}

/**
 * Wave T foundation: no planning key write is taken yet, whatever the switch says (WS1's rules replace this with
 * their checks; the room test pins it). True until then.
 */
export const planningPending = true

export type Verdict<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly code: RejectCode }

const bad = (code: RejectCode): { ok: false; code: RejectCode } => ({ ok: false, code })

/** The attribution of the writer (from the ticket, never from the client). */
export const attributionOf = (w: Writer): Attribution => ({ uid: w.uid, name: w.name, guest: w.guest })

/** A fresh `lobbyServer` for an element this writer creates (a copy never inherits `privateNote`). */
export function freshLobbyServer(w: Writer, now: number, text: boolean): LobbyServer {
  return {
    createdBy: attributionOf(w),
    createdAt: now,
    lastEditedBy: text ? attributionOf(w) : null,
    lastEditedAt: now,
  }
}

const equal = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)

/**
 * One key of a write: create (`isCreate`) or patch of an element of `type`; `value` null removes. Returns the
 * value to store.
 */
function checkKey(
  key: string,
  value: unknown,
  stored: Readonly<Record<string, unknown>>,
  isCreate: boolean,
  creatorUid: string | null,
  ctx: CustomDataContext,
  type: string,
): Verdict<unknown> {
  const spec = lobbyKeySpec(key)
  if (!spec) return bad('INVALID')
  // wave T: the planning keys (the kill switch first: nothing is written, the stored keys stay)
  if (isPlanningKey(key)) {
    if (ctx.planning === false) return bad('UNAVAILABLE')
    if (planningPending) return bad('INVALID')
  }
  // the value's schema first (a patch's `c` was checked at parse time, a create's was not): a malformed
  // `file` on an image create read `versionId` of a string and answered UNAVAILABLE, retryable and
  // outside the abuse count (V2)
  if (value !== null && lobbyValueProblem(key, value)) return bad('INVALID')
  const w = ctx.writer
  switch (spec.class) {
    case 'create-only': {
      if (value === null) {
        if (!(key in stored)) return { ok: true, value: null }
        const by = (stored[key] as { by?: string } | undefined)?.by ?? creatorUid
        return by === w.uid || w.role === 'owner' ? { ok: true, value: null } : bad('INVALID')
      }
      if (!isCreate) return equal(stored[key], value) ? { ok: true, value } : bad('INVALID')
      const by = (value as { by?: unknown }).by
      if (key !== 'kind' && by !== w.uid) return bad('INVALID')
      return { ok: true, value }
    }
    case 'identity-bound': {
      const uid = identityUidOf(key)
      if (isReactionKey(key)) {
        // wave N: a reaction goes on a sticky note only (a removal of one is never refused for the type)
        if (value !== null && type !== 'stickynote') return bad('INVALID')
        // the writer's own, added or removed; anyone's removed by an owner ("Clear reactions")
        const mine = uid !== null && uid === w.uid
        if (!mine && !(value === null && w.role === 'owner')) return bad('INVALID')
        // the kill switch: nothing is written, the stored keys stay
        if (ctx.reactions === false) return bad('UNAVAILABLE')
        // never VOTE_OPEN: a reaction is not a vote
        return { ok: true, value }
      }
      if (uid !== w.uid) return bad('INVALID')
      if (value === null) return { ok: true, value: null }
      if (key in stored) return { ok: true, value } // already there: not an addition
      if (ctx.voteOpen === null) return bad('UNAVAILABLE')
      if (ctx.voteOpen) return bad('VOTE_OPEN')
      return { ok: true, value }
    }
    case 'api-validated': {
      if (key === 'pdfPage') return { ok: true, value } // canonicalized from fileId (canonicalizeFile)
      if (value === null) return { ok: true, value: null }
      const v = value as FileValue
      const ans = ctx.fileRef(v.versionId)
      if (!ans) return bad('UNAVAILABLE')
      if (ans.status !== 'ok') return bad('INVALID')
      const ref = ans.ref
      return {
        ok: true,
        value: {
          assetId: ref.assetId,
          versionId: ref.versionId,
          kind: ref.kind,
          name: v.name,
          mimeType: ref.mimeType,
          sizeBytes: ref.sizeBytes,
        },
      }
    }
    default: {
      if (value === null) return { ok: true, value: null }
      const tag = tagKeyOf(key)
      if (tag !== null && !ctx.tagExists(tag)) return bad(ctx.tagDenied?.(tag) ?? 'INVALID')
      return { ok: true, value }
    }
  }
}

/**
 * Whether a patch of a LOCKED element may still write `key` (§2.4.3 step 5; CR-3F-2, CR-3b-4), by the
 * registry's `lockExempt` (canvas-schema custom-data.ts): the writer's own identity-bound key (`plusOne:<uid>`, a
 * +1 on a locked template note, and `react:<code>:<uid>`, a reaction on it, wave N; guests included), and
 * `present` on a frame from an account (a locked slide's order and skip mark). The key's class rules still apply
 * after this (checkPatchLobby: VOTE_OPEN, notes only, the kill switch). Another uid's key, an owner's "Clear
 * reactions" included, stays LOCKED.
 */
export function lockExemptKey(key: string, elementType: string, w: Writer): boolean {
  switch (lobbyKeySpec(key)?.lockExempt) {
    case 'own':
      return identityUidOf(key) === w.uid
    case 'frame-account':
      return elementType === 'frame' && !w.guest
    default:
      return false
  }
}

/** A create's `customData.lobby` of an element of `type`: every key checked as written at creation. */
export function checkCreateLobby(
  lobby: Readonly<Record<string, unknown>> | undefined,
  ctx: CustomDataContext,
  undeleteOf: Readonly<Record<string, unknown>> | null,
  type: string,
): Verdict<Record<string, unknown>> {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(lobby ?? {})) {
    // an undelete keeps the keys the tombstone already had, whoever wrote them
    if (undeleteOf && equal(undeleteOf[k], v)) {
      out[k] = v
      continue
    }
    const r = checkKey(k, v, {}, true, ctx.writer.uid, ctx, type)
    if (!r.ok) return r
    if (r.value !== null) out[k] = r.value
  }
  return { ok: true, value: out }
}

/** A patch's `c` on an element of `type`: each key by its class. Returns the keys to apply (null removes). */
export function checkPatchLobby(
  c: Readonly<Record<string, unknown>>,
  stored: Readonly<Record<string, unknown>>,
  creatorUid: string | null,
  ctx: CustomDataContext,
  type: string,
): Verdict<Record<string, unknown>> {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(c)) {
    const r = checkKey(k, v, stored, false, creatorUid, ctx, type)
    if (!r.ok) return r
    out[k] = r.value
  }
  return { ok: true, value: out }
}

/**
 * The api-validated keys of an image after a write: `file.versionId` must be the version of `fileId`,
 * and `pdfPage` is derived from `fileId`'s `.p<n>` (removed when there is none). Keys on other types are
 * INVALID. Returns the corrected lobby (or the verdict).
 */
export function canonicalizeFile(
  type: string,
  fileId: string | undefined,
  lobby: Readonly<Record<string, unknown>>,
): Verdict<Record<string, unknown>> {
  const out = { ...lobby }
  if (type !== 'image') {
    if ('file' in out || 'pdfPage' in out) return bad('INVALID')
    return { ok: true, value: out }
  }
  const page = fileId ? pdfPageOf(fileId) : null
  if (page === null) delete out.pdfPage
  else out.pdfPage = page
  const file = out.file as FileValue | undefined
  if (file && (!fileId || versionIdOf(fileId) !== file.versionId)) return bad('INVALID')
  return { ok: true, value: out }
}

/** Whether a `tag:<key>` may be written: its definition exists in lb_doc. */
export const tagDefKey = (tagKey: string) => `${TAG_DEF_KEY_PREFIX}${tagKey}`
