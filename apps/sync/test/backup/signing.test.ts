// Authenticated offsite backups (SEAM-08). The store is not trusted to say what a backup holds: anyone
// who can write the bucket could replace a backup file AND rewrite the checksums in its manifest. The
// sync server signs every entry, every manifest and the index with a key derived from
// DRAFTROOM_INTERNAL_SECRET, and the drill and restore-board refuse what does not verify. Manifests
// written before signing existed are accepted only with --allow-unsigned, which says so.
import { spawnSync } from 'node:child_process'
import { createHash, createHmac } from 'node:crypto'
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'
import { createFsBlobStore } from '@draftroom/blob-store'
import { draftroomSchema } from '@draftroom/canvas-schema'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { type BackupEntry, backupBoard, describeBoardDb, inspectBoardDb } from '../../src/backup/backup.ts'
import { DrillProblem, runRestoreDrill, storeBackupSource } from '../../src/backup/drill.ts'
import { OffsiteBackups } from '../../src/backup/offsite.ts'
import { backupSigningKey, canonicalJson } from '../../src/backup/signing.ts'
import { listStagedRestores, stageRestore } from '../../src/backup/staged-restore.ts'
import { boardDbPath, RoomRegistry } from '../../src/rooms.ts'
import { indexFor, note, RoomClient } from '../deleted/fixtures.ts'
import { TEST_INTERNAL_SECRET } from '../harness/tickets.ts'
import { flakyStore, type TempData, tempData } from './offsite-fixtures.ts'

const BOARD = 'signed-board'
const PREFIX = 'backups/sync'
const KEY = backupSigningKey(TEST_INTERNAL_SECRET)
const ROTATED = backupSigningKey('test-only-rotated-internal-secret-0123456789-abcdef')
const drillScript = fileURLToPath(new URL('../../src/backup/restore-drill.ts', import.meta.url))
const restoreScript = fileURLToPath(new URL('../../src/backup/restore-board.ts', import.meta.url))

let data: TempData
let logs: string[]
const log = (...a: unknown[]) => logs.push(a.map(String).join(' '))
beforeEach(() => {
  data = tempData('dr-signed-')
  logs = []
})
afterEach(() => data.cleanup())

type Json = Record<string, unknown> & {
  backups: Array<Record<string, unknown>>
  signature?: unknown
}
const objectPath = (file: string) => join(data.blobs, ...PREFIX.split('/'), BOARD, file)
const manifestPath = () => objectPath('manifest.json')
const indexPath = () => join(data.blobs, ...PREFIX.split('/'), 'index.json')
const readJson = (path: string) => JSON.parse(readFileSync(path, 'utf8')) as Json
const writeJson = (path: string, v: unknown) => writeFileSync(path, JSON.stringify(v, null, 2))
const store = () => createFsBlobStore(data.blobs)
const source = (opts: { allowUnsigned?: boolean; key?: typeof KEY } = {}) =>
  storeBackupSource(store(), { signingKey: opts.key ?? KEY, allowUnsigned: opts.allowUnsigned })

/** Boards edited, backed up and copied offsite through the real path (registry -> listener -> upload). */
async function offsiteBoard(key = KEY, extra = 0): Promise<BackupEntry[]> {
  const reg = new RoomRegistry({ dataDir: data.rooms, schema: draftroomSchema, idleEvictMs: 60_000 })
  const offsite = new OffsiteBackups({ store: store(), localRoot: data.backups, signingKey: key, log })
  offsite.start()
  const out: BackupEntry[] = []
  try {
    const c = new RoomClient(reg.getOrCreate(BOARD), 'usr_a')
    await c.connect()
    await c.put(note('n1', 'Q3 plan: approved'), note('n2', 'two', { index: indexFor(2) }))
    for (let i = 0; i <= extra; i++) {
      if (i > 0) await c.put(note(`e${i}`, `edit ${i}`, { index: indexFor(10 + i) }))
      const entry = await reg.backupNow(BOARD)
      if (!entry) throw new Error('no backup')
      out.push(entry)
      await offsite.idle()
    }
  } finally {
    await offsite.stop()
    reg.closeAll()
  }
  return out
}

