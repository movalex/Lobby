// Registers every spike B feature on a board page and keeps the handles the test hooks use.
import { exportBoardPng, exportBoardSvg, type SvgExportResult } from '../../export/svg.ts'
import { attachBoardFiles, type BoardFiles, installBoardFiles } from '../../files/board.ts'
import { boardEngineOf, onBoardEngine } from '../../overrides.ts'
import type { CanvasPort } from '../../port.ts'
import type { CanvasRegistries } from '../../registries.ts'
import { CommentsStore, commentTool, makeCommentPins } from './comments.tsx'
import { installCollapse, makeCollapseChevrons } from './mindmap.tsx'
import { boardIdFromPath, FeatureRuntime } from './runtime.ts'
import { makeTagsLayer } from './tags.tsx'
import { makeSheet, makeTimer, makeToast, makeToolbar } from './ui.tsx'
import { makeVoteBadges, voteTool } from './votes.tsx'
import { WorkshopStore } from './workshop.ts'

export interface FeatureSet {
  readonly rt: FeatureRuntime
  readonly workshop: WorkshopStore
  readonly comments: CommentsStore
  /** the board page's loader (once its engine is attached) */
  files(): BoardFiles | null
  exportSvg(opts?: { only?: readonly string[] }): Promise<SvgExportResult>
  exportPng(opts?: { only?: readonly string[] }): Promise<Blob>
  dispose(): void
}

export function installFeatureSet(port: CanvasPort, registries: CanvasRegistries): FeatureSet {
  const path = (globalThis as { location?: { pathname?: string } }).location?.pathname ?? ''
  const rt = new FeatureRuntime(port, registries, boardIdFromPath(path))
  const workshop = new WorkshopStore(rt)
  const comments = new CommentsStore(rt)
  const undo: (() => void)[] = []
  let files: BoardFiles | null = null

  // The board page's engine: the loader (one per page) and the exports read it.
  undo.push(
    onBoardEngine(registries, (engine) => {
      const boardId = engine.boardId ?? rt.boardId
      if (!boardId || files) return
      files = installBoardFiles({ api: engine.api, boardId })
      const detach = attachBoardFiles(registries, files)
      const f = files
      undo.push(() => {
        detach()
        f.dispose()
      })
    }),
  )

  const source = (only?: readonly string[]) => {
    const api = boardEngineOf(registries)?.api
    if (!api) throw new Error('the board is not ready')
    return {
      elements: api.getSceneElements(),
      appState: api.getAppState(),
      files: api.getFiles(),
      isHidden: (id: string) => registries.hidden.isHidden(id),
      ...(only ? { only: new Set(only) } : {}),
    }
  }
  const exportSvg = async (opts: { only?: readonly string[] } = {}) => {
    const src = source(opts.only)
    // the export reads the runtime blob: URLs: keep them alive until it is done
    const keys = src.elements.flatMap((e) => (e.type === 'image' && e.fileId ? [e.fileId] : []))
    const releases = keys.map((k) => files?.loader.hold(k) ?? (() => {}))
    try {
      return await exportBoardSvg(src)
    } finally {
      for (const r of releases) r()
    }
  }
  const exportPng = async (opts: { only?: readonly string[] } = {}) => exportBoardPng(source(opts.only))

  const ui = { rt, workshop, exportSvg }
  undo.push(registries.pointerTools.register(voteTool(rt, workshop)))
  undo.push(registries.pointerTools.register(commentTool(comments)))
  undo.push(registries.overlays.register({ id: 'spike-tags', order: 20, component: makeTagsLayer(rt) }))
  undo.push(
    registries.overlays.register({ id: 'spike-votes', order: 21, component: makeVoteBadges(rt, workshop) }),
  )
  undo.push(
    registries.overlays.register({
      id: 'spike-comments',
      order: 30,
      component: makeCommentPins(rt, comments),
    }),
  )
  undo.push(
    registries.overlays.register({ id: 'spike-collapse', order: 25, component: makeCollapseChevrons(rt) }),
  )
  undo.push(registries.overlays.register({ id: 'spike-toast', order: 90, component: makeToast(rt) }))
  undo.push(
    registries.slots.register('toolbar', { id: 'spike-features', order: 50, component: makeToolbar(ui) }),
  )
  undo.push(registries.slots.register('sheet', { id: 'spike-sheet', order: 50, component: makeSheet(ui) }))
  undo.push(registries.slots.register('timer', { id: 'spike-timer', order: 50, component: makeTimer(ui) }))
  undo.push(installCollapse(rt))
  workshop.start()
  comments.start()
  undo.push(() => workshop.stop())
  undo.push(() => comments.stop())

  return {
    rt,
    workshop,
    comments,
    files: () => files,
    exportSvg,
    exportPng,
    dispose() {
      for (const u of undo.splice(0).reverse()) u()
      rt.dispose()
    },
  }
}
