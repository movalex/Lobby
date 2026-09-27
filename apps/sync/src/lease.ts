import { isDeepStrictEqual } from 'node:util'
import type { TLRecordAuthorizers } from '@tldraw/sync-core'
import type { TLRecord, TLShape } from '@tldraw/tlschema'
import type { SessionMeta } from './rooms.ts'

/** Custom message sent to the one session whose write was vetoed (docs/M0-CONTRACTS.md §4). */
export interface TextLeaseDenied {
  type: 'text-lease-denied'
  shapeId: string
  holderUserId: string
  expiresInMs: number
}

export interface TextLeaseOptions {
  leaseMs: number
  /** Called after the push transaction, never inside it (the authorizer must do no I/O). */
  onDenied?: (sessionId: string, message: TextLeaseDenied) => void
  now?: () => number
}

export interface TextLease {
  authorizeRecord: TLRecordAuthorizers<TLRecord, SessionMeta>
  /** Drops every lease the user holds (call when the user has no sessions left in the room). */
  releaseUser(userId: string): void
  /** The live lease on a shape, if any. */
  holderOf(shapeId: string): { userId: string; expiresAt: number } | null
}

// Shapes without richText (images, file cards, ...) compare as undefined === undefined and never lease.
const textOf = (s: TLShape): unknown => ('richText' in s.props ? s.props.richText : undefined)

/**
 * Implicit server-enforced text lease, one instance per room: the first user whose push changes a
 * shape's richText holds it for `leaseMs`, renewed on each of their text changes. While another
 * user holds it, that user's text changes and deletes of the shape are vetoed (the whole record op:
 * a veto cannot keep non-text props from the same op). Moves and resizes that leave richText
 * untouched always pass. Keyed by user, not session, so a user's tabs share one lease.
 */
export function createTextLease(opts: TextLeaseOptions): TextLease {
  const now = opts.now ?? Date.now
  const leases = new Map<string, { userId: string; expiresAt: number }>()

  const live = (shapeId: string, at: number) => {
    const lease = leases.get(shapeId)
    if (!lease) return null
    if (lease.expiresAt <= at) {
      leases.delete(shapeId)
      return null
    }
    return lease
  }

  const deny = (
    sessionId: string,
    shapeId: string,
    lease: { userId: string; expiresAt: number },
    at: number,
  ) => {
    const message: TextLeaseDenied = {
      type: 'text-lease-denied',
      shapeId,
      holderUserId: lease.userId,
      expiresInMs: Math.max(0, lease.expiresAt - at),
    }
    // The authorizer runs inside the SQLite transaction: send only after it has finished.
    if (opts.onDenied) queueMicrotask(() => opts.onDenied?.(sessionId, message))
    return null
  }

  const authorizeRecord: TLRecordAuthorizers<TLRecord, SessionMeta> = {
    shape: (args) => {
      // The room's canWrite gate already skips read-only writes; fail closed if that ever changes.
      if (args.session.isReadonly) return null
      if (args.type === 'create') return args.next
      const userId = args.session.meta.userId
      const shapeId = args.prev.id
      const at = now()
      const lease = live(shapeId, at)
      const heldByOther = lease !== null && lease.userId !== userId

      if (args.type === 'delete') {
        if (heldByOther) return deny(args.session.sessionId, shapeId, lease, at)
        leases.delete(shapeId)
        return args.prev
      }
      if (isDeepStrictEqual(textOf(args.prev), textOf(args.next))) return args.next
      if (heldByOther) return deny(args.session.sessionId, shapeId, lease, at)
      leases.set(shapeId, { userId, expiresAt: at + opts.leaseMs })
      return args.next
    },
  }

  return {
    authorizeRecord,
    releaseUser(userId) {
      for (const [id, l] of leases) if (l.userId === userId) leases.delete(id)
    },
    holderOf(shapeId) {
      const lease = live(shapeId, now())
      return lease ? { ...lease } : null
    },
  }
}
