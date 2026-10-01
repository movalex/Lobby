// PORTED from e2e/tests/backups-2.spec.ts (32859b1; retired with the tldraw suite) to the Excalidraw stack,
// every assertion kept: the board is drawn through the facade (history-kit `drawFrameBoard`) in a
// `canvasSession`; the manifests, signatures and the owner's tools are the same files and commands (the
// backup is a `lobby-elements` file now, which changes nothing about how it is signed or verified).
//
// Authenticated offsite backups end to end (SEAM-08), on the real stack with the fs driver: the sync
// server signs every manifest entry, every manifest and the index it copies offsite, with a key derived
// from its DRAFTROOM_INTERNAL_SECRET (no DRAFTROOM_BACKUP_SIGNING_SECRET on a test stack; signing.ts). The
// owner's tools (`pnpm --filter @draftroom/sync backup:restore-drill|backup:restore-board --from=store`)
// verify those signatures before they trust a checksum: a changed backup whose manifest entry was
// rewritten to match fails loudly and is never staged, and a manifest written before signing existed is
// accepted only with --allow-unsigned, which says so. R2 itself is never contacted here.
import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from '../tests/support/canvas.ts'
import {
  backupTool,
  damaged,
  OFFSITE_SYNC_ENV,
  type OffsiteManifest,
  offsiteDir,
  offsiteIndex,
  offsiteManifestPath,
  settledOffsite,
  storeArgs,
} from './backups-kit.ts'
import { drawFrameBoard } from './history-kit.ts'

test.use({ syncEnv: OFFSITE_SYNC_ENV })

test('the sync server signs what it copies offsite, and the drill verifies it with the same secret only', async ({
  canvasSession,
  board,
  stack,
}) => {
  const a = await canvasSession('alice')
  await drawFrameBoard(a.page, 'sg')
  await a.context.close()
  const manifest = await settledOffsite(stack.dataDir, board)
  const sig = {
    alg: 'HMAC-SHA256',
    keyId: expect.stringMatching(/^[0-9a-f]{16}$/),
    value: expect.stringMatching(/^[0-9a-f]{64}$/),
  }
  expect(manifest.signature).toEqual(sig)
  expect(manifest.backups.at(-1)?.signature).toEqual(sig)
  expect(offsiteIndex(stack.dataDir)?.signature).toEqual(sig)
  // nothing in what the store holds is the secret
  const stored = readFileSync(offsiteManifestPath(stack.dataDir, board), 'utf8')
  expect(stored).not.toContain(stack.internalSecret)

  const args = storeArgs(stack.dataDir, board)
  const run = backupTool('backup:restore-drill', args, stack.internalSecret)
  test.info().annotations.push({ type: 'drill output', description: run.output })
  expect(run.status, run.output).toBe(0)
  expect(run.output).toContain(`PASS ${board} ${manifest.backups.at(-1)?.file}`)
  expect(run.output).toContain('  ok   offsite manifest signature verified')
  expect(run.output).toContain('  ok   manifest entry signature verified')
  expect(run.output).toContain('restore drill passed')
  expect(run.output).not.toContain('WARN')

  // another secret (here: the development one in apps/sync/dev.env) cannot vouch for this store
  const other = backupTool('backup:restore-drill', args, null)
  expect(other.status, other.output).toBe(1)
  expect(other.output).toContain('the offsite manifest is signed with another key')
  expect(other.output).toContain('restore drill FAILED')
})

test('a changed backup with a rewritten manifest entry is refused, and an unsigned manifest needs --allow-unsigned', async ({
  canvasSession,
  board,
  stack,
}) => {
  const a = await canvasSession('alice')
  await drawFrameBoard(a.page, 'tp')
  await a.context.close()
  const manifest = await settledOffsite(stack.dataDir, board)
  const newest = manifest.backups.at(-1)
  const objectPath = join(offsiteDir(stack.dataDir, board), newest?.file ?? 'missing')
  const manifestPath = offsiteManifestPath(stack.dataDir, board)
  const originalObject = readFileSync(objectPath)
  const originalManifest = readFileSync(manifestPath)
  const args = storeArgs(stack.dataDir, board)
  const restoreDir = join(stack.dataDir, 'restore')
  const staged = () =>
    existsSync(restoreDir) ? readdirSync(restoreDir).filter((f) => f.endsWith('.json')) : []

  try {
    // Someone with write access to the bucket changes the backup and recomputes what the entry claims.
    const changed = damaged(originalObject)
    writeFileSync(objectPath, changed)
    const forged = JSON.parse(originalManifest.toString('utf8')) as OffsiteManifest
    const entry = forged.backups.at(-1)
    if (!entry) throw new Error('no entry')
    entry.sha256 = createHash('sha256').update(changed).digest('hex')
    entry.sizeBytes = changed.byteLength
    writeFileSync(manifestPath, JSON.stringify(forged, null, 2))

    const drill = backupTool('backup:restore-drill', args, stack.internalSecret)
    test.info().annotations.push({ type: 'drill output (tampered)', description: drill.output })
    expect(drill.status, drill.output).toBe(1)
    expect(drill.output).toContain(
      '  FAIL the offsite manifest does not match its signature: it was changed outside the sync server',
    )
    expect(drill.output).toContain('restore drill FAILED')
    for (const extra of ['', ' --allow-unsigned']) {
      const restore = backupTool('backup:restore-board', `${args}${extra}`, stack.internalSecret)
      expect(restore.status, restore.output).toBe(1)
      expect(restore.output).toContain(`nothing staged for ${board}`)
      expect(staged()).toEqual([])
    }

    // A manifest as written before signing existed (the honest bytes, no signatures anywhere).
    writeFileSync(objectPath, originalObject)
    const legacy = JSON.parse(originalManifest.toString('utf8')) as OffsiteManifest
    delete legacy.signature
    for (const e of legacy.backups) delete e.signature
    writeFileSync(manifestPath, JSON.stringify(legacy, null, 2))
    const strict = backupTool('backup:restore-drill', args, stack.internalSecret)
    expect(strict.status, strict.output).toBe(1)
    expect(strict.output).toContain(
      'the offsite manifest is not signed (written before backups were signed, or its signature was removed); rerun with --allow-unsigned to accept it',
    )
    const loose = backupTool('backup:restore-drill', `${args} --allow-unsigned`, stack.internalSecret)
    test.info().annotations.push({ type: 'drill output (--allow-unsigned)', description: loose.output })
    expect(loose.status, loose.output).toBe(0)
    expect(loose.output).toContain(
      '  WARN UNVERIFIED: the offsite manifest is not signed; accepted because of --allow-unsigned',
    )
    expect(loose.output).toContain(`  WARN UNVERIFIED: backup ${newest?.file} is not signed`)
    expect(loose.output).toContain('restore drill passed, with unsigned backups accepted (--allow-unsigned)')
  } finally {
    writeFileSync(objectPath, originalObject)
    writeFileSync(manifestPath, originalManifest)
  }
  // put back as the server wrote them: verified again, no flag needed
  const after = backupTool('backup:restore-drill', args, stack.internalSecret)
  expect(after.status, after.output).toBe(0)
  expect(after.output).not.toContain('WARN')
})
