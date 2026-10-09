/**
 * The feature registries (docs/EXCALIDRAW-CONTRACTS.md §3): spike B's `CanvasRegistries` (../registries.ts,
 * frozen at C0: keys, overlays, pointer tools, customData handlers, UI slots, the hit guard, hidden ids,
 * the dragger) plus the extension points that replace tldraw's `TLUiOverrides`, `TLComponents` and
 * `TldrawOptions`: commands, menus (context and board), the selection bar, dock panels, top-bar items,
 * host slots, paste/drop handlers, the cursor filter and the menu state. Frozen at wave 1.
 *
 * A feature never edits a shared file to add a key, a menu entry, a tool, an overlay or a panel: it
 * declares it on its `CanvasFeature` (./feature.ts) or registers it here in `onMount`.
 *
 * Registries keep insertion order; lists sort by `order` (then id) where the entry has one. A host slot
 * has ONE provider: a second provider for a taken slot is refused (a dev error, reported on the console)
 * until the first unregisters.
 */
import type { ComponentType } from 'react'
import type { CanvasElement, ScenePoint } from '../port.ts'
import { type CanvasRegistries, createRegistries, type KeyEventLike, type Registry } from '../registries.ts'
// type-only: ./feature.ts imports this file at run time, not the other way round
import type { CanvasFeatureContext } from './feature.ts'
import type { KeyChord } from './keys.ts'
import type { Owner } from './owners.ts'

export type { KeyEventLike, Registry }

// ---- commands (tldraw's `overrides.actions`) ----------------------------------------------------------------

/** Where a command was started from (tldraw's TLUiEventSource). */
export type CommandSource = 'kbd' | 'menu' | 'context-menu' | 'toolbar' | 'selection-bar' | 'dock' | 'api'

export interface CommandSpec {
  /** unique across features, e.g. 'canvas-ux.select-all', 'comments.add' */
  readonly id: string
  readonly label: string
  /** shortcuts; each is also a Lobby-owned key (the key allowlist delegates nothing else) */
  readonly kbd?: readonly KeyChord[]
  /** `canvas`: the board has the keyboard and no text editor is open; `editor`: inside a granted editor */
  readonly scope?: 'canvas' | 'editor' | 'anywhere'
  /** read-only roles may run it (default false) */
  readonly readOnlyAllowed?: boolean
  enabled?(ctx: CanvasFeatureContext): boolean
  /**
   * Wave K.1: false when the command is not offered on this device at all (no row in the shortcuts dialog, its
   * keys do nothing): what it needs is missing (cursor chat on a touch screen with no cursor). Default: offered.
   */
  available?(ctx: CanvasFeatureContext): boolean
  run(ctx: CanvasFeatureContext, source: CommandSource): void | Promise<void>
}

// ---- keys (Lobby-owned keys, §2.3.3) ----------------------------------------------------------------------

/**
 * A Lobby-owned key handled in the capture-phase allowlist listener (a feature's `KeyHandlerSpec` with
 * the feature context). Prefer a command with `kbd`; use this for keys with state (type-to-edit, mind-map
 * Tab/Enter, Space-drag) or when `match` needs more than a chord.
 */
export interface FeatureKeySpec {
  readonly id: string
  readonly scope: 'canvas' | 'editor'
  /** the chords it claims (the keyboard-map test and the shortcuts dialog read these) */
  readonly chords: readonly KeyChord[]
  /**
   * CR-3A-9 (3c's request): the pointer tool this key belongs to ('comment'). It acts only while that tool is on
   * (checked before `match`), and its claim carries the tool (`KeyClaim.tool`): it is checked against the
   * claims under the same tool, not reported as a conflict with every other claim of its chord.
   */
  readonly tool?: string
  /**
   * Wave K.1: characters it claims by `KeyboardEvent.key`, whatever the key's code and Shift, with no Ctrl, Meta
   * or Alt (AltGr, which Windows reports as Ctrl+Alt, types a character and counts): a key some layouts put on
   * Shift (German Shift+7 types '/'), which a chord (matched on the code for digits and letters) cannot name.
   * A character claim is not a chord claim: list the plain chord on a command (or in `chords`) for the dialog.
   */
  readonly chars?: readonly string[]
  /** a finer test than the chords (the chords must still list every key it can claim) */
  match?(e: KeyEventLike, ctx: CanvasFeatureContext): boolean
  /** true when it acted (the event is then stopped and prevented) */
  handle(e: KeyEventLike, ctx: CanvasFeatureContext): boolean
}

