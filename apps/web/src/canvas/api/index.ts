/**
 * The ONE module ported feature code imports from the canvas (docs/EXCALIDRAW-CONTRACTS.md §1): the
 * feature-facing canvas API, the registries, the feature contract and the pure helpers. It carries no
 * engine code (a Biome rule keeps `@excalidraw/*` out of `features/**`); the implementation behind it is
 * `./impl.ts` (2C), created by the board page. Frozen at wave 1.
 */

// Wave L (W3, L3-1): the wave L key claims table (pure data; the allowlist itself stays canvas/input's)
export {
  WAVE_L_CONTEXTUAL_KEYS,
  WAVE_L_KEY_CLAIMS,
  type WaveLKeyClaim,
  type WaveLKeyClaimSpec,
} from '../input/keymap.ts'
// CR-3H-1: the checkpoint preview's types (see loadCheckpointPreview at the end)
export type { CheckpointPreviewHandle, CheckpointPreviewInput } from '../preview/index.ts'
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
  ArrowKind,
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
  FollowCamera,
  FollowCameraInput,
  FollowOptions,
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
  LobbyRoom,
  LobbySettings,
  LobbySettingsValues,
  LobbyStyles,
  LobbyText,
  LobbyTx,
  LobbyViewport,
  MixedStyles,
  PointerState,
  RemoteCursor,
  ReorderTo,
  RosterEntry,
  SceneIndex,
  ScenePoint,
  ScreenPoint,
  StyleValues,
  TextStyle,
  ToolName,
  TouchPinch,
  TransactOptions,
  Viewport,
  WheelPreference,
  ZoomLimits,
  ZoomToOptions,
} from './lobby-canvas.ts'
export { BUILT_IN_TOOLS, CAMERA_ANIMATION_MS, SINGLE_PAGE_ID, WHEEL_PREFERENCES } from './lobby-canvas.ts'
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
  TypeToEditSpec,
} from './registries.ts'
export { commandRunnable, createFeatureRegistries, HOST_SLOTS, MENU_GROUPS } from './registries.ts'
// CR-3H-1 (3h, wave 3): the checkpoint preview (canvas/preview/**, 3h's; plan §4.6): a read-only bitmap of
// a checkpoint's elements drawn with the engine's exporter and Lobby's own pan and zoom, never a second
// editor. A checkpoint is not the live scene, so `LobbyCanvas.export.canvas` (live items) cannot draw it.
// Loaded on first use; the History panel is its only caller.
export const loadCheckpointPreview = () => import('../preview/index.ts').then((m) => m.mountCheckpointPreview)
// CR-3A-4 follow-up: the words a read-only role copies from the selection (canvas/board/copy-text.ts, pure),
// so canvas-ux's menus can offer Copy only where there is something to copy. Additive: no LobbyCanvas member.
export { selectionText } from '../board/copy-text.ts'
// Wave K.1 (follow-up 5): the first welcome and its catch-up are applied (the board session marks it). Additive.
export { markRoomReady, ROOM_READY_FALLBACK_MS, roomReadyOf } from './room-ready.ts'
// Wave N.1: a few of the scene index's answers as one list in the scene's paint order (a feature that needs the opaque
// elements above a note, or the cards a face may cover, reads them instead of `items()`). Additive.
export { mergeInPaintOrder, paintOrderMemo } from './parts/scene-index.ts'