/** The reviewers' probe: rewrites one note inside the stored backup. */
function tamperObject(file: string): string {
  const work = mkdtempSync(join(tmpdir(), 'dr-signed-evil-'))
  const copy = join(work, file)
  copyFileSync(objectPath(file), copy)
  const db = new DatabaseSync(copy)
  const row = db.prepare("SELECT state FROM documents WHERE id = 'shape:n1'").get() as { state: Uint8Array }
  const rec = JSON.parse(Buffer.from(row.state).toString('utf8'))
  rec.props.richText = {
    type: 'doc',
    content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Q3 plan: CANCELLED (tampered)' }] }],
  }
  db.prepare("UPDATE documents SET state = ? WHERE id = 'shape:n1'").run(Buffer.from(JSON.stringify(rec)))
  db.close()
  copyFileSync(copy, objectPath(file))
  rmSync(work, { recursive: true, force: true })
  return objectPath(file)
}

/** ...and what anyone who can write the bucket can recompute: the entry's checksums (no key needed). */
function rewriteEntry(file: string, change: (m: Json) => void = () => {}) {
  const path = objectPath(file)
  const facts = inspectBoardDb(path)
  const manifest = readJson(manifestPath())
  const e = manifest.backups.find((b) => b.file === file)
  if (!e) throw new Error('entry not found')
  e.sha256 = createHash('sha256').update(readFileSync(path)).digest('hex')
  e.sizeBytes = statSync(path).size
  e.recordsSha256 = facts.recordsSha256
  e.recordCount = facts.recordCount
  change(manifest)
  writeJson(manifestPath(), manifest)
}

/** A manifest as the code before signing wrote it: no signature anywhere. */
function stripSignatures(path = manifestPath()) {
  const m = readJson(path)
  delete m.signature
  for (const e of m.backups ?? []) delete e.signature
  writeJson(path, m)
}

async function stage(opts: { allowUnsigned?: boolean; file?: string; key?: typeof KEY } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'dr-signed-stage-'))
  try {
    const r = await stageRestore({ dataDir: dir, source: source(opts), boardId: BOARD, file: opts.file })
    return {
      staged: true as const,
      ...r,
      restored: describeBoardDb(join(dir, 'restore', `board-${BOARD}.sqlite`)),
    }
  } catch (e) {
    if (!(e instanceof DrillProblem)) throw e
    return { staged: false as const, problems: e.problems, left: listStagedRestores(dir) }
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  }
}

