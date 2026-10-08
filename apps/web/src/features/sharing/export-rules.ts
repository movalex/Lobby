// The board's export policy rules, engine-neutral (docs/WAVE3-CONTRACTS.md "export-control"): pure
// functions and the api calls, shared by the tldraw page's store (./export-policy.ts, tldraw signals) and
// the Excalidraw page's (./ported/export-policy.ts, lib/signals). No tldraw, no engine: wave 3e split
// them out of export-policy.ts so ported code can use them; export-policy.ts re-exports every name.

import {
  EXPORT_DISABLED_MESSAGE,
  type ExportPolicy,
  ExportPolicyState,
  exportAllowedFor,
  policyIncludesGuests,
} from '@draftroom/contracts'
import type { ApiClient } from '../../api/client.ts'
import type { NoticeInput } from '../../board/board-context.ts'
import type { BoardRole } from '../../lib/permissions.ts'

/** What people see wherever an export, copy or download entry is turned off. */
export const EXPORT_OFF_TEXT = EXPORT_DISABLED_MESSAGE

/**
 * Pure rule behind the UI (tested): unknown role or policy = allowed, and an unknown kind = not a
 * name-only guest; the server decides anyway.
 */
export function exportAllowedWith(
  role: BoardRole | null,
  policy: ExportPolicy | null,
  guest: boolean | null = null,
): boolean {
  if (role === null || policy === null) return true
  return exportAllowedFor(role, policy, { nameOnlyGuest: guest === true })
}

/**
 * Wave K.1 (follow-up 4, K1-4): the Excalidraw board page's rule, for every gate there. Until the board's first
 * export-policy answer it fails closed: only people no policy can limit see export and copy-out entries, the
 * owner (never a name-only guest) and an editor who is not a known name-only guest (every policy lets an account
 * editor export, so neither sees any change; a guest's kind is known from the join that signed them in, as
 * CR-3A-4 relies on). Viewers, commenters, known name-only guests and anyone whose role is not known yet get
 * nothing until the answer, so a viewer on an export-off board never sees those entries flash on open. Once the policy is known, `exportAllowedFor` decides (an unknown role still counts as allowed: the
 * server decides). UI hints only, as everywhere: the api refuses the exports themselves.
 */
export function boardExportAllowed(
  role: BoardRole | null,
  policy: ExportPolicy | null,
  guest: boolean | null,
): boolean {
  if (policy === null) return role === 'owner' || (role === 'editor' && guest !== true)
  if (role === null) return true
  return exportAllowedFor(role, policy, { nameOnlyGuest: guest === true })
}

/**
 * Whether this person CERTAINLY may export: the policy is known, and it includes guests, or the role and
 * the kind are known and allow it (under 'everyone', anyone with an account; under 'editors', an editor
 * or owner with an account). Unlike exportAllowedWith, anything unknown counts as no.
 */
export function exportCertainWith(
  role: BoardRole | null,
  policy: ExportPolicy | null,
  guest: boolean | null,
): boolean {
  if (policy === null) return false
  if (policyIncludesGuests(policy)) return true
  if (role === null || guest === null) return false
  return exportAllowedFor(role, policy, { nameOnlyGuest: guest })
}

/**
 * DANA2-01, the Share dialog's client card: whether people who join through a client link may download
 * files and export. A board that still uses the default counts as off, since the first client link
 * turns it off. null while that is unknown. Under 'everyone' this is about clients with an account:
 * clientGuestsLimited says whether the card needs its line about name-only guests.
 */
export function clientExportAllowed(policy: ExportPolicy | null, stored: boolean | null): boolean | null {
  if (policy === null) return null
  if (policy === 'editors') return false
  if (policyIncludesGuests(policy)) return true
  return stored
}

/**
 * Audit L3: the client card says On under a stored 'everyone', yet a client who joined with just a name
 * is still limited until the owner includes guests. True when that line is due.
 */
export const clientGuestsLimited = (policy: ExportPolicy | null, stored: boolean | null): boolean =>
  policy === 'everyone' && stored === true

// ---- the Share dialog's two checkboxes (ExportPolicySection) ---------------------------------------

