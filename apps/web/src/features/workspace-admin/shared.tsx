// OWNER: WS5 (wave W, the workspace admin page). What the five tabs share: who is looking, the loading and error
// states, the 404 that turns the page into the unknown-address screen, and the in-place confirm.
import { type ReactNode, useEffect, useRef } from 'react'
import { isApiError } from '../../api/client.ts'
import { type Resource, useResource } from '../../lib/useResource.ts'
import type { WorkspaceRole } from './api.ts'

/** The person on the page (from the session; the api decides every request again). */
export interface AdminViewer {
  id: string
  role: WorkspaceRole
  /** a creator may raise roles and extend links (the existing routes check it) */
  creator: boolean
}

/** useResource, and a 404 (not an owner or admin any more, or the page switched off) hands over to `onDenied`. */
export function useAdminResource<T>(
  load: (signal: AbortSignal) => Promise<T>,
  onDenied: () => void,
): Resource<T> & { reload(): void; update(fn: (data: T) => T): void } {
  const res = useResource(load)
  const denied = res.status === 'error' && res.error.kind === 'not-found'
  useEffect(() => {
    if (denied) onDenied()
  }, [denied, onDenied])
  return res
}

/** The message of a failed change, as the api said it (its messages are user-safe), or `fallback`. */
export const errorText = (e: unknown, fallback: string): string => (isApiError(e) ? e.message : fallback)

export function Loading({ label, testId }: { label: string; testId?: string }) {
  return (
    <p className="dr-admin__state dr-muted" role="status" data-testid={testId}>
      <span className="dr-spinner" aria-hidden="true" /> {label}
    </p>
  )
}

export function LoadFailed({ message, onRetry }: { message: string; onRetry(): void }) {
  return (
    <div className="dr-admin__state" role="alert" data-testid="admin-load-error">
      <p className="dr-field-error">{message}</p>
      <button type="button" className="dr-btn dr-btn--sm" onClick={onRetry}>
        Try again
      </button>
    </div>
  )
}

/**
 * A confirm in place of the row's buttons: the question, the action and Cancel. The keyboard lands on Cancel (the safe
 * choice) when it opens; Escape cancels.
 */
export function Confirm({
  question,
  action,
  busy,
  danger = true,
  onConfirm,
  onCancel,
  children,
  testId,
}: {
  question: ReactNode
  action: string
  busy: boolean
  danger?: boolean
  onConfirm(): void
  onCancel(): void
  children?: ReactNode
  testId?: string
}) {
  const cancel = useRef<HTMLButtonElement>(null)
  useEffect(() => cancel.current?.focus(), [])
  return (
    <fieldset
      className="dr-admin__confirm"
      data-testid={testId}
      onKeyDown={(e) => {
        if (e.key !== 'Escape') return
        e.preventDefault()
        e.stopPropagation()
        onCancel()
      }}
    >
      <legend className="dr-admin__confirm-q">{question}</legend>
      {children}
      <div className="dr-admin__confirm-actions">
        <button
          type="button"
          className={`dr-btn dr-btn--sm${danger ? ' dr-admin__danger' : ' dr-btn--primary'}`}
          data-testid={testId ? `${testId}-yes` : undefined}
          disabled={busy}
          onClick={onConfirm}
        >
          {busy ? 'Working…' : action}
        </button>
        <button ref={cancel} type="button" className="dr-btn dr-btn--sm" disabled={busy} onClick={onCancel}>
          Cancel
        </button>
      </div>
    </fieldset>
  )
}

/** A small label next to a name (Creator, External, Unconfirmed, Guest). */
export function Tag({
  children,
  tone = 'plain',
  title,
}: {
  children: ReactNode
  tone?: 'plain' | 'warn' | 'ok'
  title?: string
}) {
  return (
    <span className="dr-admin__tag" data-tone={tone} title={title}>
      {children}
    </span>
  )
}
