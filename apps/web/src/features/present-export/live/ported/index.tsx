// OWNER: 3c (docs/EXCALIDRAW-CONTRACTS.md §7.2). The ported 'present-live' feature on the Excalidraw board page:
// present to everyone (live follow of the presenter).
// Created empty at wave 1 so features/canvas-registry.ts never changes; 3c fills it (and this folder).
import type { CanvasFeature } from '../../../../canvas/api/index.ts'

export const feature: CanvasFeature = { id: 'present-live' }
