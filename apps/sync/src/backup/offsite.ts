// Offsite copies of the board backups (docs/WAVE3-CONTRACTS.md "offsite-backups"). The local backups
// (backup.ts, driven by the room registry) stay the source: after each one, and on a timer, this
// service makes the store hold every local backup it is missing, then applies the offsite retention.
//
// - Streamed: each file is read from disk and uploaded chunk by chunk, hashed on the way; never held
//   in memory whole (the sync instance has 512 MB, boards can be large).
// - Checked: the bytes sent must hash to the local manifest's sha256, or the object is deleted again.
// - Independent: nothing here can fail or delay a local backup. A failed upload is counted, logged
//   without credentials (describeFailure) and retried on the next pass or the board's next backup.
// - Small: per board, only file names and the newest entry stay in memory; a board's manifest is
//   read from the store when something has to change, so a pass over unchanged boards costs no request.
// - One writer: exactly one sync server per data dir (one room owner per board) owns the manifests
//   under its prefix. The restore tools only read.
// - Signed (signing.ts): every entry it lists, every manifest and the index it writes. What it reads
//   back is checked too: an entry whose own signature does not match is dropped (and its backup
//   uploaded again if it is still on the local disk); entries without a signature (listed before
//   signing existed) or signed under another key (a rotated DRAFTROOM_INTERNAL_SECRET) are carried
//   forward as they are, never re-signed, so the restore tools keep treating them as unverified. A
//   manifest or index not signed by the current key is signed again once.

import { createHash, type Hash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import type { BlobStore } from '@draftroom/blob-store'
import { cleanAssetRefs } from './asset-refs.ts'
import {
  BACKUP_DEFAULTS,
  type BackupEntry,
  backedUpBoards,
  boardBackupDir,
  inspectBoardDb,
  onBackupCreated,
  readManifest,
} from './backup.ts'
import {
  applyRetention,
  emptyIndex,
  emptyManifest,
  MAX_MANIFEST_BYTES,
  OFFSITE_RETENTION,
  type OffsiteEntry,
  type OffsiteIndex,
  type OffsiteManifest,
  offsiteKeys,
  parseIndex,
  parseManifest,
  sortOldestFirst,
} from './offsite-manifest.ts'
import { type BackupSigningKey, type SignatureStatus, signDocument, signEntry } from './signing.ts'
import { describeFailure, getJson, OFFSITE_PREFIX, OffsiteError, putJson } from './store.ts'

export interface OffsiteOptions {
  store: BlobStore
  /** The local backups root (${DATA}/backups) whose boards are copied. */
  localRoot: string
  /** Signs every entry, manifest and index written (backupSigningKey(DRAFTROOM_INTERNAL_SECRET)). */
  signingKey: BackupSigningKey
  /** Key prefix without a trailing slash. Default `backups/sync`. */
  prefix?: string
  /** Retry pass over every board. Default: the backup interval (15 minutes). */
  intervalMs?: number
  retention?: { newest: number; dailyDays: number }
  now?: () => Date
  log?: (...a: unknown[]) => void
}

export interface OffsiteBoardStatus {
  boardId: string
  /** The last upload that completed (from the store's manifest after a restart). */
  lastSuccessAt: string | null
  lastSuccessFile: string | null
  lastSuccessClock: number | null
  /** Backups of this board in the store (null until its manifest was read). */
  offsiteCount: number | null
  /** Local backups not in the store yet, as of the last attempt. */
  pending: number
  /** Failed attempts since the last one that went through. */
  failures: number
  /** Failed attempts since this server started. */
  failuresTotal: number
  lastFailureAt: string | null
  /** A short description without credentials, e.g. "NETWORK ECONNRESET" or "UPSTREAM HTTP 403 AccessDenied". */
  lastError: string | null
}

export interface OffsiteStatus {
  store: 'off' | 'fs' | 'r2'
  prefix: string | null
  running: boolean
  lastPassAt: string | null
  /** Failed attempts since this server started, over every board. */
  failuresTotal: number
  boards: OffsiteBoardStatus[]
}

/** What GET /internal/backups/status shows when offsite backups are off. */
export const offsiteOffStatus = (): OffsiteStatus => ({
  store: 'off',
  prefix: null,
  running: false,
  lastPassAt: null,
  failuresTotal: 0,
  boards: [],
})

/** What is remembered of a board's offsite manifest between passes. */
interface Known {
  /** Every backup file the store holds for the board. */
  files: Set<string>
  pendingDeletes: number
  newest: { file: string; createdAt: string; uploadedAt: string } | null
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms).unref?.())

