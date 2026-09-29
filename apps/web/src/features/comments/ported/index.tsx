// OWNER: 3c (docs/EXCALIDRAW-CONTRACTS.md §7.2). The ported 'comments' feature on the Excalidraw board page:
// comments: the comment tool, pins that follow elements, the panel, the top-bar bell.
// Created empty at wave 1 so features/canvas-registry.ts never changes; 3c fills it (and this folder).
import type { CanvasFeature } from '../../../canvas/api/index.ts'

export const feature: CanvasFeature = { id: 'comments' }
