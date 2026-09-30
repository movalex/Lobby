/**
 * OWNER: 3e (present + export). SVG, PNG and bitmap exports and the clipboard copy, on Excalidraw's
 * exportToSvg / exportToCanvas with Lobby's own font embedding and export-only files maps
 * (canvas/export/**, docs/EXCALIDRAW-MIGRATION.md §2.10.4, §4.5). The engine handles come from
 * canvas/overrides.ts `boardEngineOf(deps.registries)`, the file resolver from canvas/files/board.ts
 * `boardFilesOf`; nothing here writes the scene.
 *
 * Like 2C's board-page members, the part is real when the board page's engine is attached before the
 * canvas is created (the board page attaches it first: canvas/board/session.ts `attach`), and a stub
 * naming 3e on a bare port (the contracts test's canvas), which has no engine to export from.
 *
 * `copy` does not read the board's export policy: the canvas has no policy store, so every caller checks
 * it first (present-export's commands and dialog, through features/sharing/ported/export-policy.ts), and
 * the api refuses originals to people the policy limits whatever the client does.
 */

import type { SceneExportContext } from '../../export/scene.ts'
import { boardFilesOf } from '../../files/board.ts'
import { boardEngineOf } from '../../overrides.ts'
import type { ExportOptions, LobbyExport } from '../lobby-canvas.ts'
import { notImplemented } from '../owners.ts'
import type { PartDeps } from './types.ts'

/** Puts `data` on the clipboard now (inside the user's gesture), resolving the bytes later. */
function writeClipboard(type: 'image/png' | 'text/plain', data: Promise<Blob>): Promise<void> {
  const clip = (globalThis as { navigator?: Navigator }).navigator?.clipboard
  const Item = (globalThis as { ClipboardItem?: typeof ClipboardItem }).ClipboardItem
  if (!clip?.write || !Item) {
    data.catch(() => {})
    return Promise.reject(new Error('the clipboard cannot take images here'))
  }
  return clip.write([new Item({ [type]: data })])
}

export function createExportPart(deps: PartDeps): LobbyExport {
  const engine = boardEngineOf(deps.registries)
  if (!engine)
    return {
      svg: notImplemented('3e', 'export.svg'),
      png: notImplemented('3e', 'export.png'),
      canvas: notImplemented('3e', 'export.canvas'),
      copy: notImplemented('3e', 'export.copy'),
    }
  const ctx = (): SceneExportContext => {
    const now = boardEngineOf(deps.registries) ?? engine
    return {
      api: now.api,
      boardId: now.boardId,
      resolver: boardFilesOf(deps.registries)?.resolver ?? null,
      isHidden: (id) => deps.registries.hidden.isHidden(id),
    }
  }
  // the exporters load with the first export: the engine's export code stays out of the board's first
  // load, and out of Node (the contracts test builds this part on a bare port)
  const scene = () => import('../../export/scene.ts')
  const png = async (opts: ExportOptions = {}) => (await scene()).exportScenePng(ctx(), opts)
  const svg = async (opts: ExportOptions = {}) => (await (await scene()).exportSceneSvg(ctx(), opts)).text
  return {
    svg,
    png,
    canvas: async (opts = {}) => (await (await scene()).exportSceneCanvas(ctx(), opts)).canvas,
    copy(format, opts = {}) {
      if (format === 'png') return writeClipboard('image/png', png(opts))
      return writeClipboard(
        'text/plain',
        svg(opts).then((t) => new Blob([t], { type: 'text/plain' })),
      )
    },
  }
}
