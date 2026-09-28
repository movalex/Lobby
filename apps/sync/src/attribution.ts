// A note's "last edited by" bound to the session that wrote its text (reviewer finding SEAM-01).
//
// tldraw 5.4.2 keeps it in `props.textLastEditedBy` of note shapes: a plain user id (in Lobby the
// ticket's uid), or null. The note renders Editor.getAttributionDisplayName(id), which is the user
// record's name (pinned to the ticket by user-records.ts, G-R8). The client stamps the prop itself:
//   - NoteShapeUtil.onBeforeUpdate, when an Editor.updateShapes call changes richText: the current
//     user's id (getAttributionUserId, the ticket uid), or null when the text becomes empty;
//   - NoteShapeUtil.onBeforeDuplicate, for duplicate and paste (putContentOntoCurrentPage): the
//     current user's id on a note with text (an empty note keeps whatever it had).
// Nothing re-stamps it without a user action, and nothing on the server checked it, so any editor (a
// name-only guest on a workshop link included) could put "Alice" under words Alice never wrote, or on
// a revealed private note, anonymous ones included.
//
// The rule (client pushes only; server writes such as the private-notes placement, "Recently
// deleted" restores, template seeds and backup restores never reach an authorizer):
//
// Update (a `shape` whose new version has the prop). Allowed when
//   1. neither the text nor the attribution changes (moves, colour, size: nearly every write), or
//   2. the text changes and the attribution becomes the session's own id (typing), or
//   3. the attribution becomes null on an empty note (clearing it), or
//   4. the new (text, attribution) pair is one this note had until THIS user's own write replaced it
//      (their undo; Lobby's per-property undo, apps/web/src/sync-quality/perPropUndo.ts, patches back
//      exactly the text and attribution their edit changed). The ledger below remembers those pairs.
//   Anything else is skipped (null), like any vetoed write: sync-core's rebase puts the writer's tab
//   back in step and it stays connected. sync-core uses only allow/veto on updates, so the whole op
//   goes, a move or colour change in it included.
// Create. Kept as sent when the attribution is null, the session's own id, or a pair the ledger (or
// "Recently deleted") shows this user deleted from this very note (undo of their delete or cut, or a
// move to another page sent as two pushes). Otherwise the note is stored with no attribution: never
// dropped (a lost undo-of-delete would lose content), never attributed to anyone the server cannot
// vouch for. sync-core stores the authorizer's record on create and rebases the writer onto it.
//
// Why no terminal close: legitimate clients can send each refused shape (an undo the server can no
// longer vouch for after a restart, a pasted empty note that still names someone), and none of them
// re-sends it on its own, so a quiet skip or rewrite cannot loop the way tldraw's user-record re-put
// does (~14 pushes/s, user-records.ts): the protocol tests check that the writer goes quiet.
//
// Residual risk (documented in the tests):
//   - "Last edited by" means that: whoever changes the text is named, even for a one-letter change,
//     and the author of an anonymous revealed note who edits it is then named as its last editor.
//   - The ledger is memory, per open room, bounded (ATTRIBUTION_LIMITS): after a restart, an eviction
//     or a very long edit history, undo of an edit to someone else's note is skipped (the tab snaps
//     back with "The board did not accept your last change"). Undo of one's own delete still works
//     through "Recently deleted" while it keeps the row; past that, the note comes back anonymous.
//   - Text retyped offline against a note someone else retyped meanwhile carries their attribution
//     unchanged on the wire, so it is skipped rather than shown under their name.
//   - A forged client can still create a note under no name at all (legitimate clients create
//     unattributed notes too: templates, bulk paste, empty notes) or empty one; it can never name
//     anyone else, and it cannot retype a note without being named.
//   - `meta.drPrivateNote.author` on revealed notes is client-writable like all meta; nothing
//     displays or trusts it.
//   - Attribution that was already forged in storage before this rule stays until the text changes.

import { createHash } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import type { TLRecordAuthorizers } from '@tldraw/sync-core'
import type { TLRecord, TLShape } from '@tldraw/tlschema'
import type { SessionMeta } from './rooms.ts'

/** The attribution prop of tldraw 5.4.2 notes (the only shape that has one). */
export const ATTRIBUTION_PROP = 'textLastEditedBy'

