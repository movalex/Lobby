// OWNER: 3h (docs/EXCALIDRAW-CONTRACTS.md §7.2). The ported 'history' feature on the Excalidraw board page:
// history: checkpoints panel and preview (exportToCanvas, no second editor).
// Created empty at wave 1 so features/canvas-registry.ts never changes; 3h fills it (and this folder).
import type { CanvasFeature } from '../../../canvas/api/index.ts'

export const feature: CanvasFeature = { id: 'history' }
