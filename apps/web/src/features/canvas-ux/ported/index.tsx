// OWNER: 3a (docs/EXCALIDRAW-CONTRACTS.md §7.2). The ported 'canvas-ux' feature on the Excalidraw board page:
// the canvas tools: toolbar, style panel, keys (Miro shortcuts, keyboard safety, type-to-edit), context and board menus, selection bar, double-click note, locked hint, export gate, defaults.
// Created empty at wave 1 so features/canvas-registry.ts never changes; 3a fills it (and this folder).
import type { CanvasFeature } from '../../../canvas/api/index.ts'

export const feature: CanvasFeature = { id: 'canvas-ux' }
