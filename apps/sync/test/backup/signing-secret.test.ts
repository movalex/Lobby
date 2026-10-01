// Security audit M3 (wave 4b, 2B): the offsite backups are signed with a key derived from the sync service's
// own DRAFTROOM_BACKUP_SIGNING_SECRET, not from the DRAFTROOM_INTERNAL_SECRET the api shares. The key
// derived from the internal secret only VERIFIES what it signed before (manifests, entries, the index), and
// never signs again once the dedicated secret is set. On 747d41d every signature carried the derived key's
// id, whatever the environment held, and loadConfig knew no DRAFTROOM_BACKUP_SIGNING_SECRET.
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createFsBlobStore } from '@draftroom/blob-store'
import { draftroomSchema } from '@draftroom/canvas-schema'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { BackupEntry } from '../../src/backup/backup.ts'
import { DrillProblem, runRestoreDrill, storeBackupSource } from '../../src/backup/drill.ts'
import { OffsiteBackups } from '../../src/backup/offsite.ts'
import { createBackupService } from '../../src/backup/service.ts'
import {
  type BackupSigningKey,
  backupSigningKey,
  checkDocument,
  checkEntry,
  signDocument,
  signEntry,
} from '../../src/backup/signing.ts'
import { stageRestore } from '../../src/backup/staged-restore.ts'
import { backupSigningSecrets, loadConfig } from '../../src/config.ts'
import { RoomRegistry } from '../../src/rooms.ts'
import { indexFor, note, RoomClient } from '../deleted/fixtures.ts'
import { TEST_INTERNAL_SECRET } from '../harness/tickets.ts'
import { type TempData, tempData } from './offsite-fixtures.ts'

const BOARD = 'dedicated-board'
const PREFIX = 'backups/sync'
const BACKUP_SECRET = 'test-only-backup-signing-secret-0123456789-abcdef'
const OTHER_BACKUP_SECRET = 'test-only-other-backup-signing-secret-0123456789'
const TICKET = 'test-ticket-secret-0123456789-0123456789'
/** The key every build before wave 4b signed with. */
const DERIVED = backupSigningKey(TEST_INTERNAL_SECRET)
/** The key of a sync with the dedicated secret set. */
const DEDICATED = backupSigningKey({ backup: BACKUP_SECRET, internal: TEST_INTERNAL_SECRET })
const drillScript = fileURLToPath(new URL('../../src/backup/restore-drill.ts', import.meta.url))

let data: TempData
let logs: string[]
const log = (...a: unknown[]) => logs.push(a.map(String).join(' '))
beforeEach(() => {
  data = tempData('dr-dedicated-')
  logs = []
})
afterEach(() => data.cleanup())

type Json = Record<string, unknown> & {
  backups: Array<Record<string, unknown>>
  signature?: { keyId?: string }
}
const objectPath = (file: string) => join(data.blobs, ...PREFIX.split('/'), BOARD, file)
const manifestPath = () => objectPath('manifest.json')
const indexPath = () => join(data.blobs, ...PREFIX.split('/'), 'index.json')
const readJson = (path: string) => JSON.parse(readFileSync(path, 'utf8')) as Json
const store = () => createFsBlobStore(data.blobs)

