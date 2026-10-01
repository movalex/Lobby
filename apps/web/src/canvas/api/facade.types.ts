/**
 * The wave-1 additions to `window.lobbyCanvas` (the e2e test facade, §6.3; the C0 verbs are
 * ../test-facade.types.ts, unchanged). Ported specs need these to replace the `window.editor` calls
 * today's specs make (e2e/tests/support/canvas.ts wraps them). Frozen at wave 1; implemented by 2E in
 * ../test-facade.ts on `LobbyCanvas` (behind the same dev-auth guard). Until a verb exists on the page,
 * the helper that needs it fails with "facade verb <name> not implemented (2E)".
 *
 * Every write still goes through `transact` and the sync engine; every return value is JSON-serializable.
 */
import type { Bounds, CanvasGesture, EditVia, ScenePoint, Viewport } from './lobby-canvas.ts'

export interface FacadeMe {
  readonly uid: string
  readonly sid: string
  readonly role: 'owner' | 'editor' | 'commenter' | 'viewer'
  readonly guest: boolean
}

export interface LobbyCanvasFacadeV1 {
  /** the first `welcome` is applied (the board is usable) */
  ready(): boolean
  /** who this tab is, from the `welcome` (null before it) */
  me(): FacadeMe | null
  /** getIsReadonly */
  readOnly(): boolean
  /** plain text of an element (a note's label, a frame's name) */
  text(id: string): string
  /** getViewportPageBounds, getZoomLevel, getCamera */
  viewport(): Viewport
  /** setCamera (scene x, y of the top-left, and zoom) */
  setViewport(v: Partial<Pick<Viewport, 'x' | 'y' | 'zoom'>>): void
  /** zoomToBounds */
  zoomTo(bounds: Bounds): void
  /** screenToPage */
  screenToScene(point: ScenePoint): ScenePoint
  /** getShapeAtPoint (hidden ids never hit) */
  hitTest(point: ScenePoint): string | null
  /** isShapeHidden */
  isHidden(id: string): boolean
  /** isIn / getPath */
  gesture(): CanvasGesture
  /** getCameraState() === 'moving' */
  cameraMoving(): boolean
  /** editor.undo / redo / getCanUndo: Lobby's stack, as Ctrl+Z would */
  undo(): void
  redo(): void
  canUndo(): boolean
  /** getDocumentSettings().meta.* → lb_doc */
  doc(key: string): unknown
  /** updateDocumentSettings → lb_doc (through the engine) */
  setDoc(entries: Record<string, unknown>): void
  /** opens the editor on `id` through the lease (true when granted and writable) */
  editText(id: string, via?: EditVia): Promise<boolean>
  /** closes the open editor (commit) */
  stopEditing(): void
  /** getBindingsFromShape(arrow) */
  arrowEnds(id: string): { start: string | null; end: string | null }
  /** getSortedChildIdsForParent(frame) */
  children(frameId: string): string[]
  /** the session this tab follows (followingUserId) */
  following(): string | null
  /** getSvgString (the export path, not a screenshot) */
  exportSvg(ids?: string[]): Promise<string>
}

export type LobbyCanvasFacadeV1Verb = keyof LobbyCanvasFacadeV1

/** The verbs, for the helpers' "not implemented" checks and the facade's own test. */
export const FACADE_V1_VERBS = [
  'ready',
  'me',
  'readOnly',
  'text',
  'viewport',
  'setViewport',
  'zoomTo',
  'screenToScene',
  'hitTest',
  'isHidden',
  'gesture',
  'cameraMoving',
  'undo',
  'redo',
  'canUndo',
  'doc',
  'setDoc',
  'editText',
  'stopEditing',
  'arrowEnds',
  'children',
  'following',
  'exportSvg',
] as const satisfies readonly LobbyCanvasFacadeV1Verb[]
type MissingVerb = Exclude<LobbyCanvasFacadeV1Verb, (typeof FACADE_V1_VERBS)[number]>
// fails to compile when a verb is added to the interface without listing it above
const verbsComplete: [MissingVerb] extends [never] ? true : never = true
void verbsComplete
