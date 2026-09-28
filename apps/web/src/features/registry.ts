// The one list of board features (integration owner). Order = dock order and override order.
import { aiFeature } from './ai/index.tsx'
import { canvasUxFeature } from './canvas-ux/index.tsx'
import { commentsFeature } from './comments/index.tsx'
import { historyFeature } from './history/index.tsx'
import { mindmapFeature } from './mindmap/index.tsx'
import { peopleFeature } from './people/index.tsx'
import { presentExportFeature } from './present-export/index.tsx'
import { sharingFeature } from './sharing/index.tsx'
import { tagsFeature } from './tags/index.tsx'
import { thumbnailsFeature } from './thumbnails/index.tsx'
import type { BoardFeature } from './types.ts'
import { workshopsFeature } from './workshops/index.tsx'

export const BOARD_FEATURES: readonly BoardFeature[] = [
  canvasUxFeature,
  commentsFeature,
  workshopsFeature,
  presentExportFeature,
  historyFeature,
  sharingFeature,
  thumbnailsFeature,
  peopleFeature,
  mindmapFeature,
  tagsFeature,
  aiFeature,
]
