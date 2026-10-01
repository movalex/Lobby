// Lobby's image loader for the Excalidraw canvas (docs/EXCALIDRAW-MIGRATION.md §2.10.3, echo source E1
// in §2.5.5; spike checks A7, A14 and B7).
//
// Why Lobby loads the bytes itself: when Excalidraw is handed a file it cannot load, App.updateImageCache
// replaces the image element with newElementWith(element, { status: "error" }), which bumps its version
// (@excalidraw/excalidraw dist/dev/index.js:47091-47111), so a sync adapter would push that as an edit
// (an echo). The failed entry also stays in the image cache and addFiles never replaces an existing id
// (addMissingFiles, index.js:43797-43821), so the image never recovers in that session.
//
// So:
//   - an image element's `fileId` is a Lobby version id (`ver_…`), a placed PDF page's `ver_….p<n>`,
//     optionally with a local derivative suffix (`…@thumb`, `…@display`; the adapter strips it on the
//     wire, E9);
//   - the loader fetches the bytes same-origin (never a signed or third-party URL), at most 6 at a time,
//     visible images first, with retries at 1, 2, 4… s for up to 5 minutes. `resolveUrl` gets the file
//     key too (page and derivative); the board's resolver (./resolve.ts) turns it into the real route,
//     which needs the asset id, the derivative id and `?board=` (apps/api/src/files/serve.ts);
//   - raster bytes become a `blob:` URL, the image is decoded, and only then is it handed to Excalidraw
//     with api.addFiles. Excalidraw never sees a URL that fails, so it never writes `status: "error"`;
//   - SVG never goes to Excalidraw as `blob:`: addMissingFiles re-encodes an SVG's dataURL by parsing it
//     as a `data:` URL (index.js:43806-43818), which throws for a blob: URL. An SVG response (Lobby's
//     resolver asks for an SVG original only when it has no raster derivative) is handed over as a
//     runtime-only `data:` URL, never stored or synced (§2.10.3 "SVG");
//   - decoded files are handed over in batches (§2.10.3 "Batching"): every addFiles call repaints the
//     whole scene (App.addFiles → scene.triggerUpdate, dist/dev/index.js:43789-43796). The loader collects
//     decoded files for up to 100 ms, or until every visible image is ready, whichever comes first, and
//     hands them over in one call (spike A14: one call per image kept the heavy board busy about 5 s);
//   - blob: URLs are revoked only when no scene element and no export still uses the key (`retainOnly`,
//     `hold`);
//   - `status` stays local-only: this module never writes an element.
//
// No @excalidraw runtime import: the module runs (and is tested) in Node.
import type { BinaryFileData } from '@excalidraw/excalidraw/types'

export type Derivative = 'thumb' | 'display'
export const DERIVATIVES: readonly Derivative[] = ['thumb', 'display']

export const DEFAULT_MAX_CONCURRENT_FETCHES = 6
/** Stop retrying this long after the first failure (the plan's "up to 5 minutes"). */
export const DEFAULT_RETRY_WINDOW_MS = 5 * 60_000
/** §2.10.3: decoded files wait at most this long for one addFiles call. */
export const DEFAULT_BATCH_WINDOW_MS = 100

const VERSION_RE = /^ver_[0-9A-Za-z]{10,40}$/
/** §3.1 `fileId` on the wire: a version id, or a placed PDF page's `ver_….p<n>`. */
const WIRE_FILE_ID_RE = /^(ver_[0-9A-Za-z]{10,40})(?:\.p([1-9][0-9]{0,3}))?$/

export interface FileKey {
  /** The scene's fileId: `ver_…`, `ver_….p<n>`, optionally `@<derivative>`. */
  key: string
  /** The bare version id (`ver_…`). */
  versionId: string
  derivative: Derivative
  /** The PDF page of a placed page (`.p<n>`), else null. */
  page: number | null
}

/** `ver_X` → thumb; `ver_X@display` → display; `ver_X.p3` → page 3; anything else (a base64 id, a URL) → null. */
export function parseFileKey(fileId: string): FileKey | null {
  const [wire = '', suffix, extra] = fileId.split('@')
  if (extra !== undefined) return null
  const m = WIRE_FILE_ID_RE.exec(wire)
  if (!m?.[1] || !VERSION_RE.test(m[1])) return null
  const derivative = (suffix ?? 'thumb') as Derivative
  if (!DERIVATIVES.includes(derivative)) return null
  return { key: fileId, versionId: m[1], derivative, page: m[2] ? Number(m[2]) : null }
}

