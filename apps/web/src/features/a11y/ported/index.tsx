// OWNER: 3i (docs/EXCALIDRAW-CONTRACTS.md §7.2). The ported 'a11y' feature on the Excalidraw board page:
// accessibility and phone: live region, keyboard traversal, content list, phone sheet, touch.
// Created empty at wave 1 so features/canvas-registry.ts never changes; 3i fills it (and this folder).
import type { CanvasFeature } from '../../../canvas/api/index.ts'

export const feature: CanvasFeature = { id: 'a11y' }
