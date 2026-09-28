import { type Project, WorkspaceStorage, type WorkspaceSummary } from '@draftroom/contracts'
import { type FormEvent, type ReactNode, useEffect, useState } from 'react'
import { api, isApiError } from '../api/client.ts'
import { Wordmark } from '../brand/Wordmark.tsx'
import { type DashboardSection, linkClick, navigate, workspacePath } from '../lib/routing.ts'
import { MenuButton } from '../ui/Menu.tsx'
import { RenameInput } from '../ui/RenameInput.tsx'

const WS_ROLE_LABEL: Record<WorkspaceSummary['role'], string> = {
  owner: 'Owner',
  admin: 'Admin',
  member: 'Member',
  guest: 'Guest',
}

const sameSection = (a: DashboardSection, b: DashboardSection) =>
  a.kind === b.kind && (a.kind !== 'project' || (b.kind === 'project' && a.projectId === b.projectId))

export function Sidebar({
  workspace,
  workspaces,
  section,
  projects,
  projectsError,
  canManageProjects,
  onCreateProject,
  onRenameProject,
}: {
  workspace: WorkspaceSummary
  workspaces: readonly WorkspaceSummary[]
  section: DashboardSection
  projects: readonly Project[]
  projectsError: string | null
  canManageProjects: boolean
  onCreateProject(name: string): Promise<void>
  onRenameProject(project: Project, name: string): Promise<void>
}) {
  const [creating, setCreating] = useState(false)
  const [renaming, setRenaming] = useState<string | null>(null)

  const link = (s: DashboardSection, label: string, icon: ReactNode, testId: string) => {
    const href = workspacePath(workspace.id, s)
    const current = sameSection(section, s)
    return (
      <li>
        <a
          className="dr-nav__item"
          href={href}
          onClick={linkClick(href)}
          aria-current={current ? 'page' : undefined}
          data-testid={testId}
        >
          {icon}
          <span className="dr-nav__label">{label}</span>
        </a>
      </li>
    )
  }

  return (
    <aside className="dr-side" aria-label="Workspace navigation">
      <a className="dr-side__brand" href="/" onClick={linkClick('/')} aria-label="Lobby home">
        <Wordmark />
      </a>
      <WorkspaceSwitcher workspace={workspace} workspaces={workspaces} />
      <nav aria-label="Boards">
        <ul className="dr-nav">
          {link(
            { kind: 'recent' },
            'Recent',
            <Icon d="M12 7v5l3 2M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0z" />,
            'nav-recent',
          )}
          {link(
            { kind: 'all' },
            'All boards',
            <Icon d="M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z" />,
            'nav-all',
          )}
          {link(
            { kind: 'archived' },
            'Archived',
            <Icon d="M3 5h18v4H3zM5 9v10h14V9M10 13h4" />,
            'nav-archived',
          )}
          {link({ kind: 'trash' }, 'Trash', <Icon d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13" />, 'nav-trash')}
        </ul>
        {/* Guests cannot list projects; they only reach the boards shared with them. */}
        {canManageProjects && (
          <>
            <div className="dr-nav__group">
              <span className="dr-nav__heading" id="dr-projects-heading">
                Projects
              </span>
              <button
                type="button"
                className="dr-iconbtn dr-iconbtn--sm"
                aria-label="New project"
                title="New project"
                data-testid="create-project"
                onClick={() => setCreating(true)}
              >
                <Icon d="M12 5v14M5 12h14" />
              </button>
            </div>
            <ul className="dr-nav" aria-labelledby="dr-projects-heading" data-testid="project-list">
              {projects.map((p) =>
                renaming === p.id ? (
                  <li key={p.id} className="dr-nav__edit">
                    <RenameInput
                      initial={p.name}
                      label={`Rename project ${p.name}`}
                      testId="project-rename"
                      maxLength={80}
                      onSubmit={(name) => {
                        setRenaming(null)
                        void onRenameProject(p, name)
                      }}
                      onCancel={() => setRenaming(null)}
                    />
                  </li>
                ) : (
                  <ProjectLink
                    key={p.id}
                    project={p}
                    href={workspacePath(workspace.id, { kind: 'project', projectId: p.id })}
                    current={section.kind === 'project' && section.projectId === p.id}
                    canRename={canManageProjects}
                    onRename={() => setRenaming(p.id)}
                  />
                ),
              )}
              {creating && (
                <li className="dr-nav__edit">
                  <NewProjectForm
                    onCancel={() => setCreating(false)}
                    onCreate={async (name) => {
                      await onCreateProject(name)
                      setCreating(false)
                    }}
                  />
                </li>
              )}
            </ul>
            {!projects.length && !creating && (
              <p className="dr-nav__hint">
                {projectsError ?? 'Group related boards into projects. Use + to create one.'}
              </p>
            )}
          </>
        )}
      </nav>
      {/* Guests do not see the workspace's storage (the api answers them 403). */}
      {canManageProjects && <StorageLine workspaceId={workspace.id} />}
    </aside>
  )
}

const KB = 1024
const MB = 1024 * KB
const GB = 1024 * MB

/** "1.2 GB", "100 GB", "250 MB", "12 KB", "0 MB" (binary units, like the upload quota's messages). */
export function formatStorage(bytes: number): string {
  if (bytes >= GB) return `${Number((bytes / GB).toFixed(1))} GB`
  if (bytes >= MB) return `${Math.round(bytes / MB)} MB`
  if (bytes > 0) return `${Math.max(1, Math.round(bytes / KB))} KB`
  return '0 MB'
}

/** "Storage: 1.2 GB of 100 GB" (workspace members; refreshed when the window regains focus). */
function StorageLine({ workspaceId }: { workspaceId: string }) {
  const [storage, setStorage] = useState<WorkspaceStorage | null>(null)
  useEffect(() => {
    let ac: AbortController | null = null
    const load = () => {
      ac?.abort()
      const mine = new AbortController()
      ac = mine
      api
        .request('GET', `/api/workspaces/${encodeURIComponent(workspaceId)}/storage`, {
          schema: WorkspaceStorage,
          signal: mine.signal,
        })
        .then(
          (s) => {
            if (!mine.signal.aborted) setStorage(s)
          },
          () => {}, // the line is a nicety: on any error it just stays hidden
        )
    }
    setStorage(null)
    load()
    const onFocus = () => {
      if (document.visibilityState === 'visible') load()
    }
    window.addEventListener('focus', onFocus)
    return () => {
      window.removeEventListener('focus', onFocus)
      ac?.abort()
    }
  }, [workspaceId])
  if (!storage) return null
  const share = storage.quotaBytes > 0 ? storage.usedBytes / storage.quotaBytes : 0
  const detail = [
    `Files ${formatStorage(storage.breakdown.originals)}`,
    `previews ${formatStorage(storage.breakdown.previews)}`,
    `board thumbnails ${formatStorage(storage.breakdown.thumbnails)}`,
  ]
  if (storage.gc?.unreferenced.versions)
    detail.push(
      `${storage.gc.unreferenced.versions} unused file${storage.gc.unreferenced.versions === 1 ? '' : 's'} (${formatStorage(storage.gc.unreferenced.bytes)}) no board uses any more`,
    )
  return (
    <p
      className="dr-nav__hint"
      data-testid="storage-usage"
      data-level={share >= 1 ? 'full' : share >= 0.9 ? 'near' : 'ok'}
      title={detail.join(' · ')}
      style={{
        marginTop: 'auto',
        paddingTop: 8,
        borderTop: '1px solid var(--dr-line)',
        color: share >= 1 ? 'var(--dr-danger)' : share >= 0.9 ? 'var(--dr-warn)' : undefined,
        fontVariantNumeric: 'tabular-nums',
      }}
    >
      Storage: {formatStorage(storage.usedBytes)} of {formatStorage(storage.quotaBytes)}
    </p>
  )
}

function ProjectLink({
  project,
  href,
  current,
  canRename,
  onRename,
}: {
  project: Project
  href: string
  current: boolean
  canRename: boolean
  onRename(): void
}) {
  return (
    <li className="dr-nav__row" data-testid="project-item" data-project-id={project.id}>
      <a
        className="dr-nav__item"
        href={href}
        onClick={linkClick(href)}
        aria-current={current ? 'page' : undefined}
      >
        <span className="dr-nav__swatch" aria-hidden="true" />
        <span className="dr-nav__label">{project.name}</span>
      </a>
      {canRename && (
        <MenuButton
          label={`Project options for ${project.name}`}
          items={[{ action: 'rename', label: 'Rename' }]}
          onSelect={onRename}
          className="dr-iconbtn dr-iconbtn--sm dr-nav__more"
          testId="project-menu"
        >
          <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
            <circle cx="5" cy="12" r="1.7" fill="currentColor" />
            <circle cx="12" cy="12" r="1.7" fill="currentColor" />
            <circle cx="19" cy="12" r="1.7" fill="currentColor" />
          </svg>
        </MenuButton>
      )}
    </li>
  )
}

function NewProjectForm({ onCreate, onCancel }: { onCreate(name: string): Promise<void>; onCancel(): void }) {
  const [name, setName] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)
  const submit = async (e: FormEvent) => {
    e.preventDefault()
    const n = name.trim()
    if (!n) {
      onCancel()
      return
    }
    setPending(true)
    try {
      await onCreate(n)
    } catch (err) {
      setError(isApiError(err) ? err.message : 'The project could not be created.')
      setPending(false)
    }
  }
  return (
    <form onSubmit={(e) => void submit(e)} className="dr-nav__form">
      <input
        className="dr-input dr-input--inline"
        data-testid="create-project-name"
        aria-label="New project name"
        placeholder="Project name"
        value={name}
        maxLength={80}
        disabled={pending}
        // biome-ignore lint/a11y/noAutofocus: opened by the user's click on "New project"
        autoFocus
        onChange={(e) => {
          setName(e.target.value)
          setError(null)
        }}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.preventDefault()
            onCancel()
          }
        }}
      />
      {error && (
        <p className="dr-field-error" role="alert">
          {error}
        </p>
      )}
    </form>
  )
}

