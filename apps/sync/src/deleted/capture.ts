// Composes the room's record authorizers with the "Recently deleted" capture.
//
// Order matters: the existing authorizer (the text lease) decides first; a delete is captured only
// when it was allowed. Read-only sessions never get here (the room's write gate skips their ops before
// any authorizer runs), and a vetoed delete is never recorded. Capturing is a Map.set: the authorizer
// runs synchronously inside the commit transaction and must do no I/O (sync-core 5.4.2
// TLRecordAuthorizer docs); the rows are written by DeletedStore.flush() from the transaction hook.

import type { TLRecordAuthorizers } from '@tldraw/sync-core'
import type { TLBinding, TLRecord, TLShape } from '@tldraw/tlschema'
import type { SessionMeta } from '../rooms.ts'
import type { DeletedBy } from './store.ts'

export interface DeleteSink {
  noteDeleted(record: TLRecord, by: DeletedBy): void
}

type Authorizers = TLRecordAuthorizers<TLRecord, SessionMeta>
type ShapeArgs = Parameters<NonNullable<Authorizers['shape']>>[0]
type BindingArgs = Parameters<NonNullable<Authorizers['binding']>>[0]

const by = (meta: SessionMeta): DeletedBy => ({ userId: meta.userId, name: meta.name })

export function withDeleteCapture(base: Authorizers, sink: DeleteSink): Authorizers {
  const baseShape = base.shape
  const baseBinding = base.binding
  return {
    ...base,
    shape: (args: ShapeArgs): TLShape | null => {
      const allowed = baseShape
        ? baseShape(args)
        : args.session.isReadonly
          ? null
          : args.type === 'delete'
            ? args.prev
            : args.next
      if (allowed && args.type === 'delete') sink.noteDeleted(args.prev, by(args.session.meta))
      return allowed
    },
    binding: (args: BindingArgs): TLBinding | null => {
      const allowed = baseBinding
        ? baseBinding(args)
        : args.session.isReadonly
          ? null
          : args.type === 'delete'
            ? args.prev
            : args.next
      if (allowed && args.type === 'delete') sink.noteDeleted(args.prev, by(args.session.meta))
      return allowed
    },
  }
}
