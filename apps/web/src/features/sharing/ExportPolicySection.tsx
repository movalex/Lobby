// The Share dialog's "Export and download" setting (docs/WAVE3-CONTRACTS.md "export-control"). Board
// owners switch it; everyone else sees its state, disabled. The api decides who may change it
// (manage_access) and enforces it; this only shows and asks.

import type { ExportPolicy } from '@draftroom/contracts'
import { useEffect, useId, useState } from 'react'
import { useValue } from 'tldraw'
import { api, isApiError } from '../../api/client.ts'
import type { BoardRole } from '../../lib/permissions.ts'
import {
  boardExportState,
  clientExportAllowed,
  EXPORT_OFF_TEXT,
  exportAllowedWith,
  refreshExportPolicy,
  saveExportPolicy,
} from './export-policy.ts'

export const EXPORT_POLICY_LABEL = 'Viewers and commenters can export, copy and download files'
export const EXPORT_POLICY_HELP =
  'When this is off, viewers, commenters and guests who joined with just a name (even on a workshop link) can’t export the board, copy from it, duplicate it or download its files. Previews keep showing. This is not a data-protection feature: anyone who can see the board can still take screenshots.'

export const EXPORT_POLICY_DEFAULT_NOTE =
  'Creating a client link turns this off, so clients can’t download originals until you turn it back on.'
/** DANA2-01: the client card's line, and its one word. */
export const CLIENT_EXPORT_LINE = 'Clients can download files and export:'
/** Where the client card's "Change" goes: the Export and download checkbox below. */
const TOGGLE_SELECTOR = '[data-testid="share-export-policy-toggle"]'

/**
 * DANA2-01: the client card says whether the people its links let in may download files and export
 * (off on a board whose owner never chose: the first client link turns it off), with "Change" taking
 * the owner to the Export and download setting further down the dialog.
 */
export function ClientExportLine({ boardId }: { boardId: string }) {
  const state = boardExportState(boardId)
  const allowed = useValue(
    'dr-share-client-export',
    () => clientExportAllowed(state.policy.get(), state.stored.get()),
    [state],
  )
  if (allowed === null) return null
  return (
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
          toggle.scrollIntoView({ block: 'center', behavior: 'smooth' })
          toggle.focus({ preventScroll: true })
        }}
      >
        Change
      </button>
    </p>
  )
}

export function ExportPolicySection({
  boardId,
  role,
  canManage,
}: {
  boardId: string
  /** The caller's current role (the dialog's, which follows a role change made in it). */
  role: BoardRole
  /** Board owners (manage_access): only they may change it; the server checks again. */
  canManage: boolean
}) {
  const id = useId()
  const state = boardExportState(boardId)
  const policy = useValue('dr-share-export-policy', () => state.policy.get(), [state])
  const guest = useValue('dr-share-export-guest', () => state.guest.get(), [state])
  const stored = useValue('dr-share-export-stored', () => state.stored.get(), [state])
  // The value being saved: the checkbox shows it at once and stays disabled until the server answers.
  const [saving, setSaving] = useState<ExportPolicy | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loadFailed, setLoadFailed] = useState(false)

  // The board page keeps the store current; ask anyway, so the dialog never shows a guess. The answer
  // never overwrites a policy event that arrived after it was asked for (export-policy.ts).
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
  const limitedHere = known && !exportAllowedWith(role, policy, guest)
  // DANA2-01: nobody chose yet, so the first client link will turn this off.
  const clientLinkWillLimit = canManage && policy === 'everyone' && stored === false
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
          checked={shown !== 'editors'}
          disabled={!canManage || !known || pending}
          aria-describedby={`${id}-help`}
          aria-busy={pending || undefined}
          onChange={(e) => void change(e.target.checked ? 'everyone' : 'editors')}
        />
        <span>{EXPORT_POLICY_LABEL}</span>
      </label>
      <p id={`${id}-help`} className="dr-share__hint dr-sharing__policy-help">
        {EXPORT_POLICY_HELP}
      </p>
      {clientLinkWillLimit && (
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