/** Why a manifest or the index read from the store is signed again (nothing when it verified). */
const RESIGN_REASON: Record<Exclude<SignatureStatus, 'valid'>, (what: string) => string> = {
  missing: (what) => `${what} is not signed (written before backups were signed); signing it`,
  'unknown-key': (what) =>
    `${what} is signed with another key (DRAFTROOM_INTERNAL_SECRET changed?); signing it with the current key`,
  invalid: (what) => `${what} does not match its signature (changed outside this server?); signing it again`,
}
const MANIFEST_RESIGN_DETAIL: Record<Exclude<SignatureStatus, 'valid'>, string> = {
  missing: ', its older entries stay unsigned',
  'unknown-key': ', its older entries stay as they are',
  invalid: ' without the entries that fail their own check',
}

async function* hashing(source: AsyncIterable<Buffer | string>, hash: Hash): AsyncGenerator<Buffer> {
  for await (const chunk of source) {
    const b = typeof chunk === 'string' ? Buffer.from(chunk) : chunk
    hash.update(b)
    yield b
  }
}

export class OffsiteBackups {
  private readonly store: BlobStore
  private readonly localRoot: string
  private readonly signingKey: BackupSigningKey
  private readonly prefix: string
  private readonly intervalMs: number
  private readonly retention: { newest: number; dailyDays: number }
  private readonly now: () => Date
  private readonly log: (...a: unknown[]) => void
  private readonly known = new Map<string, Known>()
  private readonly boards = new Map<string, OffsiteBoardStatus>()
  /** Local backup files that did not match their own manifest: never uploaded, not retried. */
  private readonly badLocal = new Set<string>()
  private readonly queue = new Set<string>()
  private index: OffsiteIndex | null = null
  /** The index read from the store is not signed by the current key: write it on the next update. */
  private indexNeedsSigning = false
  /** Boards whose manifest in the store is not signed by the current key (or listed bad entries). */
  private readonly unsignedInStore = new Set<string>()
  private draining: Promise<void> | null = null
  private timer: ReturnType<typeof setInterval> | null = null
  private unsubscribe: (() => void) | null = null
  private running = false
  private stopped = false
  private lastPassAt: string | null = null
  private failuresTotal = 0

  constructor(opts: OffsiteOptions) {
    this.store = opts.store
    this.localRoot = opts.localRoot
    this.signingKey = opts.signingKey
    this.prefix = opts.prefix ?? OFFSITE_PREFIX
    this.intervalMs = opts.intervalMs ?? BACKUP_DEFAULTS.intervalMs
    this.retention = opts.retention ?? OFFSITE_RETENTION
    this.now = opts.now ?? (() => new Date())
    this.log = opts.log ?? (() => {})
  }

  /** Follows new local backups, retries on a timer, and catches up on what a restart left behind. */
  start(): void {
    if (this.running || this.stopped) return
    this.running = true
    this.unsubscribe = onBackupCreated(this.localRoot, (boardId) => {
      void this.enqueue([boardId])
    })
    this.timer = setInterval(() => void this.runPass(), this.intervalMs)
    this.timer.unref?.()
    void this.runPass()
  }

  /**
   * Stops following backups and the timer, and waits up to `waitMs` for an upload in progress. One
   * cut short leaves nothing behind: a PUT is atomic and the manifest is written after it.
   */
  async stop(waitMs = 2_000): Promise<void> {
    this.stopped = true
    this.running = false
    this.unsubscribe?.()
    this.unsubscribe = null
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    this.queue.clear()
    if (this.draining) await Promise.race([this.draining, sleep(waitMs)])
  }

  /** Every board with local backups, one at a time. Resolves when the queue is empty. */
  runPass(): Promise<void> {
    let boards: string[] = []
    try {
      boards = backedUpBoards(this.localRoot)
    } catch (e) {
      this.log(`[backup] offsite: cannot list local backups: ${describeFailure(e)}`)
    }
    this.lastPassAt = this.now().toISOString()
    return this.enqueue(boards)
  }

  /** Copies what one board is missing. Resolves when the queue is empty. */
  syncBoard(boardId: string): Promise<void> {
    return this.enqueue([boardId])
  }

  /**
   * The object key of backup `file` of `boardId` when the store holds it, as of the last manifest this
   * service read or wrote (after syncBoard() resolved: whether that copy made it). Null otherwise.
   */
  storedKey(boardId: string, file: string): string | null {
    return this.known.get(boardId)?.files.has(file) ? offsiteKeys.file(this.prefix, boardId, file) : null
  }

  /** Resolves once nothing is queued or uploading. */
  async idle(): Promise<void> {
    while (this.draining) await this.draining
  }

