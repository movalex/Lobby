import type { DataLayout } from '@draftroom/dev-assets'
import type { AppContext } from '../context.ts'
import type { EventHub } from '../events/hub.ts'
import type { SyncInternalClient } from '../sync-internal.ts'

/** Everything a feature module (apps/api/src/features/<name>) gets. */
export interface FeatureContext extends AppContext {
  /** Publish board events AFTER the transaction commits (see events/hub.ts). */
  events: EventHub
  /** Snapshot / seed boards through the sync server. */
  sync: SyncInternalClient
  /** The local file store (object-storage stand-in). */
  layout: DataLayout
}
