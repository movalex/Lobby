// Cross-element invariants in the accept algorithm (docs/EXCALIDRAW-MIGRATION.md §2.4.4, §2.4.3 step 10),
// after the last op of a push and before RELEASE SAVEPOINT. The pure checker of the same rules is
// canvas-schema's invariants.ts (the harness runs it on the test snapshot); here the room decides what a
// violation costs:
//
//  REJECTIONS (the op that caused it is refused; its element goes back to its state before the push):
//   - a text naming a container that is missing, deleted or not a text container → INVALID
//   - a second label for a container → INVALID
//   - a label created for (or pointed at) a container leased by another session → LEASED; locked → LOCKED
//   - `frameId` naming something that is not a frame, or a frame inside a frame → INVALID
//   - a group id that would get a second parent group → INVALID
//  REPAIRS (server writes in the same clock):
//   - deleting a container deletes its label; deleting a target nulls the arrows' bindings to it (the end
//     stays where it is); deleting a frame clears its children's `frameId`
//   - a binding to a missing, deleted or unbindable element is set to null (`fix`)
//   - `boundElements` kept symmetric: a bound arrow is listed by its target, a label by its container,
//     and entries that are not bound back are removed (allowed on a locked target)
//   - `frameId` naming a frame deleted concurrently → null

import { isBindable, isTextContainer } from '@draftroom/canvas-schema/engine'
import type { RejectCode } from '@draftroom/canvas-schema/protocol'
import type { El, PushApplier, Work } from './merge.ts'

const equal = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b)
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T
const isLabel = (el: El | null | undefined): boolean => !!el && el.type === 'text' && !!el.containerId
const wasLive = (w: Work) => !!w.before && !w.before.isDeleted
const isLive = (w: Work) => !!w.el && !w.el.isDeleted

type Ref = { id: string; type: 'arrow' | 'text' }

export function enforceInvariants(p: PushApplier): void {
  for (let pass = 0; pass < 4; pass++) if (!rejectPass(p)) break
  repairPass(p)
}

// ---- rejections ------------------------------------------------------------------------------------

function rejectPass(p: PushApplier): boolean {
  let reverted = false
  const revert = (id: string, code: RejectCode) => {
    p.revert(id, code)
    reverted = true
  }
  const written = [...p.worked()].filter((w) => w.writers.length > 0 && w.el)
  const labelsOf = new Map<string, string[]>()
  for (const w of written) {
    const el = w.el as El
    if (el.isDeleted) continue
    // labels
    if (isLabel(el)) {
      const newlyPointed = !wasLive(w) || w.before?.containerId !== el.containerId
      if (newlyPointed) {
        const x = p.live(el.containerId)
        if (!x || !isTextContainer(x as never)) {
          revert(w.id, 'INVALID')
          continue
        }
        // the container's lease and lock first: a writer who may not touch X is told why (B3 L8)
        if (p.leasedByOther(x.id)) {
          revert(w.id, 'LEASED')
          continue
        }
        if (x.locked) {
          revert(w.id, 'LOCKED')
          continue
        }
        const others = (x.boundElements ?? []).filter(
          (r: Ref) => r.type === 'text' && r.id !== el.id && p.live(r.id)?.containerId === x.id,
        )
        const sameBatch = labelsOf.get(x.id) ?? []
        if (others.length || sameBatch.length) {
          revert(w.id, 'INVALID')
          continue
        }
        labelsOf.set(x.id, [...sameBatch, el.id])
      }
    }
    // frames
    if (el.type === 'frame' && el.frameId) {
      revert(w.id, 'INVALID')
      continue
    }
    if (el.frameId && (!wasLive(w) || w.before?.frameId !== el.frameId)) {
      const f = p.get(el.frameId).el
      if (f?.type !== 'frame') {
        revert(w.id, 'INVALID')
      }
    }
  }
  // group nesting: each group id has one parent group across the live elements
  const changedGroups = [...p.worked()].filter(
    (w) => w.writers.length > 0 && (wasLive(w) !== isLive(w) || !equal(w.before?.groupIds, w.el?.groupIds)),
  )
  if (changedGroups.length) {
    const removed = changedGroups.filter(wasLive).map((w) => (w.before?.groupIds ?? []) as string[])
    const added = changedGroups.filter(isLive).map((w) => (w.el?.groupIds ?? []) as string[])
    const bad = p.groupMap.conflicts(removed, added)
    if (bad.size)
      for (const w of changedGroups)
        if (
          isLive(w) &&
          !equal(w.before?.groupIds, w.el?.groupIds) &&
          ((w.el?.groupIds ?? []) as string[]).some((g) => bad.has(g))
        )
          revert(w.id, 'INVALID')
  }
  return reverted
}

// ---- repairs ---------------------------------------------------------------------------------------

/** A server write to `w` (a repair): a copy changed by `mutate`, the version bumped once, `slot` clocked. */
function repair(p: PushApplier, w: Work, slot: string, mutate: (el: El) => void): void {
  if (!w.el) return
  const next = clone(w.el)
  mutate(next)
  if (equal(next, w.el)) return
  w.el = next
  p.bump(w)
  w.gclock[slot] = p.clock
}

