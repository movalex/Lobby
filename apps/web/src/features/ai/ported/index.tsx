// OWNER: 3h (docs/EXCALIDRAW-CONTRACTS.md §7.2). The ported 'ai' feature on the Excalidraw board page:
// AI actions: menus, apply as one transact with customData.lobby.ai.
// Created empty at wave 1 so features/canvas-registry.ts never changes; 3h fills it (and this folder).
import type { CanvasFeature } from '../../../canvas/api/index.ts'

export const feature: CanvasFeature = { id: 'ai' }