/**
 * CR-3D-3: "a printable key on this selection starts editing it", for elements the allowlist's own
 * type-to-edit (sticky notes) does not cover (a mind-map topic). Asked by the input layer
 * (canvas/input/CanvasInput.ts) when exactly one unlocked element is selected and a printable key goes
 * down: `applies` says whether this feature takes it, `start` starts the edit with that first key and
 * returns false to leave it to the generic lease flow. Tool letters and other keys come after, as for notes.
 */
export interface TypeToEditSpec {
  readonly id: string
  applies(elementId: string): boolean
  start(elementId: string, key: string): boolean
}

// ---- pointer tools (tldraw's StateNode tools, `root.addChild`) --------------------------------------------------

export interface ToolPointerEvent {
  readonly point: ScenePoint
  /** the topmost element under the point (the hit guard applied), or null */
  readonly hit: CanvasElement | null
  readonly shiftKey: boolean
  readonly altKey: boolean
}

export interface FeatureToolSpec {
  /** the Lobby tool name `LobbyCanvas.setTool` takes ('comment', 'vote', 'open-card') */
  readonly id: string
  readonly label: string
  readonly kbd?: readonly KeyChord[]
  /** commenters, viewers and limited guests may use it (comments, votes, open-card) */
  readonly readOnlyAllowed: boolean
  readonly cursor?: string
  /** a toolbar button (3a's toolbar reads it); omit for tools started only by other UI */
  readonly toolbar?: { readonly group: 'main' | 'more'; readonly order: number; readonly icon: ComponentType }
  onPointerDown?(e: ToolPointerEvent, ctx: CanvasFeatureContext): void
  onPointerUp?(e: ToolPointerEvent, ctx: CanvasFeatureContext): void
  onDoubleClick?(e: ToolPointerEvent, ctx: CanvasFeatureContext): void
  /** Escape or another tool (tldraw's onExit) */
  onExit?(ctx: CanvasFeatureContext): void
}

// ---- menus (tldraw's DefaultContextMenu / DefaultMainMenu components and TldrawUiMenu*) --------------------------

/** What a menu acts on: the selection when it opened, where it opened, what was under the pointer. */
export interface MenuTarget {
  readonly ids: readonly string[]
  readonly point: ScenePoint | null
  readonly hit: CanvasElement | null
}

/** Group buckets, rendered in this order with separators between non-empty groups. */
export const MENU_GROUPS = [
  'clipboard',
  'edit',
  'arrange',
  'select',
  'frame',
  'collaborate',
  'workshop',
  'organize',
  'ai',
  'view',
  'board',
  'export',
  'danger',
] as const
export type MenuGroup = (typeof MENU_GROUPS)[number]

export interface MenuEntrySpec {
  readonly id: string
  readonly group: MenuGroup
  readonly order: number
  readonly label: string | ((ctx: CanvasFeatureContext, target: MenuTarget) => string)
  /** runs this command (its label and kbd are shown unless given here) */
  readonly command?: string
  readonly kbdHint?: KeyChord
  visible?(ctx: CanvasFeatureContext, target: MenuTarget): boolean
  disabled?(ctx: CanvasFeatureContext, target: MenuTarget): boolean
  checked?(ctx: CanvasFeatureContext, target: MenuTarget): boolean
  run?(ctx: CanvasFeatureContext, target: MenuTarget): void | Promise<void>
  /** a submenu instead of an action */
  readonly submenu?: readonly MenuEntrySpec[]
  /** a custom row (a colour row, a tag picker), rendered inside the menu's list */
  readonly component?: ComponentType<{ readonly ctx: CanvasFeatureContext; readonly target: MenuTarget }>
}

// ---- selection bar (canvas-ux's SelectionBar and the buttons AI and tags add to it) ----------------------------

export interface SelectionBarItemSpec {
  readonly id: string
  readonly order: number
  visible?(ctx: CanvasFeatureContext, selection: readonly string[]): boolean
  readonly component: ComponentType<{
    readonly ctx: CanvasFeatureContext
    readonly selection: readonly string[]
  }>
}

// ---- dock panels and the top bar (features/types.ts FeaturePanel, TopBarItem) --------------------------------

export interface CanvasPanelSpec {
  /** unique across features ('comments', 'search', 'voting', …) */
  readonly id: string
  readonly label: string
  readonly icon: ComponentType
  readonly shortcutHint?: KeyChord
  readonly order: number
  visible?(ctx: CanvasFeatureContext): boolean
  readonly component: ComponentType<{ readonly ctx: CanvasFeatureContext; close(): void }>
}

