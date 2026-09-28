// Offsite board backups (docs/WAVE3-CONTRACTS.md "offsite-backups"), end to end on the real stack with
// the fs driver: a board edited in the browser is backed up by the sync server, copied to the store
// under <DATA>/blobs/backups/sync/<board>/ with a manifest that lists the files the board references,
// and `pnpm --filter @draftroom/sync backup:restore-drill --from=store` restores it from there; a damaged
// offsite copy fails the drill. R2 itself is never contacted here.
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { edit, insertFiles, read, waitForValue } from './support/board.ts'
import { expect, test } from './support/fixtures.ts'
import { drawFrameBoard, expectServerHasTab, fixture, uploadImage } from './support/history.ts'
import { REPO_ROOT } from './support/stack.ts'

// The sync server of this file's stack copies its backups to the fs store, and backs changed boards
// up every 1.5 s instead of every 15 minutes.
test.use({ syncEnv: { DRAFTROOM_BACKUP_STORE: 'fs', DRAFTROOM_BACKUP_INTERVAL_MS: '1500' } })

interface LocalManifest {
  backups: { file: string; documentClock: number; sha256: string; sizeBytes: number }[]
}
interface OffsiteManifest {
  format: string
  boardId: string
  backups: {
    file: string
    key: string
    documentClock: number
    sha256: string
    sizeBytes: number
    schema: unknown
    createdAt: string
    uploadedAt: string
    assets: { assetId: string; versionId: string }[]
  }[]
}

const readJson = <T>(path: string): T | null =>
  existsSync(path) ? (JSON.parse(readFileSync(path, 'utf8')) as T) : null
const localManifest = (dataDir: string, board: string) =>
  readJson<LocalManifest>(join(dataDir, 'backups', board, 'manifest.json'))
const offsiteDir = (dataDir: string, board: string) => join(dataDir, 'blobs', 'backups', 'sync', board)
const offsiteManifest = (dataDir: string, board: string) =>
  readJson<OffsiteManifest>(join(offsiteDir(dataDir, board), 'manifest.json'))

/**
 * Waits until the newest local backup is also the newest offsite one, and stays so for a few backup
 * intervals (the board has stopped changing, so it is the board's current state).
 */
async function settledOffsite(dataDir: string, board: string): Promise<OffsiteManifest> {
  let last = ''
  let stableSince = 0
  const value = await waitForValue(
    async () => {
      const local = localManifest(dataDir, board)?.backups.at(-1)?.file
      const offsite = offsiteManifest(dataDir, board)
      const newest = offsite?.backups.at(-1)?.file
      if (!local || local !== newest) {
        last = ''
        return null
      }
      if (local !== last) {
        last = local
        stableSince = Date.now()
        return null
      }
      return Date.now() - stableSince >= 5_000 ? offsite : null
    },
    { timeout: 60_000, message: 'the newest local backup is offsite and the board has settled' },
  )
  return value
}

