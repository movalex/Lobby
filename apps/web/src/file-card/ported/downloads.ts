// OWNER: 3g. Originals on the Excalidraw canvas: whether this person may download them (the board's
// export policy, a UI hint: the api refuses the original anyway, 403 EXPORT_DISABLED), opening a card's
// original in a new tab (F7a), and "Download original" for the selected images, pages and cards (F2-05:
// several download one after another after a question; features/canvas-ux/download-originals.ts).
//
// K1-4 (wave K): the export policy is the board's one shared resource (features/sharing/ported/
// export-policy.ts: read once per board session, every `export-control.policy` board event, a read after
// each event-stream reconnect), which every gate on the board reads; the media feature used to make that
// read itself. The same rule (`exportAllowedFor`); before the first answer, closed but for the owner and editors with
// an account (wave K.1).
import { EXPORT_DISABLED_MESSAGE, type ExportPolicy, exportAllowedFor } from '@draftroom/contracts'
import { type AssetVersionMeta, derivativeUrl, metaUrl, originalUrl } from '../../assets/contract.ts'
import type { CanvasFeatureContext } from '../../canvas/api/index.ts'
import { boardExportAllowed, notifyExportPending } from '../../features/sharing/export-rules.ts'
import { attachExportPolicy, exportStateOf } from '../../features/sharing/ported/export-policy.ts'
import type { Atom } from '../../lib/signals.ts'
import { pageAssetName } from '../pdf-pages.ts'
import { factsOf, pageOfFileId } from './model.ts'

export const EXPORT_OFF_TEXT = EXPORT_DISABLED_MESSAGE

const policyOf = (boardId: string): Atom<ExportPolicy | null> => exportStateOf(boardId).policy

/** Keeps this board's export policy current (the feature's onMount): attaches to the shared resource. */
export function syncExportPolicy(ctx: CanvasFeatureContext): () => void {
  return attachExportPolicy({ boardId: ctx.board.id, api: ctx.api, events: ctx.events })
}

/**
 * Whether this person may download originals here (reactive). Before the first answer only the owner and an
 * editor with an account, whom no policy limits (wave K.1, the board page's `boardExportAllowed`); `guest` null
 * reads the board's shared kind then (unknown: closed), and counts as not a name-only guest after it.
 */
export function downloadsAllowed(ctx: CanvasFeatureContext, guest: boolean | null = null): boolean {
  const policy = policyOf(ctx.board.id).get()
  if (policy === null)
    return boardExportAllowed(ctx.role, null, guest ?? exportStateOf(ctx.board.id).guest.get())
  return exportAllowedFor(ctx.role, policy, { nameOnlyGuest: guest === true })
}

/** Tells the person downloads are off (the export policy's own words). */
export function notifyDownloadsOff(ctx: CanvasFeatureContext): void {
  // wave K.1: before the first policy answer nothing is known to be off yet
  if (policyOf(ctx.board.id).get() === null) return notifyExportPending(ctx.notify)
  ctx.notify({ key: 'export-off', text: EXPORT_OFF_TEXT, testId: 'export-off-toast', timeoutMs: 5000 })
}

/** The original of a card (the Download link's URL), or null for an element without a Lobby file. */
export function originalOf(ctx: CanvasFeatureContext, id: string): string | null {
  const el = ctx.canvas.get(id)
  const f = el ? factsOf(el) : null
  return f ? originalUrl(ctx.board.id, f.assetId, f.versionId) : null
}

/**
 * F7a: opens a card's original in a new tab (PDFs and videos are served inline, so the browser shows
 * them; anything else downloads). While downloads are off for this person it only says so.
 */
export function openOriginal(ctx: CanvasFeatureContext, id: string, guest: boolean | null = null): boolean {
  if (!downloadsAllowed(ctx, guest)) {
    notifyDownloadsOff(ctx)
    return true
  }
  const url = originalOf(ctx, id)
  if (!url) return false
  window.open(url, '_blank', 'noopener,noreferrer')
  return true
}

// ---- Download original (the selection) ------------------------------------------------------------------

const NOTICE_KEY = 'download-originals'
const BETWEEN_FILES_MS = 300
const fmt = new Intl.NumberFormat()

export interface DownloadItem {
  readonly id: string
  /** what is fetched: the original, or a placed page's largest rendering */
  url(): Promise<string | null>
  readonly name: string
  readonly bytes: number
}

