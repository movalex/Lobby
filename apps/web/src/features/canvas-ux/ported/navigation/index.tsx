// OWNER: 3b (docs/EXCALIDRAW-CONTRACTS.md §7.2). The ported 'navigation' feature on the Excalidraw board page:
// navigation: minimap, board search, frames panel, start view, copy link and deep links, arrange as grid, select by type, bulk paste, templates, Lobby’s fit camera, level of detail.
// Created empty at wave 1 so features/canvas-registry.ts never changes; 3b fills it (and this folder).
import type { CanvasFeature } from '../../../../canvas/api/index.ts'

export const feature: CanvasFeature = { id: 'navigation' }
