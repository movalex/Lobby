import { type Project, WorkspaceStorage, type WorkspaceSummary } from '@draftroom/contracts'
import { type FormEvent, type MouseEvent, type ReactNode, useEffect, useId, useRef, useState } from 'react'
import { api, isApiError } from '../api/client.ts'
import { Wordmark } from '../brand/Wordmark.tsx'
import { type DashboardSection, linkClick, workspacePath } from '../lib/routing.ts'
import { useValue } from '../lib/signals.ts'
import { MenuButton } from '../ui/Menu.tsx'
import { RenameInput } from '../ui/RenameInput.tsx'
import { type InternalOnlyState, OutsideAccessDialog } from './InternalOnly.tsx'
import {
  outsideAccessIn,
  type ProjectMenuAction,
  projectInternalOnly,
  projectMenuItems,
} from './internal-only-model.ts'
import { WorkspaceMenu } from './WorkspaceMenu.tsx'
import { workspaceMenuRequests } from './workspace-menu-request.ts'

const sameSection = (a: DashboardSection, b: DashboardSection) =>
  a.kind === b.kind && (a.kind !== 'project' || (b.kind === 'project' && a.projectId === b.projectId))

export function Sidebar({
  workspace,
  workspaces,
  section,
  projects,
  projectsError,
  internal,
  canSeeProjects,
  canCreateProjects,
  canRenameProjects,
  onCreateProject,
  onRenameProject,
}: {
  workspace: WorkspaceSummary
  workspaces: readonly WorkspaceSummary[]
  section: DashboardSection
  projects: readonly Project[]
  projectsError: string | null
  /** Wave J's Internal only switches (DashboardPage loads them: its What's new card asks whether the control is there). */
  internal: InternalOnlyState
  /** The project list and the storage line (workspace members and above; guests get 403). */
  canSeeProjects: boolean
  /** "New project lobby" (domain access: creators who are members and above). */
  canCreateProjects: boolean
  /** Rename a project (domain access D6: creators only, like creating one). */
  canRenameProjects: boolean
  onCreateProject(name: string): Promise<void>
  onRenameProject(project: Project, name: string): Promise<void>
}) {
  const [creating, setCreating] = useState(false)
  const [renaming, setRenaming] = useState<string | null>(null)
  // A11Y-06 / DANA-11: at 760 px and below (phones, and a laptop at 200% zoom) the sidebar folds into
  // a "Menu" button, so the first screen shows the boards instead of the navigation.
  const [open, setOpen] = useState(false)
  const bodyId = useId()
  const toggleRef = useRef<HTMLButtonElement>(null)
  // Guests reach only the boards shared with them: Archived and Trash hold nothing of theirs to act on.
  const guest = workspace.role === 'guest'
  // "Try it" on the What's new card asks for the workspace menu: on a phone the folded menu opens first
  const menuAsked = useValue(workspaceMenuRequests)
  const menuSeen = useRef(menuAsked)
  useEffect(() => {
    if (menuAsked === menuSeen.current) return
    menuSeen.current = menuAsked
    setOpen(true)
  }, [menuAsked])

  useEffect(() => {
    if (!open) return
    // Escape closes the folded menu (after any menu or field inside it had its own Escape).
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return
      setOpen(false)
      toggleRef.current?.focus()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open])

  const navClick = (href: string) => {
    const go = linkClick(href)
    return (e: MouseEvent<HTMLAnchorElement>) => {
      setOpen(false)
      go(e)
    }
  }

  const link = (s: DashboardSection, label: string, icon: ReactNode, testId: string) => {
    const href = workspacePath(workspace.id, s)
    const current = sameSection(section, s)
    return (
      <li>
        <a
          className="dr-nav__item"
          href={href}
          onClick={navClick(href)}
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
    <aside
      className="dr-side"
      aria-label="Workspace navigation"
      data-open={open ? 'true' : 'false'}
      data-testid="dashboard-sidebar"
    >
      <div className="dr-side__bar">
        <a className="dr-side__brand" href="/" onClick={linkClick('/')} aria-label="Lobby home">
          <Wordmark />
        </a>
        <button
          ref={toggleRef}
          type="button"
          className="dr-btn dr-side__toggle"
          aria-expanded={open}
          aria-controls={bodyId}
          data-testid="side-toggle"
          onClick={() => setOpen((o) => !o)}
        >
          <Icon d={open ? 'M6 6l12 12M18 6L6 18' : 'M4 7h16M4 12h16M4 17h16'} />
          Menu
        </button>
      </div>
      <div className="dr-side__body" id={bodyId}>
        <WorkspaceMenu
          workspace={workspace}
          workspaces={workspaces}
          projects={projects}
          internal={internal}
        />
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
            {!guest &&
              link(
                { kind: 'archived' },
                'Archived',
                <Icon d="M3 5h18v4H3zM5 9v10h14V9M10 13h4" />,
                'nav-archived',
              )}
            {!guest &&
              link({ kind: 'trash' }, 'Trash', <Icon d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13" />, 'nav-trash')}
          </ul>
          <SidebarProjects
            workspaceId={workspace.id}
            section={section}
            projects={projects}
            projectsError={projectsError}
            canSeeProjects={canSeeProjects}
            canCreateProjects={canCreateProjects}
            canRenameProjects={canRenameProjects}
            creating={creating && canCreateProjects}
            renaming={renaming}
            setCreating={setCreating}
            setRenaming={setRenaming}
            navClick={navClick}
            onCreateProject={onCreateProject}
            onRenameProject={onRenameProject}
            internal={internal}
          />
        </nav>
        {/* Guests do not see the workspace's storage (the api answers them 403). */}
        {canSeeProjects && <StorageLine workspaceId={workspace.id} />}
      </div>
    </aside>
  )
}

/**
 * DANA-08: projects are the lobbies the product copy promises ("a lobby for each DBC project"), so the
 * list says so; the code keeps calling them projects.
 */
function SidebarProjects({
  workspaceId,
  section,
  projects,
  projectsError,
  canSeeProjects,
  canCreateProjects,
  canRenameProjects,
  creating,
  renaming,
  setCreating,
  setRenaming,
  navClick,
  onCreateProject,
  onRenameProject,
  internal,
}: {
  workspaceId: string
  section: DashboardSection
  projects: readonly Project[]
  projectsError: string | null
  canSeeProjects: boolean
  canCreateProjects: boolean
  canRenameProjects: boolean
  creating: boolean
  renaming: string | null
  setCreating(on: boolean): void
  setRenaming(id: string | null): void
  navClick(href: string): (e: MouseEvent<HTMLAnchorElement>) => void
  onCreateProject(name: string): Promise<void>
  onRenameProject(project: Project, name: string): Promise<void>
  internal: InternalOnlyState
}) {
  const [reviewing, setReviewing] = useState<Project | null>(null)
  // Guests cannot list projects; they only reach the boards shared with them.
  if (!canSeeProjects) return null
  return (
    <>
      <div className="dr-nav__group">
        <span className="dr-nav__heading" id="dr-projects-heading">
          {PROJECTS_HEADING}
        </span>
        {canCreateProjects && (
          <button
            type="button"
            className="dr-iconbtn dr-iconbtn--sm"
            aria-label="New project lobby"
            title="New project lobby"
            data-testid="create-project"
            onClick={() => setCreating(true)}
          >
            <Icon d="M12 5v14M5 12h14" />
          </button>
        )}
      </div>
      <ul className="dr-nav" aria-labelledby="dr-projects-heading" data-testid="project-list">
        {projects.map((p) =>
          renaming === p.id && canRenameProjects ? (
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
              href={workspacePath(workspaceId, { kind: 'project', projectId: p.id })}
              current={section.kind === 'project' && section.projectId === p.id}
              canRename={canRenameProjects}
              onNavigate={navClick}
              onRename={() => setRenaming(p.id)}
              internal={internal}
              onReview={() => setReviewing(p)}
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
          {projectsError ?? (canCreateProjects ? PROJECTS_HINT : PROJECTS_HINT_NO_CREATE)}
        </p>
      )}
      {reviewing && internal.settings?.outsideAccess && (
        <OutsideAccessDialog
          workspaceId={workspaceId}
          title={`Outside access to ${reviewing.name}`}
          access={outsideAccessIn(internal.settings, { kind: 'project', projectId: reviewing.id })}
          onChanged={internal.reload}
          onClose={() => setReviewing(null)}
        />
      )}
    </>
  )
}

/** DANA-08: the sidebar's words for projects (exported for the copy test). */
export const PROJECTS_HEADING = 'Project lobbies'
export const PROJECTS_HINT = 'Give each DBC project a lobby that keeps its boards together. Use + to add one.'
/** Domain access: the same list for someone who cannot add lobbies (no "+" to point at). */
export const PROJECTS_HINT_NO_CREATE = 'Project lobbies in this workspace show up here.'

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
  return <StorageMeter storage={storage} />
}

export interface StorageSummary {
  /** "Storage: 1.2 GB of 100 GB" */
  label: string
  level: 'ok' | 'near' | 'full'
  /** Width of the bar's fill, 0–100; a sliver (2) as soon as anything is stored. */
  fill: number
  /** "12% of this workspace's storage is in use" */
  share: string
  rows: readonly { label: string; value: string }[]
  /** Files the collector found unused (owners and admins), or null. */
  note: string | null
}

/** DANA-14: what the storage meter and its breakdown say. */
export function storageSummary(s: WorkspaceStorage): StorageSummary {
  const ratio = s.quotaBytes > 0 ? s.usedBytes / s.quotaBytes : 0
  const pct =
    s.usedBytes <= 0 ? '0%' : ratio < 0.01 ? 'Less than 1%' : `${Math.min(100, Math.floor(ratio * 100))}%`
  const unused = s.gc?.unreferenced.versions ?? 0
  return {
    label: `Storage: ${formatStorage(s.usedBytes)} of ${formatStorage(s.quotaBytes)}`,
    level: ratio >= 1 ? 'full' : ratio >= 0.9 ? 'near' : 'ok',
    fill: s.usedBytes <= 0 ? 0 : Math.min(100, Math.max(2, ratio * 100)),
    share: `${pct} of this workspace's storage is in use`,
    rows: [
      { label: 'Uploaded files', value: formatStorage(s.breakdown.originals) },
      { label: 'File previews', value: formatStorage(s.breakdown.previews) },
      { label: 'Board thumbnails', value: formatStorage(s.breakdown.thumbnails) },
      {
        label: 'Files',
        value: `${s.files.toLocaleString('en-US')} of ${s.maxFiles.toLocaleString('en-US')}`,
      },
    ],
    note: unused
      ? `${unused} unused file${unused === 1 ? '' : 's'} (${formatStorage(s.gc?.unreferenced.bytes ?? 0)}) that no board uses any more.`
      : null,
  }
}

/**
 * DANA-14: the storage line as a labelled meter; its breakdown opens under a button (click, tap, Enter
 * or Space) instead of a native tooltip that touch screens and screenshots never show. Escape or a
 * click elsewhere closes it.
 */
function StorageMeter({ storage }: { storage: WorkspaceStorage }) {
  const [open, setOpen] = useState(false)
  const panelId = useId()
  const wrapRef = useRef<HTMLDivElement>(null)
  const buttonRef = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    if (!open) return
    const onDown = (e: PointerEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false)
    }
    // Capture: this closes before the folded sidebar's own Escape (which then sees defaultPrevented).
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      e.preventDefault()
      setOpen(false)
      buttonRef.current?.focus()
    }
    document.addEventListener('pointerdown', onDown)
    document.addEventListener('keydown', onKey, true)
    return () => {
      document.removeEventListener('pointerdown', onDown)
      document.removeEventListener('keydown', onKey, true)
    }
  }, [open])
  const s = storageSummary(storage)
  return (
    <div className="dr-storage" ref={wrapRef} data-level={s.level} data-testid="storage">
      <button
        ref={buttonRef}
        type="button"
        className="dr-storage__btn"
        aria-expanded={open}
        aria-controls={panelId}
        data-testid="storage-toggle"
        onClick={() => setOpen((o) => !o)}
      >
        <span className="dr-storage__label" data-testid="storage-usage" data-level={s.level}>
          {s.label}
        </span>
        <span className="dr-storage__bar" aria-hidden="true">
          <span className="dr-storage__fill" style={{ width: `${s.fill}%` }} />
        </span>
      </button>
      {/* After the button in reading order; drawn above it (the line sits at the sidebar's foot). */}
      {open && (
        <section
          id={panelId}
          className="dr-storage__pop"
          aria-label="Storage breakdown"
          data-testid="storage-breakdown"
        >
          <p className="dr-storage__share">{s.share}</p>
          <dl className="dr-storage__rows">
            {s.rows.map((r) => (
              <div key={r.label}>
                <dt>{r.label}</dt>
                <dd>{r.value}</dd>
              </div>
            ))}
          </dl>
          {s.note && <p className="dr-storage__note">{s.note}</p>}
        </section>
      )}
    </div>
  )
}