  status(): OffsiteStatus {
    return {
      store: this.store.kind,
      prefix: this.prefix,
      running: this.running,
      lastPassAt: this.lastPassAt,
      failuresTotal: this.failuresTotal,
      boards: [...this.boards.values()]
        .map((b) => ({ ...b }))
        .sort((a, b) => a.boardId.localeCompare(b.boardId)),
    }
  }

  private enqueue(boardIds: string[]): Promise<void> {
    if (this.stopped) return Promise.resolve()
    for (const b of boardIds) this.queue.add(b)
    if (!this.draining && this.queue.size > 0) {
      const run = this.drainQueue()
      this.draining = run
      // Registered before anyone can await `run`, so idle() sees `draining` cleared once it settles.
      void run.finally(() => {
        if (this.draining === run) this.draining = null
      })
    }
    return this.draining ?? Promise.resolve()
  }

  private async drainQueue(): Promise<void> {
    await null // never settle synchronously: enqueue() assigns `draining` first
    while (this.queue.size > 0 && !this.stopped) {
      const [next] = this.queue
      if (next === undefined) break
      this.queue.delete(next)
      await this.syncOne(next) // never throws
    }
  }

  private statusOf(boardId: string): OffsiteBoardStatus {
    let s = this.boards.get(boardId)
    if (!s) {
      s = {
        boardId,
        lastSuccessAt: null,
        lastSuccessFile: null,
        lastSuccessClock: null,
        offsiteCount: null,
        pending: 0,
        failures: 0,
        failuresTotal: 0,
        lastFailureAt: null,
        lastError: null,
      }
      this.boards.set(boardId, s)
    }
    return s
  }

  /** Never throws: every failure is counted and logged here. */
  private async syncOne(boardId: string): Promise<void> {
    const st = this.statusOf(boardId)
    let what = 'upload'
    try {
      let local: BackupEntry[]
      try {
        local = readManifest(this.localRoot, boardId)?.backups ?? []
      } catch {
        throw new OffsiteError('the local backup manifest is unreadable')
      }
      let manifest: OffsiteManifest | null = null
      let known = this.known.get(boardId)
      if (!known) {
        manifest = await this.fetchManifest(boardId)
        known = this.remember(boardId, manifest)
      }
      const inStore = known.files
      const missing = sortOldestFirst(
        local.filter((e) => !inStore.has(e.file) && !this.badLocal.has(`${boardId}/${e.file}`)),
      )
      st.pending = missing.length
      if (missing.length > 0 || known.pendingDeletes > 0 || this.unsignedInStore.has(boardId)) {
        manifest ??= await this.fetchManifest(boardId)
        for (const entry of missing) {
          if (this.stopped) return
          if (this.wouldKeep(manifest, entry)) manifest = await this.upload(boardId, entry, manifest)
          st.pending--
        }
        what = 'retention'
        await this.deletePending(boardId, manifest)
        // Nothing above wrote it: the one write that signs a manifest read unsigned (retried until done).
        if (this.unsignedInStore.has(boardId)) {
          what = 'manifest'
          await this.writeManifest(boardId, manifest)
        }
      }
      what = 'index'
      await this.updateIndex(boardId)
      st.failures = 0
    } catch (e) {
      const reason = describeFailure(e)
      st.failures++
      st.failuresTotal++
      this.failuresTotal++
      st.lastFailureAt = this.now().toISOString()
      st.lastError = what === 'upload' ? reason : `${what}: ${reason}`
      this.log(`[backup] offsite ${what} failed for board ${boardId}: ${reason} (retried on the next pass)`)
    }
  }

  /** Keeps the little the next pass needs, and updates the board's status from it. */
  private remember(boardId: string, manifest: OffsiteManifest): Known {
    const newest = manifest.backups.at(-1)
    const known: Known = {
      files: new Set(manifest.backups.map((b) => b.file)),
      pendingDeletes: manifest.pendingDeletes.length,
      newest: newest
        ? { file: newest.file, createdAt: newest.createdAt, uploadedAt: newest.uploadedAt }
        : null,
    }
    this.known.set(boardId, known)
    const st = this.statusOf(boardId)
    st.offsiteCount = manifest.backups.length
    if (newest && !st.lastSuccessAt) {
      st.lastSuccessAt = newest.uploadedAt
      st.lastSuccessFile = newest.file
      st.lastSuccessClock = newest.documentClock
    }
    return known
  }

