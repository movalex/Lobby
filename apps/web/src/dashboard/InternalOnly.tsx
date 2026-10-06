// Wave J: the "Internal only" switches (a workspace, each project) in the dashboard sidebar. Owners and
// admins turn one on; turning it off hands outside sharing back, so it also needs a creator (the server
// decides: 403 otherwise, its message shown as is). While one is on, the server refuses outside
// invitations, approvals, raises and links there (409 INTERNAL_ONLY); it removes nothing, so the outside
// access that remains is listed here for the owners to remove (people from the workspace or a board,
// links and pending outside invitations revoked), never removed by the switch itself. Default off.
import {
  type InternalOnlySettings,
  type Project,
  InternalOnlySettings as SettingsSchema,
} from '@draftroom/contracts'
import { useCallback, useEffect, useId, useRef, useState } from 'react'
import { api, isApiError } from '../api/client.ts'
import { ExternalTag } from '../features/people/ExternalTag.tsx'
import { Dialog } from '../ui/Dialog.tsx'
import {
  type OutsideAccess,
  type OutsideScope,
  outsideAccessIn,
  outsideAccessSummary,
} from './internal-only-model.ts'

const enc = encodeURIComponent

export interface InternalOnlyState {
  settings: InternalOnlySettings | null
  error: string | null
  setWorkspace(on: boolean): Promise<void>
  setProject(projectId: string, on: boolean): Promise<void>
  reload(): void
}

/** The workspace's switches (members and above; guests get 403 and see nothing). */
export function useInternalOnly(workspaceId: string, enabled: boolean): InternalOnlyState {
  const [settings, setSettings] = useState<InternalOnlySettings | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [tick, setTick] = useState(0)
  const latest = useRef<InternalOnlySettings | null>(null)
  latest.current = settings
  useEffect(() => {
    void tick
    if (!enabled) {
      setSettings(null)
      return
    }
    const ac = new AbortController()
    api
      .request('GET', `/api/workspaces/${enc(workspaceId)}/internal-only`, {
        schema: SettingsSchema,
        signal: ac.signal,
      })
      .then(
        (s) => {
          if (!ac.signal.aborted) setSettings(s)
        },
        () => {}, // an older api, or no access: the switch just stays hidden
      )
    return () => ac.abort()
  }, [workspaceId, enabled, tick])
  /** The switch moves at once (the server's answer replaces it; a refusal puts it back and says why). */
  const put = useCallback(
    async (url: string, on: boolean, optimistic: (s: InternalOnlySettings) => InternalOnlySettings) => {
      setError(null)
      const before = latest.current
      if (before) setSettings(optimistic(before))
      try {
        setSettings(await api.request('PUT', url, { body: { internalOnly: on }, schema: SettingsSchema }))
      } catch (e) {
        setSettings(before)
        setError(isApiError(e) ? e.message : 'That change was not saved. Try again.')
      }
    },
    [],
  )
  return {
    settings,
    error,
    setWorkspace: (on) =>
      put(`/api/workspaces/${enc(workspaceId)}/internal-only`, on, (s) => ({ ...s, workspace: on })),
    setProject: (projectId, on) =>
      put(`/api/projects/${enc(projectId)}/internal-only`, on, (s) => ({
        ...s,
        projects: s.projects.map((p) => (p.projectId === projectId ? { ...p, internalOnly: on } : p)),
      })),
    reload: () => setTick((n) => n + 1),
  }
}

