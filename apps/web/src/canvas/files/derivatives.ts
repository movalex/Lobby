// Derivatives by zoom (docs/EXCALIDRAW-MIGRATION.md §2.10.3): each derivative has its own LOCAL file key.
// A scene element's `fileId` is `ver_X@thumb` or `ver_X@display` locally, while the wire and the server
// only ever see `ver_X` (the adapter strips the suffix, E9). Default `thumb` (512 px). When an image is
// shown larger than 512 device pixels for 300 ms, it switches to `display` (2,048 px). At most 60 upgrades
// per session; beyond that, images stay `thumb`. The original is never loaded on the canvas. Never a
// downgrade (a zoom-out keeps the sharper file that is already loaded).
//
// Pure policy, no engine import: the board page feeds it the visible images' on-screen sizes and applies
// the returned local fileId switches through the adapter's local-only path (the loader then loads the
// new key; `retainOnly` revokes the old one once nothing uses it).
import { parseFileKey, withDerivative } from './loader.ts'

export const UPGRADE_THRESHOLD_PX = 512
export const UPGRADE_DWELL_MS = 300
export const MAX_UPGRADES_PER_SESSION = 60

export interface ShownImage {
  readonly id: string
  /** the scene's local fileId (`ver_X`, `ver_X@thumb`, `ver_X.p2@thumb`, …) */
  readonly fileId: string
  /** the longer side on screen, in device pixels (`max(width, height) * zoom * devicePixelRatio`) */
  readonly devicePx: number
}

export interface Upgrade {
  readonly id: string
  readonly from: string
  readonly to: string
}

export interface DerivativeUpgradesOptions {
  thresholdPx?: number
  dwellMs?: number
  maxUpgrades?: number
  now?: () => number
}

export class DerivativeUpgrades {
  private readonly thresholdPx: number
  private readonly dwellMs: number
  private readonly maxUpgrades: number
  private readonly now: () => number
  /** image id → since when it has been shown large */
  private readonly largeSince = new Map<string, number>()
  private count = 0

  constructor(opts: DerivativeUpgradesOptions = {}) {
    this.thresholdPx = opts.thresholdPx ?? UPGRADE_THRESHOLD_PX
    this.dwellMs = opts.dwellMs ?? UPGRADE_DWELL_MS
    this.maxUpgrades = opts.maxUpgrades ?? MAX_UPGRADES_PER_SESSION
    this.now = opts.now ?? (() => Date.now())
  }

  /** Upgrades made so far this session. */
  get upgrades(): number {
    return this.count
  }

  /**
   * One observation of the images on screen (images not listed are off screen: their dwell restarts).
   * Returns the switches to apply now.
   */
  observe(shown: Iterable<ShownImage>): Upgrade[] {
    const t = this.now()
    const seen = new Set<string>()
    const out: Upgrade[] = []
    for (const img of shown) {
      seen.add(img.id)
      const key = parseFileKey(img.fileId)
      if (!key || key.derivative === 'display') {
        this.largeSince.delete(img.id)
        continue
      }
      if (!(img.devicePx > this.thresholdPx)) {
        this.largeSince.delete(img.id)
        continue
      }
      const since = this.largeSince.get(img.id)
      if (since === undefined) {
        this.largeSince.set(img.id, t)
        continue
      }
      if (t - since < this.dwellMs || this.count >= this.maxUpgrades) continue
      const to = withDerivative(img.fileId, 'display')
      if (!to) continue
      this.count++
      this.largeSince.delete(img.id)
      out.push({ id: img.id, from: img.fileId, to })
    }
    for (const id of [...this.largeSince.keys()]) if (!seen.has(id)) this.largeSince.delete(id)
    return out
  }
}
