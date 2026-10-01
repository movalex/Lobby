/**
 * Cross-element invariants (docs/EXCALIDRAW-MIGRATION.md §2.4.4): the signature and the violation
 * codes were frozen at the spike B contracts step C0; O1 implements `checkInvariants` (with
 * `@excalidraw/element`'s own `isBindableElement` and `isTextBindableContainer` through
 * `engine/bindability.ts`). The room enforces the same rules after each push (apps/sync/src/room/
 * invariants.ts: rejections and repairs); the spike B harness runs `checkInvariants` on the test snapshot
 * after every check (§8.1), and O4's roll-forward runs it on its result (§5.9 step g).
 *
 * The input is a whole board's element list as the test snapshot returns it: live elements AND
 * tombstones. Rules speak about live elements; a tombstone only matters where a rule says so (a live
 * label whose container is deleted is a violation).
 */
import type { WireElement } from './elements.ts'
import { isElementType } from './elements.ts'
import { isBindable, isTextContainer } from './engine/bindability.ts'
import { isValidIndexKey } from './engine/fractional.ts'

/** One code per row of §2.4.4 (plus the index rules of §2.4.3 step 11). */
export const VIOLATION_CODES = [
  /** a text's `containerId` names no live element, or one that is not a text container (rectangle, stickynote, diamond, ellipse, arrow) */
  'LABEL_CONTAINER_INVALID',
  /** container ↔ label is not one-to-one: the container's `boundElements` lists no text, several, or one that does not name it back */
  'LABEL_NOT_ONE_TO_ONE',
  /** a label sorts before (or at) its container */
  'LABEL_ORDER',
  /** a live label whose container is deleted (deleting a container deletes its label in the same clock) */
  'LABEL_ORPHANED',
  /** `startBinding`/`endBinding.elementId` names no live, bindable element */
  'BINDING_TARGET_INVALID',
  /** a bound arrow is not listed in its target's `boundElements`, or a target lists an arrow not bound to it */
  'BINDING_ASYMMETRIC',
  /** `frameId` names no live `frame` (or a frame has a `frameId`: no nesting) */
  'FRAME_INVALID',
  /** a group id has more than one parent group across the board's elements */
  'GROUP_NESTING',
  /** a type Lobby does not store (§3.1) */
  'TYPE_REFUSED',
  /** `index` is null or not a valid fractional key */
  'INDEX_INVALID',
  /** two live elements share an `index` */
  'INDEX_DUPLICATE',
] as const
export type ViolationCode = (typeof VIOLATION_CODES)[number]

export interface Violation {
  readonly code: ViolationCode
  /** the element the rule is about */
  readonly id: string
  /** the other element involved (the container, the target, the frame, the element sharing the index) */
  readonly other?: string
  /** ids only; never element text (logs and reports carry no board content) */
  readonly detail?: string
}

/** The fields the rules read; any element-shaped object will do (the room passes its stored rows). */
export interface InvariantElement {
  readonly id: string
  readonly type: string
  readonly isDeleted: boolean
  readonly index: string | null
  readonly groupIds?: readonly string[]
  readonly frameId?: string | null
  readonly boundElements?: readonly { readonly id: string; readonly type: string }[] | null
  readonly containerId?: string | null
  readonly startBinding?: { readonly elementId: string } | null
  readonly endBinding?: { readonly elementId: string } | null
  readonly locked?: boolean
}

/**
 * The parent group of each group id, from one element's `groupIds` (innermost first): `[g1, g2, g3]`
 * says g1 is inside g2, g2 inside g3, and g3 is outermost (parent null).
 */
export function groupParents(groupIds: readonly string[]): [string, string | null][] {
  return groupIds.map((g, i) => [g, groupIds[i + 1] ?? null])
}

/** Is `bound` bound at either end to `targetId`? */
const bindsTo = (el: InvariantElement, targetId: string): boolean =>
  el.startBinding?.elementId === targetId || el.endBinding?.elementId === targetId

/** Every violation of §2.4.4 on a board's elements (live and deleted). Empty = consistent. Pure. */
export function checkInvariants(elements: readonly WireElement[]): Violation[] {
  return checkInvariantsOf(elements as readonly InvariantElement[])
}

