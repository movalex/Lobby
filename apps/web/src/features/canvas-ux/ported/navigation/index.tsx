// OWNER: 3b (docs/EXCALIDRAW-CONTRACTS.md §7.2). The ported 'navigation' feature on the Excalidraw board page:
// navigation: minimap, board search, frames panel, start view, copy link and deep links, arrange as grid, select by type, bulk paste, templates, Lobby’s fit camera and zoom wheel below 0.1, the camera keys from the chrome; the level-of-detail pass is the board page's (canvas/lod, docs/research/excalidraw/wave3/3B-2.md).
//
// What it contributes (docs/EXCALIDRAW-MIGRATION.md §4.2, §3.6; the tldraw build's canvas-ux feature):
//  - dock panels: Search board (Ctrl/Cmd+F, MAK-12), Frames (MAK-13), Templates (PRE-02/03; the insert is
//    blocked by CR-2D-2 until LobbyTx.insert lands);
//  - the navigation host slot: the zoom menu, zoom buttons and the minimap (MAK-10/11, PERF-03);
//  - the zoom keys (Alt+1 / Shift+1 fit, Alt+2 / Shift+2 selection, Ctrl/Cmd+0 / Shift+0 100%, Ctrl/Cmd+=
//    and =, Ctrl/Cmd+- and -, Shift+= / Shift+- and Ctrl/Cmd+Shift+= / - at the pointer), M for the minimap,
//    Alt+Shift+G arrange as grid; a key that types a character leaves a lone selected note to type-to-edit
//    (COL-04), as on the tldraw board; the camera keys and board search also from the chrome (A11Y2-02);
//  - the zoom wheel and the trackpad pinch below Excalidraw's 0.1, down to the whole-board fit (CR 3b-2);
//  - the context menu's Arrange as grid (MAK-18), Set this frame as start view (PRE-08), Select all on
//    this page › and Keep only › (MAK-17); the board menu's start-view entries (PRE-08);
//  - the selection bar's Copy link and Arrange as grid with its columns stepper;
//  - paste as sticky notes (COL-05, RETRO-01), a text content handler with its prompt;
//  - the first view (PRE-06: ?template=, the deep links ?el= / ?view= / legacy ?d=, the last camera, the
//    board's start view, fit) and this user's camera, kept per board;
//  - Lobby's own camera: canvas/api/parts/navigation.ts (viewport.zoomTo … limits, below Excalidraw's 0.1).
import { isReadonlyRole } from '../../../../board/access.ts'
import {
  type CanvasFeature,
  type CanvasFeatureContext,
  type CommandSpec,
  currentPlatform,
  type FeatureKeySpec,
  type MenuEntrySpec,
  matchChord,
  parseChord,
} from '../../../../canvas/api/index.ts'
import { useValue } from '../../../../lib/signals.ts'
import { FramesIcon, SearchIcon, TemplatesIcon } from '../../icons.tsx'
import { categoryLabel, TYPE_CATEGORIES, type TypeCategory } from '../../select-by-type.ts'
import { canArrangeAsGrid, runArrangeAsGrid } from './arrange-grid.ts'
import { BULK_PASTE_HANDLER, BulkPastePrompt } from './bulk-paste.tsx'
import { type ChromeKey, installChromeKeys } from './chrome-keys.ts'
import { copySelectionLink } from './copy-link.ts'
import { installNavigationDevHook } from './dev-hook.ts'
import { FramesPanel } from './FramesPanel.tsx'
import { NavigationPanel } from './NavigationPanel.tsx'
import { SearchHighlights, SearchPanel } from './SearchPanel.tsx'
import { SELECTION_BAR_ITEMS } from './SelectionBarItems.tsx'
import {
  boardCategoryCounts,
  keepOnlyCategory,
  selectAllOfCategory,
  selectionKeepOnlyChoices,
} from './select-by-type.ts'
import {
  applyStartView,
  canSetStartView,
  clearBoardStartView,
  goToStartView,
  persistView,
  readBoardStartView,
  setBoardStartViewToFrame,
  setBoardStartViewToViewport,
} from './start-view.ts'
import { minimapOpen, searchState, setMinimapOpen, startViewResult } from './state.ts'
import { TemplatesPanel } from './TemplatesPanel.tsx'
import { BackToContent, CodeSelectionOutline } from './ViewHelpers.tsx'
import { installCodeSelectionReset } from './view-helpers.ts'
import {
  installWheelZoom,
  typeToEditTarget,
  zoomAtPointer,
  zoomIn,
  zoomOut,
  zoomTo100,
  zoomToFit,
  zoomToSelection,
} from './zoom.ts'
import '../../canvas-ux.css'
import './navigation.css'

