// OWNER: WS4 (wave S, the client review page). The pictures of the page (docs/WAVE-S-CONTRACTS.md §6). A frame is drawn
// by present-export's exporter (renderPng of the frame, light theme, the board's own files), lazily as it scrolls in,
// one at a time (a phone draws one frame while the next waits), at the column width × the screen's density (capped at
// 2), and cached by the frame's elements' version sum: an edit to the frame or anything in it makes a new picture, an
// edit elsewhere does not. A file shows its own previews: the image's display copy, a video's poster, a PDF's cover.
// The object URLs live as long as the page and are revoked with it (they go in <img src> only: never in an element).
import type { AssetKind, AssetVersionMeta, DerivativeRecord } from '../../assets/contract.ts'
import { usableDerivatives } from '../../assets/contract.ts'
import type { LobbyCanvas } from '../../canvas/api/index.ts'
import { frameTarget, renderPng } from '../present-export/ported/exporter.ts'
import { frameCacheKey, pictureScale } from './model.ts'

/** What a frame's picture is cached under now, and the scale it is drawn at; null when the frame is gone. */
export function frameKey(
  canvas: LobbyCanvas,
  frameId: string,
  columnPx: number,
  dpr: number,
): { key: string; scale: 1 | 2; width: number; height: number } | null {
  const frame = canvas.get(frameId)
  const bounds = canvas.bounds(frameId)
  if (!frame || frame.isDeleted || !bounds || bounds.width <= 0 || bounds.height <= 0) return null
  const members = canvas.index.byFrame(frameId)
  const scale = pictureScale(columnPx, bounds.width, dpr)
  return {
    key: frameCacheKey(frameId, frame.version, members, scale),
    scale,
    width: bounds.width,
    height: bounds.height,
  }
}

export interface FramePicture {
  readonly key: string
  readonly url: string
}

/** The page's frame pictures: a queue (one draw at a time) and a cache of object URLs. */
export class FramePictures {
  private readonly canvas: LobbyCanvas
  private readonly urls = new Map<string, { key: string; url: string }>()
  private readonly inflight = new Map<string, Promise<FramePicture | null>>()
  private chain: Promise<unknown> = Promise.resolve()
  private disposed = false

  constructor(canvas: LobbyCanvas) {
    this.canvas = canvas
  }

  /** The cached picture for `key`, if it is the frame's current one. */
  cached(frameId: string, key: string): FramePicture | null {
    const hit = this.urls.get(frameId)
    return hit && hit.key === key ? hit : null
  }

  /** Draws the frame (or returns the cache). null: the frame is gone or the browser could not draw it. */
  load(frameId: string, key: string, scale: 1 | 2): Promise<FramePicture | null> {
    const hit = this.cached(frameId, key)
    if (hit) return Promise.resolve(hit)
    const running = this.inflight.get(`${frameId}:${key}`)
    if (running) return running
    const job = this.chain
      .then(() => this.draw(frameId, key, scale))
      .finally(() => this.inflight.delete(`${frameId}:${key}`))
    this.chain = job.catch(() => null)
    this.inflight.set(`${frameId}:${key}`, job)
    return job
  }

  private async draw(frameId: string, key: string, scale: 1 | 2): Promise<FramePicture | null> {
    if (this.disposed) return null
    const hit = this.cached(frameId, key)
    if (hit) return hit
    try {
      const blob = await renderPng(this.canvas, frameTarget(this.canvas, frameId), {
        scale,
        transparent: false,
      })
      if (this.disposed) return null
      const url = URL.createObjectURL(blob)
      const old = this.urls.get(frameId)
      this.urls.set(frameId, { key, url })
      // the previous picture of this frame goes once the new one is in (an <img> showing it switches on the next render)
      if (old) setTimeout(() => URL.revokeObjectURL(old.url), 5_000)
      return { key, url }
    } catch {
      return null
    }
  }

  dispose() {
    this.disposed = true
    for (const v of this.urls.values()) URL.revokeObjectURL(v.url)
    this.urls.clear()
  }
}

/**
 * The preview of a file for the page: the derivative to show as a picture, by kind. An image's display copy (else its
 * thumbnail), a video's poster, a PDF's cover. null: nothing to show yet (not processed) or a file with no picture.
 */
export function previewDerivative(meta: AssetVersionMeta | null, kind: AssetKind): DerivativeRecord | null {
  if (meta?.status !== 'ready') return null
  const all = usableDerivatives(meta)
  const byRole = (role: DerivativeRecord['role']) => all.find((d) => d.role === role)
  switch (kind) {
    case 'image':
      return byRole('display') ?? byRole('thumb') ?? null
    case 'video':
      return byRole('poster') ?? byRole('thumb') ?? null
    case 'pdf':
      return byRole('thumb') ?? all.find((d) => d.role === 'page' && d.page === 1) ?? null
    default:
      return null
  }
}