async function largestPageUrl(boardId: string, assetId: string, versionId: string, page: number) {
  const res = await fetch(metaUrl(boardId, assetId, versionId), {
    cache: 'no-store',
    credentials: 'same-origin',
  })
  if (!res.ok) return null
  const meta = (await res.json()) as AssetVersionMeta
  const all = (meta.derivatives ?? [])
    .filter((d) => (d.role === 'page' || d.role === 'thumb') && d.page === page && d.width > 0)
    .sort((a, b) => a.width - b.width)
  const d = all[all.length - 1]
  return d ? derivativeUrl(boardId, assetId, versionId, d.id) : null
}

/** The selected elements that have a file to download (images, placed pages, cards). */
export function selectedDownloads(ctx: CanvasFeatureContext, ids = ctx.canvas.selection): DownloadItem[] {
  const out: DownloadItem[] = []
  const boardId = ctx.board.id
  for (const id of ids) {
    const el = ctx.canvas.get(id)
    const f = el ? factsOf(el) : null
    if (!el || !f) continue
    const page = pageOfFileId((el as { fileId?: string | null }).fileId)
    out.push(
      page === null
        ? {
            id,
            url: async () => originalUrl(boardId, f.assetId, f.versionId),
            name: f.name || 'original',
            bytes: f.sizeBytes,
          }
        : {
            id,
            // a placed page's "original" is its largest rendering, never the whole PDF
            url: () => largestPageUrl(boardId, f.assetId, f.versionId, page),
            name: pageAssetName(f.name, page, 'image/webp'),
            bytes: 0,
          },
    )
  }
  return out
}

function saveBlob(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = name
  a.rel = 'noopener'
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 30_000)
}

async function downloadOne(item: DownloadItem): Promise<void> {
  const url = await item.url()
  if (!url) throw new Error('no url')
  const res = await fetch(url, { credentials: 'same-origin' })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  saveBlob(await res.blob(), item.name)
}

export function formatSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${fmt.format(Math.round(bytes / (1024 * 1024)))} MB`
  return `${fmt.format(Math.max(1, Math.round(bytes / 1024)))} KB`
}

export function confirmText(count: number, bytes: number): string {
  const size = bytes > 0 ? ` (about ${formatSize(bytes)})` : ''
  return `${fmt.format(count)} original files selected${size}. They download one after another; your browser may ask once to allow several downloads.`
}

async function downloadInTurn(ctx: CanvasFeatureContext, items: readonly DownloadItem[]) {
  let done = 0
  let failed = 0
  for (const [i, item] of items.entries()) {
    ctx.notify({
      key: NOTICE_KEY,
      text: `Downloading ${fmt.format(i + 1)} of ${fmt.format(items.length)}…`,
      testId: 'download-originals-progress',
      timeoutMs: null,
    })
    try {
      await downloadOne(item)
      done++
    } catch {
      failed++
    }
    if (i < items.length - 1) await new Promise((r) => setTimeout(r, BETWEEN_FILES_MS))
  }
  ctx.notify({
    key: NOTICE_KEY,
    text:
      failed === 0
        ? `Downloaded ${fmt.format(done)} original files.`
        : `Downloaded ${fmt.format(done)} of ${fmt.format(items.length)} original files; ${fmt.format(failed)} could not be downloaded.`,
    tone: failed ? 'error' : undefined,
    testId: 'download-originals-done',
    timeoutMs: 6000,
  })
}

/** "Download original": one file at once; several after a question, one after another (F2-05). */
export function downloadOriginals(ctx: CanvasFeatureContext, guest: boolean | null = null): void {
  if (!downloadsAllowed(ctx, guest)) {
    notifyDownloadsOff(ctx)
    return
  }
  const items = selectedDownloads(ctx)
  if (!items.length) return
  if (items.length === 1) {
    void downloadOne(items[0] as DownloadItem).catch(() =>
      ctx.notify({ key: NOTICE_KEY, text: 'The original could not be downloaded.', tone: 'error' }),
    )
    return
  }
  const bytes = items.reduce((s, i) => s + (i.bytes > 0 ? i.bytes : 0), 0)
  ctx.notify({
    key: NOTICE_KEY,
    text: confirmText(items.length, bytes),
    testId: 'download-originals-confirm',
    timeoutMs: null,
    action: {
      label: `Download ${fmt.format(items.length)} files`,
      testId: 'download-originals-start',
      onClick: () => void downloadInTurn(ctx, items),
    },
  })
}