export const PANEL = { search: 'search', frames: 'frames', templates: 'templates' } as const

/** Copy for the board settings (honest about what they do and do not do). */
export const START_VIEW_COPY = {
  startViewSet:
    'Start view set. People opening this board for the first time start here; everyone else returns to their own last view.',
  frameStartViewSet:
    'This frame is now the start view. People opening this board for the first time start on it; everyone else returns to their own last view.',
  startViewCleared: 'Start view cleared. First visits now show all content.',
} as const

function notifyBoardSetting(ctx: CanvasFeatureContext, text: string) {
  ctx.notify({ key: 'board-setting', text, testId: 'board-setting-notice', timeoutMs: 7000 })
}

/** Ctrl/Cmd+F: open the search panel, or re-focus its input when it is already open. */
export function openBoardSearch(ctx: CanvasFeatureContext) {
  ctx.openPanel(PANEL.search)
  const s = searchState(ctx.canvas)
  s.set({ ...s.get(), focusTick: s.get().focusTick + 1 })
}

const onlyFrame = (ctx: CanvasFeatureContext): string | null => {
  const sel = ctx.canvas.selection
  if (sel.length !== 1) return null
  const el = ctx.canvas.get(sel[0] as string)
  return el?.type === 'frame' ? el.id : null
}

const COMMANDS: readonly CommandSpec[] = [
  {
    id: 'navigation.board-search',
    label: 'Search board',
    kbd: ['mod+f'],
    scope: 'anywhere',
    readOnlyAllowed: true,
    run: (ctx) => openBoardSearch(ctx),
  },
  {
    id: 'navigation.toggle-minimap',
    label: 'Show / hide minimap',
    kbd: ['m'],
    readOnlyAllowed: true,
    // M on a lone selected note types an "m" into it (type-to-edit, COL-04)
    enabled: (ctx) => !typeToEditTarget(ctx.canvas),
    run: () => setMinimapOpen(!minimapOpen.get()),
  },
  {
    id: 'navigation.zoom-in',
    label: 'Zoom in',
    kbd: ['mod+='],
    readOnlyAllowed: true,
    run: (ctx) => zoomIn(ctx.canvas),
  },
  {
    id: 'navigation.zoom-out',
    label: 'Zoom out',
    kbd: ['mod+-'],
    readOnlyAllowed: true,
    run: (ctx) => zoomOut(ctx.canvas),
  },
  {
    id: 'navigation.zoom-to-100',
    label: 'Zoom to 100%',
    kbd: ['mod+0'],
    readOnlyAllowed: true,
    run: (ctx) => zoomTo100(ctx.canvas),
  },
  {
    id: 'navigation.zoom-to-fit',
    label: 'Zoom to fit',
    kbd: ['alt+1'],
    readOnlyAllowed: true,
    run: (ctx) => zoomToFit(ctx.canvas),
  },
  {
    id: 'navigation.zoom-to-selection',
    label: 'Zoom to selection',
    kbd: ['alt+2'],
    readOnlyAllowed: true,
    run: (ctx) => zoomToSelection(ctx.canvas),
  },
  {
    id: 'navigation.copy-link',
    label: 'Copy link to selection',
    readOnlyAllowed: true,
    run: (ctx) => void copySelectionLink(ctx),
  },
  {
    // MAK-18
    id: 'navigation.arrange-grid',
    label: 'Arrange as grid',
    kbd: ['alt+shift+g'],
    run: (ctx) => void runArrangeAsGrid(ctx),
  },
  {
    // PRE-08
    id: 'navigation.go-to-start-view',
    label: 'Go to start view',
    readOnlyAllowed: true,
    run: (ctx) => void goToStartView(ctx.canvas),
  },
  {
    id: 'navigation.set-start-view',
    label: 'Set current view as start view',
    enabled: canSetStartView,
    run: (ctx) => {
      if (setBoardStartViewToViewport(ctx)) notifyBoardSetting(ctx, START_VIEW_COPY.startViewSet)
    },
  },
  {
    id: 'navigation.set-frame-start-view',
    label: 'Set this frame as start view',
    enabled: (ctx) => canSetStartView(ctx) && onlyFrame(ctx) !== null,
    run: (ctx) => {
      const frame = onlyFrame(ctx)
      if (frame && setBoardStartViewToFrame(ctx, frame))
        notifyBoardSetting(ctx, START_VIEW_COPY.frameStartViewSet)
    },
  },
  {
    id: 'navigation.clear-start-view',
    label: 'Clear start view',
    enabled: canSetStartView,
    run: (ctx) => {
      if (!canSetStartView(ctx)) return
      clearBoardStartView(ctx)
      notifyBoardSetting(ctx, START_VIEW_COPY.startViewCleared)
    },
  },
  {
    // the toolbar's Templates button (3a's toolbar): a button, not a canvas tool; it toggles the picker
    id: 'navigation.open-templates',
    label: 'Templates',
    run: (ctx) => ctx.openPanel(ctx.activePanel === PANEL.templates ? null : PANEL.templates),
  },
]

