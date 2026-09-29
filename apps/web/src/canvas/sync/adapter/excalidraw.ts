/**
 * The Excalidraw adapter of the engine core (docs/EXCALIDRAW-MIGRATION.md §2.5): the scene the core reads
 * and applies, and the `onChange` feed.
 *
 *  - `read()`: every element (deleted ones included) and the gesture flags of §2.5.3, from `appState`
 *    (`selectedElementsAreBeingDragged`, `isResizing`, `isRotating`, `resizingElement`, `newElement`,
 *    `multiElement`, `selectedLinearElement?.isEditing`, `isCropping`, `editingTextElement`).
 *  - `apply(elements)`: the ONLY `updateScene` with elements the sync path makes, always with
 *    `CaptureUpdateAction.NEVER` (E4), never `reconcileElements` (§2.5.4). Synchronous: Excalidraw's scene
 *    holds the new array when it returns, so the core's version bookkeeping never races its own apply.
 *
 * Browser only (not node-safe).
 */
import { CaptureUpdateAction } from '@excalidraw/excalidraw'
import type { ExcalidrawElement } from '@excalidraw/excalidraw/element/types'
import type { AppState, ExcalidrawImperativeAPI } from '@excalidraw/excalidraw/types'
import type { LobbyEngineCore } from '../core/engine.ts'
import type { GestureState, SceneAdapter, SceneElement } from '../types.ts'

type GestureAppState = Pick<
  AppState,
  | 'selectedElementsAreBeingDragged'
  | 'isResizing'
  | 'isRotating'
  | 'isCropping'
  | 'resizingElement'
  | 'newElement'
  | 'multiElement'
  | 'selectedLinearElement'
  | 'selectedElementIds'
  | 'editingTextElement'
>

/** The gesture flags the core needs, from Excalidraw's appState (§2.5.3, §2.5.4). */
export function gestureOf(s: GestureAppState): GestureState {
  const selected = s.selectedElementIds ?? {}
  return {
    dragging: !!s.selectedElementsAreBeingDragged,
    resizing: !!s.isResizing,
    rotating: !!s.isRotating,
    cropping: !!s.isCropping,
    editingLinear: !!s.selectedLinearElement?.isEditing,
    resizingElementId: s.resizingElement?.id ?? null,
    newElementId: s.newElement?.id ?? null,
    multiElementId: s.multiElement?.id ?? null,
    selectedLinearElementId: s.selectedLinearElement?.elementId ?? null,
    selectedElementIds: Object.keys(selected).filter((k) => selected[k]),
    editingTextElementId: s.editingTextElement?.id ?? null,
  }
}

export interface ExcalidrawScene extends SceneAdapter {
  /** applies made by the core (the probe counts them) */
  readonly applies: number
}

export function createExcalidrawScene(api: ExcalidrawImperativeAPI): ExcalidrawScene {
  let applies = 0
  return {
    get applies() {
      return applies
    },
    read() {
      return {
        elements: api.getSceneElementsIncludingDeleted() as unknown as readonly SceneElement[],
        gesture: gestureOf(api.getAppState()),
      }
    },
    apply(elements) {
      applies++
      api.updateScene({
        elements: elements as unknown as readonly ExcalidrawElement[],
        captureUpdate: CaptureUpdateAction.NEVER,
      })
    },
  }
}

/**
 * Feeds every scene change to the core, then `after` (the undo boundary, the port's events). Returns the
 * detach. The core scans only what changed since its last look (versions), so this runs on every
 * `onChange`, the core's own applies included (they find nothing).
 */
export function attachEngine(
  api: ExcalidrawImperativeAPI,
  core: LobbyEngineCore,
  after?: (gesture: GestureState) => void,
): () => void {
  return api.onChange((_elements, appState) => {
    const snapshot = {
      elements: api.getSceneElementsIncludingDeleted() as unknown as readonly SceneElement[],
      gesture: gestureOf(appState),
    }
    core.onSceneChange(snapshot)
    after?.(snapshot.gesture)
  })
}