const withoutRef = (list: readonly Ref[] | null | undefined, id: string): Ref[] | null => {
  const out = (list ?? []).filter((r) => r.id !== id)
  return out.length ? out : null
}
const withRef = (list: readonly Ref[] | null | undefined, ref: Ref): Ref[] => {
  const cur = list ?? []
  if (cur.some((r) => r.id === ref.id && r.type === ref.type)) return [...cur]
  return [...cur.filter((r) => r.id !== ref.id), ref]
}
const bindsTo = (a: El, id: string) => a.startBinding?.elementId === id || a.endBinding?.elementId === id

function repairPass(p: PushApplier): void {
  // 1. deletions cascade: labels, bindings to the deleted element, frame children, back-references
  const queue = [...p.worked()].filter((w) => wasLive(w) && w.el?.isDeleted).map((w) => w.id)
  const seen = new Set<string>()
  while (queue.length) {
    const id = queue.shift() as string
    if (seen.has(id)) continue
    seen.add(id)
    const d = p.get(id).el as El
    for (const r of (d.boundElements ?? []) as Ref[]) {
      const w = p.get(r.id)
      const el = w.el
      if (!el || el.isDeleted) continue
      if (r.type === 'text' && el.containerId === id) {
        repair(p, w, 'life', (t) => {
          t.isDeleted = true
        })
        queue.push(r.id)
      } else if (r.type === 'arrow' && el.type === 'arrow' && bindsTo(el, id)) {
        repair(p, w, 'fit', (a) => {
          if (a.startBinding?.elementId === id) a.startBinding = null
          if (a.endBinding?.elementId === id) a.endBinding = null
        })
      }
    }
    if (d.type === 'frame') {
      const children = new Set(p.store.liveChildrenOfFrame(id))
      for (const w of p.worked()) if (w.el && !w.el.isDeleted && w.el.frameId === id) children.add(w.id)
      for (const c of children) {
        const w = p.get(c)
        if (w.el && !w.el.isDeleted && w.el.frameId === id)
          repair(p, w, 'fit', (e) => {
            e.frameId = null
          })
      }
    }
    // a deleted arrow or label leaves its targets' and container's lists
    if (d.type === 'arrow')
      for (const b of [d.startBinding, d.endBinding]) {
        if (!b) continue
        const w = p.get(b.elementId)
        if (w.el && !w.el.isDeleted)
          repair(p, w, 'bound', (t) => {
            t.boundElements = withoutRef(t.boundElements, id)
          })
      }
    if (isLabel(d)) {
      const w = p.get(d.containerId)
      if (w.el && !w.el.isDeleted)
        repair(p, w, 'bound', (t) => {
          t.boundElements = withoutRef(t.boundElements, id)
        })
    }
  }

  // 2. bindings of the arrows this push wrote (or revived): valid targets, listed by them
  for (const w of [...p.worked()]) {
    if (!w.writers.length || !isLive(w)) continue
    const el = w.el as El
    if (el.type === 'arrow') {
      for (const prop of ['startBinding', 'endBinding'] as const) {
        const b = el[prop]
        if (!b) continue
        const t = p.live(b.elementId)
        if (!t || !isBindable(t as never) || t.id === el.id)
          repair(p, w, 'fit', (a) => {
            a[prop] = null
          })
      }
      const a = w.el as El
      for (const b of [a.startBinding, a.endBinding]) {
        if (!b) continue
        const tw = p.get(b.elementId)
        repair(p, tw, 'bound', (t) => {
          t.boundElements = withRef(t.boundElements, { id: a.id, type: 'arrow' })
        })
      }
      // targets it no longer binds to drop it
      for (const b of [w.before?.startBinding, w.before?.endBinding]) {
        if (!b || bindsTo(a, b.elementId)) continue
        const tw = p.get(b.elementId)
        if (tw.el && !tw.el.isDeleted)
          repair(p, tw, 'bound', (t) => {
            t.boundElements = withoutRef(t.boundElements, a.id)
          })
      }
    }
    // a label is listed by its container (and left by the old one)
    if (isLabel(el)) {
      const cw = p.get(el.containerId)
      if (cw.el && !cw.el.isDeleted)
        repair(p, cw, 'bound', (c) => {
          c.boundElements = withRef(c.boundElements, { id: el.id, type: 'text' })
        })
      const old = w.before?.containerId
      if (old && old !== el.containerId) {
        const ow = p.get(old)
        if (ow.el && !ow.el.isDeleted)
          repair(p, ow, 'bound', (c) => {
            c.boundElements = withoutRef(c.boundElements, el.id)
          })
      }
    }
    // a frame deleted concurrently: clear the reference
    if (el.frameId) {
      const f = p.get(el.frameId).el
      if (f && f.type === 'frame' && f.isDeleted)
        repair(p, w, 'fit', (e) => {
          e.frameId = null
        })
    }
  }

  // 3. every list this push touched names only elements bound back to it
  for (const w of [...p.worked()]) {
    if (!w.el || w.el.isDeleted || !w.el.boundElements) continue
    if (equal(w.el.boundElements, w.before?.boundElements) && w.writers.length === 0) continue
    const self = w.id
    const keep = (r: Ref) => {
      const o = p.live(r.id)
      if (!o) return false
      if (r.type === 'text') return o.type === 'text' && o.containerId === self
      return o.type === 'arrow' && bindsTo(o, self)
    }
    const list = w.el.boundElements as Ref[]
    if (list.every(keep)) continue
    repair(p, w, 'bound', (t) => {
      const out = (t.boundElements as Ref[]).filter(keep)
      t.boundElements = out.length ? out : null
    })
  }
}