/** The zoom keys that type a character (they leave a lone selected note to type-to-edit). */
const TYPING_ZOOM_KEYS: readonly { chord: string; run: (ctx: CanvasFeatureContext) => void }[] = [
  { chord: '=', run: (ctx) => zoomIn(ctx.canvas) },
  { chord: '-', run: (ctx) => zoomOut(ctx.canvas) },
  { chord: 'shift+1', run: (ctx) => zoomToFit(ctx.canvas) },
  { chord: 'shift+2', run: (ctx) => zoomToSelection(ctx.canvas) },
  { chord: 'shift+0', run: (ctx) => zoomTo100(ctx.canvas) },
]
/**
 * tldraw's zoom-in/out-on-cursor (Shift+= and Shift+-, with or without Ctrl/Cmd): a step around the
 * pointer. On a US layout Shift+= is the '+' key and Shift+- the '_' key. The Shift-only ones type a
 * character, so they leave a lone selected note to type-to-edit too.
 */
const CURSOR_ZOOM_KEYS: readonly {
  chord: string
  types: boolean
  run: (ctx: CanvasFeatureContext) => void
}[] = [
  { chord: 'shift++', types: true, run: (ctx) => zoomAtPointer(ctx.canvas, 'in') },
  { chord: 'shift+_', types: true, run: (ctx) => zoomAtPointer(ctx.canvas, 'out') },
  { chord: 'mod+shift++', types: false, run: (ctx) => zoomAtPointer(ctx.canvas, 'in') },
  { chord: 'mod+shift+_', types: false, run: (ctx) => zoomAtPointer(ctx.canvas, 'out') },
]
const PLATFORM = currentPlatform()
const PARSED_TYPING_KEYS = TYPING_ZOOM_KEYS.map((k) => ({ ...k, parsed: parseChord(k.chord) }))
const PARSED_CURSOR_KEYS = CURSOR_ZOOM_KEYS.map((k) => ({ ...k, parsed: parseChord(k.chord) }))

/**
 * The keys that still act from the chrome (A11Y2-02, the tldraw page's CHROME_SAFE_ACTIONS): the camera
 * keys and board search. Nothing that changes the board.
 */
const CHROME_KEYS: readonly ChromeKey[] = [
  ...['mod+=', 'mod+-', 'mod+0', 'alt+1', 'alt+2'].map((chord) => ({
    chord,
    run: (ctx: CanvasFeatureContext) => COMMANDS.find((c) => c.kbd?.includes(chord))?.run(ctx, 'kbd'),
  })),
  ...TYPING_ZOOM_KEYS,
  ...CURSOR_ZOOM_KEYS,
  { chord: 'mod+f', run: (ctx) => openBoardSearch(ctx) },
]

const KEYS: readonly FeatureKeySpec[] = [
  {
    id: 'navigation.zoom-typing-keys',
    scope: 'canvas',
    chords: TYPING_ZOOM_KEYS.map((k) => k.chord),
    match: (_e, ctx) => !typeToEditTarget(ctx.canvas),
    handle: (e, ctx) => {
      const k = PARSED_TYPING_KEYS.find((x) => matchChord(x.parsed, e, PLATFORM))
      if (!k) return false
      k.run(ctx)
      return true
    },
  },
  {
    id: 'navigation.zoom-cursor-keys',
    scope: 'canvas',
    chords: CURSOR_ZOOM_KEYS.map((k) => k.chord),
    handle: (e, ctx) => {
      const k = PARSED_CURSOR_KEYS.find((x) => matchChord(x.parsed, e, PLATFORM))
      if (!k || (k.types && typeToEditTarget(ctx.canvas))) return false
      k.run(ctx)
      return true
    },
  },
]

