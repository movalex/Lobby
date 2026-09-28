// Authenticated offsite backups end to end (SEAM-08), on the real stack with the fs driver: the sync
// server signs every manifest entry, every manifest and the index it copies offsite, with a key derived
// from its DRAFTROOM_INTERNAL_SECRET. The owner's tools (`pnpm --filter @draftroom/sync
// backup:restore-drill|backup:restore-board --from=store`) verify those signatures before they trust a
// checksum: a changed backup whose manifest entry was rewritten to match fails loudly and is never
// staged, and a manifest written before signing existed is accepted only with --allow-unsigned, which
// says so. R2 itself is never contacted here.
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { waitForValue } from './support/board.ts'
import { expect, test } from './support/fixtures.ts'
import { drawFrameBoard } from './support/history.ts'
import { REPO_ROOT } from './support/stack.ts'

test.use({ syncEnv: { DRAFTROOM_BACKUP_STORE: 'fs', DRAFTROOM_BACKUP_INTERVAL_MS: '1500' } })

interface Signature {
  alg: string
  keyId: string
  value: string
}
interface Manifest {
  signature?: Signature
  backups: Array<{ file: string; sha256: string; sizeBytes: number; signature?: Signature }>
}

const readJson = <T>(path: string): T | null =>
  existsSync(path) ? (JSON.parse(readFileSync(path, 'utf8')) as T) : null
const offsiteDir = (dataDir: string, board: string) => join(dataDir, 'blobs', 'backups', 'sync', board)
const manifestPath = (dataDir: string, board: string) => join(offsiteDir(dataDir, board), 'manifest.json')
const localNewest = (dataDir: string, board: string) =>
  readJson<{ backups: { file: string }[] }>(join(dataDir, 'backups', board, 'manifest.json'))?.backups.at(-1)
    ?.file

/** The newest local backup is the newest offsite one and has stayed so for 5 s (the board settled). */
async function settledOffsite(dataDir: string, board: string): Promise<Manifest> {
  let last = ''
  let since = 0
  return waitForValue(
    async () => {
      const local = localNewest(dataDir, board)
      const offsite = readJson<Manifest>(manifestPath(dataDir, board))
      if (!local || local !== offsite?.backups.at(-1)?.file) {
        last = ''
        return null
      }
      if (local !== last) {
        last = local
        since = Date.now()
        return null
      }
      return Date.now() - since >= 5_000 ? offsite : null
    },
    { timeout: 60_000, message: 'the newest local backup is offsite and the board has settled' },
  )
}

/** Runs one of the owner's backup tools the way docs/DEPLOY.md shows (pnpm script, fs store). */
function tool(
  script: 'backup:restore-drill' | 'backup:restore-board',
  args: string,
  internalSecret: string | null,
) {
  const env: NodeJS.ProcessEnv = { ...process.env }
  for (const key of Object.keys(env))
    if (key.startsWith('DRAFTROOM_') || key.startsWith('R2_') || key === 'NODE_OPTIONS') delete env[key]
  env.DRAFTROOM_BACKUP_STORE = 'fs'
  // null: whatever apps/sync/dev.env says (the development secret, not this stack's)
  if (internalSecret !== null) env.DRAFTROOM_INTERNAL_SECRET = internalSecret
  const r = spawnSync(`pnpm --filter @draftroom/sync ${script} ${args}`, {
    cwd: REPO_ROOT,
    env,
    encoding: 'utf8',
    shell: true,
    windowsHide: true,
    timeout: 120_000,
  })
  return { status: r.status, output: `${r.stdout ?? ''}${r.stderr ?? ''}${r.error ? String(r.error) : ''}` }
}

