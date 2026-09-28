// The board's frames for the people list ("In Brainstorm"): name, page and page bounds. Read inside a
// reactive derivation while the list is open, so it must depend on the frames alone: editing any
// other shape (a drag streams a change per frame) must not re-run it.

import type { Editor, TLShape } from 'tldraw'
import type { FrameBox } from './model.ts'

export type FrameEditor = Pick<Editor, 'getAncestorPageId' | 'getShapePageBounds' | 'store'>

/** A reactive query of the frame records (the store's type index); make it once per editor. */
export function frameRecordsQuery(editor: Pick<Editor, 'store'>) {
  return editor.store.query.records('shape', () => ({ type: { eq: 'frame' } }))
}

export function frameBoxes(editor: FrameEditor, frames: readonly TLShape[]): FrameBox[] {
  const out: FrameBox[] = []
  for (const s of frames) {
    const pageId = editor.getAncestorPageId(s)
    const b = editor.getShapePageBounds(s)
    if (!pageId || !b) continue
    const name = (s.props as { name?: unknown }).name
    out.push({ name: typeof name === 'string' ? name : '', pageId, x: b.x, y: b.y, w: b.w, h: b.h })
  }
  return out
}
