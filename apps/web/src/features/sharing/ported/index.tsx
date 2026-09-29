// OWNER: 3e (docs/EXCALIDRAW-CONTRACTS.md §7.2). The ported 'sharing' feature on the Excalidraw board page:
// sharing: the share badge and the export-policy sync on the canvas.
// Created empty at wave 1 so features/canvas-registry.ts never changes; 3e fills it (and this folder).
import type { CanvasFeature } from '../../../canvas/api/index.ts'

export const feature: CanvasFeature = { id: 'sharing' }