  /** Retention decides before the upload, so a backup it would drop at once is never sent. */
  private wouldKeep(manifest: OffsiteManifest, entry: BackupEntry): boolean {
    const candidate = {
      file: entry.file,
      createdAt: entry.createdAt,
      ...(entry.holdUntil ? { holdUntil: entry.holdUntil } : {}),
    }
    const { keep } = applyRetention([...manifest.backups, candidate], this.now(), this.retention)
    return keep.includes(candidate)
  }

  /**
   * The board's manifest as the store has it (an empty one if there is none, or it is unreadable),
   * without the entries whose own signature does not match. One that is not signed by the current key,
   * or lost entries, is marked to be written again even if nothing else changes (unsignedInStore).
   */
  private async fetchManifest(boardId: string): Promise<OffsiteManifest> {
    const key = offsiteKeys.manifest(this.prefix, boardId)
    const fresh = () => {
      this.unsignedInStore.delete(boardId) // nothing worth keeping: the next upload writes a new one
      return emptyManifest(boardId, this.now())
    }
    let raw: unknown
    try {
      raw = await getJson(this.store, key, MAX_MANIFEST_BYTES)
    } catch (e) {
      if (!(e instanceof OffsiteError)) throw e // the store did not answer: retry later
      this.log(
        `[backup] offsite manifest of board ${boardId} is unreadable (${e.message}); starting a new one`,
      )
      return fresh()
    }
    if (raw === null) return fresh()
    let parsed: ReturnType<typeof parseManifest>
    try {
      parsed = parseManifest(raw, this.prefix, boardId, this.signingKey)
    } catch (e) {
      this.log(
        `[backup] offsite manifest of board ${boardId} is unreadable (${describeFailure(e)}); starting a new one`,
      )
      return fresh()
    }
    if (parsed.ignored)
      this.log(`[backup] offsite manifest of board ${boardId}: ${parsed.ignored} malformed entries ignored`)
    const status = parsed.signature.status
    if (status !== 'valid')
      this.log(
        `[backup] ${RESIGN_REASON[status](`offsite manifest of board ${boardId}`)}${MANIFEST_RESIGN_DETAIL[status]}`,
      )
    // A listed entry whose signature does not match was changed outside this server: never trust it
    // (for retention either). Its object is left alone; a local copy of that backup goes up again.
    const backups = parsed.manifest.backups.filter(
      (b) => parsed.entrySignatures.get(b.file)?.status !== 'invalid',
    )
    const dropped = parsed.manifest.backups.length - backups.length
    if (dropped)
      this.log(
        `[backup] offsite manifest of board ${boardId}: ${dropped} entries do not match their signature and were dropped (their objects stay in the store)`,
      )
    if (status !== 'valid' || dropped > 0) this.unsignedInStore.add(boardId)
    else this.unsignedInStore.delete(boardId)
    return { ...parsed.manifest, backups }
  }

  /** Signs the manifest and writes it; the next pass works from it. */
  private async writeManifest(boardId: string, manifest: OffsiteManifest): Promise<void> {
    await putJson(
      this.store,
      offsiteKeys.manifest(this.prefix, boardId),
      signDocument(this.signingKey, 'manifest', manifest),
    )
    this.unsignedInStore.delete(boardId)
    this.remember(boardId, manifest)
  }

