// OWNER: WS4 (wave N, N4-2/N4-3). The orchestration of one board open, apart from the page: once the room is ready,
// compute what changed since the visit before this one (./model.ts), narrow it with a checkpoint when that is worth a
// request (./refine.ts), and name the removed items for editors. Read-only: it asks the scene and the api and writes
// nothing; the highlights are an overlay. Every optional step that fails or takes too long leaves the timestamps' answer.
import type { VisitAnswer } from '@draftroom/contracts'
import { finish, type RemovedItem, type VisitChanges, type VisitElement, whatChanged } from './model.ts'
import { MAX_DIFF_ELEMENTS, refineWithCheckpoint } from './refine.ts'
import type { DeletedInfo } from './sources.ts'

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
  /** the viewing person's user id (P-006): what they made, edited or deleted themselves is not "since you were here" */
  me?: string
  /** the elements of the checkpoint before the visit (../visits/sources.ts), or null; absent: no refinement */
  checkpointElements?(seenAt: number, signal: AbortSignal): Promise<readonly unknown[] | null>
  /** names (and deleters) for the removed items (editors with an account), or null; absent: counts only */
  removedNames?(signal: AbortSignal): Promise<ReadonlyMap<string, DeletedInfo> | null>
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
    ...(deps.me ? { me: deps.me } : {}),
  }
  let changes = whatChanged(input)
  if (!changes || changes.total === 0) return null
  let refined = false

  if (changes.refinable && deps.checkpointElements && live.length + tombstones.length < MAX_DIFF_ELEMENTS) {
    // The request is the page's too: when the wait runs out the request is cancelled, so a slow checkpoint is not
    // downloaded and parsed on the main thread after the chip has already shown the timestamps' answer.
    const request = new AbortController()
    const cancel = () => request.abort()
    signal.addEventListener('abort', cancel, { once: true })
    try {
      const got = await Promise.race([
        deps.checkpointElements(answer.previousSeenAt, request.signal),
        (deps.after ?? wait)(deps.refineWaitMs ?? REFINE_WAIT_MS),
      ])
      if (got === 'timeout') request.abort()
      if (signal.aborted) return null
      if (got && got !== 'timeout') {
        changes = refineWithCheckpoint(changes, got, live, deps.isHidden ? { isHidden: deps.isHidden } : {})
        refined = true
      }
    } catch {
      // the timestamps' answer stands
    } finally {
      signal.removeEventListener('abort', cancel)
    }
    if (changes.total === 0) return null
  }

  if (changes.removed.length && deps.removedNames) {
    const names = await deps.removedNames(signal).catch(() => null)
    if (signal.aborted) return null
    if (names) changes = withNames(changes, names, deps.me)
    if (changes.total === 0) return null
  }
  return { changes, refined }
}

/** The removed items with their names; the ones the viewer deleted themselves (P-006) are left out. */
function withNames(
  changes: VisitChanges,
  names: ReadonlyMap<string, DeletedInfo>,
  me: string | undefined,
): VisitChanges {
  const removed: RemovedItem[] = []
  for (const r of changes.removed) {
    const known = names.get(r.id)
    if (me && known?.by === me) continue
    const name = r.name ?? known?.name
    removed.push(name ? { ...r, name } : r)
  }
  if (removed.length === changes.removed.length) return { ...changes, removed }
  return finish(changes.seenAt, changes.added, changes.changed, removed, changes.derived, changes.refinable)
}
