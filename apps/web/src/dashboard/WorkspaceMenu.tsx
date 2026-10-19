// The sidebar's workspace tile and its menu (wave K, K4-1). The first thing in the sidebar used to be the
// "Internal only" control, which read like an admin policy setting; it now lives behind the workspace tile, next
// to the list of other workspaces, and the tile wears a shield while the workspace is internal only. The panel
// opens in the sidebar's own flow (no overlay to clip at the edge, and on a phone it simply makes the folded
// menu longer); Escape closes it and gives the keyboard back to the tile. Everything the Internal only
// control did, and every one of its test ids, is unchanged: only where it sits moved. Wave R: the panel also links to
// the chat notifications settings (Slack and Teams), the same entry as the bell's; it hides itself while chat
// notifications are off, or for a member when the workspace has no channel. Wave W (WS5): owners and admins also find
// the workspace admin page here, while it is offered.
import type { Project, WorkspaceSummary } from '@draftroom/contracts'
import { useEffect, useId, useRef, useState } from 'react'
import { ChatNotificationsEntry } from '../features/notify-settings/ChatNotificationsDialog.tsx'
import { AdminMenuEntry, useAdminEntryShown } from '../features/workspace-admin/AdminMenuEntry.tsx'
import { navigate, workspacePath } from '../lib/routing.ts'
import { useValue } from '../lib/signals.ts'
import { InternalOnlySection, type InternalOnlyState } from './InternalOnly.tsx'
import { internalOnlyShown } from './internal-only-model.ts'
import { workspaceMenuRequests } from './workspace-menu-request.ts'

export const WS_ROLE_LABEL: Record<WorkspaceSummary['role'], string> = {
  owner: 'Owner',
  admin: 'Admin',
  member: 'Member',
  guest: 'Guest',
}

/** The shield on the workspace tile while the whole workspace is internal only. */
export function InternalShield() {
  return (
    <span
      className="dr-ws__shield"
      data-testid="workspace-internal-badge"
      role="img"
      aria-label="Internal only"
      title="Internal only"
    >
      <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true">
        <path
          d="M12 3l7 3v5.5c0 4.2-2.9 7.8-7 9.5-4.1-1.7-7-5.3-7-9.5V6z"
          fill="currentColor"
          fillOpacity="0.16"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinejoin="round"
        />
        <path
          d="M9 12l2.2 2.2L15.2 10"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </span>
  )
}

export function WorkspaceMenu({
  workspace,
  workspaces,
  projects,
  internal,
  defaultOpen = false,
}: {
  workspace: WorkspaceSummary
  workspaces: readonly WorkspaceSummary[]
  projects: readonly Project[]
  internal: InternalOnlyState
  /** Opens with the panel showing (the markup tests; people open it themselves). */
  defaultOpen?: boolean
}) {
  const others = workspaces.filter((w) => w.id !== workspace.id)
  const showInternal = internalOnlyShown(internal.settings, projects)
  const internalOn = internal.settings?.workspace === true
  const [open, setOpen] = useState(defaultOpen)
  const [shownAt, setShownAt] = useState(0) // requests honoured so far (see the focus effect below)
  const panelId = useId()
  const button = useRef<HTMLButtonElement>(null)
  const wrap = useRef<HTMLDivElement>(null)
  // the What's new card's "Try it" asks for the panel (a request made before this mounted is not replayed)
  const asked = useValue(workspaceMenuRequests)
  const seen = useRef(asked)
  const showAdmin = useAdminEntryShown(workspace.role)
  const hasMenu = others.length > 0 || showInternal || showAdmin
  useEffect(() => {
    if (asked === seen.current) return
    seen.current = asked
    if (!hasMenu) return
    setOpen(true)
    setShownAt((n) => n + 1)
  }, [asked, hasMenu])
  // The person asked to be shown it: the keyboard goes to the tile (which also scrolls it into view), so Escape
  // closes the panel again. After the render that opened it: on a phone the folded sidebar (Sidebar.tsx) opens
  // in the same batch, and a tile inside a folded menu cannot take the focus before that.
  useEffect(() => {
    if (shownAt > 0) button.current?.focus()
  }, [shownAt])

  useEffect(() => {
    if (!open) return
    // Escape closes the panel and gives the keyboard back to the tile, while the focus is in the menu (or
    // nowhere: on the page itself). Capture: it runs before the folded sidebar's own Escape (Sidebar.tsx),
    // which would close the whole menu. A dialog opened from the panel (the outside access review) keeps its
    // own Escape, and so does a field or popup elsewhere on the page: Escape in the search box is not for us.
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return
      if (e.target instanceof Element && e.target.closest('dialog')) return
      if (e.target instanceof Node && e.target !== document.body && !wrap.current?.contains(e.target)) return
      e.preventDefault()
      setOpen(false)
      button.current?.focus()
    }
    document.addEventListener('keydown', onKey, true)
    return () => document.removeEventListener('keydown', onKey, true)
  }, [open])

  const tile = (
    <>
      <span className="dr-ws__tile" aria-hidden="true">
        {workspace.name.slice(0, 1).toUpperCase() || 'W'}
      </span>
      <span className="dr-ws__text">
        <span className="dr-ws__name" title={workspace.name}>
          {workspace.name}
        </span>
        {/* DANA-08: say what this box is (the workspace holds the project lobbies and their boards). */}
        <span className="dr-ws__role">Workspace · {WS_ROLE_LABEL[workspace.role]}</span>
      </span>
      {internalOn && <InternalShield />}
    </>
  )

  if (!hasMenu) {
    return (
      <div className="dr-ws" data-testid="workspace-switcher">
        {tile}
      </div>
    )
  }

  return (
    <div ref={wrap} className="dr-wsmenu-wrap">
      <button
        ref={button}
        type="button"
        className="dr-ws dr-ws--button"
        data-testid="workspace-switcher"
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        title="Workspace menu"
        onClick={() => setOpen((o) => !o)}
      >
        {tile}
        <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" className="dr-ws__chevron">
          <path
            d="M7 10l5 5 5-5"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </button>
      {open && (
        <section id={panelId} className="dr-wsmenu" aria-label="Workspace menu" data-testid="workspace-menu">
          {others.length > 0 && (
            <div className="dr-wsmenu__section">
              <p className="dr-wsmenu__heading">Switch workspace</p>
              <ul className="dr-wsmenu__list">
                {others.map((w) => (
                  <li key={w.id}>
                    <button
                      type="button"
                      className="dr-wsmenu__item"
                      data-testid="workspace-option"
                      data-workspace-id={w.id}
                      onClick={() => {
                        setOpen(false)
                        navigate(workspacePath(w.id))
                      }}
                    >
                      <span className="dr-wsmenu__name">{w.name}</span>
                      <span className="dr-wsmenu__role">{WS_ROLE_LABEL[w.role]}</span>
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {showInternal && (
            <InternalOnlySection
              workspaceId={workspace.id}
              workspaceName={workspace.name}
              projects={projects}
              state={internal}
            />
          )}
          {showAdmin && <AdminMenuEntry workspaceId={workspace.id} onOpen={() => setOpen(false)} />}
          <div className="dr-wsmenu__section" data-testid="workspace-menu-chat">
            <ChatNotificationsEntry
              workspaceId={workspace.id}
              workspaceName={workspace.name}
              canManage={workspace.role === 'owner' || workspace.role === 'admin'}
            />
          </div>
        </section>
      )}
    </div>
  )
}
