// The board feature-module contract (docs/FEATURES-M2-CONTRACTS.md). Each feature lives in
// apps/web/src/features/<id>/ and exports one BoardFeature; features/registry.ts lists them.
// Features never edit BoardPage/TopBar: they contribute through these slots.

import type { Board, Me } from '@draftroom/contracts'
import type { ComponentType, ReactNode } from 'react'
import type { Editor, TLComponents, TLUiOverrides, TldrawOptions } from 'tldraw'
import type { ApiClient } from '../api/client.ts'
import type { NoticeInput } from '../board/board-context.ts'
import type { BoardRole } from '../lib/permissions.ts'
import type { BoardEvents } from './events.ts'

export interface FeatureContext {
  editor: Editor
  board: Board
  /** Caller's current role (UI hints only — the servers enforce). */
  role: BoardRole
  me: Me
  workspace: { id: string; name: string }
  api: ApiClient
  events: BoardEvents
  notify(n: NoticeInput): void
  dismiss(key: string): void
  /** Open (or focus) a dock panel by id; `null` closes the dock. */
  openPanel(panelId: string | null): void
  /** The currently open dock panel id, if any. */
  activePanel: string | null
}

export interface FeaturePanel {
  /** Unique across all features, e.g. 'comments', 'search'. */
  id: string
  label: string
  /** A small inline SVG or text glyph for the dock rail. */
  icon: ReactNode
  /** Shown in the rail tooltip, e.g. 'Ctrl+F'. Wiring the key is the feature's job (overrides). */
  shortcutHint?: string
  /** Hide the panel for some roles/boards (e.g. history for viewers). */
  visible?(ctx: FeatureContext): boolean
  Component: ComponentType<{ ctx: FeatureContext; close(): void }>
}

export interface BoardFeature {
  id: string
  /** Dock panels (left rail). */
  panels?: FeaturePanel[]
  /** Compact controls in the board top bar (before Share). Keep to one small button/pill each. */
  TopBarItem?: ComponentType<{ ctx: FeatureContext }>
  /**
   * Rendered as children of <Tldraw> (inside the editor + UI contexts, so useEditor/useValue work):
   * canvas overlays such as comment pins, vote dots, presentation chrome.
   */
  Overlay?: ComponentType<{ ctx: FeatureContext }>
  /** Merged in registry order (tldraw accepts an array). */
  overrides?: TLUiOverrides
  /** Shallow-merged into <Tldraw components>; later features win on conflicts — avoid overlaps. */
  components?: Partial<TLComponents>
  /** Shallow-merged into <Tldraw options> (e.g. maxShapesPerPage). */
  options?: Partial<TldrawOptions>
  /** After the editor mounts; return a cleanup. */
  onMount?(ctx: FeatureContext): void | (() => void)
}
