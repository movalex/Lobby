// OWNER: 3g. The api's live facts for the media feature's cards and viewers on the Excalidraw board page:
// one AssetMetaStore for the page (versions are immutable: a terminal meta is cached for the page's life,
// a version still processing is polled only while a card or a viewer shows it).
import { AssetMetaStore } from '../../assets/meta-store.ts'

export const mediaMetaStore = new AssetMetaStore()
