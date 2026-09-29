// OWNER: 3g (docs/EXCALIDRAW-CONTRACTS.md §7.2). The ported 'media' feature on the Excalidraw board page:
// media: file cards, the viewers, paste/drop/insert of files, derivatives.
// Created empty at wave 1 so features/canvas-registry.ts never changes; 3g fills it (and this folder).
import type { CanvasFeature } from '../../canvas/api/index.ts'

export const feature: CanvasFeature = { id: 'media' }