/** The wire fileId of a scene fileId (the derivative suffix stripped, E9), or null. */
export function wireFileId(fileId: string): string | null {
  const k = parseFileKey(fileId)
  return k ? (fileId.split('@')[0] ?? null) : null
}

/** `ver_X` (or `ver_X@thumb`) with the local derivative `d`: `ver_X@display`. */
export function withDerivative(fileId: string, d: Derivative): string | null {
  const wire = wireFileId(fileId)
  return wire ? `${wire}@${d}` : null
}

/** Raster types Excalidraw accepts that are safe as a blob: URL (SVG is not: see the note above). */
const RASTER_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
  'image/avif',
  'image/bmp',
])

const baseType = (contentType: string | null) => (contentType ?? '').split(';')[0]?.trim().toLowerCase() ?? ''

/**
 * The mime type handed to addFiles as a blob: URL. Never image/svg+xml: addMissingFiles re-encodes an
 * SVG's dataURL as a data: URL by parsing it (index.js:43806-43818), which throws (and logs) for a blob:
 * URL. Lobby's derivatives are WebP or PNG.
 */
export function rasterMimeType(contentType: string | null): BinaryFileData['mimeType'] | null {
  const t = baseType(contentType)
  return RASTER_TYPES.has(t) ? (t as BinaryFileData['mimeType']) : null
}

export const isSvgType = (contentType: string | null) => baseType(contentType) === 'image/svg+xml'

/** A Blob as a `data:` URL (base64), with no DOM (FileReader) needed. */
export async function blobToDataUrl(blob: Blob, mimeType: string): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer())
  let bin = ''
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  }
  return `data:${mimeType};base64,${btoa(bin)}`
}

export type LoadState = 'queued' | 'loading' | 'retrying' | 'loaded' | 'failed'

export interface ImageLoaderOptions {
  /** api.addFiles. Called once per key, only with a decoded blob: URL (or an SVG's data: URL). */
  addFiles(files: BinaryFileData[]): void
  /**
   * The same-origin path of a version's derivative (for example /files/<ast>/<ver>/d/<drv>?board=<bid>),
   * or null while it is not known yet (metadata still loading): that counts as a failed attempt and is
   * retried. `file` carries the page of a placed PDF page (spike B; spike A's pages ignore it).
   */
  resolveUrl(versionId: string, derivative: Derivative, file: FileKey): string | null | Promise<string | null>
  fetch?: (url: string, init: RequestInit) => Promise<Response>
  /** Resolves once the URL decodes as an image (default: HTMLImageElement.decode()). */
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
  /**
   * Legacy (spike A): schedules each batched addFiles itself (for example per animation frame). When it
   * is absent the loader uses §2.10.3's window: `batchWindowMs`, or earlier once every visible image is
   * ready.
   */
  scheduleFlush?: (flush: () => void) => void
  /** §2.10.3: the longest a decoded file waits for its addFiles call (default 100 ms). */
  batchWindowMs?: number
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
  /** decoded and waiting in the batch */
  batched: boolean
}