function checkedArgs(dataDir: string, board: string) {
  if (/["\r\n]/.test(dataDir)) throw new Error(`unexpected data dir ${dataDir}`)
  if (!/^[a-z0-9][a-z0-9_-]{2,63}$/.test(board)) throw new Error(`bad board id ${board}`)
  return `--from=store --data-dir "${dataDir}" --board ${board}`
}

test('the sync server signs what it copies offsite, and the drill verifies it with the same secret only', async ({
  session,
  board,
  stack,
}) => {
  const a = await session('alice')
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
  const index = readJson<{ signature?: Signature }>(
    join(stack.dataDir, 'blobs', 'backups', 'sync', 'index.json'),
  )
  expect(index?.signature).toEqual(sig)
  // nothing in what the store holds is the secret
  const stored = readFileSync(manifestPath(stack.dataDir, board), 'utf8')
  expect(stored).not.toContain(stack.internalSecret)

  const args = checkedArgs(stack.dataDir, board)
  const run = tool('backup:restore-drill', args, stack.internalSecret)
  test.info().annotations.push({ type: 'drill output', description: run.output })
  expect(run.status, run.output).toBe(0)
  expect(run.output).toContain(`PASS ${board} ${manifest.backups.at(-1)?.file}`)
  expect(run.output).toContain('  ok   offsite manifest signature verified')
  expect(run.output).toContain('  ok   manifest entry signature verified')
  expect(run.output).toContain('restore drill passed')
  expect(run.output).not.toContain('WARN')

  // another secret (here: the development one in apps/sync/dev.env) cannot vouch for this store
  const other = tool('backup:restore-drill', args, null)
  expect(other.status, other.output).toBe(1)
  expect(other.output).toContain('the offsite manifest is signed with another key')
  expect(other.output).toContain('restore drill FAILED')
})

test('a changed backup with a rewritten manifest entry is refused, and an unsigned manifest needs --allow-unsigned', async ({
  session,
  board,
  stack,
}) => {
  const a = await session('alice')
  await drawFrameBoard(a.page, 'tp')
  await a.context.close()
  const manifest = await settledOffsite(stack.dataDir, board)
  const newest = manifest.backups.at(-1)
  const objectPath = join(offsiteDir(stack.dataDir, board), newest?.file ?? 'missing')
  const originalObject = readFileSync(objectPath)
  const originalManifest = readFileSync(manifestPath(stack.dataDir, board))
  const args = checkedArgs(stack.dataDir, board)
  const restoreDir = join(stack.dataDir, 'restore')
  const staged = () =>
    existsSync(restoreDir) ? readdirSync(restoreDir).filter((f) => f.endsWith('.json')) : []

  try {
    // Someone with write access to the bucket changes the backup and recomputes what the entry claims.
    const changed = Buffer.from(originalObject)
    changed[changed.length - 100] = (changed[changed.length - 100] ?? 0) ^ 0xff
    writeFileSync(objectPath, changed)
    const forged = JSON.parse(originalManifest.toString('utf8')) as Manifest
    const entry = forged.backups.at(-1)
    if (!entry) throw new Error('no entry')
    entry.sha256 = createHash('sha256').update(changed).digest('hex')
    entry.sizeBytes = changed.byteLength
    writeFileSync(manifestPath(stack.dataDir, board), JSON.stringify(forged, null, 2))

    const drill = tool('backup:restore-drill', args, stack.internalSecret)
    test.info().annotations.push({ type: 'drill output (tampered)', description: drill.output })
    expect(drill.status, drill.output).toBe(1)
    expect(drill.output).toContain(
      '  FAIL the offsite manifest does not match its signature: it was changed outside the sync server',
    )
    expect(drill.output).toContain('restore drill FAILED')
    for (const extra of ['', ' --allow-unsigned']) {
      const restore = tool('backup:restore-board', `${args}${extra}`, stack.internalSecret)
      expect(restore.status, restore.output).toBe(1)
      expect(restore.output).toContain(`nothing staged for ${board}`)
      expect(staged()).toEqual([])
    }

    // A manifest as written before signing existed (the honest bytes, no signatures anywhere).
    writeFileSync(objectPath, originalObject)
    const legacy = JSON.parse(originalManifest.toString('utf8')) as Manifest
    delete legacy.signature
    for (const e of legacy.backups) delete e.signature
    writeFileSync(manifestPath(stack.dataDir, board), JSON.stringify(legacy, null, 2))
    const strict = tool('backup:restore-drill', args, stack.internalSecret)
    expect(strict.status, strict.output).toBe(1)
    expect(strict.output).toContain(
      'the offsite manifest is not signed (written before backups were signed, or its signature was removed); rerun with --allow-unsigned to accept it',
    )
    const loose = tool('backup:restore-drill', `${args} --allow-unsigned`, stack.internalSecret)
    test.info().annotations.push({ type: 'drill output (--allow-unsigned)', description: loose.output })
    expect(loose.status, loose.output).toBe(0)
    expect(loose.output).toContain(
      '  WARN UNVERIFIED: the offsite manifest is not signed; accepted because of --allow-unsigned',
    )
    expect(loose.output).toContain(`  WARN UNVERIFIED: backup ${newest?.file} is not signed`)
    expect(loose.output).toContain('restore drill passed, with unsigned backups accepted (--allow-unsigned)')
  } finally {
    writeFileSync(objectPath, originalObject)
    writeFileSync(manifestPath(stack.dataDir, board), originalManifest)
  }
  // put back as the server wrote them: verified again, no flag needed
  const after = tool('backup:restore-drill', args, stack.internalSecret)
  expect(after.status, after.output).toBe(0)
  expect(after.output).not.toContain('WARN')
})
