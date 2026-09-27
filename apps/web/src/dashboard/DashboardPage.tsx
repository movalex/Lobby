import type { BoardWithRole, Project } from '@draftroom/contracts'
import { useCallback, useEffect, useId, useMemo, useState } from 'react'
import { api, isApiError } from '../api/client.ts'
import { useMe } from '../auth/session.tsx'
import { UserMenu } from '../auth/UserMenu.tsx'
import { NoticeRegion, useNotices } from '../board/Notices.tsx'
import { absoluteUrl, copyText } from '../lib/clipboard.ts'
import { canCreateInWorkspace } from '../lib/permissions.ts'
import { boardPath, type DashboardSection, navigate, workspacePath } from '../lib/routing.ts'
import { writeLastWorkspace } from '../lib/storage.ts'
import { useResource } from '../lib/useResource.ts'
import { NoAccessScreen } from '../ui/screens.tsx'
import { BoardCard } from './BoardCard.tsx'
import { CreateBoardDialog } from './CreateBoardDialog.tsx'
import {
  type BoardMenuAction,
  type BoardSort,
  boardsQueryForSection,
  emptyState,
  filterBoards,
  RECENT_LIMIT,
  recentBoards,
  sectionTitle,
  sortBoards,
} from './model.ts'
import { Sidebar } from './Sidebar.tsx'

const STATUS_DONE: Record<'archive' | 'trash' | 'restore', string> = {
  archive: 'archived',
  trash: 'moved to trash',
  restore: 'restored',
}

export function DashboardPage({ workspaceId, section }: { workspaceId: string; section: DashboardSection }) {
  const me = useMe()
  const workspace = me.workspaces.find((w) => w.id === workspaceId)

  useEffect(() => {
    if (workspace) writeLastWorkspace(workspace.id)
  }, [workspace])

  if (!workspace) return <NoAccessScreen thing="workspace" />
  return <Dashboard key={workspace.id} workspaceId={workspace.id} section={section} />
}

