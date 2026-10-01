// The backup side of the sync server, wired by app.ts: staged restores applied before the server
// listens (staged-restore.ts), the offsite copy of every local backup (offsite.ts), and
// GET /internal/backups/status (behind the internal secret, like every /internal route).

import type { ServerResponse } from 'node:http'
import type { SyncConfig } from '../config.ts'
import { sendJson } from '../http/respond.ts'
import { OffsiteBackups, type OffsiteStatus, offsiteOffStatus } from './offsite.ts'
import { backupSigningKey } from './signing.ts'
import { applyStagedRestores } from './staged-restore.ts'
import { describeBackupStore, openBackupStore } from './store.ts'

export interface BackupService {
  /** Call before the server accepts anything: applies staged restores, then starts the offsite copy. */
  start(): Promise<void>
  stop(): Promise<void>
  status(): OffsiteStatus
  /**
   * Copies what one board's local backups are missing offsite now (POST /internal/backups/run-all).
   * Resolves with the object key of backup `file` once the store holds it; null when offsite backups
   * are off, or when that copy did not make it (the failure is in status()).
   */
  copyOffsite(boardId: string, file: string): Promise<string | null>
}

export function createBackupService(opts: {
  /** The offsite copies are signed with `backupSigningSecret`; the derived key of `internalSecret` verifies older ones (signing.ts). */
  config: Pick<
    SyncConfig,
    'dataDir' | 'backupStore' | 'backupIntervalMs' | 'internalSecret' | 'backupSigningSecret'
  >
  /** The registry's local backups root; null when local backups are off (then nothing goes offsite). */
  backupsDir: string | null
  log: (...a: unknown[]) => void
}): BackupService {
  const { config, backupsDir, log } = opts
  const store = backupsDir ? openBackupStore(config.backupStore) : null
  const signingKey = store
    ? backupSigningKey({ backup: config.backupSigningSecret ?? null, internal: config.internalSecret })
    : null
  const offsite =
    store && backupsDir && signingKey
      ? new OffsiteBackups({
          store,
          localRoot: backupsDir,
          signingKey,
          intervalMs: config.backupIntervalMs,
          log,
        })
      : null
  log(`[backup] offsite backups: ${offsite ? describeBackupStore(config.backupStore) : 'off'}`)
  // Key ids are hashes, never secrets (signing.ts). The derived key signing in production is refused by
  // loadConfig; outside it, the line says what to set.
  if (offsite && signingKey)
    log(
      signingKey.source === 'dedicated'
        ? `[backup] offsite backups signed with DRAFTROOM_BACKUP_SIGNING_SECRET (key id ${signingKey.id}); the key derived from DRAFTROOM_INTERNAL_SECRET (key id ${signingKey.verifyOnlyIds.join(', ')}) only verifies older backups`
        : `[backup] offsite backups signed with the key derived from DRAFTROOM_INTERNAL_SECRET (key id ${signingKey.id}): set DRAFTROOM_BACKUP_SIGNING_SECRET (docs/DEPLOY.md "Signed backups")`,
    )
  return {
    async start() {
      await applyStagedRestores({ dataDir: config.dataDir, log })
      offsite?.start()
    },
    async stop() {
      await offsite?.stop()
    },
    status: () => offsite?.status() ?? offsiteOffStatus(),
    async copyOffsite(boardId, file) {
      if (!offsite) return null
      await offsite.syncBoard(boardId)
      return offsite.storedKey(boardId, file)
    },
  }
}

/** GET /internal/backups/status: the last offsite success and the failure counts, per board. */
export function handleBackupStatus(res: ServerResponse, backups: Pick<BackupService, 'status'> | undefined) {
  sendJson(res, 200, backups?.status() ?? offsiteOffStatus())
}
