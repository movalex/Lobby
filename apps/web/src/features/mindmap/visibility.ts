// Collapsed branches are hidden with tldraw 5.4.2's own mechanism (the editor's `getShapeVisibility`
// option, passed to <Tldraw> by the board page): a hidden shape is not rendered, not hit, not selected
// by clicks or brushes, and not exported (PNG, SVG, PDF and Present all go through tldraw's rendering
// shapes). Collapsing changes nothing but `collapsed` in the topic's meta, which is synced, so everyone
// sees the same map, and the hidden topics keep their text and place.
//
// tldraw caches the answer per shape in a computed cache: the reads below (the shape, its tree
// ancestors) are its dependencies, so a collapse or an expand re-evaluates exactly the shapes under it.

import { MINDMAP_MAX_DEPTH, type MindmapTopicMeta, readEdgeMeta, readTopicMeta } from '@draftroom/contracts'
import type { Editor, TLShape, TLShapeId } from 'tldraw'
import { TOPIC_TYPES } from './tree-index.ts'

/** Whether a collapsed topic above `topic` hides it (walks the stored parent chain; loops stop). */
export function hiddenByCollapse(editor: Pick<Editor, 'getShape'>, topic: TLShape): boolean {
  const own = readTopicMeta(topic.id, topic.meta)
  if (!own || own.parentId === null) return false
  // A map whose central topic is gone is no map: its topics are plain shapes again, never hidden.
  const root = editor.getShape(own.rootId as TLShapeId)
  const rootMeta = root && TOPIC_TYPES.has(root.type) ? readTopicMeta(root.id, root.meta) : null
  if (!rootMeta || rootMeta.parentId !== null) return false
  let parentId: string | null = own.parentId
  const seen = new Set<string>([topic.id])
  for (let i = 0; parentId && i <= MINDMAP_MAX_DEPTH; i++) {
    // A loop, or a parent that is gone or not (or no longer) in this map: the topic hangs from the
    // central topic instead (model.ts buildTree), so only a collapsed central topic hides it.
    if (seen.has(parentId)) return rootMeta.collapsed
    seen.add(parentId)
    const parent: TLShape | undefined = editor.getShape(parentId as TLShapeId)
    const meta: MindmapTopicMeta | null =
      parent && TOPIC_TYPES.has(parent.type) ? readTopicMeta(parent.id, parent.meta) : null
    if (!meta || meta.rootId !== own.rootId) return rootMeta.collapsed
    if (meta.collapsed) return true
    parentId = meta.parentId
  }
  return false
}

/** tldraw `getShapeVisibility`: topics under a collapsed topic, and their lines, are hidden. */
export function mindmapShapeVisibility(shape: TLShape, editor: Editor): 'hidden' | undefined {
  const meta = shape.meta as Record<string, unknown> | undefined
  if (!meta || (meta.drMindmap === undefined && meta.drMindmapEdge === undefined)) return undefined
  if (meta.drMindmap !== undefined) {
    return TOPIC_TYPES.has(shape.type) && hiddenByCollapse(editor, shape) ? 'hidden' : undefined
  }
  if (shape.type !== 'arrow') return undefined
  const edge = readEdgeMeta(meta)
  if (!edge) return undefined
  const child = editor.getShape(edge.childId as TLShapeId)
  return child && TOPIC_TYPES.has(child.type) && hiddenByCollapse(editor, child) ? 'hidden' : undefined
}
