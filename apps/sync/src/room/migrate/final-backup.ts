// The final pre-cut-over backup of a board, as the conversion needs it (docs/EXCALIDRAW-MIGRATION.md §5.3
// step 3 and its verification table, §5.6, §7.5 steps 4 and 6; the cut-over runbook's gap G4). 2B.
//
// R0's `POST /internal/backups/run-all`, run after maintenance went on, wrote one backup of every board
// into the sync disk's local manifest (`<data>/backups/<board>/manifest.json`), held 90 days (`holdUntil`),
// and copied it offsite. The disk outlives the deploy, so the Excalidraw build reads that manifest when
// `convert-all` runs: the board's NEWEST held entry described from tldraw tables (no `format`) is its
// final backup. The conversion compares the tldraw records it converts with that entry's `recordsSha256`
// and refuses the board when they differ (`backup-digest`: an edit landed after the backup, or the
// backup is not the final one; convert-board.ts), and records the entry's offsite object key as
// `converted_from.backupKey`.
//
// Only a maintenance run (`convert-all`) consults it (service.ts): a board converted lazily on open (a
// restored old backup, a board made on R0 during a rollback) has no final backup, and the plan gives it
// `backupKey: null` (§5.3 "Lazy"). Entries in an lb format (`lobby-elements`, `lobby-elements-converted`)
// describe lb_* tables, not the tldraw records a conversion reads, so they never count. Read-only.

import { BACKUP_FILE_RE, type BackupManifest, isHeld, readManifest } from '../../backup/backup.ts'
import { BOARD_ID_RE } from '../../rooms.ts'

/**
 * The offsite key layout (backup/store.ts OFFSITE_PREFIX, offsite-manifest.ts offsiteKeys.file), spelled
 * here so that this module, which the migrate index re-exports into e2e scripts, never loads the blob
 * store. final-backup.test.ts holds the two spellings together.
 */
const OFFSITE_PREFIX = 'backups/sync'
const offsiteKeyOf = (boardId: string, file: string) => {
  if (!BOARD_ID_RE.test(boardId) || !BACKUP_FILE_RE.test(file)) throw new Error('invalid backup name')
  return `${OFFSITE_PREFIX}/${boardId}/${file}`
}

export interface FinalBackup {
  /**
   * The backup file's object key in the offsite store (`backups/sync/<board>/<file>`, offsite-manifest.ts;
   * run-all reports the same as `offsiteKey`). Its local copy is `<data>/backups/<board>/<file>`.
   */
  readonly key: string
  /** The entry's digest of the tldraw records: what the converted records must equal. */
  readonly recordsSha256: string
  readonly file: string
  readonly documentClock: number
  readonly holdUntil: string
}

const SHA_RE = /^[0-9a-f]{64}$/

/**
 * The board's newest held, tldraw-described backup entry in the local manifest, or null when it has
 * none (no run-all ran, or every held entry is in an lb format). Throws when the manifest exists but
 * cannot be read (the caller decides; service.ts converts without the check and says so in its log).
 */
export function finalBackupOf(backupsDir: string, boardId: string, now = Date.now()): FinalBackup | null {
  const manifest: BackupManifest | null = readManifest(backupsDir, boardId)
  if (!manifest) return null
  let newest: BackupManifest['backups'][number] | null = null
  for (const e of manifest.backups) {
    if (!isHeld(e, now) || e.format !== undefined) continue
    if (typeof e.recordsSha256 !== 'string' || !SHA_RE.test(e.recordsSha256)) continue
    if (!newest || Date.parse(e.createdAt) >= Date.parse(newest.createdAt)) newest = e
  }
  if (!newest) return null
  return {
    key: offsiteKeyOf(boardId, newest.file),
    recordsSha256: newest.recordsSha256,
    file: newest.file,
    documentClock: newest.documentClock,
    holdUntil: newest.holdUntil as string,
  }
}
