// OWNER: 3f (docs/EXCALIDRAW-CONTRACTS.md §7.2). The ported 'workshops' feature on the Excalidraw board page:
// workshops: the vote tool and badges, +1, private notes, timer, raise hand, reactions.
// Created empty at wave 1 so features/canvas-registry.ts never changes; 3f fills it (and this folder).
import type { CanvasFeature } from '../../../canvas/api/index.ts'

export const feature: CanvasFeature = { id: 'workshops' }
