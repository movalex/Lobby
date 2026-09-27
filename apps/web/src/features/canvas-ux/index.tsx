// Feature module: canvas-ux (docs/FEATURES-M2-CONTRACTS.md). Miro-style canvas behaviour on tldraw 5.4.2:
// keyboard parity, alignment guides on by default, type-to-edit notes, bulk paste as notes, Draftroom's
// note palette, the main toolbar + Templates picker, minimap on M, frame outline, board search, copy
// link to a selection/frame, and the start view (last camera, else fit content).

import { getUserPreferences } from 'tldraw'
import { isReadonlyRole } from '../../board/access.ts'
import type { BoardFeature, FeatureContext } from '../types.ts'
import { setFeatureCtx } from './bridge.ts'
import { registerBulkPaste } from './bulk-paste-handler.ts'
import { MAX_SHAPES_PER_PAGE, snapDefaultPatch } from './defaults.ts'
import { FramesPanel } from './FramesPanel.tsx'
import { FramesIcon, SearchIcon, TemplatesIcon } from './icons.tsx'
import { installCanvasKeyboard } from './keyboard.ts'
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

function mount(ctx: FeatureContext): () => void {
  const { editor } = ctx
  setFeatureCtx(editor, ctx)
  applyNotePalette(editor)

  const snap = snapDefaultPatch(getUserPreferences())
  if (snap) editor.user.updateUserPreferences(snap)

  const cleanups: (() => void)[] = []
  cleanups.push(installCanvasKeyboard(editor, { onBoardSearch: () => openBoardSearch(editor), isModalOpen }))
  cleanups.push(registerBulkPaste(editor))

  try {
    applyStartView(editor, {
      boardId: ctx.board.id,
      userId: ctx.me.user.id,
      canEdit: !isReadonlyRole(ctx.role, ctx.board.status),
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

  return () => {
    for (const c of cleanups.reverse()) c()
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
    NavigationPanel: DraftroomNavigationPanel,
    StylePanel: DraftroomStylePanel,
    KeyboardShortcutsDialog: DraftroomShortcutsDialog,
  },
  options: { maxShapesPerPage: MAX_SHAPES_PER_PAGE },
  onMount: mount,
}
