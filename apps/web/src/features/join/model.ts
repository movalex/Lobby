// OWNER: WS3 (wave V, the join card; docs/WAVE-V-CONTRACTS.md §3.3). Pure helpers of the join card, the /j/ page and
// "Have a code?": what the QR encodes, which workshop link the Facilitate menu's card shows, how the expiry reads.
import {
  formatJoinCode,
  JOIN_CODE_WEB_PREFIX,
  type JoinCode,
  normalizeJoinCode,
  type PendingInvitation,
} from '@draftroom/contracts'

/** What one join card shows: the QR's text, the code (when the link has one) and when it stops working. */
export interface JoinTarget {
  /** what the QR encodes: the code's /j/ URL when there is one (a smaller QR), else the full invite URL */
  readonly qrText: string
  /** "ABCD-2345", or null for a link without a code (join codes off, or not made yet) */
  readonly display: string | null
  /** the host people type the code at ("lobby.example") */
  readonly host: string
  readonly expiresAt: string
}

/** The card's content for a link's URL and its code (if any). */
export function joinTarget(
  link: { url: string; expiresAt: string },
  code: JoinCode | null | undefined,
): JoinTarget {
  const qrText = code?.joinUrl ?? link.url
  return {
    qrText,
    display: code ? code.display || formatJoinCode(code.code) : null,
    host: hostOf(qrText),
    expiresAt: code?.expiresAt ?? link.expiresAt,
  }
}

/** The host of an absolute URL (no scheme, no path), or the text itself when it is not one. */
export function hostOf(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return url
  }
}

/**
 * The board's open workshop links this person may show (multi-use editor links whose URL they are given: creators who
 * manage access), the newest first. The Facilitate menu's card shows the first; the Share dialog shows each one's own.
 */
export function workshopLinksToShow(
  invitations: readonly PendingInvitation[],
  now: number,
): PendingInvitation[] {
  return invitations
    .filter(
      (i) => i.kind === 'review' && i.role === 'editor' && i.url !== null && Date.parse(i.expiresAt) > now,
    )
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
}

/** "Expires 14:30" today, "Expires Tue 09:00" on another day; "Expired" once past. */
export function expiresLabel(iso: string, now: Date = new Date(), locale?: string): string {
  const at = new Date(iso)
  if (Number.isNaN(at.getTime())) return ''
  if (at.getTime() <= now.getTime()) return 'Expired'
  const time = at.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' })
  const sameDay = at.toDateString() === now.toDateString()
  return sameDay
    ? `Expires ${time}`
    : `Expires ${at.toLocaleDateString(locale, { weekday: 'short' })} ${time}`
}

/** The /j/ path a typed code opens, or null when it cannot be a code (the field says so before asking the api). */
export function joinPathOf(typed: string): string | null {
  const code = normalizeJoinCode(typed)
  return code ? `${JOIN_CODE_WEB_PREFIX}${code}` : null
}
