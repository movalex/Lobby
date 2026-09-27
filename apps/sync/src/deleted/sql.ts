// The board database wrapper handed to SQLiteSyncStorage, with one addition: a hook that runs INSIDE
// every storage transaction, after the transaction's own work and before COMMIT.
//
// Why: a client push is ONE storage transaction (TLSyncRoom.handlePush -> storage.transaction ->
// sql.transaction = BEGIN … COMMIT on this connection). The record authorizer sees each delete inside
// that transaction but not the end of the push, and a later op in the same push can still throw
// (INVALID_RECORD), which rolls everything back. Writing the "Recently deleted" rows from this hook,
// on the same connection, gives them exactly the push's fate: committed together or rolled back
// together, and the authorizer itself never touches the database.

import type {
  TLSqliteInputValue,
  TLSqliteRow,
  TLSyncSqliteStatement,
  TLSyncSqliteWrapper,
} from '@tldraw/sync-core'

export interface TransactionHooks {
  /** Inside the transaction, after the callback returned; must not throw (errors are its own to handle). */
  beforeCommit(): void
  /** After the transaction ended, committed or rolled back. */
  afterTransaction(): void
}

export function hookedSqlWrapper(inner: TLSyncSqliteWrapper, hooks: TransactionHooks): TLSyncSqliteWrapper {
  return {
    config: inner.config,
    // biome-ignore lint/suspicious/noConfusingVoidType: mirrors TLSyncSqliteWrapper.prepare in sync-core 5.4.2
    prepare<TResult extends TLSqliteRow | void = void, TParams extends TLSqliteInputValue[] = []>(
      sql: string,
    ): TLSyncSqliteStatement<TResult, TParams> {
      return inner.prepare<TResult, TParams>(sql)
    },
    exec(sql: string) {
      inner.exec(sql)
    },
    transaction<T>(callback: () => T): T {
      try {
        return inner.transaction(() => {
          const result = callback()
          hooks.beforeCommit()
          return result
        })
      } finally {
        hooks.afterTransaction()
      }
    },
  }
}
