// Storage settings beyond the per-workspace upload quota (config.ts `uploads`): what one name-only
// guest may upload (SEAM-02), how many boards a workspace may hold (SEAM-11), and the collector of
// uploaded files nothing references any more (UPL-1, gc.ts). Parsed by loadConfig() into
// ApiConfig.storage. Error messages name variables, never values.

import { ASSET_GC_MODES, type AssetGcMode } from '@draftroom/contracts'

export interface StorageConfig {
  /**
   * SEAM-02: what ONE name-only guest (a user with no account) may store in a workspace: originals
   * they uploaded, bytes and files. Account users only have the workspace quota.
   */
  guestQuota: { maxBytes: number; maxFiles: number }
  /** SEAM-11: boards per workspace, every status counted (a trashed board keeps its canvas and files). */
  maxBoardsPerWorkspace: number
  assetGc: {
    /** DRAFTROOM_ASSET_GC: off | report (default: marks and reports, never deletes) | delete. */
    mode: AssetGcMode
    /** Between two passes (DRAFTROOM_ASSET_GC_INTERVAL_MIN, default 6 hours). */
    intervalMs: number
    /** From start to the first pass (a deploy never starts with a full pass). */
    firstRunDelayMs: number
  }
}

const MiB = 1024 * 1024
const MINUTE = 60_000

export const DEFAULT_STORAGE_CONFIG: Readonly<StorageConfig> = Object.freeze<StorageConfig>({
  guestQuota: { maxBytes: 1024 * MiB, maxFiles: 200 },
  maxBoardsPerWorkspace: 10_000,
  assetGc: { mode: 'report', intervalMs: 360 * MINUTE, firstRunDelayMs: 10 * MINUTE },
})

type Env = Record<string, string | undefined>

function int(env: Env, name: string, fallback: number, min: number, max: number): number {
  const raw = env[name]?.trim()
  if (!raw) return fallback
  if (!/^\d+$/.test(raw)) throw new Error(`${name} must be a whole number`)
  const n = Number(raw)
  if (n < min || n > max) throw new Error(`${name} must be between ${min} and ${max}`)
  return n
}

export function parseStorageConfig(env: Env): StorageConfig {
  const d = DEFAULT_STORAGE_CONFIG
  const modeRaw = env.DRAFTROOM_ASSET_GC?.trim() || d.assetGc.mode
  if (!(ASSET_GC_MODES as readonly string[]).includes(modeRaw))
    throw new Error(`DRAFTROOM_ASSET_GC must be ${ASSET_GC_MODES.join(', ')}`)
  return {
    guestQuota: {
      maxBytes: int(env, 'DRAFTROOM_GUEST_QUOTA_MB', d.guestQuota.maxBytes / MiB, 1, 10_000_000) * MiB,
      maxFiles: int(env, 'DRAFTROOM_GUEST_MAX_FILES', d.guestQuota.maxFiles, 1, 100_000_000),
    },
    maxBoardsPerWorkspace: int(env, 'DRAFTROOM_WORKSPACE_MAX_BOARDS', d.maxBoardsPerWorkspace, 1, 10_000_000),
    assetGc: {
      mode: modeRaw as AssetGcMode,
      intervalMs:
        int(env, 'DRAFTROOM_ASSET_GC_INTERVAL_MIN', d.assetGc.intervalMs / MINUTE, 5, 10_080) * MINUTE,
      firstRunDelayMs: d.assetGc.firstRunDelayMs,
    },
  }
}
