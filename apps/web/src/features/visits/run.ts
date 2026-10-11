// OWNER: WS4 (wave N, N4-2/N4-3). The orchestration of one board open, apart from the page: once the room is ready,
// compute what changed since the visit before this one (./model.ts), narrow it with a checkpoint when that is worth a
// request (./refine.ts), and name the removed items for editors. Read-only: it asks the scene and the api and writes
// nothing; the highlights are an overlay. Every optional step that fails or takes too long leaves the timestamps' answer.
import type { VisitAnswer } from '@draftroom/contracts'
import { type RemovedItem, type VisitChanges, type VisitElement, whatChanged } from './model.ts'
import { MAX_DIFF_ELEMENTS, refineWithCheckpoint } from './refine.ts'

/** How long the chip waits for a checkpoint to sharpen the counts before it shows the timestamps' answer. */
export const REFINE_WAIT_MS = 2_000

export interface HighlightDeps {
  /** resolves once the room's first sync is complete (roomReadyOf) */
  roomReady(): Promise<void>
  /** the scene's live elements (CanvasPort.items) */
  live(): readonly VisitElement[]
  /** every deleted element the scene holds (the engine's elements that are deleted) */
  tombstones(): Iterable<VisitElement>
  isHidden?(id: string): boolean
  /** the elements of the checkpoint before the visit (../visits/sources.ts), or null; absent: no refinement */
  checkpointElements?(seenAt: number, signal: AbortSignal): Promise<readonly unknown[] | null>
  /** names for the removed items (editors with an account), or null; absent: counts only */
  removedNames?(signal: AbortSignal): Promise<ReadonlyMap<string, string> | null>
  /** a timer, so a test can run without waiting */
  after?(ms: number): Promise<'timeout'>
  /** the refine wait, ms */
  refineWaitMs?: number
}

export interface Highlights {
  readonly changes: VisitChanges
  /** a checkpoint narrowed the lists */
  readonly refined: boolean
}

const wait = (ms: number): Promise<'timeout'> =>
  new Promise((resolve) => setTimeout(() => resolve('timeout'), ms))

/**
 * The highlights for this visit, or null when there is nothing to show: no previous visit (a first visit), nothing
 * changed, or the page went away (`signal`).
 */
export async function computeHighlights(
  deps: HighlightDeps,
  answer: VisitAnswer,
  signal: AbortSignal,
): Promise<Highlights | null> {
  if (answer.previousSeenAt === null) return null
  await deps.roomReady()
  if (signal.aborted) return null
  const live = deps.live()
  const tombstones = [...deps.tombstones()]
  const input = {
    seenAt: answer.previousSeenAt,
    live,
    tombstones,
    ...(deps.isHidden ? { isHidden: deps.isHidden } : {}),
  }
  let changes = whatChanged(input)
  if (!changes || changes.total === 0) return null
  let refined = false

  if (changes.refinable && deps.checkpointElements && live.length + tombstones.length < MAX_DIFF_ELEMENTS) {
    try {
      const got = await Promise.race([
        deps.checkpointElements(answer.previousSeenAt, signal),
        (deps.after ?? wait)(deps.refineWaitMs ?? REFINE_WAIT_MS),
      ])
      if (signal.aborted) return null
      if (got && got !== 'timeout') {
        changes = refineWithCheckpoint(changes, got, live, deps.isHidden ? { isHidden: deps.isHidden } : {})
        refined = true
      }
    } catch {
      // the timestamps' answer stands
    }
    if (changes.total === 0) return null
  }

  if (changes.removed.length && deps.removedNames) {
    const names = await deps.removedNames(signal).catch(() => null)
    if (signal.aborted) return null
    if (names) changes = withNames(changes, names)
  }
  return { changes, refined }
}

function withNames(changes: VisitChanges, names: ReadonlyMap<string, string>): VisitChanges {
  const removed: RemovedItem[] = changes.removed.map((r) => {
    const name = r.name ?? names.get(r.id)
    return name ? { ...r, name } : r
  })
  return { ...changes, removed }
}
