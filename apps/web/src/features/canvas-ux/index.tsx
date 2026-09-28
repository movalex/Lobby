// Feature module: canvas-ux (docs/FEATURES-M2-CONTRACTS.md). Miro-style canvas behaviour on tldraw 5.4.2:
// keyboard parity, alignment guides on by default, type-to-edit notes, bulk paste as notes, Draftroom's
// note palette, the main toolbar + Templates picker, minimap on M, frame outline, board search, copy
// link to a selection/frame, and the start view (last camera, else fit content). Also: sans as the
// default font (RETRO-21a), double-click empty canvas = new note (RETRO-21b), a hint on locked shapes
// (F8), and the Hand tool for read-only people on touch devices (PRI-13). Second wave: arrange as grid
// (MAK-18), select by type / keep only (MAK-17), the board menu's "Hide note authors" (FAC-07 partial)
// and an owner-set start view (PRE-08).

import { DefaultFontStyle, getUserPreferences } from 'tldraw'
import { isReadonlyRole } from '../../board/access.ts'
import type { BoardFeature, FeatureContext } from '../types.ts'
import { setFeatureCtx, startViewResult } from './bridge.ts'
import { registerBulkPaste } from './bulk-paste-handler.ts'
import { DraftroomContextMenu } from './ContextMenu.tsx'
import { registerDoubleClickNote } from './dblclick-note.ts'
import {
  CAMERA_MOVING_TIMEOUT_MS,
  fontDefaultPatch,
  MAX_SHAPES_PER_PAGE,
  snapDefaultPatch,
  startToolFor,
} from './defaults.ts'
import { FramesPanel } from './FramesPanel.tsx'
import { FramesIcon, SearchIcon, TemplatesIcon } from './icons.tsx'
import { installCanvasKeyboard } from './keyboard.ts'
import { registerLockedHint } from './locked-hint-runtime.ts'
import { DraftroomMainMenu } from './MainMenu.tsx'
import { DraftroomNavigationPanel } from './NavigationPanel.tsx'
import { applyNotePalette, CanvasUxOverlay } from './Overlay.tsx'
import { canvasUxOverrides, openBoardSearch, PANEL } from './overrides.tsx'
import { SearchPanel } from './SearchPanel.tsx'
import { DraftroomShortcutsDialog } from './ShortcutsDialog.tsx'
import { DraftroomStylePanel } from './StylePanel.tsx'
import { kbdLabel, NEW_ACTION_KBDS } from './shortcuts.ts'
import { applyStartView, persistCamera } from './start-view-runtime.ts'
import { TemplatesPanel } from './TemplatesPanel.tsx'
import { DraftroomToolbar } from './Toolbar.tsx'
import './canvas-ux.css'

const IS_MAC = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform)

const isModalOpen = () => document.querySelector('dialog[open], .tlui-dialog__overlay') !== null

/** A touch-first device: its primary pointer is coarse (phones, tablets; not a touchscreen laptop). */
const isCoarsePrimaryPointer = () =>
  typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    ? window.matchMedia('(pointer: coarse)').matches
    : false

function mount(ctx: FeatureContext): () => void {
  const { editor } = ctx
  setFeatureCtx(editor, ctx)
  applyNotePalette(editor)

  const snap = snapDefaultPatch(getUserPreferences())
  if (snap) editor.user.updateUserPreferences(snap)
  const font = fontDefaultPatch(editor.getInstanceState().stylesForNextShape)
  if (font) editor.setStyleForNextShapes(DefaultFontStyle, font, { history: 'ignore' })

  const readonly = isReadonlyRole(ctx.role, ctx.board.status)
  const cleanups: (() => void)[] = []
  cleanups.push(installCanvasKeyboard(editor, { onBoardSearch: () => openBoardSearch(editor), isModalOpen }))
  cleanups.push(registerBulkPaste(editor))
  cleanups.push(registerDoubleClickNote(editor))
  cleanups.push(registerLockedHint(editor))
  const startTool = startToolFor({ coarsePointer: isCoarsePrimaryPointer(), readonly })
  if (startTool && editor.getCurrentToolId() === 'select') editor.setCurrentTool(startTool)

  let startView = 'failed'
  try {
    startView = applyStartView(editor, {
      boardId: ctx.board.id,
      userId: ctx.me.user.id,
      canEdit: !readonly,
      hold: (dispose) => cleanups.push(dispose),
      onTemplateFailed: () =>
        ctx.notify({
          key: 'template-insert',
          tone: 'error',
          text: 'The template could not be added to this board.',
        }),
    })
  } catch (e) {
    console.error('canvas-ux: start view failed', e)
  }
  cleanups.push(persistCamera(editor, ctx.board.id, ctx.me.user.id))
  // Last: everything above (keys, paste, snap default, first view) is in place once this is set.
  startViewResult(editor).set(startView)

  return () => {
    for (const c of cleanups.reverse()) c()
    startViewResult(editor).set(null)
  }
}

export const canvasUxFeature: BoardFeature = {
  id: 'canvas-ux',
  panels: [
    {
      id: PANEL.search,
      label: 'Search board',
      icon: <SearchIcon />,
      shortcutHint: kbdLabel(NEW_ACTION_KBDS['dr-board-search'], IS_MAC),
      Component: SearchPanel,
    },
    {
      id: PANEL.frames,
      label: 'Frames',
      icon: <FramesIcon />,
      Component: FramesPanel,
    },
    {
      id: PANEL.templates,
      label: 'Templates',
      icon: <TemplatesIcon />,
      visible: (ctx) => !isReadonlyRole(ctx.role, ctx.board.status),
      Component: TemplatesPanel,
    },
  ],
  Overlay: CanvasUxOverlay,
  overrides: canvasUxOverrides,
  components: {
    Toolbar: DraftroomToolbar,
    ContextMenu: DraftroomContextMenu,
    MainMenu: DraftroomMainMenu,
    NavigationPanel: DraftroomNavigationPanel,
    StylePanel: DraftroomStylePanel,
    KeyboardShortcutsDialog: DraftroomShortcutsDialog,
  },
  options: {
    maxShapesPerPage: MAX_SHAPES_PER_PAGE,
    // PERF-04: one slow frame no longer ends the camera's "moving" state mid-gesture.
    cameraMovingTimeoutMs: CAMERA_MOVING_TIMEOUT_MS,
    // RETRO-21b: double-click on empty canvas makes a note (dblclick-note.ts), not a text box.
    createTextOnCanvasDoubleClick: false,
  },
  onMount: mount,
}
