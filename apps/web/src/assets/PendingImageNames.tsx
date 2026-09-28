// F8: gives every image tile that is still waiting for its preview (in this tab) its file name, for
// the animated "Processing…" tile in pending-image.css. One stylesheet with a rule per pending
// shape (like the locked-frame badges); it only looks at the page's shapes while something is pending.

import { useEditor, useValue } from 'tldraw'
import { type PendingTile, pendingImageAssets, pendingNamesCss } from './pending-images.ts'

export function PendingImageNames() {
  const editor = useEditor()
  const css = useValue('dr-pending-image-names', () => {
    const waiting = pendingImageAssets.get()
    // Still uploading somewhere (no src yet), or this tab's resolve() waits on the worker.
    const pending = new Map<string, string>()
    for (const asset of editor.getAssets()) {
      if (asset.type !== 'image') continue
      if (!asset.props.src || waiting.has(asset.id)) pending.set(asset.id, asset.props.name)
    }
    if (!pending.size) return ''
    const tiles: PendingTile[] = []
    for (const shape of editor.getCurrentPageShapes()) {
      if (shape.type !== 'image') continue
      const assetId = (shape.props as { assetId?: string | null }).assetId
      const name = assetId ? pending.get(assetId) : undefined
      if (name !== undefined) tiles.push({ shapeId: shape.id, name })
    }
    tiles.sort((a, b) => (a.shapeId < b.shapeId ? -1 : 1))
    return pendingNamesCss(tiles)
  }, [editor])
  if (!css) return null
  return <style data-testid="pending-image-names">{css}</style>
}
