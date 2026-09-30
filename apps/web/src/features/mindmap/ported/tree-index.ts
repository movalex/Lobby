// Which elements are topics and lines of which map, kept up to date from the canvas's change stream
// (every source: this tab, other people, undo). Only the mind-map values are indexed, never positions, so
// it changes when a map's structure changes and not while things move. The port of ../tree-index.ts on
// element ids and `customData.lobby` (./meta.ts). Readers use it to find a map's elements without scanning
// the board; overlays read `version` (lib/signals.ts) to recount collapsed branches. Pure: no DOM.

import { MINDMAP_MAX_DEPTH } from '@draftroom/contracts'
import type { CanvasElement } from '../../../canvas/api/index.ts'
import { atom } from '../../../lib/signals.ts'
import { type EdgeMeta, edgeMetaOf, sameEdge, sameTopic, type TopicMeta, topicMetaOf } from './meta.ts'

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
  readonly topics = new Map<string, TopicMeta>()
  /** rootId -> every topic naming it (the root included). */
  readonly byRoot = new Map<string, Set<string>>()
  /** parentId (as stored) -> topics naming it. */
  readonly children = new Map<string, Set<string>>()
  readonly edges = new Map<string, EdgeMeta>()
  readonly edgesByChild = new Map<string, Set<string>>()
  readonly collapsed = new Set<string>()
  /** Bumped whenever the indexed structure changes (not on moves or text edits). */
  readonly version = atom('mindmap.index', 0)

  /** Indexes every element of a scene (the first run, or a full rescan). Returns true when anything changed. */
  rebuild(elements: Iterable<CanvasElement>): boolean {
    const seen = new Set<string>()
    let changed = false
    for (const el of elements) {
      seen.add(el.id)
      if (this.putQuiet(el)) changed = true
    }
    for (const id of [...this.topics.keys(), ...this.edges.keys()]) {
      if (!seen.has(id)) {
        this.drop(id)
        changed = true
      }
    }
    if (changed) this.bump()
    return changed
  }

  /** (Re)indexes a created or changed element (a deleted one is forgotten). True when the structure changed. */
  put(el: CanvasElement | undefined, id?: string): boolean {
    const changed = el ? this.putQuiet(el) : id !== undefined && this.removeQuiet(id)
    if (changed) this.bump()
    return changed
  }

  /** Forgets an element. True when it was indexed. */
  remove(id: string): boolean {
    const changed = this.removeQuiet(id)
    if (changed) this.bump()
    return changed
  }

  private putQuiet(el: CanvasElement): boolean {
    const id = el.id
    const t = topicMetaOf(el)
    const e = t ? null : edgeMetaOf(el)
    const oldT = this.topics.get(id)
    const oldE = this.edges.get(id)
    if ((t && oldT && sameTopic(t, oldT)) || (e && oldE && sameEdge(e, oldE)) || (!t && !e && !oldT && !oldE))
      return false
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
    return true
  }

  private removeQuiet(id: string): boolean {
    if (!this.topics.has(id) && !this.edges.has(id)) return false
    this.drop(id)
    return true
  }

  private drop(id: string) {
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
  rootOf(id: string): string | null {
    return this.topics.get(id)?.rootId ?? null
  }

  /** The map a topic or a line belongs to. */
  rootOfAny(id: string): string | null {
    return this.topics.get(id)?.rootId ?? this.edges.get(id)?.rootId ?? null
  }

  /**
   * Topics under `id` by stored meta (collapsed branches included), without the topic itself: the
   * collapsed badges' counts. Loops are cut by the visited set.
   */
  descendantCount(id: string): number {
    const seen = new Set<string>([id])
    const stack: string[] = [id]
    let steps = 0
    while (stack.length && steps++ < MINDMAP_MAX_DEPTH * 64) {
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
