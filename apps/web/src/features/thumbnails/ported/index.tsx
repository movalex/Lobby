// OWNER: 3e (docs/EXCALIDRAW-CONTRACTS.md §7.2). The ported 'thumbnails' feature on the Excalidraw board page:
// board thumbnails (export of the start view).
// Created empty at wave 1 so features/canvas-registry.ts never changes; 3e fills it (and this folder).
import type { CanvasFeature } from '../../../canvas/api/index.ts'

export const feature: CanvasFeature = { id: 'thumbnails' }
