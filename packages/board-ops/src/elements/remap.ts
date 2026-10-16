/**
 * Copies elements with fresh ids (archive import, duplicating a template or a selection on the new canvas):
 * the element version of `../remap.ts` (docs/EXCALIDRAW-MIGRATION.md §3.7 "Import … gives every element a
 * fresh id and remaps containerId, boundElements, bindings, frameId, groupIds and the refs inside
 * mindmap/mindmapEdge; indices go above the target's top").
 *
 * - Every element gets a new id and every group id a new group id (consistently across the set).
 * - References to elements outside the set are cut: a label whose container is missing becomes free text,
 *   a binding to a missing target is unbound, a `frameId` to a missing frame is cleared, `boundElements`
 *   entries to missing elements are dropped (null when none is left).
 * - `customData.lobby` follows the key registry's duplicate rules (canvas-schema custom-data.ts): `strip`
 *   keys (`plusOne:*`, `ai`, `privateFrame`: identity-bound or identity-stamped) are removed; `relink` keys
 *   (`mindmap`, `mindmapEdge`) point at the copies, or are removed when a ref leaves the set; `strip-index`
 *   (`present`) loses its `index` unless `keepPresentIndex` (an import keeps the board's slide order); `relink-keep`
 *   (wave T: `sb:of`, `sb:head`) points at the copies where the set has them and keeps every other ref.
 *   `customData.lobbyServer` is server-owned and never copied: the server stamps it on create.
 * - Server-owned fields restart (`version` 1, a fresh `versionNonce`, `created` null, `updated` = now);
 *   `status` (images, local-only) is dropped; everything is live.
 * - `offset` moves every element; indices are fresh keys above `indexAbove` in paint order, each label right
 *   after its container (the invariants' LABEL_ORDER).
 * Input elements are never mutated. Deleted input elements are left out.
 */
import { lobbyKeySpec } from '@draftroom/canvas-schema/custom-data'
import { indexKeysBetween, isValidIndexKey } from '@draftroom/canvas-schema/engine'
import { relinkKeep } from '@draftroom/canvas-schema/planning-keys'
import { type IdSource, newElementId, randomInt31 } from './ids.ts'
import { asElements, type BoardElement, compareByIndex, isLive } from './read.ts'

type El = Record<string, unknown>

export interface RemapElementsOptions {
  /** Added to every element's `x`, `y`. */
  offset?: { x: number; y: number }
  /** Fresh indices go above this key (the target board's top index); default: a fresh sequence. */
  indexAbove?: string | null
  /** Keep `present.index` (an import); a duplicate drops it (the registry's `strip-index`). */
  keepPresentIndex?: boolean
  /** Where new ids come from (default: fresh nanoid-style ids). */
  newId?: IdSource
  /** `updated` of the copies (default: now). */
  now?: number
}

export interface RemapElementsResult {
  /** the copies, in paint order, with fresh indices */
  elements: El[]
  /** old element id → new element id */
  idMap: Map<string, string>
  /** old group id → new group id */
  groupMap: Map<string, string>
  /** what was cut, by kind (counts only) */
  cut: { labels: number; bindings: number; frames: number; bound: number; customData: number }
}

const isObj = (v: unknown): v is El => typeof v === 'object' && v !== null && !Array.isArray(v)
const finite = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0)

