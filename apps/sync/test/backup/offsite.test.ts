// Offsite copies of the board backups (docs/WAVE3-CONTRACTS.md "offsite-backups"), against the fs
// driver: upload after each local backup, the manifest, the index, retention, failures and retries,
// restarts, and that nothing here can break a local backup or leak a credential.
import { createHash } from 'node:crypto'
import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { createFsBlobStore, createR2BlobStore } from '@draftroom/blob-store'
import { currentSchema } from '@draftroom/tldraw-import'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { backupBoard, onBackupCreated, readManifest } from '../../src/backup/backup.ts'
import { OffsiteBackups } from '../../src/backup/offsite.ts'
import {
  applyRetention,
  type OffsiteIndex,
  type OffsiteManifest,
  offsiteKeys,
} from '../../src/backup/offsite-manifest.ts'
import { backupSigningKey } from '../../src/backup/signing.ts'
import { boardDbPath } from '../../src/rooms.ts'
import { TEST_INTERNAL_SECRET } from '../harness/tickets.ts'
import { indexFor, note } from '../harness/tl-fixtures.ts'
import { tldrawBoard } from '../harness/tldraw-file.ts'
import { listFiles } from '../http/helpers.ts'
import {
  AST_A,
  AST_B,
  fileCard,
  flakyStore,
  imageAsset,
  readJsonObject,
  readObject,
  type TempData,
  tempData,
  VER_A,
  VER_B,
} from './offsite-fixtures.ts'

const BOARD = 'offsite-board'
const PREFIX = 'backups/sync'
let data: TempData
let services: OffsiteBackups[] = []
let logs: string[] = []
const log = (...a: unknown[]) => logs.push(a.map(String).join(' '))

/** A tldraw board of this data dir (as every board before the cut-over), edited and backed up by the test. */
const board = (boardId = BOARD) => tldrawBoard(data.rooms, boardId, data.backups)
function offsite(opts: Partial<ConstructorParameters<typeof OffsiteBackups>[0]> = {}) {
  const s = new OffsiteBackups({
    store: createFsBlobStore(data.blobs),
    localRoot: data.backups,
    signingKey: backupSigningKey(TEST_INTERNAL_SECRET),
    log,
    ...opts,
  })
  services.push(s)
  return s
}
const manifestOf = (store = createFsBlobStore(data.blobs), board = BOARD) =>
  readJsonObject<OffsiteManifest>(store, offsiteKeys.manifest(PREFIX, board))
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex')

beforeEach(() => {
  data = tempData()
  logs = []
})
afterEach(async () => {
  for (const s of services) await s.stop()
  services = []
  data.cleanup()
})

