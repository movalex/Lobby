// Bridge release R0 (docs/EXCALIDRAW-MIGRATION.md §5.9 step 2, §5.6): during a rollback the offsite
// manifests also list backups the Excalidraw build wrote. An entry whose `format` R0 does not know used to
// be dropped as malformed, and R0's next upload rewrote the manifest without it: the object stayed in R2,
// unlisted, so neither the drill nor a restore could find it (verifier, manifest-format). R0 now keeps any
// well-formed format name listed, signed and under retention, and refuses to drill or restore one it does
// not know.
import { mkdirSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { createFsBlobStore } from '@draftroom/blob-store'
import type { TLRecord } from '@tldraw/tlschema'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { backupBoard } from '../../src/backup/backup.ts'
import { DrillProblem, storeBackupSource, verifyRestorable } from '../../src/backup/drill.ts'
import { OffsiteBackups } from '../../src/backup/offsite.ts'
import {
  type OffsiteEntry,
  type OffsiteManifest,
  offsiteKeys,
  parseManifest,
} from '../../src/backup/offsite-manifest.ts'
import { backupSigningKey, signDocument, signEntry } from '../../src/backup/signing.ts'
import { readJsonObject, type TempData, tempData } from '../backup/offsite-fixtures.ts'
import { note } from '../deleted/fixtures.ts'
import { TEST_INTERNAL_SECRET } from '../harness/tickets.ts'
import { seedTldrawBoard } from './support.ts'

const BOARD = 'b-format-01'
const PREFIX = 'backups/sync'
const KEY = backupSigningKey(TEST_INTERNAL_SECRET)
const NEWER_FILE = '2026-10-01T10-00-00-000Z-c9.sqlite'

/** A signed entry; `format` absent = a tldraw backup, else a format R0 may not know. */
function signedEntry(file: string, format?: string): OffsiteEntry {
  const facts = {
    file,
    key: offsiteKeys.file(PREFIX, BOARD, file),
    createdAt: `${file.slice(0, 10)}T10:00:00.000Z`,
    uploadedAt: '2026-10-01T10:00:01.000Z',
    documentClock: 9,
    schema: { format },
    recordCount: 3,
    recordsSha256: 'c'.repeat(64),
    sha256: 'd'.repeat(64),
    sizeBytes: 4,
    assets: [],
    ...(format ? { format } : {}),
  }
  return { ...facts, signature: signEntry(KEY, BOARD, facts) }
}
/** An entry as a newer build could list it: well formed, signed, in a format R0 does not know. */
const newerEntry = (format: string) => signedEntry(NEWER_FILE, format)

describe('parseManifest keeps entries in a format this build does not know', () => {
  it('lists them (signature checked like any other) and still drops a malformed format value', () => {
    const tldraw = signedEntry('2026-09-30T10-00-00-000Z-c1.sqlite')
    const raw = signDocument(KEY, 'manifest', {
      format: 'draftroom-offsite-board-backups',
      version: 1,
      boardId: BOARD,
      updatedAt: '2026-10-01T10:00:01.000Z',
      backups: [tldraw, newerEntry('lobby-elements-v2')],
      pendingDeletes: [],
    })
    const parsed = parseManifest(raw, PREFIX, BOARD, KEY)
    expect(parsed.ignored).toBe(0)
    expect(parsed.manifest.backups.map((b) => b.format ?? null)).toEqual([null, 'lobby-elements-v2'])
    expect(parsed.entrySignatures.get(NEWER_FILE)?.status).toBe('valid')

    const bad = { ...raw, backups: [tldraw, { ...newerEntry('x'), format: 'Not A Format!' }] }
    expect(parseManifest(bad, PREFIX, BOARD, KEY).ignored).toBe(1)
  })
})

describe('R0 keeps a newer build entry through its own uploads', () => {
  let data: TempData
  beforeEach(() => {
    data = tempData('dr-r0-format-')
    mkdirSync(data.rooms, { recursive: true })
  })
  afterEach(() => data.cleanup())

  it('the manifest still lists it after R0 uploads a new backup; the drill refuses to restore it', async () => {
    const store = createFsBlobStore(data.blobs)
    const entry = newerEntry('lobby-elements-v2')
    await store.put(entry.key, Buffer.from('lbv2'), {
      contentType: 'application/vnd.sqlite3',
      contentLength: 4,
    })
    const manifest: OffsiteManifest = {
      format: 'draftroom-offsite-board-backups',
      version: 1,
      boardId: BOARD,
      updatedAt: entry.uploadedAt,
      backups: [entry],
      pendingDeletes: [],
    }
    const json = JSON.stringify(signDocument(KEY, 'manifest', manifest))
    await store.put(offsiteKeys.manifest(PREFIX, BOARD), Buffer.from(json), {
      contentType: 'application/json',
      contentLength: Buffer.byteLength(json),
    })

    // a rollback: R0 backs the board up and uploads it
    const live = seedTldrawBoard(data.rooms, BOARD, [note('n1', 'x') as TLRecord])
    const now = new Date('2026-10-02T09:00:00.000Z')
    const db = new DatabaseSync(live)
    let made: Awaited<ReturnType<typeof backupBoard>>
    try {
      made = await backupBoard({ db, boardId: BOARD, root: data.backups, now: () => now })
    } finally {
      db.close()
    }
    const offsite = new OffsiteBackups({
      store,
      localRoot: data.backups,
      signingKey: KEY,
      now: () => now,
    })
    try {
      await offsite.syncBoard(BOARD)
    } finally {
      await offsite.stop()
    }
    const after = await readJsonObject<OffsiteManifest>(store, offsiteKeys.manifest(PREFIX, BOARD))
    expect(after?.backups.map((b) => b.file)).toEqual([NEWER_FILE, made.file])
    expect(after?.backups[0]).toEqual(entry) // carried forward as it was, signature included
    expect(await store.head(entry.key)).not.toBeNull()

    // the restore tools find it, and refuse it by name
    const source = storeBackupSource(store, { signingKey: KEY })
    const listed = await source.entry(BOARD, NEWER_FILE)
    expect(listed.format).toBe('lobby-elements-v2')
    const err = await verifyRestorable({
      boardId: BOARD,
      entry: listed,
      path: live,
      workRooms: data.root,
    }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(DrillProblem)
    expect(String((err as Error).message)).toContain('"lobby-elements-v2", written by a newer build')
  })
})
