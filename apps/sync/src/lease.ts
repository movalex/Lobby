import { isDeepStrictEqual } from 'node:util'
import type { TLRecordAuthorizers, TLSocketRoom } from '@tldraw/sync-core'
import type { TLRecord, TLShape } from '@tldraw/tlschema'
import type { SessionMeta } from './rooms.ts'

const TEXT_LEASE_MS = 5_000
const textOf = (s: TLShape): unknown => ('richText' in s.props ? s.props.richText : undefined)

/** Implicit server-enforced text lease: first writer of a shape's richText holds it for 5 s (renewed per edit). */
export function createTextLease(getRoom: () => TLSocketRoom<TLRecord, SessionMeta>) {
  const leases = new Map<string, { userId: string; expiresAt: number }>()
  const authorizeRecord: TLRecordAuthorizers<TLRecord, SessionMeta> = {
    shape: (args) => {
      if (args.type === 'create') return args.next
      const now = Date.now()
      const lease = leases.get(args.prev.id)
      const heldByOther = !!lease && lease.userId !== args.session.meta.userId && lease.expiresAt > now
      if (args.type === 'delete') return heldByOther ? null : args.prev
      if (isDeepStrictEqual(textOf(args.prev), textOf(args.next))) return args.next
      if (heldByOther) {
        const sid = args.session.sessionId
        queueMicrotask(() =>
          getRoom().sendCustomMessage(sid, { type: 'text-lease-denied', shapeId: args.prev.id }),
        )
        return null // whole record op is vetoed -> client gets discard/rebase and reverts
      }
      leases.set(args.prev.id, { userId: args.session.meta.userId, expiresAt: now + TEXT_LEASE_MS })
      return args.next
    },
  }
  const releaseUser = (userId: string) => {
    for (const [id, l] of leases) if (l.userId === userId) leases.delete(id)
  }
  return { authorizeRecord, releaseUser }
}