/** The sidebar's workspace switch, and what still reaches the workspace from outside while it is on. */
export function InternalOnlySection({
  workspaceId,
  workspaceName,
  projects,
  state,
}: {
  workspaceId: string
  workspaceName: string
  projects: readonly Project[]
  state: InternalOnlyState
}) {
  const id = useId()
  const [reviewing, setReviewing] = useState<OutsideScope | null>(null)
  const { settings, error } = state
  if (!settings) return null
  const on = settings.workspace
  const internalProjects = projects.filter((p) =>
    settings.projects.some((x) => x.projectId === p.id && x.internalOnly),
  )
  const scope: OutsideScope | null = on
    ? { kind: 'workspace' }
    : internalProjects.length === 1 && internalProjects[0]
      ? { kind: 'project', projectId: internalProjects[0].id }
      : null
  const access = scope ? outsideAccessIn(settings, scope) : null
  const summary = access ? outsideAccessSummary(access) : null
  // Members see the state; owners and admins change it.
  if (!settings.canChange && !on && !internalProjects.length) return null
  return (
    <div className="dr-internal" data-testid="internal-only" data-on={on ? 'true' : 'false'}>
      {settings.canChange ? (
        <label className="dr-internal__switch" htmlFor={id}>
          <input
            id={id}
            type="checkbox"
            role="switch"
            aria-checked={on}
            data-testid="internal-only-switch"
            checked={on}
            disabled={on && !settings.canTurnOff}
            onChange={(e) => void state.setWorkspace(e.target.checked)}
          />
          <span className="dr-internal__text">
            <strong>Internal only</strong>
            <span>
              {on
                ? `Only people at Dark Burn and Trailer Park Group can be invited to ${workspaceName}. Links are off.`
                : 'Off: boards here can be shared outside Dark Burn and Trailer Park Group.'}
            </span>
          </span>
        </label>
      ) : (
        on && (
          <p className="dr-internal__text" data-testid="internal-only-state">
            <strong>Internal only</strong>
            <span>Only people at Dark Burn and Trailer Park Group can be invited here.</span>
          </p>
        )
      )}
      {internalProjects.length > 0 && !on && (
        <p className="dr-internal__projects" data-testid="internal-only-projects">
          Internal only: {internalProjects.map((p) => p.name).join(', ')}
        </p>
      )}
      {error && (
        <p className="dr-field-error" role="alert" data-testid="internal-only-error">
          {error}
        </p>
      )}
      {settings.outsideAccess && summary && scope && (
        <button
          type="button"
          className="dr-linkbtn dr-internal__review"
          data-testid="internal-only-review"
          onClick={() => setReviewing(scope)}
        >
          {summary}
        </button>
      )}
      {reviewing && settings.outsideAccess && (
        <OutsideAccessDialog
          workspaceId={workspaceId}
          title={
            reviewing.kind === 'workspace'
              ? `Outside access to ${workspaceName}`
              : `Outside access to ${projects.find((p) => p.id === reviewing.projectId)?.name ?? 'this project'}`
          }
          access={outsideAccessIn(settings, reviewing)}
          onChanged={state.reload}
          onClose={() => setReviewing(null)}
        />
      )}
    </div>
  )
}