export interface TopBarItemSpec {
  readonly id: string
  readonly order: number
  /** stays in the bar on narrow screens (PRI-02); others move into the "⋯" menu */
  readonly pinned?: boolean
  /** the caption above it inside the "⋯" menu */
  readonly overflowCaption?: string
  readonly component: ComponentType<{ readonly ctx: CanvasFeatureContext }>
}

// ---- overlays (tldraw's `Overlay` children of <Tldraw>, InFrontOfTheCanvas, ShapeWrapper, CollaboratorCursor) ----

/**
 * A layer of the overlay root above the canvas. `scene` layers hold things pinned to elements (comment
 * pins, vote badges, tag chips, "X is typing") and position them with `LobbyCanvas.sceneToOverlay`;
 * `screen` layers hold fixed chrome over the canvas (the presenter bar, the AI menu). Higher `order`
 * draws on top. `pointer: 'none'` layers never take clicks (the default for `scene`).
 */
export interface FeatureOverlaySpec {
  readonly id: string
  readonly layer: 'scene' | 'screen'
  readonly order: number
  readonly pointer?: 'none' | 'auto'
  /**
   * In focus mode (settings.focusMode: presenting, a focused view) the board page hides its chrome and
   * every layer except those that say `show` (the presenter bar, the live-follow banner). Default `hide`.
   */
  readonly focusMode?: 'show' | 'hide'
  readonly component: ComponentType<{ readonly ctx: CanvasFeatureContext }>
}

// ---- host slots (single-provider chrome the board page renders at fixed places) ------------------------------

/**
 * Host slots and their owners: exactly one component each (§3.5). The board page (2C) renders each slot
 * where the tldraw component of the same job was.
 */
export const HOST_SLOTS = {
  /** the main tool bar (tldraw Toolbar) */
  toolbar: '3a',
  /** the style panel (tldraw StylePanel) */
  stylePanel: '3a',
  /** the context-menu shell that renders `contextMenu` entries (tldraw ContextMenu) */
  contextMenu: '3a',
  /** the board-menu shell that renders `mainMenu` entries (tldraw MainMenu) */
  mainMenu: '3a',
  /** the keyboard shortcuts dialog, from the command, key and tool registries (tldraw KeyboardShortcutsDialog) */
  shortcutsDialog: '3a',
  /** the selection-bar shell that renders `selectionBar` items (canvas-ux Overlay's SelectionBar) */
  selectionBar: '3a',
  /** minimap and zoom controls (tldraw NavigationPanel) */
  navigation: '3b',
  /** the phone sheet (spike B slot `sheet`) */
  phoneSheet: '3i',
  /** the accessible live region announcing selection and focus (§4.8) */
  liveRegion: '3i',
} as const satisfies Record<string, Owner>
export type HostSlotName = keyof typeof HOST_SLOTS

export interface HostSlotEntry {
  /** the providing feature */
  readonly featureId: string
  readonly component: ComponentType<{ readonly ctx: CanvasFeatureContext }>
}

// ---- paste and drop (tldraw's registerExternalContentHandler / putExternalContent) ----------------------------

export type ExternalContent =
  | { readonly kind: 'files'; readonly files: readonly File[] }
  | { readonly kind: 'text'; readonly text: string; readonly html?: string }
  | { readonly kind: 'url'; readonly url: string }

export interface ContentHandlerSpec {
  readonly id: string
  readonly kinds: readonly ExternalContent['kind'][]
  /** higher runs first; the first handler that returns true takes the content */
  readonly priority: number
  handle(
    content: ExternalContent,
    ctx: CanvasFeatureContext,
    at: ScenePoint | null,
    source: 'paste' | 'drop' | 'insert',
  ): boolean | Promise<boolean>
}

// ---- single-provider functions -------------------------------------------------------------------------------

export interface Provider<F extends (...args: never[]) => unknown> {
  provide(fn: F): () => void
  /** the provided function's answer, or the fallback's */
  readonly call: F
}

// ---- the registries -----------------------------------------------------------------------------------------