export interface LoaderStats {
  fetches: number
  failures: number
  retries: number
  loaded: number
  gaveUp: number
  inFlight: number
  maxInFlight: number
  /** api.addFiles calls (each repaints the scene) */
  addFilesCalls: number
  /** files handed over as a runtime-only data: URL (SVG) */
  svgDataUrls: number
  /** batches flushed early because every visible image was ready */
  earlyFlushes: number
  /** blob: URLs revoked because nothing used their key any more */
  revokedUnused: number
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
    addFilesCalls: 0,
    svgDataUrls: 0,
    earlyFlushes: 0,
    revokedUnused: 0,
  }
  private readonly o: Required<Omit<ImageLoaderOptions, 'onState' | 'scheduleFlush'>> &
    Pick<ImageLoaderOptions, 'onState' | 'scheduleFlush'>
  /** Decoded files waiting for the next batched addFiles. */
  private batch: { entry: Entry; data: BinaryFileData }[] = []
  private flushScheduled = false
  private windowTimer: unknown = null
  /** Keys an export (or anything else) still uses: never revoked while held. */
  private readonly holds = new Map<string, number>()

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
      batchWindowMs: DEFAULT_BATCH_WINDOW_MS,
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
        batched: false,
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

  /** The runtime URL a loaded key was handed to the engine with (exports read the bytes from it). */
  urlOf(fileId: string): string | null {
    const e = this.entries.get(fileId)
    return e?.state === 'loaded' ? e.blobUrl : null
  }

  /** Hands every decoded file waiting in the batch to the engine now (one addFiles call). */
  flush(): void {
    this.flushScheduled = false
    if (this.windowTimer !== null) {
      this.o.clearTimer(this.windowTimer)
      this.windowTimer = null
    }
    if (this.disposed || !this.batch.length) return
    const batch = this.batch
    this.batch = []
    this.stats.addFilesCalls++
    this.o.addFiles(batch.map((b) => b.data))
    for (const { entry } of batch) {
      entry.batched = false
      this.stats.loaded++
      this.setState(entry, 'loaded')
    }
  }

  /**
   * Keeps `fileId`'s blob: URL alive until the returned release is called (an export reads the bytes
   * after the scene may have dropped the image).
   */
  hold(fileId: string): () => void {
    this.holds.set(fileId, (this.holds.get(fileId) ?? 0) + 1)
    let released = false
    return () => {
      if (released) return
      released = true
      const n = (this.holds.get(fileId) ?? 1) - 1
      if (n > 0) this.holds.set(fileId, n)
      else this.holds.delete(fileId)
    }
  }

  /**
   * Forgets every key the scene no longer uses (and no hold keeps): its blob: URL is revoked, a pending
   * retry stops. Call it with the scene's image fileIds after elements are deleted or switch derivative.
   */
  retainOnly(inUse: ReadonlySet<string>): void {
    for (const [key, e] of [...this.entries]) {
      if (inUse.has(key) || this.holds.has(key) || e.state === 'loading' || e.batched) continue
      if (e.timer !== null) this.o.clearTimer(e.timer)
      if (e.blobUrl) {
        this.o.revokeObjectURL(e.blobUrl)
        this.stats.revokedUnused++
      }
      this.entries.delete(key)
    }
  }

  /** Revokes every blob: URL. Call only when the canvas that uses them is gone. */
  dispose(): void {
    this.disposed = true
    this.batch = []
    if (this.windowTimer !== null) this.o.clearTimer(this.windowTimer)
    this.windowTimer = null
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

  /** Every visible image is decoded (waiting in the batch or already handed over) or has given up. */
  private visibleReady(): boolean {
    for (const e of this.entries.values()) {
      if (!e.visible) continue
      if (e.batched || e.state === 'loaded' || e.state === 'failed') continue
      return false
    }
    return true
  }

  private scheduleBatch(): void {
    if (this.o.scheduleFlush) {
      if (!this.flushScheduled) {
        this.flushScheduled = true
        this.o.scheduleFlush(() => this.flush())
      }
      return
    }
    // §2.10.3: at most `batchWindowMs`, or as soon as every visible image is ready.
    if (this.visibleReady() && [...this.entries.values()].some((e) => e.visible && e.batched)) {
      this.stats.earlyFlushes++
      this.flush()
      return
    }
    if (this.windowTimer === null) {
      this.windowTimer = this.o.setTimer(() => {
        this.windowTimer = null
        this.flush()
      }, this.o.batchWindowMs)
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
    let svg = false
    try {
      const url = await this.o.resolveUrl(e.file.versionId, e.file.derivative, e.file)
      if (url === null) throw new Error('no url yet')
      if (!url.startsWith('/') || url.startsWith('//')) throw new Error('not a same-origin path')
      this.stats.fetches++
      const res = await this.o.fetch(url, { credentials: 'same-origin', cache: 'default' })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const type = res.headers.get('content-type')
      svg = isSvgType(type)
      mimeType = svg ? 'image/svg+xml' : rasterMimeType(type)
      if (!mimeType) throw new Error('not an image')
      blob = await res.blob()
    } catch {
      blob = null
    } finally {
      this.inFlight--
      this.stats.inFlight = this.inFlight
    }
    if (this.disposed || !this.entries.has(e.file.key)) return
    if (blob && mimeType) {
      // SVG: a runtime-only data: URL (never blob:, never stored or synced); raster: a blob: URL.
      let url: string | null = null
      try {
        url = svg ? await blobToDataUrl(blob, mimeType) : this.o.createObjectURL(blob)
        await this.o.decode(url, blob)
        if (this.disposed) {
          if (!svg) this.o.revokeObjectURL(url)
          return
        }
        e.blobUrl = svg ? null : url
        if (svg) this.stats.svgDataUrls++
        e.batched = true
        this.batch.push({
          entry: e,
          data: {
            id: e.file.key as BinaryFileData['id'],
            mimeType,
            dataURL: url as BinaryFileData['dataURL'],
            created: this.o.now(),
          },
        })
        this.scheduleBatch()
        this.pump()
        return
      } catch {
        if (url && !svg) this.o.revokeObjectURL(url)
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
      // A visible image that gave up no longer holds a batch back.
      if (!this.o.scheduleFlush && this.batch.length && this.visibleReady()) this.flush()
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
