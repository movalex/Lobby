// OWNER: W4 (wave M, M4-5, FTU-11). What the AI menus offer for a target, and why an item cannot run: one model for
// the AI popover's rows and the context menu's "AI ›" submenu, so a greyed-out item always says what it needs
// ("Select two or more sticky notes first") instead of being grey with no reason. Summarize runs on the whole board
// when nothing is selected, as Ask does; it waits only for the board to have some text. Pure.

import { themesHint } from '../copy.ts'
import type { AiTarget } from './target.ts'

export type ModelAction = 'summarize' | 'themes' | 'actions'

export interface AiItemState {
  /** it cannot run on this target now */
  readonly disabled: boolean
  /** why not, in the person's words (null when it can run) */
  readonly reason: string | null
  /** the line under its name in the AI popover: the reason, or what it does */
  readonly hint: string
}

export const REASONS = {
  boardEmpty: 'Add some notes or text to the board first',
  needText: 'Select notes or text first',
  needNotes: 'Select two or more sticky notes first',
} as const

/** An item that cannot run: its reason is also its hint. */
const off = (reason: string): AiItemState => ({ disabled: true, reason, hint: reason })

/**
 * The three actions that read the target, for `target` (the selection, the frame under the pointer, or nothing) and
 * `board` (the whole board's text count: what Summarize reads with nothing selected). `insert`: the person may add AI
 * results to the board (Summarize then offers "Add to board").
 */
export function aiItemStates(
  target: Pick<AiTarget, 'kind' | 'texts' | 'notes' | 'prompts' | 'label'>,
  board: { readonly texts: number },
  opts: { readonly insert: boolean },
): Record<ModelAction, AiItemState> {
  const whole = target.kind === 'none'
  const summaryOf = whole ? board.texts : target.texts
  const summarize: AiItemState =
    summaryOf === 0
      ? off(whole ? REASONS.boardEmpty : REASONS.needText)
      : {
          disabled: false,
          reason: null,
          hint: whole
            ? 'A short summary of the whole board'
            : opts.insert
              ? 'Read it first, then add it to the board'
              : 'A short summary, just for you',
        }
  const themes: AiItemState =
    target.notes < 2
      ? off(REASONS.needNotes)
      : { disabled: false, reason: null, hint: themesHint(target.notes, target.prompts) }
  const actions: AiItemState =
    target.texts === 0
      ? off(REASONS.needText)
      : { disabled: false, reason: null, hint: 'Next steps and owners as new notes' }
  return { summarize, themes, actions }
}

/** A context-menu label with its reason when it cannot run: "Group into themes (select two or more sticky notes first)". */
export function labelWithReason(label: string, state: Pick<AiItemState, 'reason'>): string {
  if (!state.reason) return label
  return `${label} (${state.reason.charAt(0).toLowerCase()}${state.reason.slice(1)})`
}