function ProjectLink({
  project,
  href,
  current,
  canRename,
  onNavigate,
  onRename,
  internal,
  onReview,
}: {
  project: Project
  href: string
  current: boolean
  canRename: boolean
  onNavigate(href: string): (e: MouseEvent<HTMLAnchorElement>) => void
  onRename(): void
  internal: InternalOnlyState
  onReview(): void
}) {
  const items = projectMenuItems({ canRename, settings: internal.settings, projectId: project.id })
  const isInternal = projectInternalOnly(internal.settings, project.id)
  const onSelect = (action: ProjectMenuAction) => {
    if (action === 'rename') onRename()
    else if (action === 'internal-on') void internal.setProject(project.id, true)
    else if (action === 'internal-off') void internal.setProject(project.id, false)
    else onReview()
  }
  return (
    <li className="dr-nav__row" data-testid="project-item" data-project-id={project.id}>
      <a
        className="dr-nav__item"
        href={href}
        onClick={onNavigate(href)}
        aria-current={current ? 'page' : undefined}
      >
        <span className="dr-nav__swatch" aria-hidden="true" />
        <span className="dr-nav__label">{project.name}</span>
        {isInternal && (
          <span className="dr-nav__internal" data-testid="project-internal-only" title="Internal only">
            Internal
          </span>
        )}
      </a>
      {items.length > 0 && (
        <MenuButton
          label={`Project options for ${project.name}`}
          items={items}
          onSelect={onSelect}
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
