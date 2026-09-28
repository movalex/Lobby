import type { DataLayout } from '@draftroom/dev-assets'
import type { AppContext } from '../context.ts'
import type { EventHub } from '../events/hub.ts'
import type { BlobStore } from '../files/blobs.ts'
import type { SyncInternalClient } from '../sync-internal.ts'

/** Everything a feature module (apps/api/src/features/<name>) gets. */
export interface FeatureContext extends AppContext {
  /** Publish board events AFTER the transaction commits (see events/hub.ts). */
  events: EventHub
  /** Snapshot / seed boards through the sync server. */
  sync: SyncInternalClient
  /** DRAFTROOM_DATA_DIR's layout (legacy local paths, e.g. pre-M3 checkpoint bodies). */
  layout: DataLayout
  /** The object store (fs or R2, docs/M3-STORAGE-CONTRACTS.md §1): originals, derivatives, checkpoint bodies. */
  blobs: BlobStore
}
