// OWNER: 3g. W5-56: the uploading tab's local preview of the images it is adding (tldraw showed one; the
// first port did not, so a 40-image drop showed tiny "Processing…" tiles for about 11 s).
//
// THIS TAB ONLY, NEVER STORED: the preview is a `blob:` URL of the File the person picked, drawn by the
// media feature's DOM overlay (./CardLayer.tsx), never handed to the engine, never put in an element, and
// gone on reload. Two moments use it:
//   - while the drop's files upload, a "ghost" at each image's planned place (there is no element yet:
//     an element is created only once its upload has returned the version id, §2.10.1);
//   - once the element exists, until the loader has the worker's derivative, its placeholder shows the
//     local image instead of "Processing…" (other tabs still see the placeholder).
//
// Only raster images the browser shows natively, and only up to PREVIEW_MAX_PIXELS from the header
// (a decompression bomb is never decoded here: the worker refuses it and every tab shows the
// "couldn't process" tile). Each URL is revoked once nothing on the canvas needs it.
import type { FeatureRegistries } from '../../canvas/api/index.ts'
import { type Atom, atom } from '../../lib/signals.ts'
import { imageSizeFromHeader, type PixelSize } from './model.ts'

/** Images larger than this (header pixels) get no local preview: decoding them would cost the tab. */
export const PREVIEW_MAX_PIXELS = 40_000_000
/** What the browser decodes natively (and the api calls an image). SVG is never previewed. */
const PREVIEW_TYPES: ReadonlySet<string> = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif'])
/** A preview no element or ghost needs is kept this long (an element appears right after its ghost). */
export const PREVIEW_GRACE_MS = 5_000
/** At most this many previews per board page (the oldest go first). */
export const PREVIEW_MAX_ENTRIES = 200

/** A ghost: an image of an upload in progress, at its planned place (scene units). */
export interface UploadGhost {
  readonly key: string
  readonly url: string
  readonly name: string
  readonly rect: { readonly x: number; readonly y: number; readonly w: number; readonly h: number }
}

interface Entry {
  readonly url: string
  /** last time something needed it */
  seen: number
}

export interface LocalPreviews {
  /** the ghosts of uploads in progress (reactive) */
  readonly ghosts: Atom<readonly UploadGhost[]>
  /** the local preview of an uploaded version, if this tab made one (reactive through `version`) */
  urlOf(versionId: string): string | null
  /** bumped when a version's preview is added or revoked */
  readonly version: Atom<number>
  /** a blob: URL for `file`, or null when it gets no preview (type, size). The caller releases it. */
  make(file: File, size: PixelSize | null): string | null
  /** keeps `url` as the preview of `versionId` (until nothing needs it) */
  keep(versionId: string, url: string): void
  /** revokes a URL nothing will keep (an upload that failed) */
  drop(url: string): void
  addGhosts(ghosts: readonly UploadGhost[]): void
  removeGhosts(keys: readonly string[]): void
  /** forgets every preview not in `needed` for longer than the grace period */
  sweep(needed: ReadonlySet<string>, now?: number): void
  dispose(): void
}

export interface LocalPreviewDeps {
  readonly createObjectURL?: (b: Blob) => string
  readonly revokeObjectURL?: (url: string) => void
  readonly now?: () => number
}

export function createLocalPreviews(deps: LocalPreviewDeps = {}): LocalPreviews {
  const create = deps.createObjectURL ?? ((b: Blob) => URL.createObjectURL(b))
  const revoke = deps.revokeObjectURL ?? ((u: string) => URL.revokeObjectURL(u))
  const now = deps.now ?? (() => Date.now())
  const ghosts = atom<readonly UploadGhost[]>('media-upload-ghosts', [])
  const version = atom('media-local-previews', 0)
  const kept = new Map<string, Entry>()
  /** URLs handed out by `make` and not yet kept or dropped (ghosts use them) */
  const loose = new Set<string>()
  const bump = () => version.set(version.get() + 1)
  const forget = (versionId: string) => {
    const e = kept.get(versionId)
    if (!e) return
    kept.delete(versionId)
    // a URL may be kept for several versions (never in practice): revoke it only when unused
    if (![...kept.values()].some((o) => o.url === e.url) && !loose.has(e.url)) revoke(e.url)
  }
  return {
    ghosts,
    version,
    urlOf(versionId) {
      version.get()
      const e = kept.get(versionId)
      if (!e) return null
      e.seen = now()
      return e.url
    },
    make(file, size) {
      if (!PREVIEW_TYPES.has(file.type)) return null
      if (!size || size.w * size.h > PREVIEW_MAX_PIXELS) return null
      try {
        const url = create(file)
        loose.add(url)
        return url
      } catch {
        return null
      }
    },
    keep(versionId, url) {
      loose.delete(url)
      const prev = kept.get(versionId)
      if (prev?.url === url) return
      if (prev) forget(versionId)
      kept.set(versionId, { url, seen: now() })
      while (kept.size > PREVIEW_MAX_ENTRIES) {
        const oldest = kept.keys().next().value
        if (oldest === undefined) break
        forget(oldest)
      }
      bump()
    },
    drop(url) {
      if (!loose.delete(url)) return
      if (![...kept.values()].some((e) => e.url === url)) revoke(url)
    },
    addGhosts(list) {
      if (list.length) ghosts.set([...ghosts.get(), ...list])
    },
    removeGhosts(keys) {
      const gone = new Set(keys)
      const next = ghosts.get().filter((g) => !gone.has(g.key))
      if (next.length !== ghosts.get().length) ghosts.set(next)
    },
    sweep(needed, at = now()) {
      let changed = false
      for (const [versionId, e] of [...kept]) {
        if (needed.has(versionId)) {
          e.seen = at
          continue
        }
        if (at - e.seen < PREVIEW_GRACE_MS) continue
        forget(versionId)
        changed = true
      }
      if (changed) bump()
    },
    dispose() {
      for (const versionId of [...kept.keys()]) forget(versionId)
      for (const url of loose) revoke(url)
      loose.clear()
      ghosts.set([])
      bump()
    },
  }
}

const perPage = new WeakMap<FeatureRegistries, LocalPreviews>()

/** The board page's local previews (one per page's registries; disposed with the media feature). */
export function localPreviewsOf(registries: FeatureRegistries): LocalPreviews {
  let p = perPage.get(registries)
  if (!p) {
    p = createLocalPreviews()
    perPage.set(registries, p)
  }
  return p
}

/** Disposes the page's previews (the media feature unmounts). */
export function disposeLocalPreviews(registries: FeatureRegistries): void {
  perPage.get(registries)?.dispose()
  perPage.delete(registries)
}

/** The header pixel size of `file` (never decoded), for `make`'s size check. */
export async function headerSize(file: File): Promise<PixelSize | null> {
  try {
    return imageSizeFromHeader(new Uint8Array(await file.slice(0, 256 * 1024).arrayBuffer()))
  } catch {
    return null
  }
}
