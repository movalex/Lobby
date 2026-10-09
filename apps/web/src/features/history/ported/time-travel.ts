// The time-travel dialog's pure parts (wave L, L7-1 and L7-2; owner W7): the timeline's order and the words of
// a tick, what "Restore these" sends for a selection made in the preview, and the lines after a restore and
// its undo. Node-tested; the dialog is ./CheckpointPreview.tsx.

import { RESTORE_ELEMENTS_REV } from '@draftroom/canvas-schema/protocol'
import {
  type BoardCheckpoint,
  RESTORE_ELEMENTS_MAX_IDS,
  type RestoreElementsInput,
  type RestoreElementsResult,
} from '@draftroom/contracts'
import { formatRelativeTime, pluralize } from '../../../lib/format.ts'
import { checkpointTitle } from '../checkpoints-model.ts'

/** The timeline: oldest on the left, newest on the right (the list shows newest first). */
export function timelineOrder(list: readonly BoardCheckpoint[]): BoardCheckpoint[] {
  return [...list].sort((a, b) =>
    a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
  )
}

/** The slider's spoken value: "Hourly checkpoint, 2 hours ago (3 of 10)". */
export function tickText(c: BoardCheckpoint, index: number, count: number, now: Date): string {
  return `${checkpointTitle(c)}, ${formatRelativeTime(c.createdAt, now)} (${index + 1} of ${count})`
}

/** The tick a key moves to (Left/Down older, Right/Up newer, Home oldest, End newest, Page by 5); null: not a key of it. */
export function tickForKey(key: string, index: number, count: number): number | null {
  const last = Math.max(0, count - 1)
  switch (key) {
    case 'ArrowLeft':
    case 'ArrowDown':
      return Math.max(0, index - 1)
    case 'ArrowRight':
    case 'ArrowUp':
      return Math.min(last, index + 1)
    case 'Home':
      return 0
    case 'End':
      return last
    case 'PageDown':
      return Math.max(0, index - 5)
    case 'PageUp':
      return Math.min(last, index + 5)
    default:
      return null
  }
}

/**
 * Whether this tab may offer "Restore these": an editor with an account who may open checkpoints, in a room
 * at RESTORE_ELEMENTS_REV or later (null: not known yet, so not offered; an older sync has no route).
 */
export function canRestoreElements(o: {
  readonly canEdit: boolean
  readonly isAccount: boolean
  readonly canPreview: boolean
  readonly contractsRev: number | null
}): boolean {
  return o.canEdit && o.isAccount && o.canPreview && (o.contractsRev ?? 0) >= RESTORE_ELEMENTS_REV
}

interface ElementLike {
  readonly id?: unknown
  readonly type?: unknown
  readonly isDeleted?: unknown
  readonly frameId?: unknown
  readonly containerId?: unknown
}

/**
 * The ids "Restore these" sends for what is picked in the preview: the picked ones, and what a picked frame held
 * in the checkpoint (its content comes back with it, as from "Recently deleted"); labels come with their
 * containers on the server. `tooMany`: more than one restore may name.
 */
export function restoreIdsOf(
  picked: Iterable<string>,
  elements: readonly unknown[],
): { ids: string[]; tooMany: boolean } {
  const live = elements
    .map((e) => (e ?? {}) as ElementLike)
    .filter((e) => typeof e.id === 'string' && e.isDeleted !== true)
  const byId = new Map(live.map((e) => [e.id as string, e]))
  const out = new Set<string>()
  for (const id of picked) {
    const el = byId.get(id)
    if (!el) continue
    out.add(id)
    if (el.type === 'frame')
      for (const child of live)
        if (child.frameId === id && !(child.type === 'text' && typeof child.containerId === 'string'))
          out.add(child.id as string)
  }
  const ids = [...out]
  return { ids: ids.slice(0, RESTORE_ELEMENTS_MAX_IDS), tooMany: ids.length > RESTORE_ELEMENTS_MAX_IDS }
}

/**
 * The ids "Undo restore" sends: the asked ids the restore did not skip. The restore never touched a skipped one
 * (LEASED, MISSING, INVALID), so its undo must not either: restored from the 'before_restore' checkpoint, a
 * skipped element would go back to how it was before the restore, taking back what was done to it since (a
 * colleague's words once their lease ended, a note moved after the restore). Not the answer's `restored`: that
 * lists bound labels too, and could name more than RESTORE_ELEMENTS_MAX_IDS. Empty: nothing to undo (the notice
 * offers no "Undo restore").
 */
export function undoRestoreIds(
  asked: readonly string[],
  r: Pick<RestoreElementsResult, 'skipped'>,
): string[] {
  const skipped = new Set(r.skipped.map((s) => s.id))
  return [...new Set(asked)].filter((id) => !skipped.has(id))
}

/**
 * What "Undo restore" sends (round 1): the ids of undoRestoreIds, and the restore's own clock, so the sync takes
 * back only what that restore wrote and nobody changed since (CHANGED). Null: nothing to undo (no "Undo restore"),
 * also when the restore wrote nothing (round 2: its clock is then the board's, maybe a colleague's commit, and an
 * undo at it would take that commit back).
 */
export function undoRestoreInput(
  asked: readonly string[],
  r: Pick<RestoreElementsResult, 'skipped' | 'clock' | 'wrote'>,
): RestoreElementsInput | null {
  if (r.wrote === false) return null
  const ids = undoRestoreIds(asked, r)
  return ids.length ? { ids, removeAbsent: true, restoreClock: r.clock } : null
}

/** The line after "Restore these": what came back, and why the rest did not. */
export function restoreElementsSummary(
  asked: readonly string[],
  r: Pick<RestoreElementsResult, 'skipped'>,
): string {
  const skipped = new Set(r.skipped.map((s) => s.id))
  const back = asked.filter((id) => !skipped.has(id)).length
  const parts: string[] = []
  parts.push(back ? `Restored ${pluralize(back, 'object')} for everyone` : 'Nothing was restored')
  const leased = r.skipped.filter((s) => s.code === 'LEASED').length
  const missing = r.skipped.filter((s) => s.code === 'MISSING').length
  const invalid = r.skipped.filter((s) => s.code === 'INVALID').length
  if (leased)
    parts.push(
      `${pluralize(leased, 'object')} left as ${leased === 1 ? 'it is' : 'they are'}: someone is typing in it`,
    )
  if (missing) parts.push(`${pluralize(missing, 'object')} not in that checkpoint`)
  // INVALID: locked now (a restore never overrides a lock), or the copy no longer fits today's checks
  if (invalid)
    parts.push(
      `${pluralize(invalid, 'object')} could not be restored (locked, or no longer valid on this board)`,
    )
  return `${parts.join('; ')}.`
}

/**
 * The line after "Undo restore" (it skips a text being typed in, what someone changed after the restore: CHANGED,
 * and a locked element: INVALID).
 */
export function undoRestoreSummary(r: Pick<RestoreElementsResult, 'skipped'>): string {
  const leased = r.skipped.filter((s) => s.code === 'LEASED').length
  const changed = r.skipped.filter((s) => s.code === 'CHANGED').length
  const other = r.skipped.length - leased - changed
  if (!leased && !changed && !other) return 'Restore undone: the board is as it was before.'
  const except: string[] = []
  if (leased) except.push(`${pluralize(leased, 'object')} someone is typing in`)
  if (changed) except.push(`${pluralize(changed, 'object')} someone changed since`)
  if (other)
    except.push(
      `${pluralize(other, 'object')} that ${other === 1 ? 'is' : 'are'} locked or could not be changed back`,
    )
  return `Restore undone, except ${except.join(' and ')}.`
}