export function remapElements(
  input: Iterable<unknown>,
  opts: RemapElementsOptions = {},
): RemapElementsResult {
  if (opts.indexAbove !== undefined && opts.indexAbove !== null && !isValidIndexKey(opts.indexAbove))
    throw new TypeError('remapElements: indexAbove is not a valid index key')
  const newId = opts.newId ?? newElementId
  const now = opts.now ?? Date.now()
  const dx = finite(opts.offset?.x)
  const dy = finite(opts.offset?.y)

  const source: BoardElement[] = []
  const seen = new Set<string>()
  for (const el of asElements(input)) {
    if (!isLive(el) || seen.has(el.id)) continue
    seen.add(el.id)
    source.push(el)
  }
  const idMap = new Map<string, string>()
  for (const el of source) idMap.set(el.id, newId())
  const groupMap = new Map<string, string>()
  const groupOf = (g: string) => {
    let n = groupMap.get(g)
    if (!n) {
      n = newId()
      groupMap.set(g, n)
    }
    return n
  }
  const types = new Map(source.map((e) => [e.id, e.type]))
  const cut = { labels: 0, bindings: 0, frames: 0, bound: 0, customData: 0 }

  const copies = new Map<string, El>()
  for (const el of source) {
    const c = structuredClone(el) as unknown as El
    c.id = idMap.get(el.id)
    c.x = finite(el.x) + dx
    c.y = finite(el.y) + dy
    c.version = 1
    c.versionNonce = randomInt31()
    c.isDeleted = false
    c.created = null
    c.updated = now
    delete c.status
    c.groupIds = (Array.isArray(el.groupIds) ? el.groupIds : [])
      .filter((g): g is string => typeof g === 'string')
      .map(groupOf)
    // frame membership (a frame's own frameId stays null: frames never nest)
    if (typeof el.frameId === 'string') {
      const f = idMap.get(el.frameId)
      if (f && types.get(el.frameId) === 'frame' && el.type !== 'frame') c.frameId = f
      else {
        c.frameId = null
        cut.frames++
      }
    } else c.frameId = null
    // a label's container
    if (el.type === 'text' && typeof el.containerId === 'string') {
      const cid = idMap.get(el.containerId)
      if (cid) c.containerId = cid
      else {
        c.containerId = null
        c.autoResize = true
        cut.labels++
      }
    }
    // arrow bindings
    for (const end of ['startBinding', 'endBinding'] as const) {
      const b = (el as unknown as El)[end]
      if (!isObj(b)) continue
      const t = typeof b.elementId === 'string' ? idMap.get(b.elementId) : undefined
      if (t) c[end] = { ...b, elementId: t }
      else {
        c[end] = null
        cut.bindings++
      }
    }
    // boundElements: only entries that stay in the set
    if (Array.isArray(el.boundElements)) {
      const kept: { id: string; type: string }[] = []
      for (const r of el.boundElements) {
        const id = isObj(r) && typeof r.id === 'string' ? idMap.get(r.id) : undefined
        if (id && (r.type === 'text' || r.type === 'arrow')) kept.push({ id, type: r.type })
        else cut.bound++
      }
      c.boundElements = kept.length ? kept : null
    }
    // customData: the registry's duplicate rules; lobbyServer is never copied
    const cd = isObj(el.customData) ? el.customData : null
    if (cd) {
      const lobby = isObj(cd.lobby) ? remapLobby(cd.lobby, idMap, opts.keepPresentIndex === true, cut) : null
      if (lobby && Object.keys(lobby).length) c.customData = { lobby }
      else delete c.customData
    }
    copies.set(el.id, c)
  }

  // bindings are symmetric: drop an arrow entry whose arrow no longer binds to this element, and the other way
  const byNew = new Map([...copies.values()].map((c) => [c.id as string, c]))
  for (const c of copies.values()) {
    if (!Array.isArray(c.boundElements)) continue
    const kept = (c.boundElements as { id: string; type: string }[]).filter((r) => {
      const other = byNew.get(r.id)
      if (!other) return false
      if (r.type === 'text') return other.type === 'text' && other.containerId === c.id
      const sb = other.startBinding as { elementId?: string } | null | undefined
      const eb = other.endBinding as { elementId?: string } | null | undefined
      return other.type === 'arrow' && (sb?.elementId === c.id || eb?.elementId === c.id)
    })
    if (kept.length !== (c.boundElements as unknown[]).length)
      cut.bound += (c.boundElements as unknown[]).length - kept.length
    c.boundElements = kept.length ? kept : null
  }
  for (const c of copies.values()) {
    if (c.type === 'text' && typeof c.containerId === 'string') {
      const container = byNew.get(c.containerId)
      const lists = Array.isArray(container?.boundElements)
        ? (container.boundElements as { id: string }[]).some((r) => r.id === c.id)
        : false
      if (!lists) {
        c.containerId = null
        c.autoResize = true
        cut.labels++
      }
    }
    if (c.type === 'arrow') {
      for (const end of ['startBinding', 'endBinding'] as const) {
        const b = c[end] as { elementId?: string } | null | undefined
        if (!b?.elementId) continue
        const t = byNew.get(b.elementId)
        const lists = Array.isArray(t?.boundElements)
          ? (t.boundElements as { id: string; type: string }[]).some(
              (r) => r.id === c.id && r.type === 'arrow',
            )
          : false
        if (!lists) {
          c[end] = null
          cut.bindings++
        }
      }
    }
  }

  // paint order, each label right after its container, then fresh indices
  const ordered = [...source].sort(compareByIndex)
  const labelsOf = new Map<string, BoardElement[]>()
  for (const el of ordered) {
    const c = copies.get(el.id) as El
    if (c.type === 'text' && typeof c.containerId === 'string') {
      const containerOld = el.containerId as string
      labelsOf.set(containerOld, [...(labelsOf.get(containerOld) ?? []), el])
    }
  }
  const out: El[] = []
  for (const el of ordered) {
    const c = copies.get(el.id) as El
    if (c.type === 'text' && typeof c.containerId === 'string') continue
    out.push(c)
    for (const label of labelsOf.get(el.id) ?? []) out.push(copies.get(label.id) as El)
  }
  const keys = indexKeysBetween(opts.indexAbove ?? null, null, out.length)
  out.forEach((c, i) => {
    c.index = keys[i]
  })
  return { elements: out, idMap, groupMap, cut }
}

function remapLobby(
  lobby: El,
  idMap: Map<string, string>,
  keepPresentIndex: boolean,
  cut: RemapElementsResult['cut'],
): El {
  const out: El = {}
  for (const [key, value] of Object.entries(lobby)) {
    const spec = lobbyKeySpec(key)
    if (!spec || spec.duplicate === 'strip') {
      cut.customData++
      continue
    }
    if (spec.duplicate === 'relink-keep') {
      out[key] = structuredClone(relinkKeep(key, value, idMap))
      continue
    }
    if (spec.duplicate === 'relink') {
      const relinked = relink(key, value, idMap)
      if (relinked) out[key] = relinked
      else cut.customData++
      continue
    }
    if (spec.duplicate === 'strip-index' && !keepPresentIndex && isObj(value)) {
      const { index: _index, ...rest } = value
      if (Object.keys(rest).length) out[key] = rest
      continue
    }
    out[key] = structuredClone(value)
  }
  return out
}

/** `mindmap` / `mindmapEdge` with every ref pointing at a copy, or null when one leaves the set. */
function relink(key: string, value: unknown, idMap: Map<string, string>): El | null {
  if (!isObj(value)) return null
  const refs = key === 'mindmap' ? ['rootId', 'parentId'] : ['rootId', 'parentId', 'childId']
  const out: El = { ...value }
  for (const r of refs) {
    const v = value[r]
    if (v === null && key === 'mindmap' && r === 'parentId') continue
    const n = typeof v === 'string' ? idMap.get(v) : undefined
    if (!n) return null
    out[r] = n
  }
  return out
}
