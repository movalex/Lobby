// Lobby's image loader for the Excalidraw canvas (docs/EXCALIDRAW-MIGRATION.md §2.10.3, echo source E1
// in §2.5.5; spike checks A7 and A14).
//
// Why Lobby loads the bytes itself: when Excalidraw is handed a file it cannot load, App.updateImageCache
// replaces the image element with newElementWith(element, { status: "error" }), which bumps its version
// (@excalidraw/excalidraw dist/dev/index.js:47091-47111), so a sync adapter would push that as an edit
// (an echo). The failed entry also stays in the image cache and addFiles never replaces an existing id
// (addMissingFiles, index.js:43797-43821), so the image never recovers in that session.
//
// So:
//   - an image element's `fileId` is a Lobby version id (`ver_…`), optionally with a local derivative
//     suffix (`ver_…@thumb`, `ver_…@display`; the adapter strips it on the wire, E9);
//   - the loader fetches the bytes same-origin (never a signed or third-party URL), at most 6 at a time,
//     visible images first, with retries at 1, 2, 4… s for up to 5 minutes;
//   - the bytes become a `blob:` URL, the image is decoded, and only then is it handed to Excalidraw with
//     api.addFiles. Excalidraw never sees a URL that fails, so it never writes `status: "error"`;
//   - `status` stays local-only: this module never writes an element.
//
// No @excalidraw runtime import: the module runs (and is tested) in Node.
import type { BinaryFileData } from '@excalidraw/excalidraw/types'

export type Derivative = 'thumb' | 'display'
export const DERIVATIVES: readonly Derivative[] = ['thumb', 'display']

export const DEFAULT_MAX_CONCURRENT_FETCHES = 6
/** Stop retrying this long after the first failure (the plan's "up to 5 minutes"). */
export const DEFAULT_RETRY_WINDOW_MS = 5 * 60_000

const VERSION_RE = /^ver_[0-9A-Za-z]{10,40}$/

export interface FileKey {
  /** The scene's fileId: `ver_…` or `ver_…@<derivative>`. */
  key: string
  versionId: string
  derivative: Derivative
}

/** `ver_X` → thumb; `ver_X@display` → display; anything else (a base64 id, a URL) → null. */
export function parseFileKey(fileId: string): FileKey | null {
  const [versionId = '', suffix, extra] = fileId.split('@')
  if (extra !== undefined || !VERSION_RE.test(versionId)) return null
  const derivative = (suffix ?? 'thumb') as Derivative
  if (!DERIVATIVES.includes(derivative)) return null
  return { key: fileId, versionId, derivative }
}

/** Raster types Excalidraw accepts that are safe as a blob: URL (SVG is not: see the note below). */
const RASTER_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
  'image/avif',
  'image/bmp',
])

/**
 * The mime type handed to addFiles. Never image/svg+xml: addMissingFiles re-encodes an SVG's dataURL as a
 * data: URL by parsing it (index.js:43806-43818), which throws (and logs) for a blob: URL. Lobby's
 * derivatives are WebP or PNG.
 */
export function rasterMimeType(contentType: string | null): BinaryFileData['mimeType'] | null {
  const t = (contentType ?? '').split(';')[0]?.trim().toLowerCase() ?? ''
  return RASTER_TYPES.has(t) ? (t as BinaryFileData['mimeType']) : null
}

export type LoadState = 'queued' | 'loading' | 'retrying' | 'loaded' | 'failed'

export interface ImageLoaderOptions {
  /** api.addFiles. Called once per key, only with a decoded blob: URL. */
  addFiles(files: BinaryFileData[]): void
  /**
   * The same-origin path of a version's derivative (for example /files/<ast>/<ver>/d/<drv>), or null while
   * it is not known yet (metadata still loading): that counts as a failed attempt and is retried.
   */
  resolveUrl(versionId: string, derivative: Derivative): string | null | Promise<string | null>
  fetch?: (url: string, init: RequestInit) => Promise<Response>
  /** Resolves once the blob decodes as an image (default: HTMLImageElement.decode()). */
  decode?: (url: string, blob: Blob) => Promise<void>
  createObjectURL?: (blob: Blob) => string
  revokeObjectURL?: (url: string) => void
  maxConcurrent?: number
  /** Delay before retry n (1-based): 1, 2, 4, 8 … s, capped at 60 s. */
  retryDelayMs?: (attempt: number) => number
  retryWindowMs?: number
  now?: () => number
  setTimer?: (fn: () => void, ms: number) => unknown
  clearTimer?: (handle: unknown) => void
  /** Load state changes (Lobby's overlay shows its own placeholder until `loaded`, and on `failed`). */
  onState?: (key: string, state: LoadState) => void
}

interface Entry {
  file: FileKey
  state: LoadState
  attempts: number
  firstFailureAt: number | null
  visible: boolean
  seq: number
  timer: unknown
  blobUrl: string | null
}

export interface LoaderStats {
  fetches: number
  failures: number
  retries: number
  loaded: number
  gaveUp: number
  inFlight: number
  maxInFlight: number
}

const defaultDecode = async (url: string) => {
  const img = new Image()
  img.src = url
  await img.decode()
}

export const defaultRetryDelayMs = (attempt: number) => Math.min(60_000, 1000 * 2 ** Math.max(0, attempt - 1))

export class ImageLoader {
  private readonly entries = new Map<string, Entry>()
  private inFlight = 0
  private seq = 0
  private disposed = false
  readonly stats: LoaderStats = {
    fetches: 0,
    failures: 0,
    retries: 0,
    loaded: 0,
    gaveUp: 0,
    inFlight: 0,
    maxInFlight: 0,
  }
  private readonly o: Required<Omit<ImageLoaderOptions, 'onState'>> & Pick<ImageLoaderOptions, 'onState'>

