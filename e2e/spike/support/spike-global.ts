// The e2e side of `window.__lobbySpike` (apps/web/src/canvas/spike/harness.ts). A loose mirror on
// purpose: e2e never imports @excalidraw or web sources; specs reach the engine only through this global,
// inside page.evaluate.

export type SpikeRole = 'editor' | 'commenter' | 'viewer' | 'guest'
export type SpikeTheme = 'light' | 'dark'

/** The element fields specs read. Everything else is there too, untyped. */
export interface SpikeElement {
  id: string
  type: string
  version: number
  isDeleted: boolean
  x: number
  y: number
  width: number
  height: number
  backgroundColor: string
  containerId?: string | null
  text?: string
  fontFamily?: number
  boundElements?: readonly { id: string; type: string }[] | null
  [key: string]: unknown
}

/** The subset of ExcalidrawImperativeAPI specs call (see the installed types for the rest). */
export interface SpikeApi {
  updateScene(scene: {
    elements?: readonly unknown[]
    appState?: Record<string, unknown>
    captureUpdate?: unknown
  }): void
  getSceneElements(): readonly SpikeElement[]
  getSceneElementsIncludingDeleted(): readonly SpikeElement[]
  getAppState(): Record<string, unknown> & {
    scrollX: number
    scrollY: number
    zoom: { value: number }
    offsetLeft: number
    offsetTop: number
    theme: string
  }
  [key: string]: unknown
}

export interface SpikeLib {
  CaptureUpdateAction: { IMMEDIATELY: unknown; NEVER: unknown; EVENTUALLY: unknown }
  /** Regenerates every id unless opts.regenerateIds is false. */
  convertToExcalidrawElements(
    skeletons: readonly Record<string, unknown>[],
    opts?: { regenerateIds?: boolean },
  ): SpikeElement[]
  FONT_FAMILY: Record<string, number>
  newElementWith(element: SpikeElement, updates: Record<string, unknown>): SpikeElement
  restoreElements(elements: readonly unknown[], local: unknown, opts?: unknown): SpikeElement[]
  sceneCoordsToViewportCoords(
    coords: { sceneX: number; sceneY: number },
    appState: SpikeApi['getAppState'] extends () => infer S ? S : never,
  ): { x: number; y: number }
  viewportCoordsToSceneCoords(
    coords: { clientX: number; clientY: number },
    appState: SpikeApi['getAppState'] extends () => infer S ? S : never,
  ): { x: number; y: number }
}

export interface LobbySpike {
  api: SpikeApi | null
  ready: Promise<SpikeApi>
  role: SpikeRole
  setRole?: (role: SpikeRole) => void
  theme: SpikeTheme
  setTheme?: (theme: SpikeTheme) => void
  lib: SpikeLib
  extra: Record<string, unknown>
}

declare global {
  interface Window {
    __lobbySpike?: LobbySpike
  }
}
