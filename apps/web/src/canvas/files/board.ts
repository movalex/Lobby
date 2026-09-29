// The board page's image loading (docs/EXCALIDRAW-MIGRATION.md §2.10.3; spike B check B7): one
// ImageLoader per board page, fed by the FileUrlResolver (asset, derivative and board ids), kept in step
// with the scene on every change (once per animation frame), visible images first. O5's features install
// it when the board page attaches its engine (overrides.ts `onBoardEngine`), so O2's board page makes one
// call (`installBoardOverrides`) and never creates a loader of its own.
//
// Reads only: the loader hands decoded files to `api.addFiles` (runtime-only, never synced); nothing
// here writes an element. Derivative upgrades by zoom (derivatives.ts) change the scene's local fileId,
// which needs the adapter's E9 path (the `@display` suffix stripped on the wire), so they are off unless
// `upgrades` is set (the board page turns them on once O2's adapter strips the suffix).
import type { ExcalidrawImperativeAPI } from '@excalidraw/excalidraw/types'
import { AssetMetaStore } from '../../assets/meta-store.ts'
import type { CanvasRegistries } from '../registries.ts'
import { DerivativeUpgrades, type Upgrade } from './derivatives.ts'
import { ImageLoader, type ImageLoaderOptions } from './loader.ts'
import { type FileMetaSource, FileUrlResolver } from './resolve.ts'

type LoaderApi = Pick<ExcalidrawImperativeAPI, 'addFiles' | 'getAppState' | 'getSceneElements' | 'onChange'>

export interface BoardFilesOptions {
  api: LoaderApi
  boardId: string
  /** default: a new AssetMetaStore (the api's meta route, cached per page) */
  meta?: FileMetaSource
  /** extra loader options (tests: fetch, decode, timers) */
  loader?: Partial<ImageLoaderOptions>
  /** Derivative upgrades by zoom; `apply` switches the scene's local fileIds (needs O2's E9 path). */
  upgrades?: { apply(switches: readonly Upgrade[]): void; dpr?: () => number }
  /** Schedules the scene sync (default: one per animation frame; a microtask outside a browser). */
  schedule?: (fn: () => void) => void
}

export interface BoardFiles {
  readonly loader: ImageLoader
  readonly resolver: FileUrlResolver
  /** Runs the scene sync now (tests; also after an upload learned a new ref). */
  sync(): void
  dispose(): void
}

interface ImageLike {
  readonly id: string
  readonly type: string
  readonly isDeleted?: boolean
  readonly fileId?: string | null
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
  readonly customData?: { lobby?: Readonly<Record<string, unknown>> } | null
}

/** fileIds of the image elements whose bounds intersect the viewport (and their on-screen sizes). */
export function visibleImages(
  elements: readonly ImageLike[],
  appState: { scrollX: number; scrollY: number; width: number; height: number; zoom: { value: number } },
): { id: string; fileId: string; screenPx: number }[] {
  const z = appState.zoom.value
  const x1 = -appState.scrollX
  const y1 = -appState.scrollY
  const x2 = x1 + appState.width / z
  const y2 = y1 + appState.height / z
  const out: { id: string; fileId: string; screenPx: number }[] = []
  for (const e of elements) {
    if (e.type !== 'image' || !e.fileId || e.isDeleted) continue
    if (e.x + e.width >= x1 && e.x <= x2 && e.y + e.height >= y1 && e.y <= y2)
      out.push({ id: e.id, fileId: e.fileId, screenPx: Math.max(e.width, e.height) * z })
  }
  return out
}

export function installBoardFiles(opts: BoardFilesOptions): BoardFiles {
  const { api } = opts
  const resolver = new FileUrlResolver({ boardId: opts.boardId, meta: opts.meta ?? new AssetMetaStore() })
  const loader = new ImageLoader({
    addFiles: (files) => api.addFiles(files),
    resolveUrl: resolver.resolveUrl,
    ...opts.loader,
  })
  const upgrades = opts.upgrades ? new DerivativeUpgrades() : null
  let scheduled = false
  let disposed = false
  let lastKeys = ''

  const sync = () => {
    scheduled = false
    if (disposed) return
    const elements = api.getSceneElements() as unknown as readonly ImageLike[]
    resolver.learn(elements)
    const shown = visibleImages(elements, api.getAppState())
    loader.syncScene(elements, new Set(shown.map((s) => s.fileId)))
    // Keys no live element uses any more: revoked (exports hold what they read).
    const inUse = new Set<string>()
    for (const e of elements) if (e.type === 'image' && e.fileId && !e.isDeleted) inUse.add(e.fileId)
    const keys = [...inUse].sort().join(',')
    if (keys !== lastKeys) {
      lastKeys = keys
      loader.retainOnly(inUse)
    }
    if (upgrades && opts.upgrades) {
      const dpr = opts.upgrades.dpr?.() ?? (globalThis as { devicePixelRatio?: number }).devicePixelRatio ?? 1
      const switches = upgrades.observe(
        shown.map((s) => ({ id: s.id, fileId: s.fileId, devicePx: s.screenPx * dpr })),
      )
      if (switches.length) opts.upgrades.apply(switches)
    }
  }
  const schedule =
    opts.schedule ??
    ((fn: () => void) =>
      typeof requestAnimationFrame === 'function' ? requestAnimationFrame(() => fn()) : queueMicrotask(fn))
  const unsubscribe = api.onChange(() => {
    if (scheduled || disposed) return
    scheduled = true
    schedule(sync)
  })
  sync()
  return {
    loader,
    resolver,
    sync,
    dispose() {
      disposed = true
      unsubscribe()
      loader.dispose()
    },
  }
}

// One loader per board page, found by the features that need it (exports hold its keys).
const boardFiles = new WeakMap<CanvasRegistries, BoardFiles>()

export function attachBoardFiles(registries: CanvasRegistries, files: BoardFiles): () => void {
  boardFiles.set(registries, files)
  return () => {
    if (boardFiles.get(registries) === files) boardFiles.delete(registries)
  }
}

export function boardFilesOf(registries: CanvasRegistries): BoardFiles | null {
  return boardFiles.get(registries) ?? null
}
