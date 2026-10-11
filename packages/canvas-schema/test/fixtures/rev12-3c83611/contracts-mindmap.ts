// FROZEN FIXTURE, never edit. This is
//   packages/contracts/src/mindmap.ts
// of commit 3c83611 (the web deployed on staging since hotfix H2 (wave M): CONTRACTS_REV 12), as
// `git show 3c83611:<that path>` gives it (blob fcd6cc6e7710). The deployed web parses every server
// frame with these schemas (its socket transport, apps/web/src/canvas/sync/transport/socket.ts at that
// commit: `ServerMessage.safeParse` on each text frame, the gzip snapshot through `decodeSnapshotFrame`),
// so the stale-pair tests parse the room's frames with them (docs/EXCALIDRAW-CONTRACTS.md §0b, the
// per-reader downgrade rule). Changed from the commit:
// these header lines only.
// Mind maps (docs/WAVE4-CONTRACTS.md "mindmap"). Browser-safe. Owned by the mindmap owner.
//
// There is no mind-map shape type and no API route: a map is ordinary tldraw shapes on the board.
// Topics are geo, text or note shapes; each topic carries its place in the tree in shape meta, under
// `meta.drMindmap`. The line from a parent to a child is an ordinary arrow bound at both ends, marked
// with `meta.drMindmapEdge`. Everything is synced and stored by native tldraw sync like any other
// shape, so the sync server's rules (read-only roles, the text lease) apply unchanged.
//
// Meta is written by clients, so every reader validates it with the schemas below and treats a shape
// whose meta does not parse as a plain shape (never as a broken topic).
//
// Do not import values from ./index.ts here: index.ts re-exports this module.

import { z } from 'zod'

/** Shape meta key of a topic: `{ rootId, parentId, side, collapsed }`. */
export const MINDMAP_META_KEY = 'drMindmap'
/** Shape meta key of the arrow joining a parent topic to one child: `{ rootId, parentId, childId }`. */
export const MINDMAP_EDGE_META_KEY = 'drMindmapEdge'

export const MINDMAP_SIDES = ['left', 'right'] as const
export type MindmapSide = (typeof MINDMAP_SIDES)[number]

/** The shape types a topic may be (a map may start from a note or a text; new topics are geo). */
export const MINDMAP_TOPIC_TYPES = ['geo', 'text', 'note'] as const

/** Readers stop walking a tree deeper than this, and never lay out more topics than this per map. */
export const MINDMAP_MAX_DEPTH = 64
export const MINDMAP_MAX_TOPICS = 2000

/** A tldraw shape id (`shape:` + the id tldraw or a template chose). */
export const MindmapShapeRef = z.string().regex(/^shape:[^\s"'<>\\]{1,120}$/)

/**
 * A topic's place in its map. `parentId: null` marks the root, and then `rootId` must be the shape's
 * own id (checked by the reader, which knows the id). `side` is where a first-level branch grows from
 * the root; deeper topics follow their first-level ancestor. Unknown extra keys are ignored.
 */
export const MindmapTopicMeta = z.object({
  rootId: MindmapShapeRef,
  parentId: MindmapShapeRef.nullable(),
  side: z.enum(MINDMAP_SIDES),
  collapsed: z.boolean(),
})
export type MindmapTopicMeta = z.infer<typeof MindmapTopicMeta>

/** The arrow from `parentId` to `childId` (both topics of the map rooted at `rootId`). */
export const MindmapEdgeMeta = z.object({
  rootId: MindmapShapeRef,
  parentId: MindmapShapeRef,
  childId: MindmapShapeRef,
})
export type MindmapEdgeMeta = z.infer<typeof MindmapEdgeMeta>

const metaObject = (meta: unknown): Record<string, unknown> | null =>
  typeof meta === 'object' && meta !== null && !Array.isArray(meta) ? (meta as Record<string, unknown>) : null

/**
 * The topic meta of a shape with `id` and `meta`, or null when it has none or it does not validate
 * (including a root whose rootId is not its own id, and a topic that is its own parent).
 */
export function readTopicMeta(id: string, meta: unknown): MindmapTopicMeta | null {
  const raw = metaObject(meta)?.[MINDMAP_META_KEY]
  if (raw === undefined) return null
  const parsed = MindmapTopicMeta.safeParse(raw)
  if (!parsed.success) return null
  const m = parsed.data
  if (m.parentId === null ? m.rootId !== id : m.parentId === id || m.rootId === id) return null
  return m
}

/** The edge meta of an arrow, or null (missing, invalid, or a self-loop). */
export function readEdgeMeta(meta: unknown): MindmapEdgeMeta | null {
  const raw = metaObject(meta)?.[MINDMAP_EDGE_META_KEY]
  if (raw === undefined) return null
  const parsed = MindmapEdgeMeta.safeParse(raw)
  if (!parsed.success || parsed.data.parentId === parsed.data.childId) return null
  return parsed.data
}

/** Columns of the CSV outline export (one row per topic, in outline order). */
export const MINDMAP_OUTLINE_CSV_HEADER = ['level', 'topic', 'parent', 'path'] as const
