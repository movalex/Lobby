// The derivative swap (docs/EXCALIDRAW-MIGRATION.md §2.10.3 "Derivatives by zoom"; wave 3g). The loader
// (./loader.ts) loads every image's `thumb` (512 px); an image shown larger than 512 device pixels for
// 300 ms switches to `display` (2,048 px), at most 60 upgrades per session (./derivatives.ts is the
// policy). The switch is LOCAL ONLY: the scene element's `fileId` becomes `ver_X@display` while the wire,
// the server, undo and the save state only ever see `ver_X` (the sync core and the history compare
// fileIds with the suffix stripped, E9).
//
// A cropped image (a photo centre-cropped into a template slot), and the one in the crop editor, stays
// on its thumb (CR-W5-3G-2): Excalidraw crops in the pixels of the file it has loaded, every tab loads the
// thumb first, so a crop is always made on, and drawn from, the thumb. The swap never upgrades such an
// image, and puts one shown from a larger rendering back on its thumb (a remote crop of an image this tab
// upgraded; `toThumb` is the same switch for the files part's `crop`, made before the editor opens).
// Its upgrade is forgotten: once uncropped, the policy decides again.
//
// Order, so an upgrade never shows a blank tile: the display file is requested and held first; the
// element switches only once the loader has handed it to the engine. The thumb stays in the engine's
// image cache, so a switch back (below) is instant too.
//
// An upgraded image keeps its display file held (`ImageLoader.hold`) until it is deleted, replaced,
// cropped or the swap is disposed: `retainOnly` never revokes a rendering the swap may switch back to
// (CR-W5-3G-3: a moment on the wire id, an undo's install say, dropped the entry and the swap stalled with
// the image on its thumb for the rest of the session).
//
// The sync core keeps the local suffix across its rebuilds while the wire file is the same
// (canvas/sync/core/fields.ts `keepLocalFileSuffix`, CR-W5-3G-3); an upgraded element any other path puts
// back on its wire id is switched back to its loaded display file at once, without counting a new upgrade.
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

/** An image that must stay on its thumb: cropped, or in the crop editor (CR-W5-3G-2). */
export const staysOnThumb = (el: Pick<SceneImage, 'id' | 'crop'>, croppingId: string | null | undefined) =>
  !!el.crop || (!!croppingId && el.id === croppingId)

/**
 * The local switches that put `ids` back on their thumb where they show a larger rendering (the wire id:
 * the loader's thumb key). Pure: the caller applies them like the swap's own (no push, no undo step).
 */
export function toThumbSwitches(
  elements: readonly Pick<SceneImage, 'id' | 'type' | 'isDeleted' | 'fileId'>[],
  ids: ReadonlySet<string>,
): { id: string; fileId: string }[] {
  const out: { id: string; fileId: string }[] = []
  for (const el of elements) {
    if (el.type !== 'image' || el.isDeleted || !el.fileId || !ids.has(el.id)) continue
    const key = parseFileKey(el.fileId)
    if (!key || key.derivative === 'thumb') continue
    const thumb = wireFileId(el.fileId)
    if (thumb && thumb !== el.fileId) out.push({ id: el.id, fileId: thumb })
  }
  return out
}

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
  /** puts `ids` back on their thumb now and forgets their upgrades (the files part's `crop`) */
  toThumb(ids: Iterable<string>): void
  readonly upgrades: number
  dispose(): void
}

export function installDerivativeSwap(opts: DerivativeSwapOptions): DerivativeSwap {
  const policy = new DerivativeUpgrades(opts.policy)
  /**
   * image id → the display key it was upgraded to, held in the loader (kept for the switch back when
   * something puts the element on its wire id)
   */
  const upgraded = new Map<string, { key: string; release: () => void }>()
  /** display keys requested and held until the engine has them */
  const pending = new Map<string, { ids: Set<string>; release: () => void }>()
  const forget = (id: string) => {
    const u = upgraded.get(id)
    if (!u) return
    u.release()
    upgraded.delete(id)
  }
  const unpend = (id: string) => {
    for (const [key, p] of [...pending]) {
      if (!p.ids.delete(id) || p.ids.size) continue
      p.release()
      pending.delete(key)
    }
  }
  let disposed = false
  let scheduled = false

  const sync = () => {
    scheduled = false
    if (disposed) return
    const elements = opts.api.getSceneElements() as unknown as readonly SceneImage[]
    const appState = opts.api.getAppState()
    const cropping = (appState as { croppingElementId?: string | null }).croppingElementId ?? null
    const byId = new Map<string, SceneImage>()
    const onThumb = new Set<string>()
    for (const e of elements) {
      if (e.type !== 'image' || e.isDeleted) continue
      byId.set(e.id, e)
      if (staysOnThumb(e, cropping)) onThumb.add(e.id)
    }
    // 0. cropped images and the one in the crop editor (CR-W5-3G-2): back on their thumb, upgrade
    // forgotten. Needs no loader: the thumb is what every tab loads first
    const switches = toThumbSwitches(elements, onThumb)
    for (const id of onThumb) {
      forget(id)
      unpend(id)
    }
    const loader = opts.loader()
    if (!loader) {
      if (switches.length) opts.apply(switches)
      return
    }

    // 1. display files that finished loading: their images are upgraded (switched just below), each
    // holding its display file
    for (const [key, p] of [...pending]) {
      const st = loader.state(key)
      if (st === 'loaded') {
        for (const id of p.ids) {
          forget(id)
          upgraded.set(id, { key, release: loader.hold(key) })
        }
        p.release()
        pending.delete(key)
      } else if (st === 'failed' || st === undefined) {
        // failed, or gone from the loader (a new loader for the page): the policy may decide again
        p.release()
        pending.delete(key)
      }
    }
    // 2. every upgraded image not on its display file: just loaded, or put back on its wire id by
    // another path (an undo's install, a full server copy): switched at once
    for (const [id, { key }] of [...upgraded]) {
      const el = byId.get(id)
      if (!el?.fileId) {
        forget(id) // deleted
        continue
      }
      if (el.fileId === key) continue
      if (wireFileId(el.fileId) !== wireFileId(key)) {
        forget(id) // another file now (a replace): the policy decides again
        continue
      }
      const st = loader.state(key)
      if (st === 'loaded') switches.push({ id, fileId: key })
      else if (st === undefined) forget(id) // a new loader for the page: decided again
    }
    // 3. the policy: images shown large long enough
    const shown = visibleImages(elements as never, appState)
    const dpr = opts.dpr?.() ?? (globalThis as { devicePixelRatio?: number }).devicePixelRatio ?? 1
    const observed = shown.filter((s) => !upgraded.has(s.id) && !inPending(s.id) && !onThumb.has(s.id))
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
    toThumb(ids) {
      if (disposed) return
      const want = new Set(ids)
      const switches = toThumbSwitches(opts.api.getSceneElements() as unknown as readonly SceneImage[], want)
      for (const id of want) {
        forget(id)
        unpend(id)
      }
      if (switches.length) opts.apply(switches)
    },
    get upgrades() {
      return policy.upgrades
    },
    dispose() {
      disposed = true
      if (timer !== null) clearTimeout(timer)
      unsubscribe()
      for (const p of pending.values()) p.release()
      pending.clear()
      for (const u of upgraded.values()) u.release()
      upgraded.clear()
    },
  }
}
