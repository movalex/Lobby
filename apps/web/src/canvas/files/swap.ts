// The derivative swap (docs/EXCALIDRAW-MIGRATION.md §2.10.3 "Derivatives by zoom"; wave 3g). The loader
// (./loader.ts) loads every image's `thumb` (512 px); an image shown larger than 512 device pixels for
// 300 ms switches to `display` (2,048 px), at most 60 upgrades per session (./derivatives.ts is the
// policy). The switch is LOCAL ONLY: the scene element's `fileId` becomes `ver_X@display` while the wire,
// the server, undo and the save state only ever see `ver_X` (the sync core and the history compare
// fileIds with the suffix stripped, E9).
//
// A cropped image (a photo centre-cropped into a template slot) stays on its thumb: Excalidraw crops in
// the pixels of the file it has loaded, and the crop is written in the thumb's.
//
// Order, so an upgrade never shows a blank tile: the display file is requested and held first; the
// element switches only once the loader has handed it to the engine. The thumb stays in the engine's
// image cache, so a switch back (below) is instant too.
//
// A server update to an upgraded element replaces the scene copy with the server's (`ver_X`: the sync
// core's rebuild does not keep the local suffix, a request to spike B's O2); such an element is switched
// back to its loaded display file at once, without counting a new upgrade.
//
// Engine code (canvas/**): installed by the files part (canvas/api/parts/files.ts) on the board page's
// engine; nothing here writes a document field.
import type { ExcalidrawImperativeAPI } from '@excalidraw/excalidraw/types'
import { visibleImages } from './board.ts'
import {
  DerivativeUpgrades,
  type DerivativeUpgradesOptions,
  MAX_UPGRADES_PER_SESSION,
  UPGRADE_THRESHOLD_PX,
  type Upgrade,
} from './derivatives.ts'
import { type ImageLoader, parseFileKey, wireFileId } from './loader.ts'

type SwapApi = Pick<ExcalidrawImperativeAPI, 'getSceneElements' | 'getAppState' | 'onChange'>

interface SceneImage {
  readonly id: string
  readonly type: string
  readonly isDeleted?: boolean
  readonly fileId?: string | null
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
  /** a cropped image stays on its thumb: Excalidraw crops in the loaded file's pixels */
  readonly crop?: unknown
}

/** How often a pending upgrade or a dwelling image is looked at again (the dwell is 300 ms). */
const POLL_MS = 100

export interface DerivativeSwapOptions {
  api: SwapApi
  /** the board page's loader (canvas/files/board.ts `boardFilesOf`), once there */
  loader(): Pick<ImageLoader, 'request' | 'state' | 'hold'> | null
  /** switches the scene's local fileIds (engine only: no push, no undo step) */
  apply(switches: readonly { id: string; fileId: string }[]): void
  dpr?: () => number
  policy?: DerivativeUpgradesOptions
  /** default: one per animation frame (a microtask outside a browser) */
  schedule?: (fn: () => void) => void
}

export interface DerivativeSwap {
  /** runs one observation now (tests) */
  sync(): void
  readonly upgrades: number
  dispose(): void
}

export function installDerivativeSwap(opts: DerivativeSwapOptions): DerivativeSwap {
  const policy = new DerivativeUpgrades(opts.policy)
  /** image id → the display key it was upgraded to (kept for the switch back after a server update) */
  const upgraded = new Map<string, string>()
  /** display keys requested and held until the engine has them */
  const pending = new Map<string, { ids: Set<string>; release: () => void }>()
  let disposed = false
  let scheduled = false

  const sync = () => {
    scheduled = false
    if (disposed) return
    const loader = opts.loader()
    if (!loader) return
    const elements = opts.api.getSceneElements() as unknown as readonly SceneImage[]
    const byId = new Map<string, SceneImage>()
    for (const e of elements) if (e.type === 'image' && !e.isDeleted) byId.set(e.id, e)
    const switches: { id: string; fileId: string }[] = []

    // 1. display files that finished loading: their images are upgraded (switched just below)
    for (const [key, p] of [...pending]) {
      const st = loader.state(key)
      if (st === 'loaded') {
        for (const id of p.ids) upgraded.set(id, key)
        p.release()
        pending.delete(key)
      } else if (st === 'failed') {
        p.release()
        pending.delete(key)
      }
    }
    // 2. every upgraded image not on its display file: just loaded, or the server's copy put it back
    // on its thumb (a remote update): switched at once
    for (const [id, key] of [...upgraded]) {
      const el = byId.get(id)
      if (!el?.fileId) {
        upgraded.delete(id)
        continue
      }
      if (el.fileId === key) continue
      if (wireFileId(el.fileId) !== wireFileId(key)) {
        upgraded.delete(id) // another file now (a replace): the policy decides again
        continue
      }
      if (loader.state(key) === 'loaded') switches.push({ id, fileId: key })
    }
    // 3. the policy: images shown large long enough
    const shown = visibleImages(elements as never, opts.api.getAppState())
    const dpr = opts.dpr?.() ?? (globalThis as { devicePixelRatio?: number }).devicePixelRatio ?? 1
    const observed = shown.filter((s) => !upgraded.has(s.id) && !inPending(s.id) && !byId.get(s.id)?.crop)
    const decided: Upgrade[] = policy.observe(
      observed.map((s) => ({ id: s.id, fileId: s.fileId, devicePx: s.screenPx * dpr })),
    )
    for (const u of decided) {
      if (!parseFileKey(u.to)) continue
      const p = pending.get(u.to)
      if (p) {
        p.ids.add(u.id)
        continue
      }
      const release = loader.hold(u.to)
      pending.set(u.to, { ids: new Set([u.id]), release })
      loader.request([u.to], new Set([u.to]))
    }
    if (switches.length) opts.apply(switches)
    // keep observing while an upgrade is loading or a large image is inside its dwell
    const threshold = opts.policy?.thresholdPx ?? UPGRADE_THRESHOLD_PX
    const room = policy.upgrades < (opts.policy?.maxUpgrades ?? MAX_UPGRADES_PER_SESSION)
    const dwelling =
      room &&
      observed.some((s) => s.screenPx * dpr > threshold && parseFileKey(s.fileId)?.derivative !== 'display')
    if (switches.length || pending.size || dwelling) later()
  }
  let timer: ReturnType<typeof setTimeout> | null = null
  const later = () => {
    if (timer !== null || disposed) return
    timer = setTimeout(() => {
      timer = null
      schedule()
    }, POLL_MS)
  }
  const inPending = (id: string) => {
    for (const p of pending.values()) if (p.ids.has(id)) return true
    return false
  }
  const schedule = () => {
    if (scheduled || disposed) return
    scheduled = true
    ;(
      opts.schedule ??
      ((fn: () => void) =>
        typeof requestAnimationFrame === 'function' ? requestAnimationFrame(() => fn()) : queueMicrotask(fn))
    )(sync)
  }
  const unsubscribe = opts.api.onChange(() => schedule())
  schedule()
  return {
    sync,
    get upgrades() {
      return policy.upgrades
    },
    dispose() {
      disposed = true
      if (timer !== null) clearTimeout(timer)
      unsubscribe()
      for (const p of pending.values()) p.release()
      pending.clear()
    },
  }
}
