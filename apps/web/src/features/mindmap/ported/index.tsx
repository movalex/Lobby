// OWNER: 3d (docs/EXCALIDRAW-CONTRACTS.md §7.2). The ported 'mindmap' feature on the Excalidraw board page:
// mind maps: layout inside transact, keys, collapse (canvas.hide + the hit guard).
// Created empty at wave 1 so features/canvas-registry.ts never changes; 3d fills it (and this folder).
import type { CanvasFeature } from '../../../canvas/api/index.ts'

export const feature: CanvasFeature = { id: 'mindmap' }
