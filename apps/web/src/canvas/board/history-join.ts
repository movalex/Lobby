/**
 * `transact(label, fn, {joinPrevious: true})` (docs/EXCALIDRAW-CONTRACTS.md §2.1, §10 item 4): a derived
 * write (the mind map's re-layout after a text change) folds into this tab's previous undo step instead
 * of becoming a step of its own, as tldraw's side-effect handlers ran inside the user's own step.
 *
 * Lobby's history (canvas/history/stack.ts) records one entry per `transact`. The board page marks the
 * stack before the joined transact (`joinMark`, the history's own `mark()`) and, after it, hands the mark
 * to the history's `joinAction` (`joinInto`), which merges the entry the transact recorded into the
 * previous one when exactly one was recorded on top of the same previous entry (`LobbyHistory.mergeTop`):
 *
 *  - a field changed in both keeps the earlier `before` and the later `after`, and a field whose two sides
 *    end up equal is no change any more (an entry left with nothing goes: no step that undoes nothing);
 *  - `groupIds` and `boundElements` are re-derived from the earlier `before` and the later `after`;
 *  - pending pushes of both are kept (acks keep folding their `fix` rows into the merged change), and a
 *    change still to be sent stays to be sent;
 *  - the selection the steps were made with (F11): the earlier one's `before`, the later one's `after`
 *    (a joined write is made in the same breath as a select, the mind map's topic selected again as its
 *    editor closes, so its `after` may be read before the engine applies it and be empty: the next boundary
 *    that finds a selection within `SELECTION_SETTLE_MS` completes it, `UndoController.boundary`);
 *  - when the previous step was the typing into labels the step before it made empty (a mind-map topic
 *    made by Tab or Enter, then its words: CR-3D-4), that step joins too, so the topic, its words and the
 *    layout after them are one undo step, as on tldraw.
 *
 * Remote changes interleaved between the two writes never touch entries (`absorb` only moves
 * `lastLocal`), so they are unaffected. No join when the stack was empty, when the last action was an
 * undo or a redo (a non-empty redo stack: the previous step is not the user's last change), or when the
 * transact recorded nothing.
 *
 * Before (wave 2 to wave B) this module merged entries through the live `undoEntries` array with a copy of
 * the merge that kept a field changed and changed back as a change: a step that undid nothing visible.
 */
import type { HistoryMark, LobbyHistory } from '../history/stack.ts'

export type JoinMark = HistoryMark

/** The stack before a joined transact. */
export function joinMark(history: LobbyHistory): JoinMark {
  return history.mark()
}

/**
 * After the transact: merges the entry it recorded into the previous one when the rules above allow.
 * Returns true when it joined.
 */
export function joinInto(history: LobbyHistory, mark: JoinMark): boolean {
  return history.joinAction(mark)
}
