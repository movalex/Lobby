// The backup side of the sync server, wired by app.ts: staged restores applied before the server
// listens (staged-restore.ts), the offsite copy of every local backup (offsite.ts), and
// GET /internal/backups/status (behind the internal secret, like every /internal route).

import type { ServerResponse } from 'node:http'
import type { SyncConfig } from '../config.ts'
import { sendJson } from '../http/respond.ts'
import { OffsiteBackups, type OffsiteStatus, offsiteOffStatus } from './offsite.ts'
import { applyStagedRestores } from './staged-restore.ts'
import { describeBackupStore, openBackupStore } from './store.ts'

export interface BackupService {
  /** Call before the server accepts anything: applies staged restores, then starts the offsite copy. */
  start(): Promise<void>
  stop(): Promise<void>
  status(): OffsiteStatus
}

export function createBackupService(opts: {
  config: Pick<SyncConfig, 'dataDir' | 'backupStore' | 'backupIntervalMs'>
  /** The registry's local backups root; null when local backups are off (then nothing goes offsite). */
  backupsDir: string | null
  log: (...a: unknown[]) => void
}): BackupService {
  const { config, backupsDir, log } = opts
  const store = backupsDir ? openBackupStore(config.backupStore) : null
  const offsite =
    store && backupsDir
      ? new OffsiteBackups({ store, localRoot: backupsDir, intervalMs: config.backupIntervalMs, log })
      : null
  log(`[backup] offsite backups: ${offsite ? describeBackupStore(config.backupStore) : 'off'}`)
  return {
    async start() {
      await applyStagedRestores({ dataDir: config.dataDir, log })
      offsite?.start()
    },
    async stop() {
      await offsite?.stop()
    },
    status: () => offsite?.status() ?? offsiteOffStatus(),
  }
}

/** GET /internal/backups/status: the last offsite success and the failure counts, per board. */
export function handleBackupStatus(res: ServerResponse, backups: Pick<BackupService, 'status'> | undefined) {
  sendJson(res, 200, backups?.status() ?? offsiteOffStatus())
}