const categoryEntry = (
  prefix: string,
  count: (ctx: CanvasFeatureContext, id: TypeCategory) => number,
  run: (ctx: CanvasFeatureContext, id: TypeCategory) => void,
): MenuEntrySpec[] =>
  TYPE_CATEGORIES.map((c, i) => ({
    id: `${prefix}-${c.id}`,
    group: 'select',
    order: i,
    label: (ctx) => `${categoryLabel(c.id)} (${count(ctx, c.id)})`,
    visible: (ctx) => count(ctx, c.id) > 0,
    run: (ctx) => run(ctx, c.id),
  }))

const pageCount = (ctx: CanvasFeatureContext, id: TypeCategory) =>
  boardCategoryCounts(ctx.canvas).find((c) => c.id === id)?.count ?? 0
const keepCount = (ctx: CanvasFeatureContext, id: TypeCategory) =>
  selectionKeepOnlyChoices(ctx.canvas).find((c) => c.id === id)?.count ?? 0

const CONTEXT_MENU: readonly MenuEntrySpec[] = [
  {
    id: 'navigation.arrange-grid',
    group: 'arrange',
    order: 10,
    label: 'Arrange as grid',
    command: 'navigation.arrange-grid',
    visible: (ctx) => canArrangeAsGrid(ctx.canvas),
  },
  {
    id: 'navigation.set-frame-start-view',
    group: 'arrange',
    order: 20,
    label: 'Set this frame as start view',
    command: 'navigation.set-frame-start-view',
    visible: (ctx) => canSetStartView(ctx) && onlyFrame(ctx) !== null,
  },
  {
    id: 'navigation.select-all-type',
    group: 'select',
    order: 10,
    label: 'Select all on this page',
    visible: (ctx) => boardCategoryCounts(ctx.canvas).length > 0,
    submenu: categoryEntry(
      'navigation.select-all',
      pageCount,
      (ctx, id) => void selectAllOfCategory(ctx, id),
    ),
  },
  {
    id: 'navigation.keep-only',
    group: 'select',
    order: 20,
    label: 'Keep only',
    visible: (ctx) => selectionKeepOnlyChoices(ctx.canvas).length > 0,
    submenu: categoryEntry('navigation.keep-only', keepCount, (ctx, id) => void keepOnlyCategory(ctx, id)),
  },
]

/**
 * The board menu's View submenu (W5-33; tldraw's DefaultMainMenu View group: zoom in, zoom out, 100%, fit,
 * selection), with the minimap toggle.
 */
const VIEW_MENU: readonly MenuEntrySpec[] = [
  { id: 'navigation.view.zoom-in', group: 'view', order: 10, label: '', command: 'navigation.zoom-in' },
  { id: 'navigation.view.zoom-out', group: 'view', order: 20, label: '', command: 'navigation.zoom-out' },
  {
    id: 'navigation.view.zoom-to-100',
    group: 'view',
    order: 30,
    label: '',
    command: 'navigation.zoom-to-100',
  },
  {
    id: 'navigation.view.zoom-to-fit',
    group: 'view',
    order: 40,
    label: '',
    command: 'navigation.zoom-to-fit',
  },
  {
    id: 'navigation.view.zoom-to-selection',
    group: 'view',
    order: 50,
    label: '',
    command: 'navigation.zoom-to-selection',
    disabled: (ctx) => ctx.canvas.selection.length === 0,
  },
  {
    id: 'navigation.view.minimap',
    group: 'view',
    order: 60,
    label: 'Show minimap',
    kbdHint: 'm',
    checked: () => minimapOpen.get(),
    run: () => setMinimapOpen(!minimapOpen.get()),
  },
]

