// +1 on sticky notes (FAC-08). A note's +1s are the user ids in its `meta.plusOnes` array (contracts
// PLUS_ONES_META_KEY), written through the board's normal canvas sync: the sync server refuses canvas
// writes from viewers and commenters, so only people who can edit the board can +1 (their UI shows
// the counts and says why they cannot add one). Writes skip the undo history (a +1 is not an edit
// of the note) and apply to locked notes too (template notes may be locked).
//
// Concurrency: tldraw's sync sends an added id as an array append at the length the writer saw; if
// someone else's +1 landed first, the server drops the stale append and this client's copy is rolled
// back to the server's. A removal rewrites the array and can drop someone else's concurrent +1 the
// same way. So each client remembers what it last asked for on a note (PlusOneIntents) for a few
// seconds and re-applies it when a remote change undoes it: concurrent +1s converge.

import { PLUS_ONES_MAX, PLUS_ONES_META_KEY, readPlusOnes } from '@draftroom/contracts'
import type { Editor, TLShape, TLShapeId } from 'tldraw'
import { can } from '../../lib/permissions.ts'
import type { FeatureContext } from '../types.ts'

/** Only sticky notes take +1s. */
export const isPlusOneTarget = (shape: Pick<TLShape, 'type'> | null | undefined): boolean =>
  shape?.type === 'note'

export type ToggleResult =
  | { ok: true; changed: boolean; next: string[]; added: boolean }
  | { ok: false; reason: 'full' }

/**
 * The new +1 list after the person sets their +1 to `want` (default: toggle). Other entries keep
 * their order and the person's own +1 goes to the end, so on a well-formed note an addition is a
 * pure append of what is stored (the sync diff is then an append, not a rewrite); malformed entries
 * are dropped.
 */
export function togglePlusOne(meta: unknown, userId: string, want?: boolean): ToggleResult {
  const current = readPlusOnes(meta)
  const has = current.includes(userId)
  const target = want ?? !has
  if (target === has) return { ok: true, changed: false, next: current, added: false }
  if (target && current.length >= PLUS_ONES_MAX) return { ok: false, reason: 'full' }
  const next = target ? [...current, userId] : current.filter((id) => id !== userId)
  return { ok: true, changed: true, next, added: target }
}

/** Whether this person can add +1s (UI only: the sync server enforces read-only roles). */
export const canPlusOne = (ctx: Pick<FeatureContext, 'role' | 'board'>) =>
  can(ctx.role, 'edit', ctx.board.status)

export interface PlusOneWriteResult {
  ok: boolean
  /** Set when !ok: what to tell the person. */
  message?: string
  added?: boolean
}

/**
 * Sets (or toggles) the person's +1 on a note through the canvas: no undo entry, locked notes too.
 * Returns what happened; the caller records the intent for reconciliation.
 */
export function writePlusOne(
  editor: Editor,
  shapeId: TLShapeId,
  userId: string,
  want?: boolean,
): PlusOneWriteResult {
  const shape = editor.getShape(shapeId)
  if (!shape || !isPlusOneTarget(shape)) return { ok: false, message: 'That note is gone.' }
  const result = togglePlusOne(shape.meta, userId, want)
  if (!result.ok) return { ok: false, message: `A note can have at most ${PLUS_ONES_MAX} +1s.` }
  if (!result.changed) return { ok: true, added: result.added }
  editor.run(
    () => {
      editor.updateShape({ id: shape.id, type: shape.type, meta: { [PLUS_ONES_META_KEY]: result.next } })
    },
    { history: 'ignore', ignoreShapeLock: true },
  )
  return { ok: true, added: result.added }
}

interface Intent {
  want: boolean
  until: number
  tries: number
}

/**
 * What this client last asked for on each note, for `windowMs` after asking. A remote change that
 * leaves a note disagreeing with a live intent means the server dropped or overwrote our write (see
 * the header): `check` then says to re-apply it, at most `maxTries` times per intent.
 */
export class PlusOneIntents {
  private readonly intents = new Map<string, Intent>()
  private readonly windowMs: number
  private readonly maxTries: number

  constructor(windowMs = 8_000, maxTries = 5) {
    this.windowMs = windowMs
    this.maxTries = maxTries
  }

  note(shapeId: string, want: boolean, nowMs: number) {
    this.intents.set(shapeId, { want, until: nowMs + this.windowMs, tries: 0 })
  }

  /** 'reapply' = write `want` again now; null = nothing to do. `has` = the note as it is now. */
  check(shapeId: string, has: boolean | null, nowMs: number): { want: boolean } | null {
    const intent = this.intents.get(shapeId)
    if (!intent) return null
    if (nowMs > intent.until || has === null) {
      this.intents.delete(shapeId) // expired, or the note is gone
      return null
    }
    if (has === intent.want) return null
    if (intent.tries >= this.maxTries) {
      this.intents.delete(shapeId)
      return null
    }
    intent.tries++
    return { want: intent.want }
  }

  pending(): string[] {
    return [...this.intents.keys()]
  }

  forget(shapeId: string) {
    this.intents.delete(shapeId)
  }
}

const intentsByEditor = new WeakMap<Editor, PlusOneIntents>()

/** One intent list per editor (board session): shared by the overlay and the watcher. */
export function plusOneIntentsFor(editor: Editor): PlusOneIntents {
  let i = intentsByEditor.get(editor)
  if (!i) {
    i = new PlusOneIntents()
    intentsByEditor.set(editor, i)
  }
  return i
}

/**
 * Keeps the person's recent +1 intents true against concurrent writes (see the header): listens to
 * remote document changes of the notes it has intents for. Returns the stop function.
 */
export function watchPlusOneIntents(
  editor: Editor,
  userId: string,
  intents: PlusOneIntents,
  nowMs: () => number = Date.now,
): () => void {
  return editor.store.listen(
    (entry) => {
      const touched = new Set<string>()
      for (const [from] of Object.values(entry.changes.updated)) touched.add(from.id)
      for (const id of Object.keys(entry.changes.removed)) touched.add(id)
      for (const id of Object.keys(entry.changes.added)) touched.add(id)
      for (const id of intents.pending()) {
        if (!touched.has(id)) continue
        const shape = editor.getShape(id as TLShapeId)
        const has = shape ? readPlusOnes(shape.meta).includes(userId) : null
        const again = intents.check(id, has, nowMs())
        // Outside the listener's own turn: the store is mid-notification here.
        if (again) queueMicrotask(() => writePlusOne(editor, id as TLShapeId, userId, again.want))
      }
    },
    { source: 'remote', scope: 'document' },
  )
}