export interface AttributionLimits {
  /** Most replaced (text, attribution) pairs remembered per note; the oldest go first. */
  perShape: number
  /** Most pairs remembered per room; the notes least recently written go first. */
  entries: number
}

export const ATTRIBUTION_LIMITS: Readonly<AttributionLimits> = Object.freeze({
  perShape: 24,
  entries: 50_000,
})

type Props = Record<string, unknown>
const propsOf = (shape: TLShape): Props => shape.props as Props

/** undefined: the shape has no attribution prop at all; null: attributed to nobody. */
export function attributionOf(shape: TLShape): string | null | undefined {
  const props = propsOf(shape)
  if (!Object.hasOwn(props, ATTRIBUTION_PROP)) return undefined
  const value = props[ATTRIBUTION_PROP]
  return typeof value === 'string' ? value : null
}

const textOf = (shape: TLShape): unknown => propsOf(shape).richText

/** tldraw's isEmptyRichText (tldraw 5.4.2 utils/text/richText.ts): no paragraph, or one with no content. */
export function isEmptyText(shape: TLShape): boolean {
  const doc = textOf(shape) as { content?: unknown } | undefined
  if (!doc || typeof doc !== 'object' || !Array.isArray(doc.content)) return true
  if (doc.content.length === 0) return true
  if (doc.content.length === 1) {
    const node = doc.content[0] as { content?: unknown } | null
    const inner = node && typeof node === 'object' ? node.content : undefined
    if (!Array.isArray(inner) || inner.length === 0) return true
  }
  return false
}

/** JSON with object keys sorted: equal texts give equal keys whatever order a patch left keys in. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>
    const keys = Object.keys(obj)
      .filter((k) => obj[k] !== undefined)
      .sort()
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical(obj[k])}`).join(',')}}`
  }
  return JSON.stringify(value) ?? 'null'
}

const textKey = (shape: TLShape): string =>
  createHash('sha256')
    .update(canonical(textOf(shape)))
    .digest('base64url')
    .slice(0, 22)

/** What the rule decides for one write (exported for the unit tests). */
export type AttributionVerdict =
  /** text and attribution as they were */
  | 'unchanged'
  /** new text, stamped with the writer's own id */
  | 'own-edit'
  /** the text is now empty and so is the attribution */
  | 'cleared'
  /** a create attributed to nobody or to the writer */
  | 'own-create'
  /** a pair this note had until the writer's own write replaced it (their undo) */
  | 'vouched'
  /** none of the above: skipped (update) or stored anonymous (create) */
  | 'forged'

export function updateVerdict(
  prev: TLShape,
  next: TLShape,
  self: string,
  vouched: () => boolean,
): AttributionVerdict {
  const nextBy = attributionOf(next)
  if (nextBy === undefined) return 'unchanged' // not an attributed shape (any more)
  const prevBy = attributionOf(prev) ?? null // a shape that turned into a note had nobody
  const textChanged = !isDeepStrictEqual(textOf(prev), textOf(next))
  if (!textChanged && prevBy === nextBy) return 'unchanged'
  if (textChanged && nextBy === self) return 'own-edit'
  if (nextBy === null && isEmptyText(next)) return 'cleared'
  return vouched() ? 'vouched' : 'forged'
}

export function createVerdict(next: TLShape, self: string, vouched: () => boolean): AttributionVerdict {
  const nextBy = attributionOf(next)
  if (nextBy === undefined || nextBy === null || nextBy === self) return 'own-create'
  return vouched() ? 'vouched' : 'forged'
}

/** `shape` with no attribution (what a forged create is stored as). */
export function anonymized<T extends TLShape>(shape: T): T {
  return { ...shape, props: { ...shape.props, [ATTRIBUTION_PROP]: null } }
}

/**
 * Per room: the (text, attribution) pairs each note had until a user's own write replaced or deleted
 * them, keyed by that user. Memory only (the authorizer runs inside the push transaction), bounded.
 */
export class AttributionLedger {
  private readonly limits: AttributionLimits
  /** shape id -> entries (JSON [replacedBy, attribution, textKey]), oldest first; Map order = LRU. */
  private readonly byShape = new Map<string, string[]>()
  private total = 0

  constructor(limits: Partial<AttributionLimits> = {}) {
    this.limits = { ...ATTRIBUTION_LIMITS, ...limits }
  }

  get size(): number {
    return this.total
  }

