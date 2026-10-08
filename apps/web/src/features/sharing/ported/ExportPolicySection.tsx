// The Share dialog's "Export and download" setting (docs/WAVE3-CONTRACTS.md "export-control"). Board
// owners switch it; everyone else sees its state, disabled. The api decides who may change it
// (manage_access) and enforces it; this only shows and asks. It reads and writes the board's export store
// (./export-policy.ts), the same one every feature on the board page reads.

import type { ExportPolicy } from '@draftroom/contracts'
import { useEffect, useId, useState } from 'react'
import { api, isApiError } from '../../../api/client.ts'
import type { BoardRole } from '../../../lib/permissions.ts'
import { useValue } from '../../../lib/signals.ts'
import {
  clientExportAllowed,
  clientGuestsLimited,
  clientLinkWillLimit,
  EXPORT_OFF_TEXT,
  exportAllowedWith,
  guestsMayExport,
  policyWithGuests,
  policyWithViewers,
  viewersMayExport,
} from '../export-rules.ts'
import { exportStateOf, refreshExportPolicy, saveExportPolicy } from './export-policy.ts'

export const EXPORT_POLICY_LABEL = 'Viewers and commenters can export, copy and download files'
export const EXPORT_POLICY_HELP =
  'When this is off, viewers and commenters can’t export the board, copy from it, duplicate it or download its files. Guests who joined with just a name (even on a workshop link) can’t do any of that unless you also allow it for guests below. Previews keep showing. This is not a data-protection feature: anyone who can see the board can still take screenshots.'
/** Audit L3: name-only guests export only when a board owner turns this on explicitly. */
export const EXPORT_POLICY_GUESTS_LABEL = 'Guests who joined with just a name can export and download too'
export const EXPORT_POLICY_GUESTS_HELP =
  'Off until you turn it on. Guests are anonymous: anyone with a guest link joins by name alone.'

export const EXPORT_POLICY_DEFAULT_NOTE =
  'Creating a client link turns this off, so clients can’t download originals until you turn it back on.'
/** DANA2-01: the client card's line, and its one word. */
export const CLIENT_EXPORT_LINE = 'Clients can download files and export:'
/** Audit L3: the client card's second line while 'everyone' is stored (clients with an account only). */
export const CLIENT_GUESTS_LIMITED_NOTE =
  'Clients who join with just a name can’t download or export until you allow it for guests under Export and download.'
/** Where the client card's "Change" goes: the Export and download checkbox below. */
const TOGGLE_SELECTOR = '[data-testid="share-export-policy-toggle"]'

/**
 * DANA2-01: the client card says whether the people its links let in may download files and export
 * (off on a board whose owner never chose: the first client link turns it off), with "Change" taking
 * the owner to the Export and download setting further down the dialog (K5-5: unfolding "Advanced").
 */
export function ClientExportLine({ boardId }: { boardId: string }) {
  const state = exportStateOf(boardId)
  const allowed = useValue(
    'dr-share-client-export',
    () => clientExportAllowed(state.policy.get(), state.stored.get()),
    [state],
  )
  const guestsLimited = useValue(
    'dr-share-client-export-guests',
    () => clientGuestsLimited(state.policy.get(), state.stored.get()),
    [state],
  )
  if (allowed === null) return null
  return (
    <>
      <p
        className="dr-share__hint dr-sharing__client-export"
        data-testid="share-client-export"
        data-allowed={allowed}
      >
        {CLIENT_EXPORT_LINE} <strong>{allowed ? 'On' : 'Off'}</strong>{' '}
        <button
          type="button"
          className="dr-linkbtn"
          data-testid="share-client-export-change"
          aria-label="Change whether clients can download files and export"
          onClick={(e) => {
            const root = e.currentTarget.closest('[role="dialog"]') ?? document
            const toggle = root.querySelector<HTMLInputElement>(TOGGLE_SELECTOR)
            if (!toggle) return
            // K5-5: the setting sits in the folded "Advanced" section: unfold it first
            const fold = toggle.closest('details')
            if (fold && !fold.open) fold.open = true
            toggle.scrollIntoView({ block: 'center', behavior: 'smooth' })
            toggle.focus({ preventScroll: true })
          }}
        >
          Change
        </button>
      </p>
      {guestsLimited && (
        <p className="dr-share__hint" data-testid="share-client-export-guests">
          {CLIENT_GUESTS_LIMITED_NOTE}
        </p>
      )}
    </>
  )
}

