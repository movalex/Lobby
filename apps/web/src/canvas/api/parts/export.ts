/**
 * OWNER: 3e (present + export). SVG, PNG and bitmap exports and the clipboard copy, on Excalidraw's
 * exportToSvg / exportToBlob / exportToCanvas with Lobby's own font embedding (canvas/export/**,
 * docs/EXCALIDRAW-MIGRATION.md §2.10.4, §4.5). The engine handles come from canvas/overrides.ts
 * `boardEngineOf(deps.registries)`. Stubs until 3e lands them.
 */
import type { LobbyExport } from '../lobby-canvas.ts'
import { notImplemented } from '../owners.ts'
import type { PartDeps } from './types.ts'

export function createExportPart(_deps: PartDeps): LobbyExport {
  return {
    svg: notImplemented('3e', 'export.svg'),
    png: notImplemented('3e', 'export.png'),
    canvas: notImplemented('3e', 'export.canvas'),
    copy: notImplemented('3e', 'export.copy'),
  }
}