export interface FeatureRegistries extends CanvasRegistries {
  readonly commands: Registry<CommandSpec>
  readonly featureKeys: Registry<FeatureKeySpec>
  /** CR-3D-3: elements a printable key starts editing besides sticky notes (see TypeToEditSpec) */
  readonly typeToEdit: Registry<TypeToEditSpec>
  readonly tools: Registry<FeatureToolSpec>
  readonly contextMenu: Registry<MenuEntrySpec>
  readonly mainMenu: Registry<MenuEntrySpec>
  readonly selectionBar: Registry<SelectionBarItemSpec>
  readonly panels: Registry<CanvasPanelSpec>
  readonly topBar: Registry<TopBarItemSpec>
  readonly featureOverlays: Registry<FeatureOverlaySpec>
  readonly contentHandlers: Registry<ContentHandlerSpec>
  readonly hostSlots: {
    /** refused (returns a no-op and logs) when the slot already has a provider */
    provide(slot: HostSlotName, entry: HostSlotEntry): () => void
    get(slot: HostSlotName): HostSlotEntry | null
  }
  /**
   * whether a remote cursor is drawn (present mode and "hide cursors" say no); default: shown. Several
   * features may provide at once (3e present mode, 3f "Hide everyone's cursors"): a cursor is drawn only
   * when every provider says yes, and each `provide` returns its own undo (CR-3F-5 / CR 3E-3, W3-4).
   */
  readonly cursorVisible: Provider<(sid: string) => boolean>
  /** whether a Lobby menu or popover is open (tldraw's `menus.hasAnyOpenMenus`); 3a provides */
  readonly menusOpen: Provider<() => boolean>
  /** entries sorted for rendering: by `order`, then id */
  sorted<T extends { readonly id: string; readonly order: number }>(registry: Registry<T>): readonly T[]
}

function createRegistry<T extends { readonly id: string }>(changed: () => void): Registry<T> {
  const entries = new Map<string, T>()
  return {
    register(entry) {
      entries.set(entry.id, entry)
      changed()
      return () => {
        if (entries.get(entry.id) === entry) {
          entries.delete(entry.id)
          changed()
        }
      }
    },
    list: () => [...entries.values()],
    get: (id) => entries.get(id),
  }
}

function createProvider<F extends (...args: never[]) => unknown>(
  fallback: F,
  changed: () => void,
): Provider<F> {
  let current: F | null = null
  return {
    provide(fn) {
      current = fn
      changed()
      return () => {
        if (current === fn) {
          current = null
          changed()
        }
      }
    },
    call: ((...args: Parameters<F>) => (current ?? fallback)(...args)) as F,
  }
}

/**
 * A filter every provider contributes to: `call` is true only when all of them say yes (true with none).
 * `provide` adds a provider and returns its own removal (CR-3F-5 / CR 3E-3).
 */
function createAllProvider<A extends unknown[]>(changed: () => void): Provider<(...args: A) => boolean> {
  const providers: ((...args: A) => boolean)[] = []
  return {
    provide(fn) {
      providers.push(fn)
      changed()
      let on = true
      return () => {
        if (!on) return
        on = false
        const i = providers.indexOf(fn)
        if (i >= 0) providers.splice(i, 1)
        changed()
      }
    },
    call: (...args: A) => providers.every((p) => p(...args)),
  }
}

/** A fresh set of feature registries for one board page (the C0 registries included). */
export function createFeatureRegistries(): FeatureRegistries {
  const core = createRegistries()
  // one change signal for both halves: the core's subscribers hear the new registries too
  const listeners = new Set<() => void>()
  const changed = () => {
    for (const l of [...listeners]) l()
  }
  core.subscribe(changed)
  const slots = new Map<HostSlotName, HostSlotEntry>()
  return {
    ...core,
    commands: createRegistry<CommandSpec>(changed),
    featureKeys: createRegistry<FeatureKeySpec>(changed),
    typeToEdit: createRegistry<TypeToEditSpec>(changed),
    tools: createRegistry<FeatureToolSpec>(changed),
    contextMenu: createRegistry<MenuEntrySpec>(changed),
    mainMenu: createRegistry<MenuEntrySpec>(changed),
    selectionBar: createRegistry<SelectionBarItemSpec>(changed),
    panels: createRegistry<CanvasPanelSpec>(changed),
    topBar: createRegistry<TopBarItemSpec>(changed),
    featureOverlays: createRegistry<FeatureOverlaySpec>(changed),
    contentHandlers: createRegistry<ContentHandlerSpec>(changed),
    hostSlots: {
      provide(slot, entry) {
        const taken = slots.get(slot)
        if (taken) {
          console.error(
            `host slot "${slot}" already has a provider (${taken.featureId}); ${entry.featureId} refused (owner: ${HOST_SLOTS[slot]})`,
          )
          return () => {}
        }
        slots.set(slot, entry)
        changed()
        return () => {
          if (slots.get(slot) === entry) {
            slots.delete(slot)
            changed()
          }
        }
      },
      get: (slot) => slots.get(slot) ?? null,
    },
    cursorVisible: createAllProvider<[sid: string]>(changed),
    menusOpen: createProvider<() => boolean>(() => false, changed),
    sorted: (registry) =>
      [...registry.list()].sort((a, b) => a.order - b.order || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
}
