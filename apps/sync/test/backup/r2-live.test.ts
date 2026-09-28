// Offsite backups against the real R2 bucket. Opt-in, like packages/blob-store/test/r2-live.test.ts:
// runs only with DRAFTROOM_LIVE_R2=1 AND when the gitignored `.env.deploy.local` at the repo root holds
// CLOUDFLARE_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY and R2_BUCKET (a staging/test bucket),
// so a plain `pnpm test` never needs the network or writes to the bucket.
//
// Everything goes under a random `test/<run-id>/backups/sync` prefix (never the real backups/sync),
// every key written is recorded and deleted at the end, and each one is checked gone. Secrets are read
// here and passed only to the store; assertions on text that could contain them use booleans.
//
// NOT RUN by the session that wrote it (no credentials there): see docs/DEPLOY.md "Offsite backups".

import { randomBytes } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { parseEnv } from 'node:util'
import { type BlobStore, createR2BlobStore } from '@draftroom/blob-store'
import { draftroomSchema } from '@draftroom/canvas-schema'
import { afterAll, describe, expect, it } from 'vitest'
import { runRestoreDrill, storeBackupSource } from '../../src/backup/drill.ts'
import { OffsiteBackups } from '../../src/backup/offsite.ts'
import { type OffsiteManifest, offsiteKeys } from '../../src/backup/offsite-manifest.ts'
import { RoomRegistry } from '../../src/rooms.ts'
import { note, RoomClient } from '../deleted/fixtures.ts'
import { AST_A, fileCard, readJsonObject, tempData, VER_A } from './offsite-fixtures.ts'

interface LiveCreds {
  accountId: string
  accessKeyId: string
  secretAccessKey: string
  bucket: string
}

function loadLive(): { creds: LiveCreds } | { skip: string } {
  if (process.env.DRAFTROOM_LIVE_R2 !== '1') return { skip: 'opt-in: DRAFTROOM_LIVE_R2=1' }
  const file = fileURLToPath(new URL('../../../../.env.deploy.local', import.meta.url))
  if (!existsSync(file)) return { skip: 'no .env.deploy.local' }
  const env = parseEnv(readFileSync(file, 'utf8'))
  const creds = {
    accountId: env.CLOUDFLARE_ACCOUNT_ID ?? '',
    accessKeyId: env.R2_ACCESS_KEY_ID ?? '',
    secretAccessKey: env.R2_SECRET_ACCESS_KEY ?? '',
    bucket: env.R2_BUCKET ?? '',
  }
  if (!creds.accountId || !creds.accessKeyId || !creds.secretAccessKey || !creds.bucket)
    return { skip: '.env.deploy.local lacks the R2 keys' }
  if (!/staging|test/.test(creds.bucket)) return { skip: 'R2_BUCKET is not a staging/test bucket' }
  return { creds }
}

const live = loadLive()
const runId = `offsite-${Date.now().toString(36)}-${randomBytes(4).toString('hex')}`
const PREFIX = `test/${runId}/backups/sync`
const BOARD = 'live-offsite-board'

if ('skip' in live) {
  describe.skip(`live R2 offsite backups (skipped: ${live.skip})`, () => {
    it('needs .env.deploy.local with R2 credentials', () => {})
  })
} else {
  const { creds } = live
  const written = new Set<string>()
  const base = createR2BlobStore(creds)
  // Records every key this run writes, so all of them can be deleted and checked afterwards.
  const store: BlobStore = {
    kind: base.kind,
    put: (key, body, opts) => {
      if (!key.startsWith(`${PREFIX}/`)) throw new Error('refusing to write outside the run prefix')
      written.add(key)
      return base.put(key, body, opts)
    },
    get: (key, opts) => base.get(key, opts),
    head: (key) => base.head(key),
    delete: (key) => base.delete(key),
    presignGet: (key, opts) => base.presignGet(key, opts),
    presignPut: (key, opts) => base.presignPut(key, opts),
  }
  const data = tempData('dr-offsite-live-')
  const logs: string[] = []

  afterAll(async () => {
    for (const key of written) await base.delete(key)
    const left: string[] = []
    for (const key of written) if (await base.head(key)) left.push(key)
    data.cleanup()
    expect(left).toEqual([])
  }, 120_000)

  describe('live R2 offsite backups', () => {
    it('uploads a backup with its manifest and index, and the drill restores it from R2', async () => {
      const reg = new RoomRegistry({ dataDir: data.rooms, schema: draftroomSchema, idleEvictMs: 60_000 })
      const offsite = new OffsiteBackups({
        store,
        localRoot: data.backups,
        prefix: PREFIX,
        log: (...a) => logs.push(a.map(String).join(' ')),
      })
      offsite.start()
      try {
        const c = new RoomClient(reg.getOrCreate(BOARD), 'usr_a')
        await c.connect()
        await c.put(note('n1', 'live'), fileCard('f', AST_A, VER_A))
        const entry = await reg.backupNow(BOARD)
        if (!entry) throw new Error('no backup')
        await offsite.idle()
        expect(offsite.status().boards[0]).toMatchObject({ lastSuccessFile: entry.file, failures: 0 })
        const manifest = await readJsonObject<OffsiteManifest>(store, offsiteKeys.manifest(PREFIX, BOARD))
        expect(manifest?.backups.map((b) => [b.file, b.sha256, b.assets])).toEqual([
          [entry.file, entry.sha256, [{ assetId: AST_A, versionId: VER_A }]],
        ])
        const head = await store.head(offsiteKeys.file(PREFIX, BOARD, entry.file))
        expect(head).toEqual({ contentLength: entry.sizeBytes, contentType: 'application/vnd.sqlite3' })
        const report = await runRestoreDrill({ dataDir: data.root, source: storeBackupSource(store, PREFIX) })
        expect(report.boards.map((b) => [b.boardId, b.ok, b.live])).toEqual([[BOARD, true, 'identical']])
      } finally {
        await offsite.stop()
        reg.closeAll()
      }
      const printed = logs.join('\n')
      for (const secret of [creds.accessKeyId, creds.secretAccessKey, creds.accountId])
        expect(printed.includes(secret)).toBe(false)
      expect(written.size).toBeGreaterThanOrEqual(3) // object, manifest, index
    }, 180_000)
  })
}
