// OWNER: 3d (docs/EXCALIDRAW-CONTRACTS.md §7.2). The ported 'tags' feature on the Excalidraw board page:
// tags: tag:<key> customData, tagDef:<key> doc keys, chips, the panel.
// Created empty at wave 1 so features/canvas-registry.ts never changes; 3d fills it (and this folder).
import type { CanvasFeature } from '../../../canvas/api/index.ts'

export const feature: CanvasFeature = { id: 'tags' }
