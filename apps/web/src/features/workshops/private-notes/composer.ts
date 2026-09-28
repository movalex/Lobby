// The "Add note" composer's text box around a save (round-2 F6): the box empties the moment a note
// is sent, so the next idea can be typed while the first one saves, and an answer that arrives later
// never erases what was typed meanwhile. Pure (unit-tested in Node); PrivateNotesPanel applies it.

/** What the box holds right after "Add note" sends `text`. */
export function composerOnSubmit(_text: string): string {
  return ''
}

/**
 * What the box holds once the answer to a sent note arrives. Saved: whatever was typed since. Refused:
 * the refused note comes back to try again, ahead of anything typed since (nothing is lost).
 */
export function composerAfterAnswer(s: { current: string; submitted: string; ok: boolean }): string {
  if (s.ok) return s.current
  if (!s.current.trim()) return s.submitted
  return `${s.submitted}\n\n${s.current}`
}
