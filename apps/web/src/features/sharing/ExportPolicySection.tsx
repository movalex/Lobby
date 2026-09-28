// The Share dialog's "Export and download" setting (docs/WAVE3-CONTRACTS.md "export-control"). Board
// owners switch it; everyone else sees its state, disabled. The api decides who may change it
// (manage_access) and enforces it; this only shows and asks.

import type { ExportPolicy } from '@draftroom/contracts'
import { useEffect, useId, useState } from 'react'
import { useValue } from 'tldraw'
import { api, isApiError } from '../../api/client.ts'
import type { BoardRole } from '../../lib/permissions.ts'
import { boardExportState, EXPORT_OFF_TEXT, exportAllowedWith, exportPolicyApi } from './export-policy.ts'

const policyApi = exportPolicyApi(api)

export const EXPORT_POLICY_LABEL = 'Viewers and commenters can export, copy and download files'
export const EXPORT_POLICY_HELP =
  'When this is off, viewers and commenters cannot export the board (image, PDF, CSV or .json), copy from it, duplicate it or download its files. File previews on the board keep showing. This is not a data-protection feature: anyone who can see the board can still take screenshots.'

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
  // The value being saved: the checkbox shows it at once and stays disabled until the server answers.
  const [saving, setSaving] = useState<ExportPolicy | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loadFailed, setLoadFailed] = useState(false)

  // The board page keeps the store current; ask anyway, so the dialog never shows a guess.
  useEffect(() => {
    const controller = new AbortController()
    policyApi.get(boardId, controller.signal).then(
      (s) => state.policy.set(s.exportPolicy),
      () => {
        if (!controller.signal.aborted) setLoadFailed(true)
      },
    )
    return () => controller.abort()
  }, [boardId, state])

  const change = async (next: ExportPolicy) => {
    setSaving(next)
    setError(null)
    try {
      const saved = await policyApi.put(boardId, next)
      state.policy.set(saved.exportPolicy) // this tab at once; everyone else through the board event
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
  const limitedHere = known && !exportAllowedWith(role, policy)
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
