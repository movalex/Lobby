// "Copy link" to the selection or a frame (PRS-04 part) on the new canvas: `/b/<id>?el=<id>,<id>`
// (docs/EXCALIDRAW-MIGRATION.md §3.6; the tldraw build copied `?d=s<ids>`). Opening it zooms to those
// elements and selects them (./start-view.ts). Access is still checked by the servers when it is opened.
import type { CanvasFeatureContext } from '../../../../canvas/api/index.ts'
import { copyText } from '../../../../lib/clipboard.ts'
import { elementsLink, linkBase } from '../../../../lib/deep-link.ts'

/** The link to `ids` (the bare board link for none), on this board's URL. */
export function linkToElements(ids: readonly string[], href = window.location.href): string {
  return elementsLink(linkBase(href), ids)
}

/** The ids a link names: a selected label stands for its container. */
function linkIds(ctx: CanvasFeatureContext, ids: readonly string[]): string[] {
  const out: string[] = []
  for (const id of ids) {
    const el = ctx.canvas.get(id)
    if (!el) continue
    const root = el.type === 'text' && el.containerId ? el.containerId : el.id
    if (!out.includes(root)) out.push(root)
  }
  return out
}

/** Copies the link to `ids` (default: the selection) and says what was copied. Returns the link. */
export async function copySelectionLink(ctx: CanvasFeatureContext, ids?: readonly string[]): Promise<string> {
  const list = linkIds(ctx, ids ?? ctx.canvas.selection)
  const link = linkToElements(list)
  const ok = await copyText(link)
  const onlyFrame = list.length === 1 && ctx.canvas.get(list[0] as string)?.type === 'frame'
  const what = !list.length ? 'board' : onlyFrame ? 'frame' : list.length === 1 ? 'object' : 'selection'
  ctx.notify({
    key: 'copy-link',
    text: ok ? `Link to this ${what} copied.` : `Copy this link: ${link}`,
    testId: 'copy-link-notice',
    timeoutMs: ok ? 4000 : 15_000,
  })
  return link
}