/** The drill as after a disk loss: nothing live to compare with. */
async function drill(opts: { allowUnsigned?: boolean; key?: typeof KEY; boardIds?: string[] } = {}) {
  const elsewhere = mkdtempSync(join(tmpdir(), 'dr-signed-nolive-'))
  try {
    return await runRestoreDrill({ dataDir: elsewhere, source: source(opts), boardIds: opts.boardIds })
  } finally {
    rmSync(elsewhere, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  }
}

describe('what the sync server writes is signed', () => {
  it('every entry, the manifest and the index carry an HMAC-SHA256 signature under a derived key', async () => {
    const [entry] = await offsiteBoard()
    const manifest = readJson(manifestPath())
    const sig = { alg: 'HMAC-SHA256', keyId: KEY.id, value: expect.stringMatching(/^[0-9a-f]{64}$/) }
    expect(manifest.signature).toEqual(sig)
    expect(manifest.backups).toHaveLength(1)
    expect(manifest.backups[0]).toMatchObject({ file: entry?.file, signature: sig })
    expect(readJson(indexPath()).signature).toEqual(sig)
    // the key is derived (HKDF, its own label), not the internal secret used as-is
    const { signature, ...unsigned } = manifest
    const raw = createHmac('sha256', TEST_INTERNAL_SECRET)
      .update(`draftroom-offsite-manifest/v1\n${canonicalJson(unsigned)}`)
      .digest('hex')
    expect((signature as { value: string }).value).not.toBe(raw)
    expect(KEY.id).not.toBe(ROTATED.id)
    expect(KEY.id).toMatch(/^[0-9a-f]{16}$/)
    // and the key never shows up when the key object is printed or serialized
    expect(JSON.stringify(KEY)).not.toMatch(/[0-9a-f]{64}/)
    expect(String(KEY)).not.toContain(TEST_INTERNAL_SECRET)
  })

  it('the drill and a staged restore verify both signatures before trusting a checksum', async () => {
    const [entry] = await offsiteBoard()
    const report = await drill()
    expect(report.ok).toBe(true)
    expect(report.warnings).toEqual([])
    expect(report.boards[0]?.warnings).toEqual([])
    expect(report.boards[0]?.checks.slice(0, 3)).toEqual([
      'offsite manifest signature verified',
      'manifest entry signature verified',
      `downloaded ${PREFIX}/${BOARD}/${entry?.file} from the fs store (${entry?.sizeBytes} bytes)`,
    ])
    const staged = await stage()
    expect(staged.staged).toBe(true)
    if (staged.staged) {
      expect(staged.warnings).toEqual([])
      expect(staged.request.unsignedAccepted).toBeUndefined()
    }
  })

  it('canonical JSON ignores key order and nothing else', () => {
    expect(canonicalJson({ b: 1, a: [{ d: 'x', c: null }] })).toBe('{"a":[{"c":null,"d":"x"}],"b":1}')
    expect(canonicalJson({ a: 1, b: 2 })).toBe(canonicalJson({ b: 2, a: 1 }))
    expect(canonicalJson([1, 2])).not.toBe(canonicalJson([2, 1]))
    expect(canonicalJson({ a: '1' })).not.toBe(canonicalJson({ a: 1 }))
  })
})

describe('a tampered backup or a rewritten manifest fails loudly', () => {
  it("the reviewers' probe: a changed backup whose entry checksums are recomputed is refused by the drill and never staged", async () => {
    const [entry] = await offsiteBoard()
    const file = entry?.file ?? '?'
    tamperObject(file)
    rewriteEntry(file)
    const report = await drill()
    expect(report.ok).toBe(false)
    expect(report.boards[0]?.problems).toEqual([
      'the offsite manifest does not match its signature: it was changed outside the sync server',
    ])
    const staged = await stage()
    expect(staged).toMatchObject({ staged: false, left: [] })
    // --allow-unsigned never accepts a signature that is present and wrong
    expect((await drill({ allowUnsigned: true })).ok).toBe(false)
    expect((await stage({ allowUnsigned: true })).staged).toBe(false)
  })

  it('removing the manifest signature does not help: the entry still carries its own', async () => {
    const [entry] = await offsiteBoard()
    const file = entry?.file ?? '?'
    tamperObject(file)
    rewriteEntry(file, (m) => {
      delete m.signature
    })
    expect((await drill()).boards[0]?.problems).toEqual([
      'the offsite manifest is not signed (written before backups were signed, or its signature was removed); rerun with --allow-unsigned to accept it',
    ])
    const loose = await drill({ allowUnsigned: true })
    expect(loose.ok).toBe(false)
    expect(loose.boards[0]?.problems).toEqual([
      `the manifest entry of ${file} does not match its signature: it was changed outside the sync server`,
    ])
    expect((await stage({ allowUnsigned: true })).staged).toBe(false)
  })

  it('a signature made with a guessed key, or moved from another entry or board, does not verify', async () => {
    const entries = await offsiteBoard(KEY, 1)
    const [older, newer] = entries.map((e) => e.file)
    const manifest = readJson(manifestPath())
    const olderEntry = manifest.backups.find((b) => b.file === older)
    const newerEntry = manifest.backups.find((b) => b.file === newer)
    // the older entry's (valid) signature pasted onto the newer entry
    if (newerEntry && olderEntry) newerEntry.signature = olderEntry.signature
    delete manifest.signature
    writeJson(manifestPath(), manifest)
    const moved = await drill({ allowUnsigned: true })
    expect(moved.boards[0]?.problems).toEqual([
      `the manifest entry of ${newer} does not match its signature: it was changed outside the sync server`,
    ])
    // a keyed hash under the right key id but a guessed key
    const forged = readJson(manifestPath())
    forged.signature = { alg: 'HMAC-SHA256', keyId: KEY.id, value: 'ab'.repeat(32) }
    writeJson(manifestPath(), forged)
    expect((await drill({ allowUnsigned: true })).boards[0]?.problems).toEqual([
      'the offsite manifest does not match its signature: it was changed outside the sync server',
    ])
  })

  it('a rewritten index fails the drill of every board, and --board still works', async () => {
    await offsiteBoard()
    const index = readJson(indexPath())
    ;(index.boards as unknown[]).push({ boardId: 'phantom-board', latestFile: 'x', count: 1 })
    writeJson(indexPath(), index)
    await expect(drill()).rejects.toThrow(
      'the offsite index does not match its signature: it was changed outside the sync server; name the boards to drill with --board',
    )
    expect((await drill({ boardIds: [BOARD] })).ok).toBe(true)
  })
})

describe('manifests written before signing: only with --allow-unsigned, and it says so', () => {
  it('a fully unsigned manifest and index are refused, then accepted with warnings on every line that matters', async () => {
    const [entry] = await offsiteBoard()
    const file = entry?.file ?? '?'
    stripSignatures()
    stripSignatures(indexPath())
    await expect(drill()).rejects.toThrow(
      'the offsite index is not signed (written before backups were signed, or its signature was removed); rerun with --allow-unsigned, or name the boards with --board',
    )
    expect((await drill({ boardIds: [BOARD] })).boards[0]?.problems).toEqual([
      'the offsite manifest is not signed (written before backups were signed, or its signature was removed); rerun with --allow-unsigned to accept it',
    ])
    const staged = await stage()
    expect(staged).toMatchObject({ staged: false, left: [] })

    const loose = await drill({ allowUnsigned: true })
    expect(loose.ok).toBe(true)
    expect(loose.warnings).toEqual([
      'UNVERIFIED: the offsite index is not signed; accepted because of --allow-unsigned',
    ])
    expect(loose.boards[0]?.warnings).toEqual([
      'UNVERIFIED: the offsite manifest is not signed; accepted because of --allow-unsigned',
      `UNVERIFIED: backup ${file} is not signed, so its checksums prove nothing about who wrote them; accepted because of --allow-unsigned`,
    ])
    const accepted = await stage({ allowUnsigned: true })
    expect(accepted.staged).toBe(true)
    if (accepted.staged) {
      expect(accepted.warnings).toHaveLength(2)
      expect(accepted.request.unsignedAccepted).toBe(true)
    }
  })

  it('the uploader signs a legacy manifest it finds: new backups verify, its older entries stay unsigned', async () => {
    const [first] = await offsiteBoard()
    stripSignatures()
    stripSignatures(indexPath())
    // the next server start (code with signing) makes a new backup of the same board
    const reg = new RoomRegistry({ dataDir: data.rooms, schema: draftroomSchema, idleEvictMs: 60_000 })
    const counting = flakyStore(data.blobs)
    const offsite = new OffsiteBackups({ store: counting, localRoot: data.backups, signingKey: KEY, log })
    offsite.start()
    await offsite.idle()
    // nothing new to upload, yet the manifest and the index are signed now (one write each)
    expect(counting.puts).toEqual([`${PREFIX}/${BOARD}/manifest.json`, `${PREFIX}/index.json`])
    await offsite.runPass()
    expect(counting.puts).toHaveLength(2) // and never again
    const resigned = readJson(manifestPath())
    expect(resigned.signature).toMatchObject({ keyId: KEY.id })
    expect(resigned.backups[0]?.signature).toBeUndefined()
    expect(readJson(indexPath()).signature).toMatchObject({ keyId: KEY.id })
    expect(logs.join('\n')).toContain(
      `[backup] offsite manifest of board ${BOARD} is not signed (written before backups were signed); signing it, its older entries stay unsigned`,
    )
    let second: BackupEntry | null = null
    try {
      const c = new RoomClient(reg.getOrCreate(BOARD), 'usr_a')
      await c.connect()
      await c.put(note('n3', 'after the upgrade', { index: indexFor(3) }))
      second = await reg.backupNow(BOARD)
      await offsite.idle()
    } finally {
      await offsite.stop()
      reg.closeAll()
    }
    const manifest = readJson(manifestPath())
    expect(manifest.backups.map((b) => [b.file, !!b.signature])).toEqual([
      [first?.file, false],
      [second?.file, true],
    ])
    // the newest verifies without the flag; the older one needs it
    expect((await drill()).ok).toBe(true)
    expect((await stage({ file: first?.file })).staged).toBe(false)
    expect((await stage({ file: first?.file, allowUnsigned: true })).staged).toBe(true)
  })

  it('signing a legacy manifest that fails (store down) is retried on the next pass, not forgotten', async () => {
    await offsiteBoard()
    stripSignatures()
    const flaky = flakyStore(data.blobs)
    let down = true
    flaky.failPut = (key) => down && key.endsWith('/manifest.json')
    const offsite = new OffsiteBackups({ store: flaky, localRoot: data.backups, signingKey: KEY, log })
    offsite.start()
    await offsite.idle()
    expect(offsite.status().boards[0]).toMatchObject({
      failures: 1,
      lastError: 'manifest: NETWORK ECONNRESET',
    })
    expect(readJson(manifestPath()).signature).toBeUndefined()
    down = false
    await offsite.runPass()
    await offsite.stop()
    expect(readJson(manifestPath()).signature).toMatchObject({ keyId: KEY.id })
    expect(offsite.status().boards[0]?.failures).toBe(0)
  })

  it('the uploader drops entries that fail their own signature (leaving their objects) and uploads the backup again', async () => {
    const [entry] = await offsiteBoard()
    const file = entry?.file ?? '?'
    const manifest = readJson(manifestPath())
    const e = manifest.backups[0]
    if (e) e.recordCount = 999
    writeJson(manifestPath(), manifest)
    const offsite = new OffsiteBackups({ store: store(), localRoot: data.backups, signingKey: KEY, log })
    offsite.start()
    await offsite.idle()
    await offsite.stop()
    const text = logs.join('\n')
    expect(text).toContain(
      `[backup] offsite manifest of board ${BOARD} does not match its signature (changed outside this server?); signing it again without the entries that fail their own check`,
    )
    expect(text).toContain(
      `[backup] offsite manifest of board ${BOARD}: 1 entries do not match their signature and were dropped (their objects stay in the store)`,
    )
    // the local backup was still there, so it went up again with a fresh, valid entry
    const again = readJson(manifestPath())
    expect(again.backups.map((b) => b.file)).toEqual([file])
    expect(again.backups[0]?.recordCount).toBe(entry?.recordCount)
    expect((await drill()).ok).toBe(true)
  })
})

describe('another DRAFTROOM_INTERNAL_SECRET (rotated, or the wrong one in the shell)', () => {
  it('cannot verify, and the message names the likely cause; the uploader re-signs and keeps the older entries', async () => {
    const [old] = await offsiteBoard(KEY)
    const report = await drill({ key: ROTATED, boardIds: [BOARD] })
    expect(report.boards[0]?.problems).toEqual([
      `the offsite manifest is signed with another key (key id ${KEY.id}; this server's is ${ROTATED.id}): DRAFTROOM_INTERNAL_SECRET differs from the one that wrote it; rerun with --allow-unsigned to accept it unverified`,
    ])
    // the server after a rotation: keeps the old entry (unverifiable, not dropped), signs what it writes
    const offsite = new OffsiteBackups({ store: store(), localRoot: data.backups, signingKey: ROTATED, log })
    offsite.start()
    await offsite.idle()
    await offsite.stop()
    const manifest = readJson(manifestPath())
    expect(manifest.signature).toMatchObject({ keyId: ROTATED.id })
    expect(manifest.backups.map((b) => [b.file, (b.signature as { keyId?: string })?.keyId])).toEqual([
      [old?.file, KEY.id],
    ])
    const rotated = await drill({ key: ROTATED })
    expect(rotated.boards[0]?.problems).toEqual([
      `backup ${old?.file} is signed with another key (key id ${KEY.id}; this server's is ${ROTATED.id}): DRAFTROOM_INTERNAL_SECRET differs from the one that wrote it; rerun with --allow-unsigned to accept it unverified`,
    ])
    const loose = await drill({ key: ROTATED, allowUnsigned: true })
    expect(loose.ok).toBe(true)
    expect(loose.boards[0]?.warnings).toEqual([
      `UNVERIFIED: backup ${old?.file} is signed with another key (key id ${KEY.id}); accepted because of --allow-unsigned`,
    ])
  })
})

describe('the CLIs', () => {
  const run = (script: string, args: string[], env: Record<string, string> = {}) => {
    const clean: NodeJS.ProcessEnv = { ...process.env }
    for (const k of Object.keys(clean)) if (k.startsWith('DRAFTROOM_') || k.startsWith('R2_')) delete clean[k]
    const r = spawnSync(process.execPath, [script, ...args], {
      encoding: 'utf8',
      timeout: 60_000,
      env: { ...clean, ...env },
    })
    return { status: r.status, out: `${r.stdout}${r.stderr}` }
  }
  const fsStore = { DRAFTROOM_BACKUP_STORE: 'fs', DRAFTROOM_INTERNAL_SECRET: TEST_INTERNAL_SECRET }

  it('restore-drill --from=store verifies, needs the internal secret, and takes --allow-unsigned', async () => {
    const [entry] = await offsiteBoard()
    const ok = run(drillScript, ['--from=store', '--data-dir', data.root, '--board', BOARD], fsStore)
    expect(ok.out).toContain('  ok   offsite manifest signature verified')
    expect(ok.out).toContain('  ok   manifest entry signature verified')
    expect(ok.status).toBe(0)

    const noSecret = run(drillScript, ['--from=store', '--data-dir', data.root], {
      DRAFTROOM_BACKUP_STORE: 'fs',
    })
    expect(noSecret.status).toBe(1)
    expect(noSecret.out).toContain(
      'DRAFTROOM_INTERNAL_SECRET is required to verify offsite backups (the sync server signs them with it)',
    )

    const local = run(drillScript, ['--allow-unsigned', '--data-dir', data.root], fsStore)
    expect(local.status).toBe(1)
    expect(local.out).toContain('--allow-unsigned only applies to --from=store')

    stripSignatures()
    stripSignatures(indexPath())
    const strict = run(drillScript, ['--from=store', '--data-dir', data.root], fsStore)
    expect(strict.status).toBe(1)
    expect(strict.out).toContain('rerun with --allow-unsigned')
    const loose = run(drillScript, ['--from=store', '--allow-unsigned', '--data-dir', data.root], fsStore)
    expect(loose.out).toContain(
      '  WARN UNVERIFIED: the offsite index is not signed; accepted because of --allow-unsigned',
    )
    expect(loose.out).toContain(`  WARN UNVERIFIED: backup ${entry?.file} is not signed`)
    expect(loose.out).toContain(`PASS ${BOARD} ${entry?.file}`)
    expect(loose.out).toContain('restore drill passed, with unsigned backups accepted (--allow-unsigned)')
    expect(loose.status).toBe(0)
  })

  it('restore-board --from=store refuses a tampered backup and stages an unsigned one only with --allow-unsigned', async () => {
    const [entry] = await offsiteBoard()
    const file = entry?.file ?? '?'
    tamperObject(file)
    rewriteEntry(file)
    const tampered = run(restoreScript, ['--from=store', '--board', BOARD, '--data-dir', data.root], fsStore)
    expect(tampered.status).toBe(1)
    expect(tampered.out).toContain(
      '  FAIL the offsite manifest does not match its signature: it was changed outside the sync server',
    )
    expect(tampered.out).toContain(`nothing staged for ${BOARD}`)
    expect(existsSync(join(data.root, 'restore', `board-${BOARD}.json`))).toBe(false)

    // an honest pre-signing manifest (the object is put back)
    data.cleanup()
    data = tempData('dr-signed-')
    const [legacy] = await offsiteBoard()
    stripSignatures()
    const strict = run(restoreScript, ['--from=store', '--board', BOARD, '--data-dir', data.root], fsStore)
    expect(strict.status).toBe(1)
    expect(strict.out).toContain('rerun with --allow-unsigned to accept it')
    const loose = run(
      restoreScript,
      ['--from=store', '--allow-unsigned', '--board', BOARD, '--data-dir', data.root],
      fsStore,
    )
    expect(loose.out).toContain(
      '  WARN UNVERIFIED: the offsite manifest is not signed; accepted because of --allow-unsigned',
    )
    expect(loose.out).toContain(
      `staged ${BOARD} from fs backup ${legacy?.file} (UNSIGNED, accepted with --allow-unsigned)`,
    )
    expect(loose.status).toBe(0)
    const wrong = run(restoreScript, [
      '--from=local',
      '--allow-unsigned',
      '--board',
      BOARD,
      '--data-dir',
      data.root,
    ])
    expect(wrong.out).toContain('--allow-unsigned only applies to --from=store')
    expect(wrong.status).toBe(1)
  })
})

describe('local backups are not affected', () => {
  it('backupBoard and the local manifest stay as they were (the sync disk is the trust root)', async () => {
    await offsiteBoard()
    const db = new DatabaseSync(boardDbPath(data.rooms, BOARD))
    try {
      const e = await backupBoard({ db, boardId: BOARD, root: data.backups })
      expect(Object.keys(e)).not.toContain('signature')
    } finally {
      db.close()
    }
  })
})
