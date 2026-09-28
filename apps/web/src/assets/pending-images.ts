// F8: which image assets are still waiting for their previews in this tab, so their tiles can say so.
//
// resolve() (asset-store.ts) waits for the worker's previews before it returns a URL; until then
// tldraw 5.4.2 renders the image shape with an empty `.tl-image-container`, and collaborators saw
// blank grey tiles for several seconds. pending-image.css turns that empty tile into a quiet animated
// "Processing…" tile; the file name comes from a per-shape CSS custom property that
// PendingImageNames writes for the shapes whose asset is listed here (or still uploading: no src).

import { atom } from 'tldraw'

/** Asset record ids with a resolve() waiting on the worker, with how many resolves wait on each. */
const waiting = new Map<string, number>()
export const pendingImageAssets = atom<ReadonlySet<string>>('dr-pending-image-assets', new Set())

function publish() {
  pendingImageAssets.set(new Set(waiting.keys()))
}

/** Marks `assetId` pending until `work` settles (concurrent resolves of one asset are counted). */
export async function whilePending<T>(assetId: string, work: Promise<T>): Promise<T> {
  waiting.set(assetId, (waiting.get(assetId) ?? 0) + 1)
  if (waiting.get(assetId) === 1) publish()
  try {
    return await work
  } finally {
    const left = (waiting.get(assetId) ?? 1) - 1
    if (left > 0) waiting.set(assetId, left)
    else {
      waiting.delete(assetId)
      publish()
    }
  }
}

/**
 * A CSS string literal for `text` (a file name: untrusted). Quotes, backslashes, line breaks and
 * anything outside printable ASCII are escaped, so the value can never close the string or the rule.
 */
export function cssString(text: string): string {
  let out = '"'
  for (const ch of text.slice(0, 200)) {
    const code = ch.codePointAt(0) ?? 0
    const printable = code >= 0x20 && code < 0x7f && ch !== '"' && ch !== '\\' && ch !== '<' && ch !== '>'
    out += printable ? ch : `\\${code.toString(16)} `
  }
  return `${out}"`
}

export interface PendingTile {
  shapeId: string
  name: string
}

/** The stylesheet that hands each pending tile its file name (pending-image.css shows it). */
export function pendingNamesCss(tiles: readonly PendingTile[]): string {
  return tiles
    .map(
      (t) =>
        `.tl-shape[data-shape-id=${cssString(t.shapeId)}] { --dr-pending-name: ${cssString(t.name || 'Image')}; }`,
    )
    .join('\n')
}
