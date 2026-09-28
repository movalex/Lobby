// F2-05: tldraw's "Download original" starts one browser download per selected image or video, so
// Ctrl+A → Download original fired 18 downloads in 6 s (and Chrome's "download multiple files" prompt).
// With one file it stays tldraw's action. With more, a notice first says how many files (and how much)
// and asks; on "Download N files" they download one after another, each after the previous one arrived,
// with a running count in the same notice. No ZIP: the originals are fetched as they are.

import type { Editor, TLAsset, TLAssetId, TLShape, TLUiActionsContextType } from 'tldraw'
import { downloadBlob } from '../present-export/download.ts'
import { getFeatureCtx } from './bridge.ts'

const NOTICE_KEY = 'download-originals'
/** A pause between files, so the browser sees a sequence rather than a burst. */
const BETWEEN_FILES_MS = 300

/** The selected images and videos that have an uploaded file (what tldraw's action would download). */
export function selectedOriginals(editor: Editor): { shape: TLShape; asset: TLAsset }[] {
  const out: { shape: TLShape; asset: TLAsset }[] = []
  for (const shape of editor.getSelectedShapes()) {
    if (shape.type !== 'image' && shape.type !== 'video') continue
    const assetId = (shape.props as { assetId?: TLAssetId | null }).assetId
    const asset = assetId ? editor.getAsset(assetId) : undefined
    if (asset?.props.src) out.push({ shape, asset })
  }
  return out
}

const fmt = new Intl.NumberFormat()

export function formatSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${fmt.format(Math.round(bytes / (1024 * 1024)))} MB`
  return `${fmt.format(Math.max(1, Math.round(bytes / 1024)))} KB`
}

/** The question asked before downloading several originals. */
export function confirmText(count: number, bytes: number): string {
  const size = bytes > 0 ? ` (about ${formatSize(bytes)})` : ''
  return `${fmt.format(count)} original files selected${size}. They download one after another; your browser may ask once to allow several downloads.`
}

function fileName(asset: TLAsset, index: number): string {
  const name = (asset.props as { name?: unknown }).name
  return typeof name === 'string' && name.trim() ? name : `original-${index + 1}`
}

async function downloadInTurn(editor: Editor, items: { asset: TLAsset }[]): Promise<void> {
  const ctx = getFeatureCtx(editor)
  let done = 0
  let failed = 0
  for (const [i, { asset }] of items.entries()) {
    ctx?.notify({
      key: NOTICE_KEY,
      text: `Downloading ${fmt.format(i + 1)} of ${fmt.format(items.length)}…`,
      testId: 'download-originals-progress',
      timeoutMs: null,
    })
    try {
      const url = await editor.resolveAssetUrl(asset.id, { shouldResolveToOriginal: true })
      if (!url) throw new Error('no url')
      const resp = await fetch(url)
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`)
      downloadBlob(await resp.blob(), fileName(asset, i))
      done++
    } catch {
      failed++
    }
    if (i < items.length - 1) await new Promise((r) => setTimeout(r, BETWEEN_FILES_MS))
  }
  ctx?.notify({
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

/** Wraps tldraw's download-original action (before the export gate wraps it, so the gate still asks first). */
export function sequentialDownloadOriginal(
  editor: Editor,
  actions: TLUiActionsContextType,
): TLUiActionsContextType {
  const action = actions['download-original']
  if (!action) return actions
  actions['download-original'] = {
    ...action,
    onSelect(source) {
      const items = selectedOriginals(editor)
      const ctx = getFeatureCtx(editor)
      if (items.length <= 1 || !ctx) return action.onSelect(source)
      const bytes = items.reduce((sum, { asset }) => {
        const size = (asset.props as { fileSize?: unknown }).fileSize
        return sum + (typeof size === 'number' && size > 0 ? size : 0)
      }, 0)
      ctx.notify({
        key: NOTICE_KEY,
        text: confirmText(items.length, bytes),
        testId: 'download-originals-confirm',
        timeoutMs: null,
        action: {
          label: `Download ${fmt.format(items.length)} files`,
          testId: 'download-originals-start',
          onClick: () => void downloadInTurn(editor, items),
        },
      })
    },
  }
  return actions
}
