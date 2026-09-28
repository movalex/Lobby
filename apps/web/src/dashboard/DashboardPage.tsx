import type { Board, Project } from '@draftroom/contracts'
import { type ChangeEvent, useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import { api, isApiError } from '../api/client.ts'
import { useMe } from '../auth/session.tsx'
import { UserMenu } from '../auth/UserMenu.tsx'
import { NoticeRegion, useNotices } from '../board/Notices.tsx'
import { ShareDialog } from '../board/ShareDialog.tsx'
import { absoluteUrl, copyText } from '../lib/clipboard.ts'
import { canCreateInWorkspace } from '../lib/permissions.ts'
import { boardPath, type DashboardSection, navigate, workspacePath } from '../lib/routing.ts'
import { writeLastWorkspace } from '../lib/storage.ts'
import { useResource } from '../lib/useResource.ts'
import { NoAccessScreen } from '../ui/screens.tsx'
import { BoardCard } from './BoardCard.tsx'
import { BoardDetailsDialog, DuplicateBoardDialog, MoveBoardDialog } from './BoardDialogs.tsx'
import { CreateBoardDialog } from './CreateBoardDialog.tsx'
import { DashboardBell, useDashboardInbox } from './DashboardBell.tsx'
import { dashboardApi, IMPORT_BODY_LIMIT_BYTES } from './dashboard-api.ts'
import {
  type BoardMenuAction,
  type BoardSort,
  boardsQueryForSection,
  duplicateTitle,
  emptyState,
  filterBoards,
  filterByOwner,
  importTitle,
  type OwnerFilter,
  RECENT_LIMIT,
  recentBoards,
  sectionTitle,
  sortBoards,
  TRASH_NOTE,
  withStar,
  withStarredEntry,
} from './model.ts'
import { newsByBoard } from './notifications.ts'
import { readPickerHidden, readViewMode, type ViewMode, writeViewMode } from './prefs.ts'
import { Sidebar } from './Sidebar.tsx'
import { newBoardPath } from './template-paths.ts'
import './dashboard.css'

const dash = dashboardApi(api)

type DashBoard = Awaited<ReturnType<typeof dash.listBoards>>[number]

const STATUS_DONE: Record<'archive' | 'trash' | 'restore', string> = {
  archive: 'archived',
  trash: 'moved to trash',
  restore: 'restored',
}

type Dialog =
  | { kind: 'share'; board: DashBoard }
  | { kind: 'move'; board: DashBoard }
  | { kind: 'duplicate'; board: DashBoard }
  | { kind: 'details'; board: DashBoard }
  | null

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
  const ownerId = useId()
  const searchRef = useRef<HTMLInputElement>(null)
  const importRef = useRef<HTMLInputElement>(null)

  const [query, setQuery] = useState('')
  const [sort, setSort] = useState<BoardSort>('opened')
  const [owner, setOwner] = useState<OwnerFilter>('anyone')
  const [view, setView] = useState<ViewMode>(() => readViewMode())
  const [creating, setCreating] = useState(false)
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [dialog, setDialog] = useState<Dialog>(null)
  const [importing, setImporting] = useState(false)
  const [quickCreating, setQuickCreating] = useState(false)
  const [now, setNow] = useState(() => new Date())
  // PRI-05a: what is new, without opening each board (the board bell's inbox).
  const inbox = useDashboardInbox()
  const news = useMemo(() => newsByBoard(inbox.inbox?.notifications ?? []), [inbox.inbox])

  // Relative times ("5 min ago") stay honest while the dashboard is left open.
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 60_000)
    return () => clearInterval(t)
  }, [])

  // DSH-06: Ctrl/Cmd+E jumps to board search.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === 'e') {
        e.preventDefault()
        searchRef.current?.focus()
        searchRef.current?.select()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // Guests may not list projects (the API answers 403); they only see boards shared with them.
  const projectsLoad = useCallback(
    (signal: AbortSignal) => (canCreate ? api.listProjects(workspaceId, signal) : Promise.resolve([])),
    [workspaceId, canCreate],
  )
  const projects = useResource(projectsLoad)

  const { status, projectId } = boardsQueryForSection(section)
  const boardsLoad = useCallback(
    (signal: AbortSignal) => dash.listBoards(workspaceId, { status, projectId }, signal),
    [workspaceId, status, projectId],
  )
  const boards = useResource(boardsLoad)

  // Starred (DSH-01) leads the landing view, across projects.
  const showStarred = section.kind === 'recent'
  const starredLoad = useCallback(
    (signal: AbortSignal): Promise<DashBoard[]> =>
      showStarred ? dash.starredBoards(workspaceId, signal) : Promise.resolve([]),
    [workspaceId, showStarred],
  )
  const starred = useResource(starredLoad)

  // Search is per list; a different list starts unfiltered.
  const sectionKey = section.kind === 'project' ? `p:${section.projectId}` : section.kind
  useEffect(() => {
    setQuery('')
    setRenamingId(null)
  }, [sectionKey])

  const projectList: Project[] = projects.data ?? []
  const projectName = (id: string | null) =>
    id ? (projectList.find((p) => p.id === id)?.name ?? null) : null
  const visible = useMemo(() => {
    const all = filterByOwner(boards.data ?? [], owner, me.user.id)
    const filtered = filterBoards(all, query)
    if (section.kind === 'recent' && !query) return recentBoards(filtered)
    return sortBoards(filtered, section.kind === 'recent' ? 'opened' : sort)
  }, [boards.data, query, section.kind, sort, owner, me.user.id])
  const starredVisible = useMemo(
    () => filterBoards(filterByOwner(starred.data ?? [], owner, me.user.id), query),
    [starred.data, owner, me.user.id, query],
  )

  const pageTitle = `${sectionTitle(section, projectList)} · ${workspace?.name ?? 'Lobby'}`
  useEffect(() => {
    document.title = `${pageTitle} · Lobby`
    return () => {
      document.title = 'Lobby'
    }
  }, [pageTitle])

  if (!workspace) return <NoAccessScreen thing="workspace" />

  const title = sectionTitle(section, projectList)
  const empty = emptyState(section, { searching: query.trim().length > 0, canCreate })
  const showSort = section.kind !== 'recent'
  // New boards are active: offering "New board" while looking at Trash or Archived would be confusing.
  const showCreate = canCreate && section.kind !== 'archived' && section.kind !== 'trash'
  const totalCount = boards.data?.length ?? 0
  const menu = { canCreate, canMove: canCreate }
  const defaultProjectId = section.kind === 'project' ? section.projectId : null

  const updateBoard = (id: string, fn: (b: DashBoard) => DashBoard) => {
    boards.update((list) => list.map((b) => (b.id === id ? fn(b) : b)))
    starred.update((list) => list.map((b) => (b.id === id ? fn(b) : b)))
  }

  const setStar = async (board: DashBoard, on: boolean) => {
    boards.update((list) => withStar(list, board.id, on))
    starred.update((list) => withStarredEntry(list, board, on))
    try {
      await dash.setStar(board.id, on)
    } catch (e) {
      boards.update((list) => withStar(list, board.id, !on))
      starred.reload()
      notify({
        key: `star:${board.id}`,
        text: isApiError(e) ? e.message : 'The star was not saved. Try again.',
        tone: 'error',
      })
    }
  }

  const onAction = async (action: BoardMenuAction, board: DashBoard) => {
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
      case 'share':
      case 'move':
      case 'duplicate':
      case 'details':
        setDialog({ kind: action, board })
        return
      case 'star':
      case 'unstar':
        await setStar(board, action === 'star')
        return
      case 'archive':
      case 'trash':
      case 'restore': {
        setBusyId(board.id)
        try {
          await api.setBoardStatus(board.id, action)
          // The board now belongs to another list; drop it here and let that list fetch fresh.
          boards.update((list) => list.filter((b) => b.id !== board.id))
          starred.reload()
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

  const onRename = async (board: DashBoard, next: string) => {
    setRenamingId(null)
    const previous = board.title
    updateBoard(board.id, (b) => ({ ...b, title: next }))
    try {
      const saved = await api.patchBoard(board.id, { title: next })
      updateBoard(board.id, (b) => ({ ...b, ...saved, role: b.role, starred: b.starred }))
    } catch (e) {
      updateBoard(board.id, (b) => ({ ...b, title: previous }))
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

  // "New board": the template picker, unless this user ticked "Don't show on new boards" (PRE-01);
  // then one click makes a blank board and opens it.
  const newBoard = async () => {
    if (!readPickerHidden(me.user.id)) {
      setCreating(true)
      return
    }
    setQuickCreating(true)
    try {
      const board = await api.createBoard(workspace.id, {
        title: 'Untitled board',
        projectId: defaultProjectId,
      })
      navigate(boardPath(board.id))
    } catch (e) {
      setQuickCreating(false)
      notify({
        key: 'create',
        text: isApiError(e) ? e.message : 'The board could not be created.',
        tone: 'error',
      })
    }
  }

  const onImportFile = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    e.target.value = '' // the same file can be picked again after an error
    if (!file) return
    if (file.size > IMPORT_BODY_LIMIT_BYTES) {
      notify({ key: 'import', text: 'That file is larger than 25 MB, the import limit.', tone: 'error' })
      return
    }
    setImporting(true)
    try {
      let archive: unknown
      try {
        archive = JSON.parse(await file.text())
      } catch {
        throw new Error('not-json')
      }
      const title = importTitle(file.name)
      const created = await dash.importBoard(workspace.id, archive, {
        title,
        projectId: defaultProjectId ?? undefined,
      })
      const dropped = created.droppedFiles
        ? ` ${created.droppedFiles} ${created.droppedFiles === 1 ? 'file was' : 'files were'} left out (no access).`
        : ''
      notify({
        key: 'import',
        text: `Imported “${created.board.title}”.${dropped}`,
        testId: 'dashboard-toast',
        timeoutMs: dropped ? 10_000 : 5000,
      })
      boards.reload()
    } catch (err) {
      const text =
        err instanceof Error && err.message === 'not-json'
          ? 'That file is not a Lobby board export (.json).'
          : isApiError(err) && err.kind === 'not-found'
            ? 'Importing is not available on this server yet.'
            : isApiError(err)
              ? err.message
              : 'The board could not be imported.'
      notify({ key: 'import', text, tone: 'error', timeoutMs: 10_000 })
    } finally {
      setImporting(false)
    }
  }

  const cardList = (list: readonly DashBoard[], label: string, testId: string) => (
    <ul
      className={view === 'list' ? 'dr-grid dr-list' : 'dr-grid'}
      aria-label={label}
      data-testid={testId}
      data-view={view}
    >
      {list.map((b) => (
        <BoardCard
          key={b.id}
          board={b}
          now={now}
          layout={view}
          menu={menu}
          projectName={projectName(b.projectId)}
          news={news.get(b.id) ?? null}
          busy={busyId === b.id}
          renaming={renamingId === b.id}
          onAction={(a, board) => void onAction(a, board)}
          onRename={(board, t) => void onRename(board, t)}
          onRenameCancel={() => setRenamingId(null)}
          onStar={(board, on) => void setStar(board, on)}
        />
      ))}
    </ul>
  )

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
              ref={searchRef}
              type="search"
              className="dr-input dr-search__input"
              data-testid="dashboard-search"
              placeholder={searchPlaceholder(section, title)}
              title="Search boards (Ctrl+E)"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Escape') setQuery('')
              }}
            />
          </div>
          <div className="dr-dash__spacer" />
          <DashboardBell {...inbox} />
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
                : ' '}
            </p>
          </div>
          <div className="dr-dash__actions">
            <fieldset className="dr-seg" data-testid="view-toggle" data-view={view}>
              <legend className="dr-sr-only">Board layout</legend>
              {(['grid', 'list'] as const).map((m) => (
                <button
                  key={m}
                  type="button"
                  className="dr-seg__btn"
                  data-view={m}
                  aria-pressed={view === m}
                  aria-label={m === 'grid' ? 'Grid view' : 'List view'}
                  title={m === 'grid' ? 'Grid view' : 'List view'}
                  onClick={() => {
                    setView(m)
                    writeViewMode(m)
                  }}
                >
                  <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
                    <path
                      d={
                        m === 'grid'
                          ? 'M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z'
                          : 'M4 6h16M4 12h16M4 18h16'
                      }
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.9"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  </svg>
                </button>
              ))}
            </fieldset>
            <label htmlFor={ownerId} className="dr-sr-only">
              Filter by owner
            </label>
            <select
              id={ownerId}
              className="dr-input dr-select dr-select--compact"
              data-testid="owner-filter"
              value={owner}
              onChange={(e) => setOwner(e.target.value as OwnerFilter)}
            >
              <option value="anyone">Created by anyone</option>
              <option value="me">Created by me</option>
              <option value="not-me">Created by others</option>
            </select>
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
                  <option value="created">Date created</option>
                  <option value="name">Name</option>
                </select>
              </>
            )}
            {showCreate && (
              <>
                <input
                  ref={importRef}
                  type="file"
                  accept=".json,application/json"
                  className="dr-sr-only"
                  tabIndex={-1}
                  aria-hidden="true"
                  data-testid="import-board-file"
                  onChange={(e) => void onImportFile(e)}
                />
                <button
                  type="button"
                  className="dr-btn"
                  data-testid="import-board"
                  disabled={importing}
                  title="Import a board exported from Lobby (.json)"
                  onClick={() => importRef.current?.click()}
                >
                  {importing ? 'Importing…' : 'Import'}
                </button>
                {readPickerHidden(me.user.id) && (
                  <button
                    type="button"
                    className="dr-btn"
                    data-testid="open-templates"
                    onClick={() => setCreating(true)}
                  >
                    Templates
                  </button>
                )}
                <button
                  type="button"
                  className="dr-btn dr-btn--primary"
                  data-testid="create-board"
                  disabled={quickCreating}
                  onClick={() => void newBoard()}
                >
                  <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
                    <path
                      d="M12 5v14M5 12h14"
                      stroke="currentColor"
                      strokeWidth="2.2"
                      strokeLinecap="round"
                    />
                  </svg>
                  New board
                </button>
              </>
            )}
          </div>
        </div>

        {section.kind === 'trash' && (
          <p className="dr-dash__note" data-testid="trash-note">
            {TRASH_NOTE}
          </p>
        )}

        {showStarred && starredVisible.length > 0 && (
          <section className="dr-dash__group" aria-labelledby="dr-starred-h" data-testid="starred-section">
            <h2 id="dr-starred-h" className="dr-dash__group-title">
              Starred
            </h2>
            {cardList(starredVisible, 'Starred boards', 'starred-grid')}
          </section>
        )}
        {showStarred && starredVisible.length > 0 && (
          <h2 className="dr-dash__group-title">{query ? 'Matching boards' : 'Recent'}</h2>
        )}

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
            <p className="dr-muted">
              {owner !== 'anyone' && !query ? 'No boards match the owner filter.' : empty.body}
            </p>
            {empty.offerCreate && (
              <button type="button" className="dr-btn dr-btn--primary" onClick={() => void newBoard()}>
                Create a board
              </button>
            )}
          </div>
        )}
        {boards.status === 'ready' && visible.length > 0 && cardList(visible, title, 'board-grid')}
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
          userId={me.user.id}
          projects={projectList}
          defaultProjectId={defaultProjectId}
          onClose={() => setCreating(false)}
          onCreated={(board, templateId) => {
            setCreating(false)
            navigate(newBoardPath(board.id, templateId))
          }}
        />
      )}
      {dialog?.kind === 'share' && (
        <ShareDialog
          board={dialog.board}
          role={dialog.board.role}
          workspace={{ id: workspace.id, name: workspace.name }}
          selfUserId={me.user.id}
          onClose={() => setDialog(null)}
          onBoardChange={(b: Board) => {
            updateBoard(b.id, (x) => ({ ...x, ...b }))
            setDialog((d) => (d?.kind === 'share' ? { ...d, board: { ...d.board, ...b } } : d))
          }}
        />
      )}
      {dialog?.kind === 'move' && (
        <MoveBoardDialog
          board={dialog.board}
          projects={projectList}
          onClose={() => setDialog(null)}
          onMove={async (pid) => {
            const saved = await api.patchBoard(dialog.board.id, { projectId: pid })
            setDialog(null)
            // In a project view the board may leave this list.
            if (section.kind === 'project' && saved.projectId !== section.projectId)
              boards.update((list) => list.filter((b) => b.id !== saved.id))
            else updateBoard(saved.id, (b) => ({ ...b, ...saved }))
            notify({
              key: `move:${saved.id}`,
              text: `“${saved.title}” moved to ${projectName(saved.projectId) ?? 'No project'}`,
              testId: 'dashboard-toast',
            })
          }}
        />
      )}
      {dialog?.kind === 'duplicate' && (
        <DuplicateBoardDialog
          board={dialog.board}
          defaultTitle={duplicateTitle(dialog.board.title)}
          onClose={() => setDialog(null)}
          onDuplicate={async (input) => {
            const created = await dash.duplicateBoard(dialog.board.id, input)
            setDialog(null)
            boards.reload()
            notify({
              key: `duplicate:${dialog.board.id}`,
              text: `Duplicated as “${created.board.title}”${created.warnings.length ? ` (${created.warnings[0]})` : ''}`,
              testId: 'dashboard-toast',
            })
          }}
        />
      )}
      {dialog?.kind === 'details' && (
        <BoardDetailsDialog
          board={dialog.board}
          workspaceName={workspace.name}
          projectName={projectName(dialog.board.projectId)}
          onClose={() => setDialog(null)}
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
        fill="var(--dr-surface)"
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