/** `checkInvariants` over any element-shaped rows (the room calls it on its stored rows). */
export function checkInvariantsOf(elements: readonly InvariantElement[]): Violation[] {
  const out: Violation[] = []
  const byId = new Map<string, InvariantElement>()
  for (const el of elements) byId.set(el.id, el)
  const liveOf = (id: string | null | undefined): InvariantElement | null => {
    if (!id) return null
    const el = byId.get(id)
    return el && !el.isDeleted ? el : null
  }

  const seenIndex = new Map<string, string>()
  const parents = new Map<string, Set<string | null>>()

  for (const el of elements) {
    if (el.isDeleted) continue
    if (!isElementType(el.type)) out.push({ code: 'TYPE_REFUSED', id: el.id, detail: el.type.slice(0, 32) })

    // index (§2.4.3 step 11)
    if (!isValidIndexKey(el.index)) out.push({ code: 'INDEX_INVALID', id: el.id })
    else {
      const other = seenIndex.get(el.index)
      if (other !== undefined) out.push({ code: 'INDEX_DUPLICATE', id: el.id, other })
      else seenIndex.set(el.index, el.id)
    }

    // labels
    if (el.type === 'text' && el.containerId) {
      const stored = byId.get(el.containerId)
      const container = liveOf(el.containerId)
      if (stored?.isDeleted) out.push({ code: 'LABEL_ORPHANED', id: el.id, other: el.containerId })
      else if (!container || !isTextContainer(container as never))
        out.push({ code: 'LABEL_CONTAINER_INVALID', id: el.id, other: el.containerId })
      else {
        const texts = (container.boundElements ?? []).filter((r) => r.type === 'text')
        if (texts.length !== 1 || texts[0]?.id !== el.id)
          out.push({ code: 'LABEL_NOT_ONE_TO_ONE', id: el.id, other: container.id })
        if (
          isValidIndexKey(el.index) &&
          isValidIndexKey(container.index) &&
          !(el.index > container.index || (el.index === container.index && el.id > container.id))
        )
          out.push({ code: 'LABEL_ORDER', id: el.id, other: container.id })
      }
    }
    // a container's text entries: exactly one, naming a live text that names it back
    const texts = (el.boundElements ?? []).filter((r) => r.type === 'text')
    if (texts.length > 1)
      out.push({ code: 'LABEL_NOT_ONE_TO_ONE', id: el.id, detail: `${texts.length} text entries` })
    for (const r of texts) {
      const t = liveOf(r.id)
      if (t?.type !== 'text' || t.containerId !== el.id)
        out.push({ code: 'LABEL_NOT_ONE_TO_ONE', id: el.id, other: r.id })
    }

    // arrow bindings
    if (el.type === 'arrow') {
      for (const b of [el.startBinding, el.endBinding]) {
        if (!b) continue
        const t = liveOf(b.elementId)
        if (!t || !isBindable(t as never)) {
          out.push({ code: 'BINDING_TARGET_INVALID', id: el.id, other: b.elementId })
          continue
        }
        if (!(t.boundElements ?? []).some((r) => r.id === el.id && r.type === 'arrow'))
          out.push({ code: 'BINDING_ASYMMETRIC', id: el.id, other: t.id })
      }
    }
    // a target's arrow entries: each names a live arrow bound to it
    for (const r of el.boundElements ?? []) {
      if (r.type !== 'arrow') continue
      const a = liveOf(r.id)
      if (a?.type !== 'arrow' || !bindsTo(a, el.id))
        out.push({ code: 'BINDING_ASYMMETRIC', id: el.id, other: r.id })
    }

    // frames
    if (el.frameId) {
      const f = liveOf(el.frameId)
      if (f?.type !== 'frame') out.push({ code: 'FRAME_INVALID', id: el.id, other: el.frameId })
    }
    if (el.type === 'frame' && el.frameId)
      out.push({ code: 'FRAME_INVALID', id: el.id, detail: 'nested frame' })

    // group nesting
    for (const [g, p] of groupParents(el.groupIds ?? [])) {
      const set = parents.get(g) ?? new Set<string | null>()
      set.add(p)
      parents.set(g, set)
    }
  }
  for (const [g, set] of parents)
    if (set.size > 1) out.push({ code: 'GROUP_NESTING', id: g, detail: `${set.size} parents` })
  return out
}
