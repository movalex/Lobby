import type { Board, Project } from '@draftroom/contracts'
import {
  type ChangeEvent,
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from 'react'
import { api, isApiError } from '../api/client.ts'
import { useMe } from '../auth/session.tsx'
import { UserMenu } from '../auth/UserMenu.tsx'
import { NoticeRegion, useNotices } from '../board/Notices.tsx'
import { isPaletteKey, paletteKeyOf } from '../features/command-palette/keys.ts'
import { boardTryPath } from '../features/command-palette/try-hints.ts'
import { TeamFeedbackPill } from '../features/feedback/FeedbackPill.tsx'
import { openFeedback } from '../features/feedback/state.ts'
import { useIsGuest } from '../invite/guest.tsx'
import { absoluteUrl, copyText } from '../lib/clipboard.ts'
import { boardPath, type DashboardSection, navigate, workspacePath } from '../lib/routing.ts'
import { writeLastWorkspace } from '../lib/storage.ts'
import { countUsage } from '../lib/usage.ts'
import { useResource } from '../lib/useResource.ts'
import { isFocusLost } from '../ui/focus.ts'
import { SkipLink } from '../ui/SkipLink.tsx'
import { NoAccessScreen } from '../ui/screens.tsx'
import { BoardCard } from './BoardCard.tsx'
import { BoardDetailsDialog, DuplicateBoardDialog, MoveBoardDialog } from './BoardDialogs.tsx'
import { CreateBoardDialog } from './CreateBoardDialog.tsx'
import { DashboardBell, useDashboardInbox } from './DashboardBell.tsx'
import { dashboardApi, IMPORT_BODY_LIMIT_BYTES } from './dashboard-api.ts'
import { HelpMenu } from './HelpMenu.tsx'
import { useInternalOnly } from './InternalOnly.tsx'
import { ImportMenu } from './import-menu/ImportMenu.tsx'
import { useMiroImport } from './import-miro/index.tsx'
import { internalOnlyShown } from './internal-only-model.ts'
import { LazyDialogBoundary } from './LazyDialogBoundary.tsx'
import {
  type BoardMenuAction,
  type BoardSort,
  boardsQueryForSection,
  dashboardAccess,
  duplicatedToast,
  duplicateTitle,
  emptyState,
  filterBoards,
  filterByOwner,
  importedToast,
  importTitle,
  OUTSIDE_NOTICE,
  type OwnerFilter,
  RECENT_LIMIT,
  recentBoards,
  sectionTitle,
  showOutsideNotice,
  sortBoards,
  TRASH_NOTE,
  UNCONFIRMED_NOTICE,
  withStar,
  withStarredEntry,
} from './model.ts'
import { newsByBoard } from './notifications.ts'
import {
  readPickerHidden,
  readViewMode,
  readWhatsNewSeen,
  type ViewMode,
  writeViewMode,
  writeWhatsNewDismissed,
} from './prefs.ts'
import { Sidebar } from './Sidebar.tsx'
import { StartRow } from './StartRow.tsx'
import { createSampleBoard } from './sample-board.ts'
import { ContentSearch } from './search/ContentSearch.tsx'
import { contentSearchApplies, SEARCH_MAX_QUERY_CHARS } from './search/content-search.ts'
import { type StartChoice, showStartRow, startRowOffered, startTiles, startTitle } from './start-row-model.ts'
import { SampleBoardButton } from './TemplateGallery.tsx'
import type { CatalogEntry } from './template-catalog.ts'
import { newBoardPath } from './template-paths.ts'
import { useCatalog, whenIdle } from './use-catalog.ts'
import { WelcomeCard } from './Welcome.tsx'
import { WhatsNewCard } from './WhatsNew.tsx'
import { isApplePlatform } from './welcome.ts'
import {
  introCard,
  NO_PLACE_TO_TRY,
  planBoardTry,
  planHintTry,
  type TryAction,
  type TryKey,
  unavailableTries,
  WHATS_NEW_VERSION,
  whatsNewFor,
} from './whats-new.ts'
import { requestWorkspaceMenu } from './workspace-menu-request.ts'
import './dashboard.css'

const dash = dashboardApi(api)

// K4-6: the Share dialog (about 43 KB with its sharing code) is fetched when someone chooses Share on a card,
// not with the dashboard: most visits never open it. dashboard-bundle.test.ts keeps it out of the page's
// static imports.
const ShareDialog = lazy(() => import('../board/ShareDialog.tsx').then((m) => ({ default: m.ShareDialog })))
// Wave L (W3, L3-2): the command palette, its own chunk, fetched the first time Ctrl/Cmd+K is pressed here
const DashboardPalette = lazy(() => import('../features/command-palette/dashboard.tsx'))

// A11Y-17: whether the person has clicked, tapped or pressed a key in this tab yet. After they have
// (signing in, a link in the folded phone menu), a dashboard that leaves the focus nowhere moves it to
// its heading, so a screen reader announces the new page; a fresh page load stays where browsers start.
let interacted = false
if (typeof window !== 'undefined') {
  const mark = () => {
    interacted = true
  }
  window.addEventListener('pointerdown', mark, { capture: true, once: true })
  window.addEventListener('keydown', mark, { capture: true, once: true })
}

/** The focus is on <body>, gone, or on something no longer shown (a link of the menu that just folded). */
function focusGone(): boolean {
  if (isFocusLost()) return true
  const a = document.activeElement
  return a instanceof HTMLElement && typeof a.checkVisibility === 'function' && !a.checkVisibility()
}

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
  // A name-only guest (wave 3): only the boards of their guest links, and a note saying so.
  const guest = useIsGuest()
  const workspace = me.workspaces.find((w) => w.id === workspaceId) ?? me.workspaces[0]
  // Domain access (docs/DOMAIN-ACCESS-CONTRACTS.md §9): creating needs a creator AND a workspace role that
  // may create; reading the project list, moving boards and the storage line need only the role.
  const access = dashboardAccess(me.access, workspace?.role ?? null)
  const { canCreate, inWorkspace, limit } = access
  const { notices, notify, dismiss } = useNotices()
  const searchId = useId()
  const sortId = useId()
  const ownerId = useId()
  const searchRef = useRef<HTMLInputElement>(null)
  const importRef = useRef<HTMLInputElement>(null)
  const titleRef = useRef<HTMLHeadingElement>(null)

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
  // K4-1: the "Start something" row's tile whose board is being made
  const [starting, setStarting] = useState<StartChoice | null>(null)
  const [catalogWanted, setCatalogWanted] = useState(false)
  // K4-5: a What's new "Try it" whose work is under way (a board being opened or made). The ref is the guard
  // (a second click in the same tick sees it); the state only draws the button.
  const [tryPending, setTryPending] = useState<TryKey | null>(null)
  const tryBusy = useRef(false)
  // K4-5: "Try it" on the template row asks for it to be shown and focused (see the effect below)
  const [startRowAsk, setStartRowAsk] = useState(0)
  // wave L (L3-2): the command palette (Ctrl/Cmd+K)
  const [paletteOpen, setPaletteOpen] = useState(false)
  const canCreateNow = useRef(canCreate)
  canCreateNow.current = canCreate
  const { mod: catalogMod } = useCatalog(catalogWanted)
  // K4-5, wave P: which release of the What's new card this person last saw (their browser's storage, which may be
  // missing). No record at all is a first visit: the Welcome card, not a changelog (P-002).
  const [seenRelease, setSeenRelease] = useState(() => readWhatsNewSeen(me.user.id))
  const welcomeFirst = seenRelease === null && !guest && section.kind === 'recent'
  const [now, setNow] = useState(() => new Date())
  // PRI-05a: what is new, without opening each board (the board bell's inbox).
  const inbox = useDashboardInbox()
  const news = useMemo(() => newsByBoard(inbox.inbox?.notifications ?? []), [inbox.inbox])

  // Whether the row is on the page now: only creators on the landing view see it, so only they fetch the
  // template catalog for its thumbnails (a guest, an outside account, the All / Archived / Trash / project
  // views and a search in progress never pay for the chunk). It is fetched once the page is idle, so the
  // dashboard's first paint never waits for the template builders.
  // The Welcome card has the three starts, so a first visit does not also get the row of twelve (P-009).
  const startRowShown =
    !welcomeFirst &&
    showStartRow({
      canCreate,
      guest,
      section,
      searching: query.trim().length > 0,
      pickerHidden: readPickerHidden(me.user.id),
    })
  useEffect(() => (startRowShown ? whenIdle(() => setCatalogWanted(true)) : undefined), [startRowShown])

  // K4-5: "Try it" on the row's item: the row is shown (a search was cleared for it) and its first tile
  // takes the focus; where the row is not there after all, the picker has the same templates.
  useEffect(() => {
    if (startRowAsk === 0) return
    const tile = document.querySelector<HTMLElement>('[data-testid="start-tile"]')
    if (tile) {
      tile.scrollIntoView({ block: 'center', behavior: 'smooth' })
      tile.focus({ preventScroll: true })
    } else if (canCreateNow.current) setCreating(true)
  }, [startRowAsk])

  // Wave J / K4-1: the Internal only switches live in the sidebar's workspace menu. The dashboard owns the
  // state so the What's new card can tell whether that menu has a control for this person at all.
  const internal = useInternalOnly(workspace?.id ?? workspaceId, inWorkspace)

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

  // Wave L (L3-2): Ctrl/Cmd+K opens the command palette (boards, lists, templates, words inside boards)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || !isPaletteKey(paletteKeyOf(e))) return
      e.preventDefault()
      setPaletteOpen(true)
      countUsage('palette.open:key')
      // the creators' templates read better with the catalog's names (fetched once, as for the row)
      if (canCreateNow.current) setCatalogWanted(true)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // Guests may not list projects (the API answers 403); they only see boards shared with them.
  const projectsLoad = useCallback(
    (signal: AbortSignal) => (inWorkspace ? api.listProjects(workspaceId, signal) : Promise.resolve([])),
    [workspaceId, inWorkspace],
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

  // A11Y-17: arriving here from sign-in (or from a link in the folded phone menu, which closes) left
  // the focus on <body>; the page heading takes it, so the new page is announced and Tab goes on from it.
  useEffect(() => {
    if (interacted && focusGone()) titleRef.current?.focus({ preventScroll: true })
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

  // wave R (WS1): "From Miro…" in the Import menu; each board an import finishes reloads the list
  const miro = useMiroImport({
    workspaceId: workspace?.id ?? workspaceId,
    projects: projectList,
    defaultProjectId: section.kind === 'project' ? section.projectId : null,
    onFinished: boards.reload,
  })

  if (!workspace) return <NoAccessScreen thing="workspace" />

  const title = sectionTitle(section, projectList)
  // Domain access: an outside account whose role would create is told why the create controls are missing.
  const outsideNotice = showOutsideNotice(access, section)
  const empty = emptyState(section, { searching: query.trim().length > 0, canCreate, limit, outsideNotice })
  // Search across boards (wave 4): "Inside boards" results below the title matches.
  const contentSearching = contentSearchApplies(section, query)
  const showSort = section.kind !== 'recent'
  // New boards are active: offering "New board" while looking at Trash or Archived would be confusing.
  const showCreate = canCreate && section.kind !== 'archived' && section.kind !== 'trash'
  const totalCount = boards.data?.length ?? 0
  // The card says only what is true for this person: the row if they get it (not while a search or another
  // view hides it for now: "Try it" brings it back), the workspace menu's Internal only control if they have
  // one (owners and admins, and anyone while it is on; a plain member has none).
  const startRowForCard = startRowOffered({ canCreate, guest, pickerHidden: readPickerHidden(me.user.id) })
  const newItems = whatsNewFor({
    canCreate,
    startRow: startRowForCard,
    internalOnly: internalOnlyShown(internal.settings, projectList),
  })
  // "Try it" buttons with nowhere to go yet (the list is on its way) or at all (no board and no Start row): disabled
  const tryUnavailable = unavailableTries({
    listReady: boards.status === 'ready',
    boards: boards.data ?? [],
    startRow: startRowForCard,
    items: newItems,
  })
  const intro = introCard({ seen: seenRelease, items: newItems, guest, landing: section.kind === 'recent' })
  const whatsNewShown = intro === 'whats-new'
  const welcomeShown = intro === 'welcome'
  // Whatever card they saw is remembered at this release: neither shows again until the next one
  const rememberIntro = () => {
    writeWhatsNewDismissed(me.user.id, WHATS_NEW_VERSION)
    setSeenRelease(WHATS_NEW_VERSION)
  }
  const menu = { canCreate, canMove: inWorkspace }
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
    // Stay where they are (P-045: it jumped into the empty project, so moving a board there needed a trip back to
    // All boards): the lobby is in the sidebar and in Move to…, and the notice offers to open it.
    notify({
      key: `project:${p.id}`,
      text: `Project lobby “${p.name}” created`,
      testId: 'dashboard-toast',
      timeoutMs: 8000,
      action: {
        label: 'Open it',
        testId: 'project-open-new',
        onClick: () => navigate(workspacePath(workspace.id, { kind: 'project', projectId: p.id })),
      },
    })
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
    if (!canCreate) return
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

  // K4-1: a tile of the "Start something" row. The same thing as choosing a template in New board (a private
  // board named for the template, opened at ?template=<id>); the api's creator rule answers 403 for anyone
  // who may not, whatever the row shows.
  const startFromRow = async (choice: StartChoice, entry: CatalogEntry | null) => {
    if (!canCreate || starting) return
    setStarting(choice)
    try {
      const board = await api.createBoard(workspace.id, {
        title: startTitle(entry, choice),
        projectId: defaultProjectId,
      })
      navigate(newBoardPath(board.id, choice === 'blank' ? null : choice))
    } catch (e) {
      setStarting(null)
      notify({
        key: 'create',
        text: isApiError(e) ? e.message : 'The board could not be created.',
        tone: 'error',
      })
    }
  }

  // K4-5: "Try it" on a What's new item takes the person to the thing, and does something they can see.
  const tryNew = (action: TryAction) => {
    if (tryBusy.current) return
    if (typeof action === 'object') {
      // M3-3: a wave L item: the board they can edit that they opened last, with a coach mark on the thing; with none,
      // the Start row (nothing is made). Counted by the item's id (`whatsnew.try:<id>`).
      countUsage(`whatsnew.try:${action.hint}`)
      const plan = planHintTry({
        listReady: boards.status === 'ready',
        boards: boards.data ? sortBoards(boards.data, 'opened') : [],
        hint: action.hint,
        startRow: startRowOffered({ canCreate, guest, pickerHidden: readPickerHidden(me.user.id) }),
        boardAddress: boardTryPath,
      })
      if (plan.kind === 'open') navigate(plan.to)
      else if (plan.kind === 'start-row') {
        setQuery('')
        setStartRowAsk((n) => n + 1)
      }
      return
    }
    if (action === 'workspace-menu') requestWorkspaceMenu()
    else if (action === 'templates') {
      if (canCreate) setCreating(true)
    } else if (action === 'start-row') {
      // a search hides the row: clear it, then the effect above focuses the first tile
      setQuery('')
      setStartRowAsk((n) => n + 1)
    } else if (action === 'board') {
      // Show a board's top bar without leaving anything behind: the board they opened last, and only
      // someone with no boards at all gets the Lobby tour made for them (once; the buttons wait).
      const plan = planBoardTry({
        listReady: boards.status === 'ready',
        latestBoardId: (boards.data ? recentBoards(boards.data)[0]?.id : null) ?? null,
        canCreate,
      })
      if (plan.kind === 'open') navigate(boardPath(plan.boardId))
      if (plan.kind !== 'make-tour') return
      tryBusy.current = true
      setTryPending('board')
      createSampleBoard(api.createBoard, workspace.id, defaultProjectId).then(
        (path) => navigate(path),
        (e) => {
          tryBusy.current = false
          setTryPending(null)
          notify({
            key: 'sample-board',
            text: isApiError(e) ? e.message : 'The sample board could not be created.',
            tone: 'error',
          })
        },
      )
    }
  }

  const onImportFile = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    e.target.value = '' // the same file can be picked again after an error
    if (!file || !canCreate) return
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
      notify({
        key: 'import',
        text: importedToast(created),
        testId: 'dashboard-toast',
        timeoutMs: created.warnings.length || created.droppedFiles ? 10_000 : 5000,
      })
      boards.reload()
    } catch (err) {
      const text =
        err instanceof Error && err.message === 'not-json'
          ? 'That file is not a Lobby board export (.json).'
          : isApiError(err) && err.kind === 'not-found'
            ? 'Importing is not available on this server.'
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
      {/* A11Y-09: the first Tab stop jumps past the sidebar and the search bar to the board list. Wave K: past the
          "Start something" row and the What's new card too, to the first board (the page heading when there is
          none), so the twelve template tiles are not the price of getting to a board. */}
      <SkipLink
        label="Skip to boards"
        testId="skip-to-boards"
        onSkip={() => {
          const first = document.querySelector<HTMLElement>(
            '[data-testid="starred-grid"] a, [data-testid="board-grid"] a',
          )
          ;(first ?? titleRef.current)?.focus({ preventScroll: false })
        }}
      />
      <Sidebar
        workspace={workspace}
        workspaces={me.workspaces}
        section={section}
        projects={projectList}
        projectsError={projects.status === 'error' ? projects.error.message : null}
        internal={internal}
        canSeeProjects={inWorkspace}
        canCreateProjects={canCreate}
        canRenameProjects={canCreate}
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
              Search boards and what is on them
            </label>
            <input
              id={searchId}
              ref={searchRef}
              type="search"
              className="dr-input dr-search__input"
              data-testid="dashboard-search"
              placeholder={searchPlaceholder(section, title)}
              title="Search boards (Ctrl+E)"
              maxLength={SEARCH_MAX_QUERY_CHARS}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Escape') setQuery('')
              }}
            />
          </div>
          <div className="dr-dash__spacer" />
          <HelpMenu
            canTour={canCreate}
            onTour={() => void startFromRow('lobby-tour', null)}
            onFeedback={() => openFeedback(null)}
          />
          <DashboardBell {...inbox} />
          <UserMenu />
        </header>

        <div className="dr-dash__head">
          <div>
            <h1 className="dr-dash__title" data-testid="dashboard-title" ref={titleRef} tabIndex={-1}>
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
                {/* wave R: one button today; a menu once WS1's or WS4's entry is on (import-menu/flags.ts) */}
                <ImportMenu
                  importing={importing}
                  onJson={() => importRef.current?.click()}
                  onMiro={miro.open}
                />
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

        {limit === 'unconfirmed' && (
          <div className="dr-dash__guest" role="note" data-testid="access-unconfirmed">
            <strong>{UNCONFIRMED_NOTICE}</strong>
            <span>
              <button type="button" className="dr-btn dr-btn--sm" onClick={() => location.reload()}>
                Reload
              </button>
            </span>
          </div>
        )}

        {outsideNotice && (
          <div className="dr-dash__guest" role="note" data-testid="access-outside">
            <strong>{OUTSIDE_NOTICE.title}</strong>
            <span>{OUTSIDE_NOTICE.body}</span>
          </div>
        )}

        {guest && (
          <div className="dr-dash__guest" role="note" data-testid="guest-banner">
            <strong>You're a guest. Sign in with an account to keep access.</strong>
            <span>
              You see only the boards you joined with a link. Guest access ends when the link does, or when
              you sign out; with an account, ask whoever shared a board to invite you.
            </span>
          </div>
        )}

        {section.kind === 'trash' && (
          <p className="dr-dash__note" data-testid="trash-note">
            {TRASH_NOTE}
          </p>
        )}

        {startRowShown && (
          <StartRow
            tiles={startTiles(catalogMod ? catalogMod.templateCatalog() : null)}
            pending={starting}
            onChoose={(c, e) => void startFromRow(c, e)}
          />
        )}

        {welcomeShown && (
          <WelcomeCard
            canCreate={canCreate}
            pending={starting}
            apple={isApplePlatform()}
            onStart={(choice) => {
              rememberIntro()
              void startFromRow(choice, null)
            }}
            onMoreTemplates={() => {
              if (canCreate) setCreating(true)
            }}
            onDismiss={rememberIntro}
          />
        )}

        {whatsNewShown && (
          <WhatsNewCard
            items={newItems}
            pending={tryPending}
            unavailable={tryUnavailable}
            unavailableReason={boards.status === 'ready' ? NO_PLACE_TO_TRY : undefined}
            onTry={tryNew}
            onTellUs={() => openFeedback(null)}
            onDismiss={rememberIntro}
          />
        )}

        {showStarred && starredVisible.length > 0 && (
          <section className="dr-dash__group" aria-labelledby="dr-starred-h" data-testid="starred-section">
            <h2 id="dr-starred-h" className="dr-dash__group-title">
              Starred
            </h2>
            {cardList(starredVisible, 'Starred boards', 'starred-grid')}
          </section>
        )}
        {((showStarred && starredVisible.length > 0) || contentSearching) && (
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
        {boards.status === 'ready' && visible.length === 0 && contentSearching && (
          <p className="dr-csearch__none" data-testid="dashboard-empty">
            No board titles match “{query.trim()}”.
          </p>
        )}
        {boards.status === 'ready' && visible.length === 0 && !contentSearching && (
          <div className="dr-empty" data-testid="dashboard-empty">
            <EmptyArt kind={section.kind} />
            <h2 className="dr-empty__title">{empty.title}</h2>
            <p className="dr-muted">
              {owner !== 'anyone' && !query ? 'No boards match the owner filter.' : empty.body}
            </p>
            {empty.offerCreate && (
              <div className="dr-empty__actions">
                <button type="button" className="dr-btn dr-btn--primary" onClick={() => void newBoard()}>
                  Create a board
                </button>
                <SampleBoardButton
                  workspaceId={workspace.id}
                  projectId={defaultProjectId}
                  onError={(text) => notify({ key: 'sample-board', text, tone: 'error' })}
                />
              </div>
            )}
          </div>
        )}
        {boards.status === 'ready' && visible.length > 0 && cardList(visible, title, 'board-grid')}
        <ContentSearch
          workspaceId={workspace.id}
          query={query}
          section={section}
          inputRef={searchRef}
          projectName={section.kind === 'project' ? undefined : projectName}
        />
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
      {paletteOpen && (
        <LazyDialogBoundary what="The command palette" onClose={() => setPaletteOpen(false)}>
          <Suspense fallback={null}>
            <DashboardPalette
              workspaceId={workspace.id}
              workspaces={me.workspaces}
              viewer={me.user.id}
              canCreate={canCreate}
              guest={guest}
              tiles={startTiles(catalogMod ? catalogMod.templateCatalog() : null)}
              onStart={(t) => void startFromRow(t.choice, t.entry)}
              onBrowseTemplates={() => {
                if (canCreate) setCreating(true)
              }}
              onClose={() => setPaletteOpen(false)}
            />
          </Suspense>
        </LazyDialogBoundary>
      )}
      {creating && canCreate && (
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
        <LazyDialogBoundary what="Share" onClose={() => setDialog(null)}>
          <Suspense fallback={null}>
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
          </Suspense>
        </LazyDialogBoundary>
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
      {dialog?.kind === 'duplicate' && canCreate && (
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
              text: duplicatedToast(created),
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
      {miro.dialog}
      <NoticeRegion notices={notices} onDismiss={dismiss} />
      {/* K4-5: Feedback is one click away, on the dashboard as on a board */}
      <TeamFeedbackPill />
    </div>
  )
}

function EmptyArt({ kind }: { kind: DashboardSection['kind'] }) {
  // P-033: the empty Trash is a bin, not the "make a note" picture
  if (kind === 'trash') return <TrashArt />
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

function TrashArt() {
  return (
    <svg className="dr-empty__art" data-testid="empty-art-trash" viewBox="0 0 120 80" aria-hidden="true">
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
      <path
        d="M46 30h28l-2.2 28a3 3 0 0 1-3 2.8H51.2a3 3 0 0 1-3-2.8zM42 30h36M54 30v-4h12v4"
        fill="none"
        stroke="var(--dr-navy)"
        strokeWidth="2.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path d="M56 37v16M64 37v16" stroke="var(--dr-line-strong)" strokeWidth="2.2" strokeLinecap="round" />
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