  /** Uploads one local backup and lists it; returns the manifest as written. */
  private async upload(
    boardId: string,
    entry: BackupEntry,
    current: OffsiteManifest,
  ): Promise<OffsiteManifest> {
    const path = join(boardBackupDir(this.localRoot, boardId), entry.file)
    let size: number
    try {
      size = (await stat(path)).size
    } catch (e) {
      // Pruned locally since the manifest was read: a newer backup exists and is queued.
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return current
      throw e
    }
    const badLocal = (why: string) => {
      this.badLocal.add(`${boardId}/${entry.file}`)
      return new OffsiteError(`local backup ${entry.file} does not match its manifest (${why}); not uploaded`)
    }
    if (size !== entry.sizeBytes) throw badLocal('size')
    const key = offsiteKeys.file(this.prefix, boardId, entry.file)
    const hash = createHash('sha256')
    const file = createReadStream(path)
    const body = Readable.from(hashing(file, hash), { objectMode: false })
    try {
      await this.store.put(key, body, { contentType: 'application/vnd.sqlite3', contentLength: size })
    } finally {
      file.destroy() // a no-op once read to the end; closes the file if the store gave up early
    }
    if (hash.digest('hex') !== entry.sha256) {
      await this.store.delete(key).catch(() => {})
      throw badLocal('sha256')
    }
    const assets = cleanAssetRefs(entry.assets) ?? inspectBoardDb(path).assets
    const uploadedAt = this.now().toISOString()
    const facts: OffsiteEntry = {
      file: entry.file,
      key,
      createdAt: entry.createdAt,
      uploadedAt,
      documentClock: entry.documentClock,
      schema: entry.schema,
      recordCount: entry.recordCount,
      recordsSha256: entry.recordsSha256,
      sha256: entry.sha256,
      sizeBytes: size,
      assets,
      // R0 (open item 9): a file with only lb_* tables says so; signed with every other field.
      ...(entry.format ? { format: entry.format } : {}),
      // R0: run-all's final set is kept outside retention until then (signed with the rest).
      ...(entry.holdUntil ? { holdUntil: entry.holdUntil } : {}),
    }
    // Signed here, from the local manifest (the sync disk) and the bytes just sent: the only place an
    // entry is ever signed.
    const stored: OffsiteEntry = { ...facts, signature: signEntry(this.signingKey, boardId, facts) }
    const { keep, drop } = applyRetention(
      [...current.backups.filter((b) => b.file !== entry.file), stored],
      this.now(),
      this.retention,
    )
    const keptFiles = new Set(keep.map((b) => b.file))
    const next: OffsiteManifest = {
      ...current,
      updatedAt: uploadedAt,
      backups: keep,
      pendingDeletes: [...new Set([...current.pendingDeletes, ...drop.map((b) => b.file)])].filter(
        (f) => !keptFiles.has(f),
      ),
    }
    // The object first, then the manifest that lists it: the manifest never names a missing object.
    await this.writeManifest(boardId, next)
    const st = this.statusOf(boardId)
    st.lastSuccessAt = uploadedAt
    st.lastSuccessFile = entry.file
    st.lastSuccessClock = entry.documentClock
    st.failures = 0
    this.log(`[backup] offsite: board ${boardId} ${entry.file} stored (${size} bytes)`)
    return next
  }

  /** Deletes the objects retention dropped; the manifest stops listing each once its delete succeeded. */
  private async deletePending(boardId: string, manifest: OffsiteManifest): Promise<void> {
    if (manifest.pendingDeletes.length === 0) return
    const left: string[] = []
    let firstError: unknown = null
    for (const file of manifest.pendingDeletes) {
      try {
        await this.store.delete(offsiteKeys.file(this.prefix, boardId, file))
      } catch (e) {
        left.push(file)
        firstError ??= e
      }
    }
    if (left.length !== manifest.pendingDeletes.length)
      await this.writeManifest(boardId, {
        ...manifest,
        updatedAt: this.now().toISOString(),
        pendingDeletes: left,
      })
    if (firstError !== null) throw firstError
  }

  /** Lists the board in <prefix>/index.json (how the restore tools find boards without a list call). */
  private async updateIndex(boardId: string): Promise<void> {
    const known = this.known.get(boardId)
    const newest = known?.newest
    if (!known || !newest) return
    if (!this.index) {
      let index = emptyIndex(this.now())
      let raw: unknown = null
      try {
        raw = await getJson(this.store, offsiteKeys.index(this.prefix), MAX_MANIFEST_BYTES)
      } catch (e) {
        if (!(e instanceof OffsiteError)) throw e
        this.log(`[backup] offsite index is unreadable (${e.message}); starting a new one`)
      }
      if (raw !== null)
        try {
          const parsed = parseIndex(raw, this.signingKey)
          index = parsed.index
          // Its rows are hints (board ids); what matters is that the index is signed from now on.
          if (parsed.signature.status !== 'valid') {
            this.indexNeedsSigning = true
            this.log(`[backup] ${RESIGN_REASON[parsed.signature.status]('offsite index')}`)
          }
        } catch (e) {
          this.log(`[backup] offsite index is unreadable (${describeFailure(e)}); starting a new one`)
        }
      this.index = index
    }
    const row = {
      boardId,
      latestFile: newest.file,
      latestCreatedAt: newest.createdAt,
      latestUploadedAt: newest.uploadedAt,
      count: known.files.size,
    }
    const old = this.index.boards.find((b) => b.boardId === boardId)
    if (
      !this.indexNeedsSigning &&
      old &&
      old.latestFile === row.latestFile &&
      old.count === row.count &&
      old.latestUploadedAt === row.latestUploadedAt
    )
      return
    const next: OffsiteIndex = {
      ...this.index,
      updatedAt: this.now().toISOString(),
      boards: [...this.index.boards.filter((b) => b.boardId !== boardId), row].sort((a, b) =>
        a.boardId.localeCompare(b.boardId),
      ),
    }
    await putJson(this.store, offsiteKeys.index(this.prefix), signDocument(this.signingKey, 'index', next))
    this.index = next
    this.indexNeedsSigning = false
  }
}
