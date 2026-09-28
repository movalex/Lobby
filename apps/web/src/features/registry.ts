// The one list of board features (integration owner). Order = dock order and override order.
import { canvasUxFeature } from './canvas-ux/index.tsx'
import { commentsFeature } from './comments/index.tsx'
import { historyFeature } from './history/index.tsx'
import { presentExportFeature } from './present-export/index.tsx'
import { sharingFeature } from './sharing/index.tsx'
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
]
