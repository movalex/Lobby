// OWNER: 3e (docs/EXCALIDRAW-CONTRACTS.md §7.2). The ported 'present-export' feature on the Excalidraw board page:
// present and export: frame-by-frame presenting, PNG/SVG/PDF/CSV export, the export dialog.
// Created empty at wave 1 so features/canvas-registry.ts never changes; 3e fills it (and this folder).
import type { CanvasFeature } from '../../../canvas/api/index.ts'

export const feature: CanvasFeature = { id: 'present-export' }