function Dashboard({ workspaceId, section }: { workspaceId: string; section: DashboardSection }) {
  const me = useMe()
  const workspace = me.workspaces.find((w) => w.id === workspaceId) ?? me.workspaces[0]
  const canCreate = canCreateInWorkspace(workspace?.role ?? null)
  const { notices, notify, dismiss } = useNotices()
  const searchId = useId()
  const sortId = useId()

  const [query, setQuery] = useState('')
  const [sort, setSort] = useState<BoardSort>('opened')
  const [creating, setCreating] = useState(false)
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [now, setNow] = useState(() => new Date())

  // Relative times ("5 min ago") stay honest while the dashboard is left open.
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 60_000)
    return () => clearInterval(t)
  }, [])

  // Guests may not list projects (the API answers 403); they only see boards shared with them.
  const projectsLoad = useCallback(
    (signal: AbortSignal) => (canCreate ? api.listProjects(workspaceId, signal) : Promise.resolve([])),
    [workspaceId, canCreate],
  )
  const projects = useResource(projectsLoad)

  const { status, projectId } = boardsQueryForSection(section)
  const boardsLoad = useCallback(
    (signal: AbortSignal) => api.listBoards(workspaceId, { status, projectId }, signal),
    [workspaceId, status, projectId],
  )
  const boards = useResource(boardsLoad)

  // Search is per list; a different list starts unfiltered.
  const sectionKey = section.kind === 'project' ? `p:${section.projectId}` : section.kind
  useEffect(() => {
    setQuery('')
    setRenamingId(null)
  }, [sectionKey])

  const projectList: Project[] = projects.data ?? []
  const visible = useMemo(() => {
    const all = boards.data ?? []
    const filtered = filterBoards(all, query)
    if (section.kind === 'recent' && !query) return recentBoards(filtered)
    return sortBoards(filtered, section.kind === 'recent' ? 'opened' : sort)
  }, [boards.data, query, section.kind, sort])

  const pageTitle = `${sectionTitle(section, projectList)} · ${workspace?.name ?? 'Draftroom'}`
  useEffect(() => {
    document.title = `${pageTitle} · Draftroom`
    return () => {
      document.title = 'Draftroom'
    }
  }, [pageTitle])

  if (!workspace) return <NoAccessScreen thing="workspace" />

  const title = sectionTitle(section, projectList)
  const empty = emptyState(section, { searching: query.trim().length > 0, canCreate })
  const showSort = section.kind !== 'recent'
  // New boards are active: offering "New board" while looking at Trash or Archived would be confusing.
  const showCreate = canCreate && section.kind !== 'archived' && section.kind !== 'trash'
  const totalCount = boards.data?.length ?? 0

  const onAction = async (action: BoardMenuAction, board: BoardWithRole) => {
    switch (action) {
      case 'open':
        navigate(boardPath(board.id))
        return
      case 'copy-link': {
        const url = absoluteUrl(boardPath(board.id))
        const ok = await copyText(url)
        notify({
          key: 'copy-link',
          text: ok ? 'Board link copied' : `Copy this link: ${url}`,
          timeoutMs: ok ? 2500 : 10_000,
        })
        return
      }
      case 'rename':
        setRenamingId(board.id)
        return
      case 'archive':
      case 'trash':
      case 'restore': {
        setBusyId(board.id)
        try {
          await api.setBoardStatus(board.id, action)
          // The board now belongs to another list; drop it here and let that list fetch fresh.
          boards.update((list) => list.filter((b) => b.id !== board.id))
          notify({
            key: `status:${board.id}`,
            text: `“${board.title}” ${STATUS_DONE[action]}`,
            testId: 'dashboard-toast',
          })
        } catch (e) {
          notify({
            key: `status:${board.id}`,
            text: isApiError(e) ? e.message : 'That did not work. Try again.',
            tone: 'error',
          })
        } finally {
          setBusyId(null)
        }
        return
      }
    }
  }

  const onRename = async (board: BoardWithRole, next: string) => {
    setRenamingId(null)
    const previous = board.title
    boards.update((list) => list.map((b) => (b.id === board.id ? { ...b, title: next } : b)))
    try {
      const saved = await api.patchBoard(board.id, { title: next })
      boards.update((list) => list.map((b) => (b.id === board.id ? { ...b, ...saved, role: b.role } : b)))
    } catch (e) {
      boards.update((list) => list.map((b) => (b.id === board.id ? { ...b, title: previous } : b)))
      notify({
        key: `rename:${board.id}`,
        text: isApiError(e) ? e.message : 'The board could not be renamed.',
        tone: 'error',
      })
    }
  }

  const createProject = async (name: string) => {
    const p = await api.createProject(workspace.id, name)
    projects.update((list) => [...list, p])
    navigate(workspacePath(workspace.id, { kind: 'project', projectId: p.id }))
  }
  const renameProject = async (project: Project, name: string) => {
    try {
      const p = await api.renameProject(project.id, name)
      projects.update((list) => list.map((x) => (x.id === p.id ? p : x)))
    } catch (e) {
      notify({
        key: `project:${project.id}`,
        text: isApiError(e) ? e.message : 'The project could not be renamed.',
        tone: 'error',
      })
    }
  }

  return (
    <div className="dr-dash" data-testid="dashboard" data-workspace-id={workspace.id}>
      <Sidebar
        workspace={workspace}
        workspaces={me.workspaces}
        section={section}
        projects={projectList}
        projectsError={projects.status === 'error' ? projects.error.message : null}
        canManageProjects={canCreate}
        onCreateProject={createProject}
        onRenameProject={renameProject}
      />
      <main className="dr-dash__main">
        <header className="dr-dash__top">
          <div className="dr-search">
            <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" className="dr-search__icon">
              <path
                d="M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14zM20 20l-4-4"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
              />
            </svg>
            <label htmlFor={searchId} className="dr-sr-only">
              Search boards by title
            </label>
            <input
              id={searchId}
              type="search"
              className="dr-input dr-search__input"
              data-testid="dashboard-search"
              placeholder={searchPlaceholder(section, title)}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Escape') setQuery('')
              }}
            />
          </div>
          <div className="dr-dash__spacer" />
          <UserMenu />
        </header>

        <div className="dr-dash__head">
          <div>
            <h1 className="dr-dash__title" data-testid="dashboard-title">
              {title}
            </h1>
            <p className="dr-dash__sub">
              {boards.status === 'ready'
                ? section.kind === 'recent'
                  ? totalCount > RECENT_LIMIT
                    ? `The ${RECENT_LIMIT} boards opened or edited most recently in ${workspace.name}`
                    : `Boards in ${workspace.name}, most recently opened first`
                  : `${totalCount} ${totalCount === 1 ? 'board' : 'boards'}`
                : ' '}
            </p>
          </div>
          <div className="dr-dash__actions">
            {showSort && (
              <>
                <label htmlFor={sortId} className="dr-sr-only">
                  Sort boards
                </label>
                <select
                  id={sortId}
                  className="dr-input dr-select dr-select--compact"
                  data-testid="dashboard-sort"
                  value={sort}
                  onChange={(e) => setSort(e.target.value as BoardSort)}
                >
                  <option value="opened">Last opened</option>
                  <option value="edited">Last edited</option>
                  <option value="name">Name</option>
                </select>
              </>
            )}
            {showCreate && (
              <button
                type="button"
                className="dr-btn dr-btn--primary"
                data-testid="create-board"
                onClick={() => setCreating(true)}
              >
                <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
                  <path d="M12 5v14M5 12h14" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />
                </svg>
                New board
              </button>
            )}
          </div>
        </div>

        {boards.status === 'loading' && (
          <ul className="dr-grid" aria-busy="true" aria-label="Loading boards">
            {[0, 1, 2, 3].map((i) => (
              <li key={i} className="dr-bcard dr-bcard--skeleton" aria-hidden="true" />
            ))}
          </ul>
        )}
        {boards.status === 'error' && (
          <div className="dr-empty" role="alert" data-testid="dashboard-error">
            <h2 className="dr-empty__title">Boards could not be loaded</h2>
            <p className="dr-muted">{boards.error.message}</p>
            <button type="button" className="dr-btn" onClick={boards.reload}>
              Try again
            </button>
          </div>
        )}
        {boards.status === 'ready' && visible.length === 0 && (
          <div className="dr-empty" data-testid="dashboard-empty">
            <EmptyArt />
            <h2 className="dr-empty__title">{empty.title}</h2>
            <p className="dr-muted">{empty.body}</p>
            {empty.offerCreate && (
              <button type="button" className="dr-btn dr-btn--primary" onClick={() => setCreating(true)}>
                Create a board
              </button>
            )}
          </div>
        )}
        {boards.status === 'ready' && visible.length > 0 && (
          <ul className="dr-grid" aria-label={title} data-testid="board-grid">
            {visible.map((b) => (
              <BoardCard
                key={b.id}
                board={b}
                now={now}
                busy={busyId === b.id}
                renaming={renamingId === b.id}
                onAction={(a, board) => void onAction(a, board)}
                onRename={(board, t) => void onRename(board, t)}
                onRenameCancel={() => setRenamingId(null)}
              />
            ))}
          </ul>
        )}
        {section.kind === 'recent' && boards.status === 'ready' && totalCount > RECENT_LIMIT && !query && (
          <p className="dr-dash__more">
            <a
              className="dr-btn dr-btn--ghost"
              href={workspacePath(workspace.id, { kind: 'all' })}
              onClick={(e) => {
                e.preventDefault()
                navigate(workspacePath(workspace.id, { kind: 'all' }))
              }}
            >
              See all {totalCount} boards
            </a>
          </p>
        )}
      </main>
      {creating && (
        <CreateBoardDialog
          workspaceId={workspace.id}
          workspaceName={workspace.name}
          projects={projectList}
          defaultProjectId={section.kind === 'project' ? section.projectId : null}
          onClose={() => setCreating(false)}
          onCreated={(board) => {
            setCreating(false)
            navigate(boardPath(board.id))
          }}
        />
      )}
      <NoticeRegion notices={notices} onDismiss={dismiss} />
    </div>
  )
}

function EmptyArt() {
  return (
    <svg className="dr-empty__art" viewBox="0 0 120 80" aria-hidden="true">
      <rect
        x="6"
        y="8"
        width="108"
        height="64"
        rx="8"
        fill="#fff"
        stroke="var(--dr-line-strong)"
        strokeDasharray="4 4"
      />
      <rect
        x="22"
        y="22"
        width="24"
        height="24"
        rx="2"
        fill="var(--dr-amber)"
        opacity="0.85"
        transform="rotate(-5 34 34)"
      />
      <rect
        x="54"
        y="30"
        width="24"
        height="24"
        rx="2"
        fill="#f6c863"
        opacity="0.7"
        transform="rotate(4 66 42)"
      />
      <path d="M86 40h14M93 33v14" stroke="var(--dr-navy)" strokeWidth="2.4" strokeLinecap="round" />
    </svg>
  )
}

function searchPlaceholder(section: DashboardSection, title: string): string {
  switch (section.kind) {
    case 'recent':
    case 'all':
      return 'Search boards'
    case 'archived':
      return 'Search archived boards'
    case 'trash':
      return 'Search trash'
    case 'project':
      return `Search ${title}`
  }
}
