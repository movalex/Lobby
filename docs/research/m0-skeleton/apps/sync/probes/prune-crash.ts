// node probes/prune-crash.ts naive|flush  -> naive is expected to crash the process ~1 s after db.close()
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { draftroomSchema } from '@draftroom/canvas-schema'
import { NodeSqliteWrapper, SQLiteSyncStorage, TLSocketRoom } from '@tldraw/sync-core'
import type { TLRecord } from '@tldraw/tlschema'

const mode = process.argv[2] ?? 'naive'
const db = new DatabaseSync(join(mkdtempSync(join(tmpdir(), 'dr-prune-')), 'b.sqlite'))
const storage = new SQLiteSyncStorage<TLRecord>({ sql: new NodeSqliteWrapper(db) })
const room = new TLSocketRoom<TLRecord, void>({ schema: draftroomSchema, storage })
storage.transaction((txn) => {
  txn.delete('page:page')
})
room.close()
if (mode === 'flush') (storage as unknown as { pruneTombstones: { flush(): void } }).pruneTombstones.flush()
db.close()
setTimeout(() => {
  console.log(`${mode}: survived`)
  process.exit(0)
}, 1500)