/** The first checkbox: viewers and commenters with an account may export, copy and download. */
export const viewersMayExport = (policy: ExportPolicy): boolean => policy !== 'editors'

/** The second checkbox: name-only guests may too (only the owner's explicit 'everyone-including-guests'). */
export const guestsMayExport = (policy: ExportPolicy): boolean => policyIncludesGuests(policy)

/**
 * The policy after the first checkbox changes: off is 'editors'; on is 'everyone', with guests out until
 * the owner includes them (turning it back on never brings guests along).
 */
export function policyWithViewers(current: ExportPolicy, on: boolean): ExportPolicy {
  if (!on) return 'editors'
  return current === 'editors' ? 'everyone' : current
}

/** The policy after the guests checkbox changes (offered only while viewers may export). */
export const policyWithGuests = (on: boolean): ExportPolicy => (on ? 'everyone-including-guests' : 'everyone')

/**
 * DANA2-01: the Share dialog's "Creating a client link turns this off…" line, for a board nobody chose
 * a setting for yet. Only for someone who can create client links: a board owner who may only reduce
 * access (not a creator, domain access D4) is not told about a link it cannot make.
 */
export function clientLinkWillLimit(opts: {
  canManage: boolean
  canCreateLinks: boolean
  policy: ExportPolicy | null
  stored: boolean | null
}): boolean {
  return opts.canManage && opts.canCreateLinks && opts.policy === 'everyone' && opts.stored === false
}

/**
 * F9: the Export dialog's sentence about who may export, from the current policy. Nothing while the
 * policy is unknown, rather than a guess.
 */
export function exportPolicySentence(policy: ExportPolicy | null): string {
  if (policy === 'everyone-including-guests')
    return 'Everyone who can view the board can export it, guests included.'
  if (policy === 'everyone')
    return 'Everyone who can view the board with an account can export it; guests who joined with just a name can’t.'
  if (policy === 'editors') return 'Only editors can export this board: viewers, commenters and guests can’t.'
  return ''
}

/** Says why an export, copy or download did nothing. */
export function notifyExportOff(notify: (n: NoticeInput) => void) {
  notify({ key: 'export-off', text: EXPORT_OFF_TEXT, testId: 'export-off-notice', timeoutMs: 6000 })
}

/**
 * Wave K.1: what an export or a copy says while the board's policy has not arrived yet (`boardExportAllowed` is
 * closed then for anyone a policy could limit). It says nothing is turned off: nobody knows that yet.
 */
export const EXPORT_PENDING_TEXT =
  'Checking whether you can export or copy on this board. Try again in a moment.'

/** The pending notice (same key as the off notice: one replaces the other). */
export function notifyExportPending(notify: (n: NoticeInput) => void) {
  notify({ key: 'export-off', text: EXPORT_PENDING_TEXT, testId: 'export-pending-notice', timeoutMs: 4000 })
}

const enc = encodeURIComponent

export function exportPolicyApi(api: ApiClient) {
  return {
    get: (boardId: string, signal?: AbortSignal) =>
      api.request('GET', `/api/boards/${enc(boardId)}/export-policy`, { schema: ExportPolicyState, signal }),
    put: (boardId: string, exportPolicy: ExportPolicy) =>
      api.request('PUT', `/api/boards/${enc(boardId)}/export-policy`, {
        body: { exportPolicy },
        schema: ExportPolicyState,
      }),
  }
}

/**
 * How answers and events are ordered for one board: an answer applies only if no policy event arrived
 * after its request was sent, and no answer to a later request was applied already. So an answer read
 * on the server before a change never overwrites the event announcing that change, and a slow answer
 * never overwrites a newer one (while a failed newer request does not throw away an older answer).
 */
export interface PolicyOrder {
  /** a policy event arrived */
  event(): void
  /** a request is sent: the returned check says whether its answer may still apply (and records it) */
  begin(): () => boolean
}

export function createPolicyOrder(): PolicyOrder {
  let events = 0
  let sent = 0
  let applied = 0
  return {
    event: () => {
      events++
    },
    begin() {
      const mine = ++sent
      const eventsThen = events
      return () => {
        if (events !== eventsThen || applied > mine) return false
        applied = mine
        return true
      }
    },
  }
}
