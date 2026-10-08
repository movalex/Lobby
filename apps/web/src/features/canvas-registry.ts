// The one list of PORTED board features for the Excalidraw board page (docs/EXCALIDRAW-CONTRACTS.md §4,
// §7.2), in dock and registration order. Frozen at wave 1: each entry is its owner's file, created empty,
// so no wave-3 owner edits this list. A new feature is a change request. The tldraw page keeps
// features/registry.ts (BOARD_FEATURES) until wave 4.
import type { CanvasFeature } from '../canvas/api/index.ts'
import { feature as mediaFeature } from '../file-card/ported/index.tsx'
import { feature as a11yFeature } from './a11y/ported/index.tsx'
import { feature as aiFeature } from './ai/ported/index.tsx'
import { feature as canvasUxFeature } from './canvas-ux/ported/index.tsx'
import { feature as navigationFeature } from './canvas-ux/ported/navigation/index.tsx'
import { feature as commentsFeature } from './comments/ported/index.tsx'
import { feature as cursorChatFeature } from './cursor-chat/ported/index.tsx'
import { feature as historyFeature } from './history/ported/index.tsx'
import { feature as mindmapFeature } from './mindmap/ported/index.tsx'
import { feature as peopleFeature } from './people/ported/index.tsx'
import { feature as presentLiveFeature } from './present-export/live/ported/index.tsx'
import { feature as presentExportFeature } from './present-export/ported/index.tsx'
import { feature as sharingFeature } from './sharing/ported/index.tsx'
import { feature as tagsFeature } from './tags/ported/index.tsx'
import { feature as thumbnailsFeature } from './thumbnails/ported/index.tsx'
import { feature as workshopsFeature } from './workshops/ported/index.tsx'

export const CANVAS_FEATURES: readonly CanvasFeature[] = [
  canvasUxFeature,
  navigationFeature,
  commentsFeature,
  workshopsFeature,
  presentExportFeature,
  presentLiveFeature,
  historyFeature,
  sharingFeature,
  thumbnailsFeature,
  peopleFeature,
  mindmapFeature,
  tagsFeature,
  aiFeature,
  mediaFeature,
  a11yFeature,
  // wave K (K6-4): cursor chat, a change request of its own (its '/' and its two overlays)
  cursorChatFeature,
]