/** A board edited, backed up and copied offsite by a server signing with `key`; `extra` more edits + backups. */
async function offsiteBoard(key: BackupSigningKey, extra = 0): Promise<BackupEntry[]> {
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

/** The drill as after a disk loss, with the key a Shell would build from its environment. */
async function drill(key: BackupSigningKey, allowUnsigned = false, boardIds?: string[]) {
  const elsewhere = mkdtempSync(join(tmpdir(), 'dr-dedicated-nolive-'))
  try {
    return await runRestoreDrill({
      dataDir: elsewhere,
      source: storeBackupSource(store(), { signingKey: key, allowUnsigned }),
      boardIds,
    })
  } finally {
    rmSync(elsewhere, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  }
}

describe('the key', () => {
  it('signs with the dedicated secret and keeps the derived key for verifying only', () => {
    expect(DEDICATED.source).toBe('dedicated')
    expect(DEDICATED.id).not.toBe(DERIVED.id)
    expect(DEDICATED.verifyOnlyIds).toEqual([DERIVED.id])
    expect(DEDICATED.sourceOf(DERIVED.id)).toBe('derived')
    expect(DEDICATED.sourceOf('0000000000000000')).toBeNull()
    expect(DERIVED.source).toBe('derived')
    expect(DERIVED.verifyOnlyIds).toEqual([])
    // the secrets never show
    expect(JSON.stringify(DEDICATED)).not.toContain(BACKUP_SECRET)
    expect(JSON.stringify(DEDICATED)).not.toContain(TEST_INTERNAL_SECRET)
    expect(String(DEDICATED)).toBe(`BackupSigningKey(${DEDICATED.id})`)
    // one value must not open two doors
    expect(() => backupSigningKey({ backup: TEST_INTERNAL_SECRET, internal: TEST_INTERNAL_SECRET })).toThrow(
      /must differ/,
    )
    expect(() => backupSigningKey({ backup: 'short', internal: TEST_INTERNAL_SECRET })).toThrow(
      /DRAFTROOM_BACKUP_SIGNING_SECRET/,
    )
  })

  it("the dedicated key's signatures verify with the dedicated key only; the derived key's with both", () => {
    const entry = { file: 'x.sqlite', sha256: 'a'.repeat(64) }
    const byDedicated = signEntry(DEDICATED, BOARD, entry)
    expect(byDedicated.keyId).toBe(DEDICATED.id)
    expect(checkEntry(DEDICATED, BOARD, { ...entry, signature: byDedicated })).toEqual({ status: 'valid' })
    // the shared internal secret alone is not enough any more (the audit's forgery)
    expect(checkEntry(DERIVED, BOARD, { ...entry, signature: byDedicated })).toEqual({
      status: 'unknown-key',
      keyId: DEDICATED.id,
    })
    const byDerived = signEntry(DERIVED, BOARD, entry)
    expect(checkEntry(DERIVED, BOARD, { ...entry, signature: byDerived })).toEqual({ status: 'valid' })
    expect(checkEntry(DEDICATED, BOARD, { ...entry, signature: byDerived })).toEqual({
      status: 'valid',
      keyId: DERIVED.id,
      via: 'derived',
    })
    // ... but a changed entry under the derived key is still invalid, not "older"
    expect(checkEntry(DEDICATED, BOARD, { ...entry, sha256: 'b'.repeat(64), signature: byDerived })).toEqual({
      status: 'invalid',
    })
    const doc = signDocument(DERIVED, 'index', { boards: [] })
    expect(checkDocument(DEDICATED, 'index', doc)).toMatchObject({ status: 'valid', via: 'derived' })
    // another dedicated secret: unknown, and the message names both variables
    const other = backupSigningKey({ backup: OTHER_BACKUP_SECRET, internal: TEST_INTERNAL_SECRET })
    expect(checkEntry(other, BOARD, { ...entry, signature: byDedicated })).toEqual({
      status: 'unknown-key',
      keyId: DEDICATED.id,
    })
    expect(other.secretNames).toBe(
      'DRAFTROOM_BACKUP_SIGNING_SECRET (or, for older backups, DRAFTROOM_INTERNAL_SECRET)',
    )
    expect(DERIVED.secretNames).toBe('DRAFTROOM_INTERNAL_SECRET')
  })
})

describe('a sync server with DRAFTROOM_BACKUP_SIGNING_SECRET', () => {
  it('signs every entry, manifest and index with the dedicated key; the internal secret alone cannot verify them', async () => {
    const [entry] = await offsiteBoard(DEDICATED)
    const manifest = readJson(manifestPath())
    expect(manifest.signature?.keyId).toBe(DEDICATED.id)
    expect(manifest.backups.map((b) => (b.signature as { keyId: string }).keyId)).toEqual([DEDICATED.id])
    expect(readJson(indexPath()).signature?.keyId).toBe(DEDICATED.id)
    expect(DEDICATED.id).not.toBe(DERIVED.id)

    const ok = await drill(DEDICATED)
    expect(ok.ok).toBe(true)
    expect(ok.boards[0]?.checks.slice(0, 2)).toEqual([
      'offsite manifest signature verified',
      'manifest entry signature verified',
    ])
    // a Shell with the internal secret only: the audit's forger, and an operator who forgot the variable.
    // The index is refused first (the drill cannot even list the boards); named boards get the manifest's
    // refusal, which says which secrets this key is made of.
    await expect(drill(DERIVED)).rejects.toThrow(
      `the offsite index is signed with another key (key id ${DEDICATED.id}; this server's is ${DERIVED.id}): DRAFTROOM_INTERNAL_SECRET differs from the one that wrote it; rerun with --allow-unsigned, or name the boards with --board`,
    )
    const internalOnly = await drill(DERIVED, false, [BOARD])
    expect(internalOnly.ok).toBe(false)
    expect(internalOnly.boards[0]?.problems).toEqual([
      `the offsite manifest is signed with another key (key id ${DEDICATED.id}; this server's is ${DERIVED.id}): DRAFTROOM_INTERNAL_SECRET differs from the one that wrote it; rerun with --allow-unsigned to accept it unverified`,
    ])
    // another dedicated secret: refused, naming both variables
    const other = backupSigningKey({ backup: OTHER_BACKUP_SECRET, internal: TEST_INTERNAL_SECRET })
    const wrong = await drill(other, false, [BOARD])
    expect(wrong.boards[0]?.problems).toEqual([
      `the offsite manifest is signed with another key (key id ${DEDICATED.id}; this server's is ${other.id}): DRAFTROOM_BACKUP_SIGNING_SECRET (or, for older backups, DRAFTROOM_INTERNAL_SECRET) differs from the one that wrote it; rerun with --allow-unsigned to accept it unverified`,
    ])
    expect(entry?.file).toBeDefined()
  })

  it('verifies the backups an older build signed with the derived key, says so, and signs new ones with the dedicated key', async () => {
    // the build before wave 4b wrote this board's backups
    const [old] = await offsiteBoard(DERIVED)
    expect(readJson(manifestPath()).signature?.keyId).toBe(DERIVED.id)

    // the new build, with the dedicated secret, before it writes anything: everything still verifies
    const before = await drill(DEDICATED)
    expect(before.ok).toBe(true)
    expect(before.warnings).toEqual([])
    expect(before.boards[0]?.checks.slice(0, 2)).toEqual([
      'offsite manifest signature verified (signed under the older key, derived from DRAFTROOM_INTERNAL_SECRET)',
      'manifest entry signature verified (signed under the older key, derived from DRAFTROOM_INTERNAL_SECRET)',
    ])
    const dir = mkdtempSync(join(tmpdir(), 'dr-dedicated-stage-'))
    try {
      const staged = await stageRestore({
        dataDir: dir,
        source: storeBackupSource(store(), { signingKey: DEDICATED }),
        boardId: BOARD,
      })
      expect(staged.warnings).toEqual([])
      expect(staged.request.unsignedAccepted).toBeUndefined()
    } finally {
      rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
    }

    // the new build backs the board up again: the new entry, the manifest and the index carry the dedicated
    // key; the old entry keeps its derived-key signature (never re-signed) and still verifies
    const [fresh] = await offsiteBoard(DEDICATED)
    const manifest = readJson(manifestPath())
    expect(manifest.signature?.keyId).toBe(DEDICATED.id)
    expect(readJson(indexPath()).signature?.keyId).toBe(DEDICATED.id)
    expect(manifest.backups.map((b) => [b.file, (b.signature as { keyId: string }).keyId]).sort()).toEqual(
      [
        [old?.file, DERIVED.id],
        [fresh?.file, DEDICATED.id],
      ].sort(),
    )
    // nothing was re-signed with the derived key: it never signs once the dedicated secret is set
    expect(logs.filter((l) => /signing it/.test(l))).toEqual([])
    const after = await drill(DEDICATED)
    expect(after.ok).toBe(true)
    expect(after.boards[0]?.backupFile).toBe(fresh?.file)
    // a Shell that lost the dedicated secret: the manifest no longer verifies, --allow-unsigned warns
    const lost = await drill(DERIVED, false, [BOARD])
    expect(lost.ok).toBe(false)
    const loose = await drill(DERIVED, true, [BOARD])
    expect(loose.ok).toBe(true)
    expect(loose.boards[0]?.warnings.join('\n')).toContain('UNVERIFIED')
  })

  it('a derived-key signature over changed content is still refused, dedicated secret or not', async () => {
    await offsiteBoard(DERIVED)
    const manifest = readJson(manifestPath())
    ;(manifest.backups[0] as Record<string, unknown>).recordCount = 999
    writeFileSync(manifestPath(), JSON.stringify(manifest, null, 2))
    const dir = mkdtempSync(join(tmpdir(), 'dr-dedicated-tamper-'))
    try {
      await expect(
        stageRestore({
          dataDir: dir,
          source: storeBackupSource(store(), { signingKey: DEDICATED }),
          boardId: BOARD,
        }),
      ).rejects.toBeInstanceOf(DrillProblem)
    } finally {
      rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
    }
  })
})

describe('the configuration', () => {
  const base = {
    DRAFTROOM_DATA_DIR: './.data-test',
    DRAFTROOM_TICKET_SECRET: TICKET,
    DRAFTROOM_INTERNAL_SECRET: TEST_INTERNAL_SECRET,
  }
  const prod = {
    ...base,
    NODE_ENV: 'production',
    DRAFTROOM_API_INTERNAL_URL: 'draftroom-staging-api:10000',
    ALLOWED_ORIGINS: 'https://draftroom-staging-web.onrender.com',
  }
  const r2 = {
    DRAFTROOM_BACKUP_STORE: 'r2',
    R2_ACCOUNT_ID: '0123456789abcdef0123456789abcdef',
    R2_ACCESS_KEY_ID: 'key-id-0123456789abcdef0123456789abcdef',
    R2_SECRET_ACCESS_KEY: 'secret-0123456789abcdef0123456789abcdef0123456789abcdef',
    R2_BUCKET: 'draftroom-staging',
  }

  it('loadConfig reads DRAFTROOM_BACKUP_SIGNING_SECRET, requires 32 characters and a value of its own', () => {
    expect(loadConfig(base).backupSigningSecret).toBeNull()
    expect(loadConfig({ ...base, DRAFTROOM_BACKUP_SIGNING_SECRET: BACKUP_SECRET }).backupSigningSecret).toBe(
      BACKUP_SECRET,
    )
    for (const [value, re] of [
      ['short-0123456789', /DRAFTROOM_BACKUP_SIGNING_SECRET must be at least 32/],
      [TEST_INTERNAL_SECRET, /DRAFTROOM_BACKUP_SIGNING_SECRET and DRAFTROOM_INTERNAL_SECRET must differ/],
      [TICKET, /DRAFTROOM_BACKUP_SIGNING_SECRET and DRAFTROOM_TICKET_SECRET must differ/],
    ] as const) {
      let message = ''
      try {
        loadConfig({ ...base, DRAFTROOM_BACKUP_SIGNING_SECRET: value })
      } catch (e) {
        message = (e as Error).message
      }
      expect(message).toMatch(re)
      expect(message).not.toContain(value)
    }
    expect(() =>
      loadConfig({ ...prod, DRAFTROOM_BACKUP_SIGNING_SECRET: 'dev-only-backup-signing-secret-0123456789' }),
    ).toThrow(/DRAFTROOM_BACKUP_SIGNING_SECRET is a development placeholder/)
  })

  it('in production an offsite store needs the dedicated secret; with the store off, or outside production, the derived key may sign', () => {
    expect(() => loadConfig({ ...prod, ...r2 })).toThrow(
      /DRAFTROOM_BACKUP_SIGNING_SECRET is required when DRAFTROOM_BACKUP_STORE is on in production/,
    )
    expect(
      loadConfig({ ...prod, ...r2, DRAFTROOM_BACKUP_SIGNING_SECRET: BACKUP_SECRET }).backupSigningSecret,
    ).toBe(BACKUP_SECRET)
    expect(loadConfig(prod).backupSigningSecret).toBeNull()
    expect(loadConfig({ ...base, DRAFTROOM_BACKUP_STORE: 'fs' }).backupSigningSecret).toBeNull()
  })

  it('backupSigningSecrets (the restore tools) reads both variables', () => {
    expect(backupSigningSecrets(base)).toEqual({ backup: null, internal: TEST_INTERNAL_SECRET })
    expect(backupSigningSecrets({ ...base, DRAFTROOM_BACKUP_SIGNING_SECRET: BACKUP_SECRET })).toEqual({
      backup: BACKUP_SECRET,
      internal: TEST_INTERNAL_SECRET,
    })
    expect(() => backupSigningSecrets({ DRAFTROOM_BACKUP_SIGNING_SECRET: BACKUP_SECRET })).toThrow(
      /DRAFTROOM_INTERNAL_SECRET is required/,
    )
  })

  it('the backup service signs with the dedicated key when the config has it, and logs the key ids, never a secret', () => {
    const config = {
      dataDir: data.root,
      backupStore: { kind: 'fs' as const, root: data.blobs },
      internalSecret: TEST_INTERNAL_SECRET,
      backupSigningSecret: BACKUP_SECRET,
    }
    createBackupService({ config, backupsDir: data.backups, log })
    const line = logs.find((l) => l.includes('signed with DRAFTROOM_BACKUP_SIGNING_SECRET')) ?? ''
    expect(line).toContain(`key id ${DEDICATED.id}`)
    expect(line).toContain(`key id ${DERIVED.id}`)
    expect(logs.join('\n')).not.toContain(BACKUP_SECRET)
    expect(logs.join('\n')).not.toContain(TEST_INTERNAL_SECRET)
    logs = []
    createBackupService({ config: { ...config, backupSigningSecret: null }, backupsDir: data.backups, log })
    expect(logs.join('\n')).toContain(
      `signed with the key derived from DRAFTROOM_INTERNAL_SECRET (key id ${DERIVED.id}): set DRAFTROOM_BACKUP_SIGNING_SECRET`,
    )
  })

  it('restore-drill --from=store takes the dedicated secret from the environment', async () => {
    const [entry] = await offsiteBoard(DEDICATED)
    const run = (env: Record<string, string>) => {
      const clean: NodeJS.ProcessEnv = { ...process.env }
      for (const k of Object.keys(clean))
        if (k.startsWith('DRAFTROOM_') || k.startsWith('R2_')) delete clean[k]
      const r = spawnSync(
        process.execPath,
        [drillScript, '--from=store', '--data-dir', data.root, '--board', BOARD],
        {
          encoding: 'utf8',
          timeout: 60_000,
          env: {
            ...clean,
            DRAFTROOM_BACKUP_STORE: 'fs',
            DRAFTROOM_INTERNAL_SECRET: TEST_INTERNAL_SECRET,
            ...env,
          },
        },
      )
      return { status: r.status, out: `${r.stdout}${r.stderr}` }
    }
    const ok = run({ DRAFTROOM_BACKUP_SIGNING_SECRET: BACKUP_SECRET })
    expect(ok.out).toContain('  ok   manifest entry signature verified')
    expect(ok.out).toContain(`PASS ${BOARD} ${entry?.file}`)
    expect(ok.status).toBe(0)
    const without = run({})
    expect(without.status).toBe(1)
    expect(without.out).toContain(`is signed with another key (key id ${DEDICATED.id}`)
    expect(without.out).not.toContain(BACKUP_SECRET)
  })
})
