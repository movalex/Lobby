// K2-6 (wave K, UXP-8, UXD-15): the comments' instructions, by input. On a touch-first device (primary pointer
// coarse: phones, tablets) there is no C key and no Shift+Enter on the soft keyboard, so the words say what to
// tap instead; the Post button sends either way. Pure apart from `coarsePointer`, which reads matchMedia (a
// browser without it, or one that throws, reads as a fine pointer).

/** The primary pointer is coarse (a phone or a tablet, not a touchscreen laptop). */
export function coarsePointer(): boolean {
  try {
    const mm = (globalThis as { matchMedia?: (q: string) => { matches: boolean } }).matchMedia
    return typeof mm === 'function' ? mm.call(globalThis, '(pointer: coarse)').matches : false
  } catch {
    return false
  }
}

/** The comments panel's line when the board has no comment yet. */
export function emptyPanelText(opts: { readonly coarse: boolean; readonly canComment: boolean }): string {
  if (!opts.canComment) return 'No comments yet.'
  return opts.coarse
    ? 'No comments yet. Tap the comment button, then tap a note or the board.'
    : 'No comments yet. Press C, then click an object or the board to add one.'
}

/** The composer's hint under its text box. */
export function composerHint(coarse: boolean): string {
  return coarse ? '@ to mention' : 'Enter to post · Shift+Enter for a new line · @ to mention'
}

/** The panel's footnote: where notifications show (in-app; no promise about email). */
export const NOTIFICATIONS_NOTE = 'Mentions and replies show in the bell in the top bar.'