function drill(dataDir: string, board: string) {
  const env: NodeJS.ProcessEnv = { ...process.env }
  for (const key of Object.keys(env))
    if (key.startsWith('DRAFTROOM_') || key.startsWith('R2_') || key === 'NODE_OPTIONS') delete env[key]
  env.DRAFTROOM_BACKUP_STORE = 'fs'
  if (/["\r\n]/.test(dataDir)) throw new Error(`unexpected data dir ${dataDir}`)
  if (!/^[a-z0-9][a-z0-9_-]{2,63}$/.test(board)) throw new Error(`bad board id ${board}`)
  const command = `pnpm --filter @draftroom/sync backup:restore-drill --from=store --data-dir "${dataDir}" --board ${board}`
  const r = spawnSync(command, {
    cwd: REPO_ROOT,
    env,
    encoding: 'utf8',
    shell: true,
    windowsHide: true,
    timeout: 120_000,
  })
  return { status: r.status, output: `${r.stdout ?? ''}${r.stderr ?? ''}${r.error ? String(r.error) : ''}` }
}

test('an edited board is copied offsite with a manifest of its files, and the drill restores it from the store', async ({
  session,
  board,
  users,
  stack,
}) => {
  const a = await session('alice')
  await drawFrameBoard(a.page, 'ob')
  const image = await uploadImage(a.page, board)
  await insertFiles(a.page, [fixture('document.pdf')])
  const card = await waitForValue(
    () =>
      read(a.page, (ed) => {
        const s = ed.getCurrentPageShapes().find((x) => x.type === 'dr-file-card')
        const p = s?.props as { assetId?: string; versionId?: string } | undefined
        return p?.assetId?.startsWith('ast_') && p.versionId
          ? { assetId: p.assetId, versionId: p.versionId }
          : null
      }),
    { timeout: 30_000, message: 'the PDF file card has its asset ids' },
  )
  await edit(a.page, (ed) =>
    ed.createShape({ id: 'shape:ob-last', type: 'geo', x: 900, y: 80, props: { w: 80, h: 80 } }),
  )
  await expectServerHasTab(await users.api('alice'), board, a.page)
  // Nobody edits from here on: the backups catch up with the board and stop.
  await a.context.close()

  const manifest = await settledOffsite(stack.dataDir, board)
  const newest = manifest.backups.at(-1)
  const local = localManifest(stack.dataDir, board)?.backups.at(-1)
  expect(manifest).toMatchObject({ format: 'draftroom-offsite-board-backups', boardId: board })
  expect(newest).toMatchObject({
    file: local?.file,
    key: `backups/sync/${board}/${local?.file}`,
    documentClock: local?.documentClock,
    sha256: local?.sha256,
    sizeBytes: local?.sizeBytes,
  })
  expect(newest?.schema).toBeTruthy()
  // the stored object is the local backup, byte for byte
  const object = readFileSync(join(offsiteDir(stack.dataDir, board), newest?.file ?? 'missing'))
  expect(createHash('sha256').update(object).digest('hex')).toBe(newest?.sha256)
  expect(object.byteLength).toBe(newest?.sizeBytes)
  // both kinds of file references: the image's asset record and the PDF's file card
  expect(newest?.assets).toEqual(expect.arrayContaining([image.file, card]))
  const index = readJson<{ boards: { boardId: string; latestFile: string }[] }>(
    join(stack.dataDir, 'blobs', 'backups', 'sync', 'index.json'),
  )
  expect(index?.boards).toContainEqual(expect.objectContaining({ boardId: board, latestFile: newest?.file }))

  const run = drill(stack.dataDir, board)
  test.info().annotations.push({ type: 'drill output', description: run.output })
  expect(run.status, run.output).toBe(0)
  expect(run.output).toContain(`PASS ${board} ${newest?.file}`)
  expect(run.output).toContain(
    `downloaded backups/sync/${board}/${newest?.file} from the fs store (${newest?.sizeBytes} bytes)`,
  )
  expect(run.output).toContain('file sha256 matches the manifest')
  expect(run.output).toContain('opened through the sync room registry; every record identical')
  expect(run.output).toContain('identical to the live board (unchanged since the backup)')
  expect(run.output).toContain('restore drill passed')
  expect(run.output).not.toContain('FAIL')
})

test('a damaged offsite copy fails the drill from the store', async ({ session, board, stack }) => {
  const a = await session('alice')
  await drawFrameBoard(a.page, 'od')
  await a.context.close()
  const manifest = await settledOffsite(stack.dataDir, board)
  const file = join(offsiteDir(stack.dataDir, board), manifest.backups.at(-1)?.file ?? 'missing')
  const original = readFileSync(file)
  const damaged = Buffer.from(original)
  damaged[damaged.length - 100] = (damaged[damaged.length - 100] ?? 0) ^ 0xff
  writeFileSync(file, damaged)
  try {
    const run = drill(stack.dataDir, board)
    expect(run.status, run.output).toBe(1)
    expect(run.output).toContain(`FAIL ${board}`)
    expect(run.output).toContain('backup file checksum does not match its manifest')
    expect(run.output).toContain('restore drill FAILED')
  } finally {
    writeFileSync(file, original)
  }
  expect(drill(stack.dataDir, board).status).toBe(0)
})