  constructor(opts: ImageLoaderOptions) {
    this.o = {
      fetch: (url, init) => fetch(url, init),
      decode: defaultDecode,
      createObjectURL: (b) => URL.createObjectURL(b),
      revokeObjectURL: (u) => URL.revokeObjectURL(u),
      maxConcurrent: DEFAULT_MAX_CONCURRENT_FETCHES,
      retryDelayMs: defaultRetryDelayMs,
      retryWindowMs: DEFAULT_RETRY_WINDOW_MS,
      now: () => Date.now(),
      setTimer: (fn, ms) => setTimeout(fn, ms),
      clearTimer: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
      ...opts,
    }
  }

  /**
   * Makes sure every image element of the scene is loaded or queued. `visible` fileIds go first.
   * Unknown fileIds (not a Lobby version id) are ignored: Lobby never hands Excalidraw anything else.
   */
  syncScene(
    elements: Iterable<{ type: string; fileId?: string | null; isDeleted?: boolean }>,
    visible?: ReadonlySet<string>,
  ): void {
    const ids: string[] = []
    for (const el of elements) if (el.type === 'image' && el.fileId && !el.isDeleted) ids.push(el.fileId)
    this.request(ids, visible)
  }

  request(fileIds: Iterable<string>, visible?: ReadonlySet<string>): void {
    if (this.disposed) return
    for (const id of fileIds) {
      const file = parseFileKey(id)
      if (!file) continue
      const known = this.entries.get(id)
      const isVisible = visible?.has(id) ?? false
      if (known) {
        known.visible = isVisible
        continue
      }
      this.entries.set(id, {
        file,
        state: 'queued',
        attempts: 0,
        firstFailureAt: null,
        visible: isVisible,
        seq: this.seq++,
        timer: null,
        blobUrl: null,
      })
      this.o.onState?.(id, 'queued')
    }
    this.pump()
  }

  state(fileId: string): LoadState | undefined {
    return this.entries.get(fileId)?.state
  }

  states(): Record<LoadState, number> {
    const out: Record<LoadState, number> = { queued: 0, loading: 0, retrying: 0, loaded: 0, failed: 0 }
    for (const e of this.entries.values()) out[e.state]++
    return out
  }

  /** Revokes every blob: URL. Call only when the canvas that uses them is gone. */
  dispose(): void {
    this.disposed = true
    for (const e of this.entries.values()) {
      if (e.timer !== null) this.o.clearTimer(e.timer)
      if (e.blobUrl) this.o.revokeObjectURL(e.blobUrl)
    }
    this.entries.clear()
  }

  private setState(e: Entry, state: LoadState) {
    e.state = state
    this.o.onState?.(e.file.key, state)
  }

  private next(): Entry | null {
    let best: Entry | null = null
    for (const e of this.entries.values()) {
      if (e.state !== 'queued') continue
      if (!best || (e.visible && !best.visible) || (e.visible === best.visible && e.seq < best.seq)) best = e
    }
    return best
  }

  private pump(): void {
    while (!this.disposed && this.inFlight < this.o.maxConcurrent) {
      const e = this.next()
      if (!e) return
      void this.load(e)
    }
  }

  private async load(e: Entry): Promise<void> {
    this.setState(e, 'loading')
    this.inFlight++
    this.stats.inFlight = this.inFlight
    this.stats.maxInFlight = Math.max(this.stats.maxInFlight, this.inFlight)
    e.attempts++
    let blob: Blob | null = null
    let mimeType: BinaryFileData['mimeType'] | null = null
    try {
      const url = await this.o.resolveUrl(e.file.versionId, e.file.derivative)
      if (url === null) throw new Error('no url yet')
      if (!url.startsWith('/') || url.startsWith('//')) throw new Error('not a same-origin path')
      this.stats.fetches++
      const res = await this.o.fetch(url, { credentials: 'same-origin', cache: 'default' })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      mimeType = rasterMimeType(res.headers.get('content-type'))
      if (!mimeType) throw new Error('not a raster image')
      blob = await res.blob()
    } catch {
      blob = null
    } finally {
      this.inFlight--
      this.stats.inFlight = this.inFlight
    }
    if (this.disposed) return
    if (blob && mimeType) {
      const url = this.o.createObjectURL(blob)
      try {
        await this.o.decode(url, blob)
        if (this.disposed) {
          this.o.revokeObjectURL(url)
          return
        }
        e.blobUrl = url
        this.o.addFiles([
          {
            id: e.file.key as BinaryFileData['id'],
            mimeType,
            dataURL: url as BinaryFileData['dataURL'],
            created: this.o.now(),
          },
        ])
        this.stats.loaded++
        this.setState(e, 'loaded')
        this.pump()
        return
      } catch {
        this.o.revokeObjectURL(url)
      }
    }
    this.fail(e)
    this.pump()
  }

  private fail(e: Entry): void {
    this.stats.failures++
    const now = this.o.now()
    e.firstFailureAt ??= now
    if (now - e.firstFailureAt >= this.o.retryWindowMs) {
      this.stats.gaveUp++
      this.setState(e, 'failed')
      return
    }
    this.setState(e, 'retrying')
    e.timer = this.o.setTimer(() => {
      e.timer = null
      if (this.disposed || e.state !== 'retrying') return
      this.stats.retries++
      this.setState(e, 'queued')
      this.pump()
    }, this.o.retryDelayMs(e.attempts))
  }
}
