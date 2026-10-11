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
import { noteSceneWalk } from '../walks.ts'

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

/** What a scene change's elements were, cheaply: the array, its length, and its versions and nonces. */
export interface SceneFingerprint {
  readonly ref: readonly unknown[]
  readonly length: number
  readonly versions: number
  readonly nonces: number
}

export function fingerprintOf(elements: readonly SceneElement[]): SceneFingerprint {
  let versions = 0
  let nonces = 0
  for (const e of elements) {
    versions += e.version
    nonces = (nonces ^ e.versionNonce) | 0
  }
  return { ref: elements, length: elements.length, versions, nonces }
}

const sameFingerprint = (a: SceneFingerprint | null, b: SceneFingerprint): boolean =>
  !!a && a.ref === b.ref && a.length === b.length && a.versions === b.versions && a.nonces === b.nonces

/** The gesture state the core reads, as a comparable key. */
const gestureKey = (g: GestureState): string => JSON.stringify(g)

/**
 * Feeds every scene change to the core, then `after` (the undo boundary, the port's events) with whether
 * any element changed. Returns the detach.
 *
 * CR 3b-8: an `onChange` that only moved the camera (a pan, a zoom: most of them while someone navigates)
 * changes no element and no gesture state, so the core's scan is skipped and `after` hears neither
 * changed (the port then skips its element scan, undo its step boundary). Any element write bumps a version and a
 * nonce (Excalidraw's `mutateElement`, `newElementWith`) or replaces the array, which the fingerprint sees;
 * one tight loop over the versions replaces two scans with map lookups per camera frame.
 */
export function attachEngine(
  api: ExcalidrawImperativeAPI,
  core: LobbyEngineCore,
  after?: (gesture: GestureState, changed: { elements: boolean; gesture: boolean }) => void,
): () => void {
  let last: SceneFingerprint | null = null
  let lastGesture = ''
  return api.onChange((_elements, appState) => {
    const elements = api.getSceneElementsIncludingDeleted() as unknown as readonly SceneElement[]
    const gesture = gestureOf(appState)
    // N1-6: one loop over every element's version per onChange (a camera frame included), counted in dev builds
    noteSceneWalk('sync.fingerprint')
    const fp = fingerprintOf(elements)
    const changed = !sameFingerprint(last, fp)
    last = fp
    const g = gestureKey(gesture)
    const gestureChanged = g !== lastGesture
    lastGesture = g
    if (changed || gestureChanged) core.onSceneChange({ elements, gesture })
    after?.(gesture, { elements: changed, gesture: gestureChanged })
  })
}