export function ExportPolicySection({
  boardId,
  role,
  canManage,
  canCreateLinks = true,
}: {
  boardId: string
  /** The caller's current role (the dialog's, which follows a role change made in it). */
  role: BoardRole
  /** Board owners (manage_access): only they may change it; the server checks again. */
  canManage: boolean
  /** The caller may create client links (domain access: a creator); else no line about them. */
  canCreateLinks?: boolean
}) {
  const id = useId()
  const state = exportStateOf(boardId)
  const policy = useValue('dr-share-export-policy', () => state.policy.get(), [state])
  const guest = useValue('dr-share-export-guest', () => state.guest.get(), [state])
  const stored = useValue('dr-share-export-stored', () => state.stored.get(), [state])
  // The value being saved: the checkbox shows it at once and stays disabled until the server answers.
  const [saving, setSaving] = useState<ExportPolicy | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loadFailed, setLoadFailed] = useState(false)

  // The board page keeps the store current; ask anyway (the dashboard has no board page), so the dialog
  // never shows a guess. The answer never overwrites a policy event that arrived after it was asked for.
  useEffect(() => {
    const controller = new AbortController()
    refreshExportPolicy(api, boardId, controller.signal).catch(() => {
      if (!controller.signal.aborted) setLoadFailed(true)
    })
    return () => controller.abort()
  }, [boardId])

  const change = async (next: ExportPolicy) => {
    setSaving(next)
    setError(null)
    try {
      // This tab at once (unless a newer change already arrived); everyone else through the board event.
      await saveExportPolicy(api, boardId, next)
    } catch (e) {
      // The checkbox goes back to what the server has.
      setError(isApiError(e) ? e.message : 'The setting was not changed. Try again.')
    } finally {
      setSaving(null)
    }
  }

  const pending = saving !== null
  const shown = saving ?? policy
  const known = policy !== null
  const viewersOn = shown === null || viewersMayExport(shown)
  const guestsOn = shown !== null && guestsMayExport(shown)
  const limitedHere = known && !exportAllowedWith(role, policy, guest)
  // DANA2-01: nobody chose yet, so the first client link will turn this off.
  const linkWillLimit = clientLinkWillLimit({ canManage, canCreateLinks, policy, stored })
  return (
    <section
      className="dr-share__section"
      aria-labelledby={`${id}-h`}
      data-testid="share-export-policy"
      data-policy={policy ?? 'loading'}
    >
      <h3 id={`${id}-h`} className="dr-share__heading">
        Export and download
      </h3>
      {error && (
        <p className="dr-share__error" role="alert" data-testid="share-export-policy-error">
          {error}
        </p>
      )}
      <label className="dr-sharing__policy" htmlFor={id}>
        <input
          id={id}
          type="checkbox"
          data-testid="share-export-policy-toggle"
          checked={viewersOn}
          disabled={!canManage || !known || pending}
          aria-describedby={`${id}-help`}
          aria-busy={pending || undefined}
          onChange={(e) => void change(policyWithViewers(shown ?? 'everyone', e.target.checked))}
        />
        <span>{EXPORT_POLICY_LABEL}</span>
      </label>
      <p id={`${id}-help`} className="dr-share__hint dr-sharing__policy-help">
        {EXPORT_POLICY_HELP}
      </p>
      <label className="dr-sharing__policy dr-sharing__policy-guests" htmlFor={`${id}-guests`}>
        <input
          id={`${id}-guests`}
          type="checkbox"
          data-testid="share-export-policy-guests"
          checked={guestsOn}
          disabled={!canManage || !known || pending || !viewersOn}
          aria-describedby={`${id}-guests-help`}
          aria-busy={pending || undefined}
          onChange={(e) => void change(policyWithGuests(e.target.checked))}
        />
        <span>{EXPORT_POLICY_GUESTS_LABEL}</span>
      </label>
      <p id={`${id}-guests-help`} className="dr-share__hint dr-sharing__policy-help">
        {EXPORT_POLICY_GUESTS_HELP}
      </p>
      {linkWillLimit && (
        <p className="dr-share__hint" data-testid="share-export-policy-default">
          {EXPORT_POLICY_DEFAULT_NOTE}
        </p>
      )}
      {!known && loadFailed && (
        <p className="dr-share__hint" role="status">
          This setting could not be loaded. Close and reopen Share to try again.
        </p>
      )}
      {limitedHere && (
        <p
          className="dr-share__hint dr-sharing__policy-off"
          role="status"
          data-testid="share-export-policy-off"
        >
          {EXPORT_OFF_TEXT}
        </p>
      )}
      {!canManage && <p className="dr-share__note">Only board owners can change this.</p>}
    </section>
  )
}
