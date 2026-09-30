import type { VoteShapeInfo } from '@draftroom/contracts'
import type { Editor, TLShapeId } from 'tldraw'

// The engine-neutral hooks live in ./workshop-context.ts (shared with the Excalidraw page's ported
// feature); the tldraw page keeps importing them from here.
export { canEditBoard, storeFor, useIsFacilitator, useNow, useWorkshop } from './workshop-context.ts'

/** Shape lookup for the shared eligibility rule (packages/contracts isVoteEligible). */
export function editorLookup(editor: Editor): (id: string) => VoteShapeInfo | undefined {
  return (id) => {
    const s = editor.getShape(id as TLShapeId)
    return s ? { id: s.id, type: s.type, parentId: s.parentId } : undefined
  }
}
