// OWNER: WS2 (wave S). WS2's entries in the review viewer's slots (../slots.ts), registered once when the media feature
// loads (file-card/ported/CardLayer.tsx imports ./VersionChip.tsx, which imports this): the header's version picker
// and "Compare" (`ws2.versions`, order 10), and the compare slot (`ws2.compare`, every kind: it decides per version).
import { CompareSlot } from '../compare/CompareSlot.tsx'
import { registerViewerSlot } from '../slots.ts'
import { ViewerVersions } from './ViewerVersions.tsx'

registerViewerSlot({ id: 'ws2.versions', slot: 'header', order: 10, Component: ViewerVersions })
registerViewerSlot({ id: 'ws2.compare', slot: 'compare', Component: CompareSlot })
