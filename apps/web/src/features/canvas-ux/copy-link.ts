// "Copy link" to the selection or a frame (PRS-04 part): a tldraw deep link (?d=s<ids>, built by
// Editor.createDeepLink) on the bare board URL. Opening it zooms to those shapes and selects them
// (start-view-runtime.ts). Access is still checked by the servers when the link is opened.

import type { Editor, TLShapeId } from 'tldraw'
import { copyText } from '../../lib/clipboard.ts'
import { getFeatureCtx } from './bridge.ts'
import { boardLinkBase, DEEP_LINK_PARAM } from './start-view.ts'

export function linkToShapes(editor: Editor, shapeIds: readonly TLShapeId[]): string {
  const base = boardLinkBase(window.location.href)
  if (!shapeIds.length) return base
  return editor
    .createDeepLink({ url: base, param: DEEP_LINK_PARAM, to: { type: 'shapes', shapeIds: [...shapeIds] } })
    .toString()
}

export async function copySelectionLink(editor: Editor, shapeIds?: readonly TLShapeId[]): Promise<string> {
  const ids = shapeIds ?? editor.getSelectedShapeIds()
  const link = linkToShapes(editor, ids)
  const ok = await copyText(link)
  const onlyFrame = ids.length === 1 && editor.getShape(ids[0] as TLShapeId)?.type === 'frame'
  const what = !ids.length ? 'board' : onlyFrame ? 'frame' : ids.length === 1 ? 'object' : 'selection'
  getFeatureCtx(editor)?.notify({
    key: 'copy-link',
    text: ok ? `Link to this ${what} copied.` : `Copy this link: ${link}`,
    testId: 'copy-link-notice',
    timeoutMs: ok ? 4000 : 15_000,
  })
  return link
}