  private static entry(user: string, shape: TLShape): string | null {
    const by = attributionOf(shape)
    if (by === undefined) return null
    return JSON.stringify([user, by, textKey(shape)])
  }

  /** `user`'s write replaced (or deleted) `stored`, the note as it was in storage. */
  replaced(stored: TLShape, user: string): void {
    const entry = AttributionLedger.entry(user, stored)
    if (!entry) return
    const id = stored.id
    const list = this.byShape.get(id) ?? []
    const at = list.indexOf(entry)
    if (at !== -1) list.splice(at, 1)
    else this.total++
    list.push(entry)
    while (list.length > this.limits.perShape) {
      list.shift()
      this.total--
    }
    this.byShape.delete(id) // re-insert: most recently written last
    this.byShape.set(id, list)
    while (this.total > this.limits.entries) {
      const oldest = this.byShape.keys().next()
      if (oldest.done) break
      this.total -= this.byShape.get(oldest.value)?.length ?? 0
      this.byShape.delete(oldest.value)
    }
  }

  /** Did `user`'s own write replace exactly this (text, attribution) of this note? */
  vouches(candidate: TLShape, user: string): boolean {
    const list = this.byShape.get(candidate.id)
    if (!list) return false
    const entry = AttributionLedger.entry(user, candidate)
    return entry !== null && list.includes(entry)
  }
}

/** Is `candidate` exactly what `user` deleted from this note, as "Recently deleted" kept it? */
export function sameAsDeleted(
  candidate: TLShape,
  user: string,
  row: { state: string; deletedBy: string } | null,
): boolean {
  if (!row || row.deletedBy !== user) return false
  let deleted: TLShape
  try {
    deleted = JSON.parse(row.state) as TLShape
  } catch {
    return false
  }
  if (!deleted || typeof deleted !== 'object' || deleted.id !== candidate.id || !deleted.props) return false
  return (
    attributionOf(deleted) === attributionOf(candidate) &&
    isDeepStrictEqual(textOf(deleted), textOf(candidate))
  )
}

export interface NoteAttributionOptions {
  ledger: AttributionLedger
  /** The newest "Recently deleted" row of a shape id, if any (a synchronous read of the board db). */
  deletedRow?: (shapeId: string) => { state: string; deletedBy: string } | null
  /** A forged create was stored anonymous, or a forged update skipped (ids only, never content). */
  onForged?: (kind: 'create' | 'update', shapeId: string, sessionId: string) => void
}

type Authorizers = TLRecordAuthorizers<TLRecord, SessionMeta>
type ShapeArgs = Parameters<NonNullable<Authorizers['shape']>>[0]

/**
 * Wraps the room's `shape` authorizer (the text lease) with the attribution rule, which decides
 * first: a forged update never takes a lease, and a create reaches the lease already rewritten.
 */
export function withNoteAttribution(base: Authorizers, opts: NoteAttributionOptions): Authorizers {
  const baseShape = base.shape
  const { ledger } = opts
  const inner = (args: ShapeArgs): TLShape | null =>
    baseShape
      ? baseShape(args)
      : args.session.isReadonly
        ? null
        : args.type === 'delete'
          ? args.prev
          : args.next
  return {
    ...base,
    shape: (args: ShapeArgs): TLShape | null => {
      // The room's canWrite gate already skips read-only writes; fail closed if that ever changes.
      if (args.session.isReadonly) return null
      const { userId } = args.session.meta
      if (args.type === 'delete') {
        const allowed = inner(args)
        if (allowed) ledger.replaced(args.prev, userId)
        return allowed
      }
      if (args.type === 'create') {
        const verdict = createVerdict(args.next, userId, () => {
          if (ledger.vouches(args.next, userId)) return true
          return sameAsDeleted(args.next, userId, opts.deletedRow?.(args.next.id) ?? null)
        })
        let next = args.next
        if (verdict === 'forged') {
          next = anonymized(args.next)
          opts.onForged?.('create', args.next.id, args.session.sessionId)
        }
        return inner({ ...args, next })
      }
      const verdict = updateVerdict(args.prev, args.next, userId, () => ledger.vouches(args.next, userId))
      if (verdict === 'forged') {
        opts.onForged?.('update', args.next.id, args.session.sessionId)
        return null
      }
      const allowed = inner(args)
      if (allowed && verdict !== 'unchanged') ledger.replaced(args.prev, userId)
      return allowed
    },
  }
}
