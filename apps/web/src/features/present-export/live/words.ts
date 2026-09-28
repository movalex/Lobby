// What present-live says, in one place (pure, unit-tested). "Lobby" is the product name in UI text.
import type { PresentChange } from '@draftroom/contracts'

/** The notice after a live presentation ended for someone who was following it. */
export function endedText(change: PresentChange | null, presenterName: string | null): string {
  const who = presenterName ?? 'The presenter'
  if (change?.kind !== 'ended' || !change.reason) return 'The presentation has ended.'
  switch (change.reason) {
    case 'stopped':
      return `${change.byName ?? who} ended the presentation.`
    case 'ended-by-owner':
      return `${change.byName ?? 'A board owner'} ended the presentation.`
    case 'presenter-left':
      return `${who} left the board, so the presentation ended.`
  }
}

/** "3 following" / "1 following" / "No one following yet". */
export function followingText(count: number): string {
  return count === 0 ? 'No one following yet' : `${count} following`
}

/** A short list of names for a tooltip: "Ann, Ben and 3 others". */
export function namesText(names: readonly string[], total = names.length, max = 3): string {
  if (total === 0 || names.length === 0) return ''
  const shown = names.slice(0, max)
  const rest = total - shown.length
  if (rest <= 0) {
    if (shown.length === 1) return shown[0] ?? ''
    return `${shown.slice(0, -1).join(', ')} and ${shown[shown.length - 1]}`
  }
  return `${shown.join(', ')} and ${rest} ${rest === 1 ? 'other' : 'others'}`
}

/** What the api's refusal means for the person who pressed "Present to everyone". */
export function startRefusedText(code: string, message: string): string {
  switch (code) {
    case 'GUEST_ACCOUNT_REQUIRED':
      return 'Guests can’t present to everyone. Sign in with an account to do that.'
    case 'FORBIDDEN':
      return 'Only people who can edit this board can present to everyone.'
    default:
      return message
  }
}
