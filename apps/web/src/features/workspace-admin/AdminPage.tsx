// OWNER: WS5 (wave W, the workspace admin page; docs/WAVE-W-CONTRACTS.md §7). /w/:wid/admin: five tabs (contracts
// ADMIN_TABS: members, storage, audit log, links and guests, retention), each from its owner/admin route
// (ADMIN_ROUTE_KEYS). Every change it offers calls an EXISTING route (api.ts); retention is read-only, and nothing here
// deletes data for good. Loaded only while FORMATS_FLAGS.admin is on and the api offers it (App.tsx), inside the
// session. Anyone who is not an owner or admin of the workspace, or whom the api answers 404, sees the unknown-address
// screen: the page tells nobody else that it exists.
//
// Keyboard: the tabs are a tablist (Left/Right, Home/End move and select; Tab goes into the panel); every action is a
// button; a confirm opens in place with the keyboard on its first button and Escape cancels it. Phone: one column,
// rows wrap into cards, nothing scrolls sideways. The open tab is kept in `?tab=` (a reload or a shared address opens
// it).
import { ADMIN_TABS, type AdminTab, type Me } from '@draftroom/contracts'
import { type KeyboardEvent, useCallback, useId, useMemo, useState } from 'react'
import { useSessionOrNull } from '../../auth/session.tsx'
import { Wordmark } from '../../brand/Wordmark.tsx'
import { linkClick, workspacePath } from '../../lib/routing.ts'
import { MessageScreen } from '../../ui/screens.tsx'
import { AuditTab } from './AuditTab.tsx'
import { type AdminApi, adminApi } from './api.ts'
import { LinksTab } from './LinksTab.tsx'
import { MembersTab } from './MembersTab.tsx'
import { TAB_LABELS, tabFromSearch } from './model.ts'
import { RetentionTab } from './RetentionTab.tsx'
import { StorageTab } from './StorageTab.tsx'
import type { AdminViewer } from './shared.tsx'
import './admin.css'

const readSearch = () => (typeof location === 'undefined' ? '' : location.search)

export default function AdminPage({ workspaceId }: { workspaceId: string }) {
  const session = useSessionOrNull()
  const me = session?.state.status === 'signed-in' ? session.state.me : null
  const api = useMemo(() => adminApi(workspaceId), [workspaceId])
  return <AdminPageView workspaceId={workspaceId} me={me} api={api} />
}

/** The page for `me` (null: nobody signed in), with its requests through `api` (tests pass a fake). */
export function AdminPageView({
  workspaceId,
  me,
  api,
  initialTab,
}: {
  workspaceId: string
  me: Me | null
  api: AdminApi
  initialTab?: AdminTab
}) {
  const workspace = me?.workspaces.find((w) => w.id === workspaceId) ?? null
  const [tab, setTabState] = useState<AdminTab>(() => initialTab ?? tabFromSearch(readSearch(), ADMIN_TABS))
  const [denied, setDenied] = useState(false)
  const idBase = useId()
  const onDenied = useCallback(() => setDenied(true), [])

  const setTab = (next: AdminTab) => {
    setTabState(next)
    try {
      const url = new URL(location.href)
      url.searchParams.set('tab', next)
      history.replaceState(history.state, '', `${url.pathname}${url.search}${url.hash}`)
    } catch {
      // the address is a convenience: the tab still changes
    }
  }

  const manager = workspace !== null && (workspace.role === 'owner' || workspace.role === 'admin')
  if (!me || !manager || denied)
    return (
      <MessageScreen
        testId="workspace-admin-denied"
        title="Page not found"
        body="There is nothing at this address."
      />
    )

  const viewer: AdminViewer = { id: me.user.id, role: workspace.role, creator: me.access.creator }

  const onKey = (e: KeyboardEvent) => {
    const i = ADMIN_TABS.indexOf(tab)
    const to =
      e.key === 'ArrowRight'
        ? (i + 1) % ADMIN_TABS.length
        : e.key === 'ArrowLeft'
          ? (i + ADMIN_TABS.length - 1) % ADMIN_TABS.length
          : e.key === 'Home'
            ? 0
            : e.key === 'End'
              ? ADMIN_TABS.length - 1
              : -1
    const next = ADMIN_TABS[to]
    if (!next) return
    e.preventDefault()
    setTab(next)
    document.getElementById(`${idBase}-${next}`)?.focus()
  }

  const back = workspacePath(workspaceId)
  return (
    <div className="dr-admin" data-testid="workspace-admin" data-tab={tab}>
      <header className="dr-admin__bar">
        <a href="/" onClick={linkClick('/')} aria-label="Lobby home" className="dr-admin__home">
          <Wordmark />
        </a>
        <a
          className="dr-btn dr-btn--ghost dr-btn--sm"
          href={back}
          onClick={linkClick(back)}
          data-testid="workspace-admin-back"
        >
          Back to boards
        </a>
      </header>
      <main className="dr-admin__main">
        <div className="dr-admin__head">
          <h1 className="dr-admin__title">Workspace admin</h1>
          <p className="dr-admin__sub dr-muted">
            <span data-testid="workspace-admin-name">{workspace.name}</span> · only owners and admins see this
            page
          </p>
        </div>
        <div className="dr-admin__tabs" role="tablist" aria-label="Workspace admin" onKeyDown={onKey}>
          {ADMIN_TABS.map((t) => (
            <button
              key={t}
              id={`${idBase}-${t}`}
              type="button"
              role="tab"
              className="dr-admin__tab"
              data-testid={`admin-tab-${t}`}
              aria-selected={tab === t}
              aria-controls={`${idBase}-panel`}
              tabIndex={tab === t ? 0 : -1}
              onClick={() => setTab(t)}
            >
              {TAB_LABELS[t]}
            </button>
          ))}
        </div>
        <section
          id={`${idBase}-panel`}
          role="tabpanel"
          aria-labelledby={`${idBase}-${tab}`}
          className="dr-admin__panel"
          data-testid={`admin-panel-${tab}`}
        >
          {tab === 'members' && (
            <MembersTab api={api} viewer={viewer} workspaceName={workspace.name} onDenied={onDenied} />
          )}
          {tab === 'storage' && <StorageTab api={api} onDenied={onDenied} />}
          {tab === 'audit' && <AuditTab api={api} onDenied={onDenied} />}
          {tab === 'links' && <LinksTab api={api} viewer={viewer} onDenied={onDenied} />}
          {tab === 'retention' && <RetentionTab api={api} onDenied={onDenied} />}
        </section>
      </main>
    </div>
  )
}
