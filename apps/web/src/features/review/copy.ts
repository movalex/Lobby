// OWNER: WS1 (wave S). The review words the dashboard and both bells use, in a module that imports nothing but the
// contracts (the dashboard's bundle stays as small as it was): a review_status bell item's sentence and the board
// card's chip.

import type { NotificationItem } from '@draftroom/contracts'

/**
 * What a review_status bell item says after the actor's name, before " on <board>": "approved Key art B",
 * "requested changes on Key art B", "started Round 2 (6 items)".
 */
export function reviewNotificationText(n: Pick<NotificationItem, 'review'>): string {
  const r = n.review
  if (!r) return 'updated a review'
  if (r.event === 'round_opened') {
    const count = r.itemCount ?? 0
    const items = `${count} ${count === 1 ? 'item' : 'items'}`
    return `started ${r.roundTitle ?? 'a review round'} (${items})`
  }
  const what = r.label ?? 'an item'
  if (r.reason === 'new_version') return `uploaded a new version of ${what}: awaiting review`
  if (r.reason === 'new_round') return `put ${what} back in review`
  if (r.status === 'approved') return `approved ${what}`
  if (r.status === 'changes_requested') return `requested changes on ${what}`
  return `set ${what} back to Awaiting review`
}

/** The dashboard card's chip: "2 awaiting · 1 changes · 3 approved" (zero parts left out); null when none. */
export function boardChipText(
  c: { readonly pending: number; readonly changes: number; readonly approved: number } | undefined,
): string | null {
  if (!c) return null
  const parts: string[] = []
  if (c.pending > 0) parts.push(`${c.pending} awaiting`)
  if (c.changes > 0) parts.push(`${c.changes} ${c.changes === 1 ? 'change' : 'changes'}`)
  if (c.approved > 0) parts.push(`${c.approved} approved`)
  return parts.length ? parts.join(' · ') : null
}
