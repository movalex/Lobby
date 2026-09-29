/**
 * The compare-and-set unit of an arrow's or a line's geometry (docs/EXCALIDRAW-MIGRATION.md §2.8, spike
 * B): its `path` group, compared through its USER-SET geometry in scene coordinates within
 * `GEOMETRY_TOLERANCE_PX` (canvas-schema groups.ts `sameUserSetGeometry`, THE compare the derived test and
 * the tests use), so a re-snap of its bound ends since, floating-point noise or the server's 2-decimal
 * rounding never block an undo of a free end, a midpoint or an elbow segment. `angle`, `elbowed` and
 * `polygon` must still equal the side exactly.
 *
 * The restore sets the whole recorded unit of the target side; the server then re-snaps the bound ends
 * against the current targets with Excalidraw's `movePoints` (rule 7), so unbound points land where they
 * were in scene coordinates and bound ends on the targets' current edges (a points-only restore is never
 * produced).
 *
 * NODE-SAFE (CONTRACTS.md).
 */
import {
  type LinearGeometryInput,
  sameUserSetGeometry,
  userSetGeometry,
} from '@draftroom/canvas-schema/groups'
import type { HistEl } from './diff.ts'
import { deepEqual } from './fields.ts'

const EXACT = ['angle', 'elbowed', 'polygon'] as const

/** `cur` equals the element with `side`'s recorded `fields` (a `path` unit), as §2.8 compares it. */
export function samePathUnit(
  cur: HistEl,
  side: Readonly<Record<string, unknown>>,
  fields: readonly string[],
): boolean {
  const other: Record<string, unknown> = { ...cur }
  for (const f of fields) other[f] = side[f]
  for (const f of EXACT) if (fields.includes(f) && !deepEqual(cur[f], other[f])) return false
  try {
    return sameUserSetGeometry(
      userSetGeometry(cur as unknown as LinearGeometryInput),
      userSetGeometry(other as unknown as LinearGeometryInput),
    )
  } catch {
    return fields.every((f) => deepEqual(cur[f], other[f]))
  }
}