/** The people and links that still reach the scope from outside, each with the way to end it. */
export function OutsideAccessDialog({
  workspaceId,
  title,
  access,
  onChanged,
  onClose,
}: {
  workspaceId: string
  title: string
  access: OutsideAccess
  onChanged(): void
  onClose(): void
}) {
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const run = async (key: string, fn: () => Promise<unknown>) => {
    setBusy(key)
    setError(null)
    try {
      await fn()
      onChanged()
    } catch (e) {
      setError(isApiError(e) ? e.message : 'That did not work. Try again.')
    } finally {
      setBusy(null)
    }
  }
  return (
    <Dialog
      title={title}
      description="Turning on Internal only removes nothing. Remove the people and links below if they should no longer have access."
      onClose={onClose}
      testId="outside-access-dialog"
    >
      {error && (
        <p className="dr-share__error" role="alert">
          {error}
        </p>
      )}
      {access.people.length === 0 && access.links.length === 0 && access.invitations.length === 0 && (
        <p className="dr-muted" data-testid="outside-access-empty">
          Nobody outside Dark Burn and Trailer Park Group has access here now.
        </p>
      )}
      {access.people.length > 0 && (
        <ul className="dr-members" data-testid="outside-access-people">
          {access.people.map((p) => (
            <li
              key={p.user.id}
              className="dr-member"
              data-testid="outside-access-person"
              data-user-id={p.user.id}
            >
              <div className="dr-member__text">
                <span className="dr-member__name">
                  {p.user.name}
                  <ExternalTag domain={p.emailDomain} />
                </span>
                <span className="dr-member__sub">
                  {p.workspaceRole === 'guest'
                    ? p.boards.map((b) => b.title).join(', ') || 'No boards'
                    : `Workspace ${p.workspaceRole}${p.boards.length ? ` · ${p.boards.map((b) => b.title).join(', ')}` : ''}`}
                </span>
              </div>
              <div className="dr-member__actions">
                {p.workspaceRole === 'guest' ? (
                  p.boards.map((b) => (
                    <button
                      key={b.id}
                      type="button"
                      className="dr-btn dr-btn--sm"
                      data-testid="outside-access-remove-board"
                      disabled={busy !== null}
                      onClick={() =>
                        void run(`${p.user.id}:${b.id}`, () =>
                          api.request('DELETE', `/api/boards/${enc(b.id)}/members/${enc(p.user.id)}`, {
                            schema: null,
                          }),
                        )
                      }
                    >
                      Remove from {b.title}
                    </button>
                  ))
                ) : (
                  <button
                    type="button"
                    className="dr-btn dr-btn--sm"
                    data-testid="outside-access-remove-workspace"
                    disabled={busy !== null}
                    onClick={() =>
                      void run(p.user.id, () =>
                        api.request(
                          'DELETE',
                          `/api/workspaces/${enc(workspaceId)}/members/${enc(p.user.id)}`,
                          {
                            schema: null,
                          },
                        ),
                      )
                    }
                  >
                    Remove from workspace
                  </button>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
      {access.links.length > 0 && (
        <ul className="dr-members" data-testid="outside-access-links">
          {access.links.map((l) => (
            <li key={l.id} className="dr-member" data-testid="outside-access-link" data-link-id={l.id}>
              <div className="dr-member__text">
                <span className="dr-member__name">
                  {l.role === 'editor' ? 'Workshop link' : 'Review link'}
                  {l.allowGuests ? ' (guests can join)' : ''}
                </span>
                <span className="dr-member__sub">
                  {l.boardTitle} · until {new Date(l.expiresAt).toLocaleString()}
                </span>
              </div>
              <div className="dr-member__actions">
                <button
                  type="button"
                  className="dr-btn dr-btn--sm"
                  data-testid="outside-access-revoke"
                  disabled={busy !== null}
                  onClick={() =>
                    void run(l.id, () =>
                      api.request('POST', `/api/boards/${enc(l.boardId)}/review-links/${enc(l.id)}/revoke`, {
                        body: { removeAccess: true },
                        schema: null,
                      }),
                    )
                  }
                >
                  Revoke
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
      {access.invitations.length > 0 && (
        <ul className="dr-members" data-testid="outside-access-invitations">
          {access.invitations.map((i) => (
            <li
              key={i.id}
              className="dr-member"
              data-testid="outside-access-invitation"
              data-invitation-id={i.id}
            >
              <div className="dr-member__text">
                <span className="dr-member__name">
                  Invitation to {i.emailHint}
                  <ExternalTag domain={i.emailDomain} />
                </span>
                <span className="dr-member__sub">
                  {i.boardTitle ?? 'The workspace'} · not accepted · until{' '}
                  {new Date(i.expiresAt).toLocaleString()}
                </span>
              </div>
              <div className="dr-member__actions">
                <button
                  type="button"
                  className="dr-btn dr-btn--sm"
                  data-testid="outside-access-revoke-invitation"
                  disabled={busy !== null}
                  onClick={() =>
                    void run(i.id, () =>
                      api.request('DELETE', `/api/invitations/${enc(i.id)}`, { schema: null }),
                    )
                  }
                >
                  Revoke
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </Dialog>
  )
}
