// Which shapes are topics and lines of which map, kept up to date from the store's side effects (every
// source: this user, other people, undo). Only meta is indexed, never positions, so it changes when a
// map's structure changes and not while things move. Readers use it to find a map's shapes without
// scanning the page, and the overlay's badges read `version` to recount collapsed branches.

import {
  MINDMAP_MAX_DEPTH,
  type MindmapEdgeMeta,
  type MindmapTopicMeta,
  readEdgeMeta,
  readTopicMeta,
} from '@draftroom/contracts'
import { atom, type TLShape, type TLShapeId } from 'tldraw'

export const TOPIC_TYPES: ReadonlySet<string> = new Set(['geo', 'text', 'note'])

/** A shape's topic meta, when it is a valid topic. */
export function topicMetaOf(shape: TLShape | undefined): MindmapTopicMeta | null {
  if (!shape || !TOPIC_TYPES.has(shape.type)) return null
  return readTopicMeta(shape.id, shape.meta)
}

/** An arrow's edge meta, when it is a mind-map line. */
export function edgeMetaOf(shape: TLShape | undefined): MindmapEdgeMeta | null {
  if (shape?.type !== 'arrow') return null
  return readEdgeMeta(shape.meta)
}

/** Cheap pre-check before validating: does the shape carry either mind-map key at all? */
export function hasMindmapMeta(shape: TLShape): boolean {
  const m = shape.meta as Record<string, unknown> | undefined
  return m !== undefined && (m.drMindmap !== undefined || m.drMindmapEdge !== undefined)
}

const addTo = <K, V>(map: Map<K, Set<V>>, key: K, value: V) => {
  let set = map.get(key)
  if (!set) {
    set = new Set()
    map.set(key, set)
  }
  set.add(value)
}
const removeFrom = <K, V>(map: Map<K, Set<V>>, key: K, value: V) => {
  const set = map.get(key)
  if (!set) return
  set.delete(value)
  if (!set.size) map.delete(key)
}

export class TreeIndex {
  readonly topics = new Map<TLShapeId, MindmapTopicMeta>()
  /** rootId -> every topic naming it (the root included). */
  readonly byRoot = new Map<string, Set<TLShapeId>>()
  /** parentId (as stored) -> topics naming it. */
  readonly children = new Map<string, Set<TLShapeId>>()
  readonly edges = new Map<TLShapeId, MindmapEdgeMeta>()
  readonly edgesByChild = new Map<string, Set<TLShapeId>>()
  readonly collapsed = new Set<TLShapeId>()
  /** Bumped whenever the indexed structure changes (not on moves or text edits). */
  readonly version = atom('dr-mindmap-index', 0)

  /** (Re)indexes a created or changed shape. Returns true when the structure changed. */
  put(shape: TLShape): boolean {
    const id = shape.id
    const t = topicMetaOf(shape)
    const e = t ? null : edgeMetaOf(shape)
    const oldT = this.topics.get(id)
    const oldE = this.edges.get(id)
    if (
      (t && oldT && sameTopic(t, oldT)) ||
      (e && oldE && sameEdge(e, oldE)) ||
      (!t && !e && !oldT && !oldE)
    ) {
      return false
    }
    this.drop(id)
    if (t) {
      this.topics.set(id, t)
      addTo(this.byRoot, t.rootId, id)
      if (t.parentId) addTo(this.children, t.parentId, id)
      if (t.collapsed) this.collapsed.add(id)
    } else if (e) {
      this.edges.set(id, e)
      addTo(this.edgesByChild, e.childId, id)
    }
    this.bump()
    return true
  }

  /** Forgets a deleted shape. Returns true when it was indexed. */
  remove(id: TLShapeId): boolean {
    if (!this.topics.has(id) && !this.edges.has(id)) return false
    this.drop(id)
    this.bump()
    return true
  }

  private drop(id: TLShapeId) {
    const t = this.topics.get(id)
    if (t) {
      this.topics.delete(id)
      removeFrom(this.byRoot, t.rootId, id)
      if (t.parentId) removeFrom(this.children, t.parentId, id)
      this.collapsed.delete(id)
    }
    const e = this.edges.get(id)
    if (e) {
      this.edges.delete(id)
      removeFrom(this.edgesByChild, e.childId, id)
    }
  }

  private bump() {
    this.version.set(this.version.get() + 1)
  }

  /** The root a topic belongs to (its own id for a root). */
  rootOf(id: TLShapeId): string | null {
    return this.topics.get(id)?.rootId ?? null
  }

  /**
   * Topics under `id` by stored meta (collapsed branches included), without the topic itself. Used for
   * the collapsed badges' counts; loops are cut by the visited set.
   */
  descendantCount(id: TLShapeId): number {
    const seen = new Set<string>([id])
    const stack: string[] = [id]
    let depth = 0
    while (stack.length && depth++ < MINDMAP_MAX_DEPTH * 64) {
      const cur = stack.pop() as string
      for (const c of this.children.get(cur) ?? []) {
        if (seen.has(c)) continue
        seen.add(c)
        stack.push(c)
      }
    }
    return seen.size - 1
  }
}

const sameTopic = (a: MindmapTopicMeta, b: MindmapTopicMeta) =>
  a.rootId === b.rootId && a.parentId === b.parentId && a.side === b.side && a.collapsed === b.collapsed
const sameEdge = (a: MindmapEdgeMeta, b: MindmapEdgeMeta) =>
  a.rootId === b.rootId && a.parentId === b.parentId && a.childId === b.childId
