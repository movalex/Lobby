// "Request access" (PRS-04): on the no-access screen for signed-in users, and in the Share dialog for
// viewers/commenters who want more. The server answers the same for any board id, so this component
// never learns (or shows) whether a board exists.

import type { RequestableRole } from '@draftroom/contracts'
import { useCallback, useEffect, useId, useState } from 'react'
import { api, isApiError } from '../../api/client.ts'
import { formatRelativeTime } from '../../lib/format.ts'
import { sharingApi } from './api.ts'
import {
  pickDefaultRole,
  ROLE_WORD,
  readSentRequest,
  requestableRoles,
  type SentRequest,
  safeLocalStorage,
  writeSentRequest,
} from './model.ts'
import './sharing.css'

const sharing = sharingApi(api)

const ROLE_CHOICE: Record<RequestableRole, string> = {
  editor: 'Edit',
  commenter: 'Comment',
  viewer: 'View',
}
const ACCESS_NAME: Record<RequestableRole, string> = {
  editor: 'Edit',
  commenter: 'Comment',
  viewer: 'View',
}

export function RequestAccess({
  boardId,
  userId,
  currentRole,
  defaultRole,
  onApprovedCheck,
  autoFocus = false,
}: {
  boardId: string
  userId: string
  /** The caller's role when they can already view the board (viewer/commenter asking for more). */
  currentRole: 'owner' | RequestableRole | null
  /**
   * The role to preselect (PRI-16): the one they had before losing access, when known. Otherwise
   * the next step up for a viewer/commenter, or Comment for someone without access.
   */
  defaultRole?: RequestableRole | null
  /** Focus the role choice on mount (opened from the role pill or a blocked-edit hint). */
  autoFocus?: boolean
  /** Called periodically after a request was sent by someone without access (e.g. to reload). */
  onApprovedCheck?: () => void
}) {
  const roles = requestableRoles(currentRole)
  const roleId = useId()
  const msgId = useId()
  const [role, setRole] = useState<RequestableRole>(() => pickDefaultRole(roles, currentRole, defaultRole))
  const [message, setMessage] = useState('')
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [sent, setSent] = useState<SentRequest | null>(() =>
    currentRole ? null : readSentRequest(safeLocalStorage(), userId, boardId),
  )

  // Viewers/commenters can ask the server about their own pending request.
  useEffect(() => {
    if (!currentRole) return
    const controller = new AbortController()
    sharing
      .myAccessRequest(boardId, controller.signal)
      .then((r) => {
        if (r) setSent({ role: r.roleRequested, at: Date.parse(r.createdAt) || Date.now() })
      })
      .catch(() => {})
    return () => controller.abort()
  }, [boardId, currentRole])

  // Someone without access: look for the approval now and then (the board opens once it is granted).
  const check = useCallback(() => onApprovedCheck?.(), [onApprovedCheck])
  useEffect(() => {
    if (!sent || currentRole || !onApprovedCheck) return
    const t = setInterval(() => {
      if (document.visibilityState === 'visible') check()
    }, 5_000)
    return () => clearInterval(t)
  }, [sent, currentRole, onApprovedCheck, check])

  if (!roles.length) return null

  const submit = async () => {
    setPending(true)
    setError(null)
    try {
      await sharing.requestAccess(boardId, role, message)
      const s = { role, at: Date.now() }
      if (!currentRole) writeSentRequest(safeLocalStorage(), userId, boardId, s)
      setSent(s)
    } catch (e) {
      if (isApiError(e) && e.code === 'ALREADY_HAS_ACCESS') {
        setError('You already have this access. Reload the board to use it.')
      } else {
        setError(isApiError(e) ? e.message : 'The request was not sent. Try again.')
      }
    } finally {
      setPending(false)
    }
  }

  if (sent) {
    return (
      <div className="dr-reqaccess dr-reqaccess--sent" data-testid="access-request-status" role="status">
        <p>
          <strong>{ACCESS_NAME[sent.role]} access requested</strong>{' '}
          {formatRelativeTime(new Date(sent.at).toISOString())}. The board’s owners see it in their Share
          dialog{currentRole ? '.' : ', and this page opens the board once they approve.'}
        </p>
        <button
          type="button"
          className="dr-linkbtn"
          data-testid="access-request-again"
          onClick={() => setSent(null)}
        >
          Ask again or for a different role
        </button>
      </div>
    )
  }

  return (
    <form
      className="dr-reqaccess"
      data-testid="access-request-form"
      onSubmit={(e) => {
        e.preventDefault()
        void submit()
      }}
    >
      <div className="dr-reqaccess__row">
        <label htmlFor={roleId}>{currentRole ? 'Ask for' : 'Request access to'}</label>
        <select
          id={roleId}
          // biome-ignore lint/a11y/noAutofocus: opened on purpose to ask for access
          autoFocus={autoFocus}
          className="dr-input dr-select dr-select--compact"
          data-testid="access-request-role"
          value={role}
          onChange={(e) => setRole(e.target.value as RequestableRole)}
        >
          {roles.map((r) => (
            <option key={r} value={r}>
              {ROLE_CHOICE[r]}
            </option>
          ))}
        </select>
      </div>
      <label htmlFor={msgId} className="dr-reqaccess__label">
        Message to the owners <span className="dr-optional">(optional)</span>
      </label>
      <textarea
        id={msgId}
        className="dr-input dr-reqaccess__msg"
        data-testid="access-request-message"
        maxLength={300}
        rows={2}
        value={message}
        placeholder="Why you need access"
        onChange={(e) => setMessage(e.target.value)}
      />
      {error && (
        <p className="dr-field-error" role="alert">
          {error}
        </p>
      )}
      <button
        type="submit"
        className="dr-btn dr-btn--primary"
        data-testid="access-request-button"
        disabled={pending}
      >
        {pending ? 'Sending…' : currentRole ? `Request ${ROLE_WORD[role]} access` : 'Request access'}
      </button>
      <p className="dr-reqaccess__hint">
        The owners get an in-app notification (Draftroom does not send email yet).
      </p>
    </form>
  )
}