function WorkspaceSwitcher({
  workspace,
  workspaces,
}: {
  workspace: WorkspaceSummary
  workspaces: readonly WorkspaceSummary[]
}) {
  const others = workspaces.filter((w) => w.id !== workspace.id)
  const current = (
    <>
      <span className="dr-ws__tile" aria-hidden="true">
        {workspace.name.slice(0, 1).toUpperCase() || 'W'}
      </span>
      <span className="dr-ws__text">
        <span className="dr-ws__name" title={workspace.name}>
          {workspace.name}
        </span>
        <span className="dr-ws__role">{WS_ROLE_LABEL[workspace.role]}</span>
      </span>
    </>
  )
  if (!others.length) {
    return (
      <div className="dr-ws" data-testid="workspace-switcher">
        {current}
      </div>
    )
  }
  return (
    <div className="dr-ws-wrap">
      <MenuButton
        label={`Switch workspace (current: ${workspace.name})`}
        items={others.map((w) => ({ action: w.id, label: `${w.name} · ${WS_ROLE_LABEL[w.role]}` }))}
        onSelect={(id) => navigate(workspacePath(id))}
        className="dr-ws dr-ws--button"
        testId="workspace-switcher"
        align="start"
      >
        {current}
        <Icon d="M7 10l5 5 5-5" />
      </MenuButton>
    </div>
  )
}

function Icon({ d }: { d: string }) {
  return (
    <svg className="dr-nav__icon" viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
      <path
        d={d}
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}
