// Helpers for the ported backup specs (backups-2.spec.ts, offsite-backups.spec.ts) on the Excalidraw stack:
// the sync server's local and offsite manifests under the stack's data dir (fs store), waiting until a
// board's newest local backup is offsite and the board has settled, and the owner's backup tools
// (`pnpm --filter @draftroom/sync backup:restore-drill|backup:restore-board --from=store`) run the way
// docs/DEPLOY.md shows. The two tldraw specs each carried a copy of these; the port shares them.
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { waitForValue } from '../tests/support/board.ts'
import { REPO_ROOT } from '../tests/support/stack.ts'

/**
 * The sync env of a backup spec's stack: backups copied to the fs store (under <DATA>/blobs), and changed
 * boards backed up every 1.5 s instead of every 15 minutes. On the Excalidraw stack this turns the element
 * backups (apps/sync/src/backup/element-backups.ts) and the offsite copy on; EXCALIDRAW_SYNC_ENV's `off`
 * is the default this overrides.
 */
export const OFFSITE_SYNC_ENV: Readonly<Record<string, string>> = {
  DRAFTROOM_BACKUP_STORE: 'fs',
  DRAFTROOM_BACKUP_INTERVAL_MS: '1500',
}

export interface Signature {
  alg: string
  keyId: string
  value: string
}

export interface LocalEntry {
  file: string
  documentClock: number
  recordCount: number
  sha256: string
  sizeBytes: number
  format?: string
}
export interface LocalManifest {
  backups: LocalEntry[]
}

export interface OffsiteEntry extends LocalEntry {
  key: string
  schema: unknown
  createdAt: string
  uploadedAt: string
  assets: { assetId: string; versionId: string }[]
  signature?: Signature
}
export interface OffsiteManifest {
  format: string
  boardId: string
  signature?: Signature
  backups: OffsiteEntry[]
}
export interface OffsiteIndex {
  signature?: Signature
  boards: { boardId: string; latestFile: string }[]
}

export const readJson = <T>(path: string): T | null =>
  existsSync(path) ? (JSON.parse(readFileSync(path, 'utf8')) as T) : null

export const localManifest = (dataDir: string, board: string) =>
  readJson<LocalManifest>(join(dataDir, 'backups', board, 'manifest.json'))

export const offsiteDir = (dataDir: string, board: string) => join(dataDir, 'blobs', 'backups', 'sync', board)
export const offsiteManifestPath = (dataDir: string, board: string) =>
  join(offsiteDir(dataDir, board), 'manifest.json')
export const offsiteManifest = (dataDir: string, board: string) =>
  readJson<OffsiteManifest>(offsiteManifestPath(dataDir, board))
export const offsiteIndex = (dataDir: string) =>
  readJson<OffsiteIndex>(join(dataDir, 'blobs', 'backups', 'sync', 'index.json'))

/**
 * Waits until the newest local backup is also the newest offsite one, and stays so for a few backup
 * intervals (the board has stopped changing, so it is the board's current state).
 */
export async function settledOffsite(dataDir: string, board: string): Promise<OffsiteManifest> {
  let last = ''
  let stableSince = 0
  return waitForValue(
    async () => {
      const local = localManifest(dataDir, board)?.backups.at(-1)?.file
      const offsite = offsiteManifest(dataDir, board)
      if (!local || local !== offsite?.backups.at(-1)?.file) {
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
}

export type BackupTool = 'backup:restore-drill' | 'backup:restore-board'

export interface ToolRun {
  status: number | null
  output: string
}

/**
 * Runs one of the owner's backup tools against the fs store (pnpm script, as docs/DEPLOY.md shows).
 * `internalSecret`: the stack's own DRAFTROOM_INTERNAL_SECRET, so the tool verifies what its sync server
 * signed (it wins over apps/sync/dev.env, which --env-file never lets override the environment); null
 * leaves whatever dev.env says (the development secret, not this stack's).
 */
export function backupTool(script: BackupTool, args: string, internalSecret: string | null): ToolRun {
  const env: NodeJS.ProcessEnv = { ...process.env }
  for (const key of Object.keys(env))
    if (key.startsWith('DRAFTROOM_') || key.startsWith('R2_') || key === 'NODE_OPTIONS') delete env[key]
  env.DRAFTROOM_BACKUP_STORE = 'fs'
  if (internalSecret !== null) env.DRAFTROOM_INTERNAL_SECRET = internalSecret
  // One command line through the shell (pnpm is a .cmd shim on Windows); every part is ours and checked.
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

/** `--from=store --data-dir … --board …` for a stack's data dir and one board (both checked first). */
export function storeArgs(dataDir: string, board: string): string {
  if (/["\r\n]/.test(dataDir)) throw new Error(`unexpected data dir ${dataDir}`)
  if (!/^[a-z0-9][a-z0-9_-]{2,63}$/.test(board)) throw new Error(`bad board id ${board}`)
  return `--from=store --data-dir "${dataDir}" --board ${board}`
}

/** The restore drill from the store, verifying with the stack's own secret. */
export const drillFromStore = (dataDir: string, board: string, internalSecret: string) =>
  backupTool('backup:restore-drill', storeArgs(dataDir, board), internalSecret)

/** A changed copy of `bytes`: one byte near the end flipped. */
export function damaged(bytes: Buffer): Buffer {
  const out = Buffer.from(bytes)
  const at = out.length - 100
  out[at] = (out[at] ?? 0) ^ 0xff
  return out
}
