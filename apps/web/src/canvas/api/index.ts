/**
 * The ONE module ported feature code imports from the canvas (docs/EXCALIDRAW-CONTRACTS.md §1): the
 * feature-facing canvas API, the registries, the feature contract and the pure helpers. It carries no
 * engine code (a Biome rule keeps `@excalidraw/*` out of `features/**`); the implementation behind it is
 * `./impl.ts` (2C), created by the board page. Frozen at wave 1.
 */

export type { KeyEventLike } from '../registries.ts'
export type { CanvasFeature, CanvasFeatureContext, KeyClaim } from './feature.ts'
export {
  CanvasFeatureContextProvider,
  collectKeyClaims,
  installCanvasFeatures,
  keyConflicts,
  useCanvasFeatureContext,
} from './feature.ts'
export * as geometry from './geometry.ts'
export * as items from './items.ts'
export type { KeyChord, ParsedChord, Platform } from './keys.ts'
export { currentPlatform, formatChord, matchChord, parseChord } from './keys.ts'
export type {
  Bounds,
  BuiltInTool,
  CameraMove,
  CanvasChange,
  CanvasElement,
  CanvasGesture,
  CanvasInputEvent,
  CanvasTx,
  ChangeSource,
  DocKey,
  EditOptions,
  EditVia,
  ExportOptions,
  HitTestOptions,
  InputModifiers,
  ItemKind,
  LeaseHolder,
  LobbyCanvas,
  LobbyCanvasEventMap,
  LobbyDoc,
  LobbyExport,
  LobbyFiles,
  LobbyFollow,
  LobbyHistory,
  LobbyItemKind,
  LobbyPresence,
  LobbySettings,
  LobbyStyles,
  LobbyText,
  LobbyTx,
  LobbyViewport,
  MixedStyles,
  PointerState,
  RemoteCursor,
  ReorderTo,
  RosterEntry,
  ScenePoint,
  ScreenPoint,
  StyleValues,
  TextStyle,
  ToolName,
  TransactOptions,
  Viewport,
  ZoomLimits,
  ZoomToOptions,
} from './lobby-canvas.ts'
export { BUILT_IN_TOOLS, CAMERA_ANIMATION_MS, SINGLE_PAGE_ID } from './lobby-canvas.ts'
export type { Owner } from './owners.ts'
export { isOwner, NotImplementedError, OWNERS } from './owners.ts'
export type {
  CanvasPanelSpec,
  CommandSource,
  CommandSpec,
  ContentHandlerSpec,
  ExternalContent,
  FeatureKeySpec,
  FeatureOverlaySpec,
  FeatureRegistries,
  FeatureToolSpec,
  HostSlotEntry,
  HostSlotName,
  MenuEntrySpec,
  MenuGroup,
  MenuTarget,
  Provider,
  SelectionBarItemSpec,
  ToolPointerEvent,
  TopBarItemSpec,
} from './registries.ts'
export { createFeatureRegistries, HOST_SLOTS, MENU_GROUPS } from './registries.ts'