describe('upload after each local backup', () => {
  it('stores the file byte for byte, with a manifest entry and an index row', async () => {
    const a = board()
    await a.put(
      note('n1', 'hello'),
      fileCard('card', AST_A, VER_A),
      imageAsset('img', AST_B, VER_B),
      // the same version twice counts once
      fileCard('card2', AST_A, VER_A),
    )
    const s = offsite()
    s.start()
    await s.idle()
    const entry = await a.backupNow()
    if (!entry) throw new Error('no local backup')
    await s.idle()

    const store = createFsBlobStore(data.blobs)
    const key = `backups/sync/${BOARD}/${entry.file}`
    const stored = await readObject(store, key)
    const local = readFileSync(join(data.backups, BOARD, entry.file))
    expect(stored && sha(stored)).toBe(entry.sha256)
    expect(stored?.equals(local)).toBe(true)

    const manifest = await manifestOf(store)
    expect(manifest).toMatchObject({ format: 'draftroom-offsite-board-backups', version: 1, boardId: BOARD })
    expect(manifest?.backups).toHaveLength(1)
    expect(manifest?.backups[0]).toMatchObject({
      file: entry.file,
      key,
      createdAt: entry.createdAt,
      documentClock: entry.documentClock,
      recordCount: entry.recordCount,
      recordsSha256: entry.recordsSha256,
      sha256: entry.sha256,
      sizeBytes: local.byteLength,
      schema: currentSchema(),
      // the build plan's "asset versions": both kinds of file references, sorted and distinct
      assets: [
        { assetId: AST_A, versionId: VER_A },
        { assetId: AST_B, versionId: VER_B },
      ],
    })
    expect(Date.parse(manifest?.backups[0]?.uploadedAt ?? '')).toBeGreaterThanOrEqual(
      Date.parse(entry.createdAt),
    )
    // the local manifest records the same references
    expect(readManifest(data.backups, BOARD)?.backups.at(-1)?.assets).toEqual(manifest?.backups[0]?.assets)

    const index = await readJsonObject<OffsiteIndex>(store, offsiteKeys.index(PREFIX))
    expect(index?.boards).toEqual([
      {
        boardId: BOARD,
        latestFile: entry.file,
        latestCreatedAt: entry.createdAt,
        latestUploadedAt: manifest?.backups[0]?.uploadedAt,
        count: 1,
      },
    ])
    expect(s.status().boards).toEqual([
      expect.objectContaining({
        boardId: BOARD,
        lastSuccessFile: entry.file,
        lastSuccessClock: entry.documentClock,
        offsiteCount: 1,
        pending: 0,
        failures: 0,
        lastError: null,
      }),
    ])
    expect(logs.join('\n')).toContain(`board ${BOARD} ${entry.file} stored`)
  })

  it('catches up at start on local backups made while it was not running, without duplicates', async () => {
    const a = board()
    await a.put(note('n1', 'v1'))
    const first = await a.backupNow()
    await a.put(note('n2', 'v2', { index: indexFor(2) }))
    const second = await a.backupNow()
    const store = flakyStore(data.blobs)
    const s = offsite({ store })
    s.start()
    await s.idle()
    expect((await manifestOf())?.backups.map((b) => b.file)).toEqual([first?.file, second?.file])
    const uploads = store.puts.filter((k) => k.endsWith('.sqlite'))
    expect(uploads).toHaveLength(2)
    // a pass with nothing new sends no request at all
    const before = { puts: store.puts.length, gets: store.gets.length, deletes: store.deletes.length }
    await s.runPass()
    expect({ puts: store.puts.length, gets: store.gets.length, deletes: store.deletes.length }).toEqual(
      before,
    )
    // a restart reads the store's manifest instead of uploading again
    await s.stop()
    const again = offsite({ store })
    again.start()
    await again.idle()
    expect(store.puts.filter((k) => k.endsWith('.sqlite'))).toHaveLength(2)
    expect(again.status().boards[0]).toMatchObject({ lastSuccessFile: second?.file, offsiteCount: 2 })
  })

  it('does nothing for boards whose local backups are all offsite, and ignores other folders', async () => {
    const s = offsite()
    s.start()
    await s.idle()
    expect(s.status()).toMatchObject({ store: 'fs', prefix: PREFIX, running: true, boards: [] })
    expect(listFiles(data.blobs)).toEqual([])
  })
})

describe('failures never break the local backup and are retried', () => {
  it('a failed upload is counted, logged without detail beyond its code, and retried on the next pass', async () => {
    const a = board()
    await a.put(note('n1', 'keep me'))
    const store = flakyStore(data.blobs)
    let down = true
    store.failPut = () => down
    const s = offsite({ store })
    s.start()
    const entry = await a.backupNow()
    // the local backup is complete and listed regardless
    expect(entry).not.toBeNull()
    expect(readManifest(data.backups, BOARD)?.backups.map((b) => b.file)).toEqual([entry?.file])
    await s.idle()
    expect(s.status().boards[0]).toMatchObject({
      boardId: BOARD,
      lastSuccessAt: null,
      pending: 1,
      failures: 1,
      failuresTotal: 1,
      lastError: 'NETWORK ECONNRESET',
    })
    expect(s.status().failuresTotal).toBe(1)
    expect(logs.join('\n')).toContain(
      `[backup] offsite upload failed for board ${BOARD}: NETWORK ECONNRESET (retried on the next pass)`,
    )
    expect(await manifestOf()).toBeNull()

    // still down: the next backup's own upload fails too, and the room keeps working
    await a.put(note('n2', 'more', { index: indexFor(2) }))
    const second = await a.backupNow()
    await s.idle()
    expect(s.status().boards[0]).toMatchObject({ failures: 2, pending: 2 })

    down = false
    await s.runPass()
    expect((await manifestOf())?.backups.map((b) => b.file)).toEqual([entry?.file, second?.file])
    expect(s.status().boards[0]).toMatchObject({
      lastSuccessFile: second?.file,
      failures: 0,
      failuresTotal: 2,
      pending: 0,
    })
  })

  it('an object stored without its manifest is uploaded again and listed once', async () => {
    const a = board()
    await a.put(note('n1', 'x'))
    const store = flakyStore(data.blobs)
    let manifestDown = true
    store.failPut = (key) => manifestDown && key.endsWith('/manifest.json')
    const s = offsite({ store })
    s.start()
    const entry = await a.backupNow()
    await s.idle()
    expect(s.status().boards[0]?.failures).toBe(1)
    expect(await manifestOf()).toBeNull()
    manifestDown = false
    await s.runPass()
    expect((await manifestOf())?.backups.map((b) => b.file)).toEqual([entry?.file])
    expect(store.puts.filter((k) => k.endsWith(entry?.file ?? '?'))).toHaveLength(2)
  })

  it('a local file that does not match its manifest is never uploaded, and not retried', async () => {
    const a = board()
    await a.put(note('n1', 'x'))
    const store = flakyStore(data.blobs)
    store.failPut = () => true
    const s = offsite({ store })
    s.start()
    const entry = await a.backupNow()
    await s.idle()
    if (!entry) throw new Error('no backup')
    const file = join(data.backups, BOARD, entry.file)
    const bytes = readFileSync(file)
    bytes[bytes.length - 20] = (bytes[bytes.length - 20] ?? 0) ^ 0xff
    writeFileSync(file, bytes)
    store.failPut = () => false
    await s.runPass()
    expect(s.status().boards[0]?.lastError).toBe(
      `local backup ${entry.file} does not match its manifest (sha256); not uploaded`,
    )
    expect(await readObject(store, `backups/sync/${BOARD}/${entry.file}`)).toBeNull()
    expect(await manifestOf()).toBeNull()
    const puts = store.puts.length
    await s.runPass()
    expect(store.puts.length).toBe(puts)
  })

  it('a listener that throws cannot fail a local backup', async () => {
    const a = board()
    await a.put(note('n1', 'x'))
    const off = onBackupCreated(data.backups, () => {
      throw new Error('boom')
    })
    try {
      expect(await a.backupNow()).not.toBeNull()
    } finally {
      off()
    }
  })
})