const MAIN_MENU: readonly MenuEntrySpec[] = [
  ...VIEW_MENU,
  {
    id: 'navigation.go-to-start-view',
    group: 'board',
    order: 10,
    label: 'Go to start view',
    command: 'navigation.go-to-start-view',
  },
  {
    id: 'navigation.set-start-view',
    group: 'board',
    order: 20,
    label: 'Set current view as start view',
    command: 'navigation.set-start-view',
    visible: canSetStartView,
  },
  {
    id: 'navigation.clear-start-view',
    group: 'board',
    order: 30,
    label: 'Clear start view',
    command: 'navigation.clear-start-view',
    visible: (ctx) => canSetStartView(ctx) && readBoardStartView(ctx.canvas) !== null,
  },
]

/** The first-view marker (tests and people debugging know the first view is decided) and the paste prompt. */
function NavigationOverlay({ ctx }: { ctx: CanvasFeatureContext }) {
  const startView = useValue('nav-start-view', () => startViewResult(ctx.canvas).get(), [ctx.canvas])
  return (
    <>
      <span data-testid="navigation-overlay" data-start-view={startView ?? undefined} hidden />
      <BulkPastePrompt ctx={ctx} />
      <BackToContent ctx={ctx} />
    </>
  )
}

function mount(ctx: CanvasFeatureContext): () => void {
  const { canvas } = ctx
  const cleanups: (() => void)[] = []
  let live = true
  const readonly = isReadonlyRole(ctx.role, ctx.board.status) || canvas.readOnly()
  void applyStartView(ctx, {
    boardId: ctx.board.id,
    userId: ctx.me.user.id,
    canEdit: !readonly,
    hold: (dispose) => (live ? cleanups.push(dispose) : dispose()),
    // LEAD-2: the param stays in the address bar until the template is in, so a reload retries; so does this
    onTemplateFailed: (retry) =>
      ctx.notify({
        key: 'template-insert',
        tone: 'error',
        text: 'The template could not be added to this board.',
        testId: 'template-insert-failed',
        action: { label: 'Try again', testId: 'template-insert-retry', onClick: () => void retry() },
      }),
  })
    .then(
      (did) => {
        if (live) startViewResult(canvas).set(did)
      },
      (e) => {
        console.error('navigation: start view failed', e)
        if (live) startViewResult(canvas).set('failed')
      },
    )
    // this user's camera is kept from the first view on (never the camera the board opened with)
    .then(() => {
      if (live) cleanups.push(persistView(canvas, ctx.board.id, ctx.me.user.id))
    })
  cleanups.push(installNavigationDevHook(ctx))
  // the zoom wheel below Excalidraw's 0.1 (CR 3b-2) and the camera keys from the chrome (A11Y2-02)
  cleanups.push(installWheelZoom(canvas), installChromeKeys(ctx, CHROME_KEYS))
  // W5-39: the outline of a connector selected by a deep link or a search result lasts as long as that selection
  cleanups.push(installCodeSelectionReset(canvas))
  return () => {
    live = false
    for (const c of cleanups.reverse()) c()
    startViewResult(canvas).set(null)
  }
}

export const feature: CanvasFeature = {
  id: 'navigation',
  panels: [
    {
      id: PANEL.search,
      label: 'Search board',
      icon: SearchIcon,
      shortcutHint: 'mod+f',
      order: 10,
      component: SearchPanel,
    },
    { id: PANEL.frames, label: 'Frames', icon: FramesIcon, order: 20, component: FramesPanel },
    {
      id: PANEL.templates,
      label: 'Templates',
      icon: TemplatesIcon,
      order: 30,
      visible: (ctx) => !isReadonlyRole(ctx.role, ctx.board.status),
      component: TemplatesPanel,
    },
  ],
  commands: COMMANDS,
  keys: KEYS,
  contextMenu: CONTEXT_MENU,
  mainMenu: MAIN_MENU,
  selectionBar: SELECTION_BAR_ITEMS,
  overlays: [
    { id: 'navigation.search-dim', layer: 'scene', order: 5, pointer: 'none', component: SearchHighlights },
    {
      id: 'navigation.code-selection',
      layer: 'scene',
      order: 6,
      pointer: 'none',
      component: CodeSelectionOutline,
    },
    { id: 'navigation.overlay', layer: 'screen', order: 30, pointer: 'auto', component: NavigationOverlay },
  ],
  slots: { navigation: NavigationPanel },
  contentHandlers: [BULK_PASTE_HANDLER],
  onMount: mount,
}
