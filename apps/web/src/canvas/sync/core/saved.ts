/**
 * "Saved, exactly" (docs/EXCALIDRAW-MIGRATION.md §2.5.7), pure. "Saved" only when nothing is dirty,
 * nothing is in flight, nothing is queued offline and every sent push has its ack (acks go out after
 * COMMIT with synchronous=FULL, so Saved means on disk).
 *
 * NODE-SAFE (CONTRACTS.md).
 */
import type { SaveStatus } from '../types.ts'

/** How long UNAVAILABLE retries show "Saving…" before "Can't save right now — retrying" (§2.5.7). */
export const RETRYING_AFTER_MS = 30_000

export interface SaveInputs {
  /** a socket is open and its welcome (and snapshot) processed */
  readonly connected: boolean
  /** elements with unsent (or lease-gated) changes */
  readonly dirty: number
  /** ops in pushes without an ack */
  readonly inflightOps: number
  /** changes queued on this device while offline */
  readonly offlineQueued: number
  /**
   * Changes that may exist but are not known yet (the previous page's offline queue, not read yet): they
   * keep Saved away (V1 N20) but are not offline changes, so a page opening with an empty queue reads as
   * connecting, not as "Offline — 1 change" (A11Y-14, CR-3I-6).
   */
  readonly unknown?: number
  /** since when pushes come back UNAVAILABLE (null: they do not) */
  readonly unavailableSince: number | null
  /** the last non-retryable reject, until a later push is accepted whole */
  readonly lastReject: SaveStatus['lastReject']
  readonly now: number
}

export function computeSaveStatus(i: SaveInputs): SaveStatus {
  const pending = i.dirty + i.inflightOps + (i.unknown ?? 0) + (i.connected ? 0 : i.offlineQueued)
  const base = {
    pending,
    offlineChanges: i.connected ? 0 : Math.max(i.offlineQueued, i.dirty + i.inflightOps),
  }
  if (!i.connected) return { ...base, state: 'offline', lastReject: i.lastReject }
  if (i.unavailableSince !== null && i.now - i.unavailableSince >= RETRYING_AFTER_MS)
    return { ...base, state: 'retrying', lastReject: i.lastReject }
  if (pending > 0) return { ...base, state: 'saving', lastReject: i.lastReject }
  if (i.lastReject) return { ...base, state: 'not-saved', lastReject: i.lastReject }
  return { ...base, state: 'saved', lastReject: null }
}
