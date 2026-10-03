// OWNER: 3f. +1 on sticky notes (FAC-08) on the Excalidraw page. A note's +1s are its identity-bound
// `customData.lobby['plusOne:<uid>'] = true` keys (canvas-schema custom-data.ts, plan §3.3 class 3): the
// sync server accepts a key only from the user it names, refuses a new one while a dot vote is open
// (`VOTE_OPEN`), and refuses canvas writes from viewers and commenters, so only people who can edit the
// board +1 (their UI shows the counts and says why they cannot).
//
// What changed from the tldraw board (plus-ones.ts): the +1s were one `meta.plusOnes` array, whose
// concurrent appends the server dropped (so each client re-applied its own intents). Each +1 is now its
// own key, patched per key (`c:<key>`), so two people's concurrent +1s never meet and no intent list is
// needed. The order of +1s is not stored (the value is `true` to fit 200 of them in the +1 budget):
// readers order them by uid.

import { PLUS_ONE_KEY_PREFIX } from '@draftroom/canvas-schema/custom-data'
import { PLUS_ONES_MAX } from '@draftroom/contracts'
import { type CanvasElement, items, type LobbyCanvas } from '../../../canvas/api/index.ts'
import { canEditBoard, type WorkshopContext } from '../workshop-context.ts'
import { isPlusOneTarget } from './elements.ts'

/** The uids with a +1 on `el` (sorted), malformed entries left out. */
export function plusOnesOf(el: CanvasElement | null | undefined): string[] {
  if (!el) return []
  return items
    .lobbyEntries(el, PLUS_ONE_KEY_PREFIX)
    .filter((e) => e.value === true)
    .map((e) => e.suffix)
    .sort()
}

/** Whether this person can add +1s (UI only: the sync server enforces read-only roles). */
export const canPlusOne = (ctx: Pick<WorkshopContext, 'role' | 'board'>) => canEditBoard(ctx)

export type PlusOnePatch = { readonly [key: string]: true | null }

/**
 * The `customData.lobby` patch that sets `uid`'s +1 to `want` (default: toggle), null when nothing
 * changes, or 'full' when the note already has the most +1s a note can hold.
 */
export function plusOnePatch(el: CanvasElement, uid: string, want?: boolean): PlusOnePatch | null | 'full' {
  const current = plusOnesOf(el)
  const has = current.includes(uid)
  const next = want ?? !has
  if (next === has) return null
  if (next && current.length >= PLUS_ONES_MAX) return 'full'
  return { [`${PLUS_ONE_KEY_PREFIX}${uid}`]: next ? true : null }
}

export interface PlusOneWriteResult {
  ok: boolean
  /** Set when !ok: what to tell the person. */
  message?: string
  added?: boolean
}

/**
 * Sets (or toggles) the person's +1 on a note through the canvas (one `transact`). Locked notes take
 * +1s too (template notes may be locked); the server checks the key against the ticket.
 *
 * A +1 is no undo step (`skipUndo`, W5-26 / CR-3F-1, as the tldraw board wrote it with
 * `history: 'ignore'`): the giver's Ctrl+Z undoes their previous edit, never the +1 on everyone's screen.
 */
export function writePlusOne(
  canvas: LobbyCanvas,
  id: string,
  uid: string,
  want?: boolean,
): PlusOneWriteResult {
  const el = canvas.get(id)
  if (!el || !isPlusOneTarget(el)) return { ok: false, message: 'That note is gone.' }
  const patch = plusOnePatch(el, uid, want)
  if (patch === 'full') return { ok: false, message: `A note can have at most ${PLUS_ONES_MAX} +1s.` }
  const added = patch ? Object.values(patch)[0] === true : plusOnesOf(el).includes(uid)
  if (!patch) return { ok: true, added }
  try {
    canvas.transact('+1', (tx) => tx.update(id, { customData: { lobby: patch } }), { skipUndo: true })
  } catch {
    return { ok: false, message: 'That did not work.' }
  }
  return { ok: true, added }
}
