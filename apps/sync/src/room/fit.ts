// Server-derived bound arrows (docs/EXCALIDRAW-MIGRATION.md §2.9.4 rule 7) in the savepoint and clock of
// the write that causes them. The container fit itself (rule 3: the holder's conditional write, applied
// last, dropped after a newer `pos`/`shape` write) is applied by merge.ts; this file does what follows
// from any applied geometry change:
//
//  trigger 1: an applied change to a bindable element's x, y, width, height or angle, whatever group
//             carried it (`pos`, `shape`, a fit, a free text's `layout`, an undelete, a repair);
//  trigger 2: an applied write to an arrow's own `path` unit (or its bindings, or its creation).
//
// Each affected live arrow is re-snapped once, after all ops of the push, against the stored (working)
// targets with canvas-schema's engine helpers (`resnapArrow`: both bound ends, the rebase through
// `movePoints`, the elbow router's whole output, the rounding rule). A re-snap equal to the stored unit
// after rounding writes nothing. A re-snap advances only `gclock.fit`; it is `fix` on an arrow the push
// wrote and a `derived` row otherwise. When an arrow's geometry changed, its bound label gets a derived
// `layout` write (position only while someone holds the arrow's lease).

import { type ArrowElementLike, arrowLabelLayout, resnapArrow } from '@draftroom/canvas-schema/engine'
import { pathUnitOf } from '@draftroom/canvas-schema/groups'
import { ELBOW_PATH_FIELDS } from '@draftroom/canvas-schema/protocol'
import type { El, PushApplier, Work } from './merge.ts'

const equal = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b)

/** The arrows this push's writes affect, re-snapped, and their labels laid out. */
export function resnapDerived(p: PushApplier): void {
  const arrows = new Set<string>()
  for (const id of p.resnapArrows) if (p.live(id)?.type === 'arrow') arrows.add(id)
  for (const id of p.movedTargets) {
    const t = p.live(id)
    if (!t) continue
    for (const r of t.boundElements ?? []) {
      if (r.type !== 'arrow') continue
      const a = p.live(r.id)
      if (a?.type === 'arrow' && (a.startBinding?.elementId === id || a.endBinding?.elementId === id))
        arrows.add(r.id)
    }
  }
  for (const id of arrows) resnapOne(p, p.get(id))
}

/** The elements a re-snap of `a` reads: the arrow and its live targets. */
function targetsOf(p: PushApplier, a: El): Map<string, El> {
  const map = new Map<string, El>([[a.id, a]])
  for (const b of [a.startBinding, a.endBinding]) {
    if (!b) continue
    const t = p.live(b.elementId)
    if (t) map.set(t.id, t)
  }
  return map
}

function resnapOne(p: PushApplier, w: Work): void {
  const a = w.el as El
  const map = targetsOf(p, a)
  const res = resnapArrow(a as unknown as ArrowElementLike, map as never)
  if (res.changed) {
    const next = { ...a } as El
    for (const f of ELBOW_PATH_FIELDS) if (!(f in res.path)) delete next[f]
    Object.assign(next, JSON.parse(JSON.stringify(res.path)))
    w.el = next
    p.bump(w) // before the label helper reads the arrow (its cache is per arrow version, E 11674-11690)
    w.gclock.fit = p.clock
    if (w.writers.length === 0) w.derived = true
  }
  const before = w.before && !w.before.isDeleted ? pathUnitOf(w.before) : null
  if (!equal(pathUnitOf(w.el as El), before)) layoutLabel(p, w)
}

/** The arrow's bound label follows it: a derived `layout` write (position only while leased). */
function layoutLabel(p: PushApplier, aw: Work): void {
  const a = aw.el as El
  const ref = (a.boundElements ?? []).find((r: { type: string }) => r.type === 'text')
  if (!ref) return
  const lw = p.get(ref.id)
  const label = lw.el
  if (!label || label.isDeleted || label.containerId !== a.id) return
  const leased = p.leases.holderOf(a.id, p.now) !== null
  const lay = arrowLabelLayout(a as unknown as ArrowElementLike, label as never, targetsOf(p, a) as never, {
    leased,
  })
  const next = { ...label, x: lay.x, y: lay.y } as El
  if (lay.text !== undefined) {
    next.text = lay.text
    next.width = lay.width as number
    next.height = lay.height as number
  }
  if (equal(next, label)) return
  lw.el = next
  p.bump(lw)
  lw.gclock.fit = p.clock
  if (lw.writers.length === 0) lw.derived = true
}
