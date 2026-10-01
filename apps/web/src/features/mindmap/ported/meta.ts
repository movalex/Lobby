// Mind-map facts on canvas elements (docs/EXCALIDRAW-MIGRATION.md §3.3, §4.7): a topic carries
// `customData.lobby.mindmap` = {rootId, parentId, side, collapsed} and the line from a parent to a child
// is an arrow carrying `customData.lobby.mindmapEdge` = {rootId, parentId, childId}, both with ELEMENT ids
// (canvas-schema custom-data.ts `MindmapValue`, `MindmapEdgeValue`; today's tldraw `meta.drMindmap` and
// `meta.drMindmapEdge` carried `shape:` refs, and the converter maps them).
//
// Values are written by clients, so every reader validates them and treats an element whose value does not
// parse as a plain element (never as a broken topic), exactly as the tldraw readers do
// (packages/contracts/src/mindmap.ts readTopicMeta / readEdgeMeta). Pure: no DOM, no engine.

import { MindmapEdgeValue, MindmapValue } from '@draftroom/canvas-schema/custom-data'
import type { MindmapSide } from '@draftroom/contracts'
import type { CanvasElement } from '../../../canvas/api/index.ts'

export const MINDMAP_KEY = 'mindmap'
export const MINDMAP_EDGE_KEY = 'mindmapEdge'

/** A topic's place in its map (element ids). The same shape as today's `MindmapTopicMeta`. */
export interface TopicMeta {
  rootId: string
  parentId: string | null
  side: MindmapSide
  collapsed: boolean
}

export interface EdgeMeta {
  rootId: string
  parentId: string
  childId: string
}

/**
 * Element types a topic may be: new topics are rectangles with a bound label; a map may also start from
 * a sticky note, an ellipse, a diamond or a free text (tldraw's geo, note and text topics, converted).
 */
export const TOPIC_TYPES: ReadonlySet<string> = new Set([
  'rectangle',
  'ellipse',
  'diamond',
  'stickynote',
  'text',
])

type Lobby = Readonly<Record<string, unknown>> | undefined

const lobbyOf = (el: { customData?: { lobby?: Lobby } | null } | undefined): Lobby => el?.customData?.lobby

const isLive = (el: CanvasElement | undefined): el is CanvasElement =>
  !!el && !(el as { isDeleted?: boolean }).isDeleted

/** Whether the element can be a topic at all (a bound label never is: its container is). */
export function isTopicType(el: Pick<CanvasElement, 'type'> & { containerId?: string | null }): boolean {
  if (!TOPIC_TYPES.has(el.type)) return false
  return !(el.type === 'text' && el.containerId)
}

/**
 * The topic meta of an element, or null when it has none or it does not validate (a root whose rootId
 * is not its own id, a topic that is its own parent or claims to be its own root).
 */
export function topicMetaOf(el: CanvasElement | undefined): TopicMeta | null {
  if (!isLive(el) || !isTopicType(el)) return null
  const raw = lobbyOf(el)?.[MINDMAP_KEY]
  if (raw === undefined) return null
  const parsed = MindmapValue.safeParse(raw)
  if (!parsed.success) return null
  const m = parsed.data
  if (m.parentId === null ? m.rootId !== el.id : m.parentId === el.id || m.rootId === el.id) return null
  return { rootId: m.rootId, parentId: m.parentId, side: m.side, collapsed: m.collapsed }
}

/**
 * A topic value as stored, checked against the schema only: a copy (Ctrl+D, paste) still carries its
 * original's ids until the runtime rewrites it, so its value does not validate against its own id yet.
 */
export function rawTopicValue(el: CanvasElement | undefined): TopicMeta | null {
  if (!isLive(el) || !isTopicType(el)) return null
  const parsed = MindmapValue.safeParse(lobbyOf(el)?.[MINDMAP_KEY])
  return parsed.success ? { ...parsed.data } : null
}

/** The edge meta of an arrow, or null (missing, invalid, not an arrow, or a self-loop). */
export function edgeMetaOf(el: CanvasElement | undefined): EdgeMeta | null {
  if (!isLive(el) || el.type !== 'arrow') return null
  const raw = lobbyOf(el)?.[MINDMAP_EDGE_KEY]
  if (raw === undefined) return null
  const parsed = MindmapEdgeValue.safeParse(raw)
  if (!parsed.success || parsed.data.parentId === parsed.data.childId) return null
  return { ...parsed.data }
}

/** Cheap pre-check before validating: does the element carry either mind-map key at all? */
export function hasMindmapData(el: CanvasElement | undefined): boolean {
  const lobby = lobbyOf(el)
  return !!lobby && (lobby[MINDMAP_KEY] !== undefined || lobby[MINDMAP_EDGE_KEY] !== undefined)
}

export const sameTopic = (a: TopicMeta, b: TopicMeta) =>
  a.rootId === b.rootId && a.parentId === b.parentId && a.side === b.side && a.collapsed === b.collapsed
export const sameEdge = (a: EdgeMeta, b: EdgeMeta) =>
  a.rootId === b.rootId && a.parentId === b.parentId && a.childId === b.childId

/** The `customData` patch that sets a topic's meta (tx.update merges `customData.lobby` per key). */
export const topicPatch = (meta: TopicMeta) => ({ customData: { lobby: { [MINDMAP_KEY]: { ...meta } } } })
/** The `customData` patch that sets an edge's meta. */
export const edgePatch = (meta: EdgeMeta) => ({ customData: { lobby: { [MINDMAP_EDGE_KEY]: { ...meta } } } })
/** The `customData` patch that removes a topic's meta (the element becomes a plain shape). */
export const clearTopicPatch = () => ({ customData: { lobby: { [MINDMAP_KEY]: null } } })