describe('logs and status carry no credentials', () => {
  let server: Server
  afterEach(() => new Promise<void>((r) => server.close(() => r())))

  it('an R2 refusal shows as its status and S3 code only', async () => {
    const secretBody = 'SECRET-UPSTREAM-DETAIL'
    server = createServer((req, res) => {
      req.resume()
      req.on('end', () => {
        res.writeHead(403, { 'content-type': 'application/xml' })
        res.end(
          `<?xml version="1.0"?><Error><Code>AccessDenied</Code><Message>${secretBody}</Message></Error>`,
        )
      })
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
    const port = (server.address() as AddressInfo).port
    const creds = { accessKeyId: 'AKIAFAKEACCESSKEY01', secretAccessKey: 'fake/SECRET+access+key+0123456789' }
    const store = createR2BlobStore({
      accountId: '0123456789abcdef0123456789abcdef',
      bucket: 'draftroom-test',
      endpoint: `http://127.0.0.1:${port}`,
      retries: 0,
      timeoutMs: 5_000,
      ...creds,
    })
    const a = board()
    await a.put(note('n1', 'x'))
    const s = offsite({ store })
    s.start()
    await a.backupNow()
    await s.idle()
    const status = s.status()
    expect(status.store).toBe('r2')
    expect(status.boards[0]?.lastError).toBe('UPSTREAM HTTP 403 AccessDenied')
    const everything = `${logs.join('\n')}\n${JSON.stringify(status)}`
    for (const forbidden of [
      creds.accessKeyId,
      creds.secretAccessKey,
      secretBody,
      'X-Amz',
      `127.0.0.1:${port}`,
      'Authorization',
    ])
      expect(everything.includes(forbidden), forbidden).toBe(false)
  })
})

describe('offsite retention: the newest 12, plus one per day for 14 days', () => {
  const day = (d: number, h: number) => new Date(Date.UTC(2026, 8, d, h))

  it('keeps the newest 12 and the latest backup of each of the last 14 days (the rule)', () => {
    // 20 days, three backups a day at 09:00, 13:00 and 17:00; "now" is the last one
    const entries = []
    for (let d = 1; d <= 20; d++)
      for (const h of [9, 13, 17]) entries.push({ file: `d${d}h${h}`, createdAt: day(d, h).toISOString() })
    const { keep, drop } = applyRetention(entries, day(20, 17))
    const kept = keep.map((e) => e.file)
    // newest 12 = days 17-20, all three each
    for (let d = 17; d <= 20; d++) for (const h of [9, 13, 17]) expect(kept).toContain(`d${d}h${h}`)
    // days 7-16: only the day's latest; days 1-6: nothing
    for (let d = 7; d <= 16; d++) expect(kept.filter((f) => f.startsWith(`d${d}h`))).toEqual([`d${d}h17`])
    for (let d = 1; d <= 6; d++) expect(kept.some((f) => f.startsWith(`d${d}h`))).toBe(false)
    expect(keep).toHaveLength(22)
    expect(drop).toHaveLength(38)
    // a board that stopped changing long ago keeps its newest backups forever
    const old = entries.slice(0, 5)
    expect(applyRetention(old, day(30, 0)).keep).toHaveLength(5)
  })

  it('applies it to the store: dropped objects are deleted and the manifest lists exactly what is kept', async () => {
    const a = board()
    await a.put(note('n1', 'x'))
    let now = day(1, 9)
    const store = flakyStore(data.blobs)
    const s = offsite({ store, now: () => now })
    s.start()
    await s.idle()
    const db = new DatabaseSync(boardDbPath(data.rooms, BOARD))
    try {
      for (let d = 1; d <= 20; d++)
        for (const h of [9, 13, 17]) {
          now = day(d, h)
          // local keeps more than the store here, so the store's rule is what is tested
          await backupBoard({ db, boardId: BOARD, root: data.backups, keep: 100, now: () => now })
          await s.idle()
        }
    } finally {
      db.close()
    }
    const manifest = await manifestOf()
    const expected = applyRetention(readManifest(data.backups, BOARD)?.backups ?? [], now).keep.map(
      (e) => e.file,
    )
    expect(manifest?.backups.map((b) => b.file)).toEqual(expected)
    expect(manifest?.backups).toHaveLength(22)
    expect(manifest?.pendingDeletes).toEqual([])
    const objects = readdirSync(join(data.blobs, 'backups', 'sync', BOARD))
      .filter((f) => f.endsWith('.sqlite'))
      .sort()
    expect(objects).toEqual([...expected].sort())
    expect(s.status().boards[0]).toMatchObject({ offsiteCount: 22, failures: 0 })
  })

  it('a failed delete stays pending in the manifest and is retried', async () => {
    const a = board()
    await a.put(note('n1', 'x'))
    let now = day(1, 9)
    const store = flakyStore(data.blobs)
    let deletesDown = true
    store.failDelete = () => deletesDown
    const retention = { newest: 2, dailyDays: 0 }
    const s = offsite({ store, now: () => now, retention })
    s.start()
    await s.idle()
    const db = new DatabaseSync(boardDbPath(data.rooms, BOARD))
    const made: string[] = []
    try {
      for (const h of [1, 2, 3]) {
        now = day(1, h)
        made.push(
          (await backupBoard({ db, boardId: BOARD, root: data.backups, keep: 100, now: () => now })).file,
        )
        await s.idle()
      }
    } finally {
      db.close()
    }
    let manifest = await manifestOf()
    expect(manifest?.backups.map((b) => b.file)).toEqual(made.slice(1))
    expect(manifest?.pendingDeletes).toEqual([made[0]])
    expect(s.status().boards[0]?.lastError).toBe('retention: UPSTREAM HTTP 503')
    expect(await readObject(store, `backups/sync/${BOARD}/${made[0]}`)).not.toBeNull()
    deletesDown = false
    await s.runPass()
    manifest = await manifestOf()
    expect(manifest?.pendingDeletes).toEqual([])
    expect(await readObject(store, `backups/sync/${BOARD}/${made[0]}`)).toBeNull()
    expect(s.status().boards[0]?.failures).toBe(0)
  })
})

describe('the store cannot steer the uploader', () => {
  it('a manifest entry naming another key is ignored, never deleted or restored from', async () => {
    const store = createFsBlobStore(data.blobs)
    const victim = 'assets/ast_AAAAAAAAAAAAAAAAAAAA/ver_AAAAAAAAAAAAAAAAAAAA/original'
    await store.put(victim, Buffer.from('precious'), { contentType: 'application/pdf', contentLength: 8 })
    const bad = {
      format: 'draftroom-offsite-board-backups',
      version: 1,
      boardId: BOARD,
      updatedAt: new Date().toISOString(),
      backups: [
        {
          file: '2026-01-01T00-00-00-000Z-c1.sqlite',
          key: victim,
          createdAt: '2026-01-01T00:00:00.000Z',
          uploadedAt: '2026-01-01T00:00:00.000Z',
          documentClock: 1,
          schema: {},
          recordCount: 1,
          recordsSha256: '0'.repeat(64),
          sha256: '0'.repeat(64),
          sizeBytes: 1,
          assets: [],
        },
      ],
      pendingDeletes: ['../../assets/x', victim],
    }
    const json = Buffer.from(JSON.stringify(bad))
    await store.put(offsiteKeys.manifest(PREFIX, BOARD), json, {
      contentType: 'application/json',
      contentLength: json.byteLength,
    })
    const a = board()
    await a.put(note('n1', 'x'))
    const s = offsite({ retention: { newest: 1, dailyDays: 0 } })
    s.start()
    await a.backupNow()
    await s.idle()
    expect((await readObject(store, victim))?.toString()).toBe('precious')
    expect(logs.join('\n')).toContain('1 malformed entries ignored')
    expect((await manifestOf())?.backups).toHaveLength(1)
  })
})
