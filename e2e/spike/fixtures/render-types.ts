// Types of the render spike pages' `window.__lobbySpike.extra` (apps/web/src/canvas/spike/pages/render-*.tsx),
// as the specs see it. A loose mirror, like support/spike-global.ts: e2e never imports web or engine code.
import type { SpikeApi, SpikeElement } from '../support/spike-global.ts'

export interface EchoOp {
  id: string
  from: number
  to: number
  fields: string[]
}

export interface EchoProbe {
  applyServer(elements: readonly unknown[]): void
  applied(elements: readonly unknown[]): void
  ops: EchoOp[]
  unknown: Set<string>
  onChangeCalls: number
  versionDrift(): { id: string; from: number; to: number }[]
  reset(): void
  scan(): void
}

export type LoadState = 'queued' | 'loading' | 'retrying' | 'loaded' | 'failed'

export interface LoaderLike {
  syncScene(elements: readonly unknown[], visible?: ReadonlySet<string>): void
  request(ids: Iterable<string>, visible?: ReadonlySet<string>): void
  state(id: string): LoadState | undefined
  states(): Record<LoadState, number>
  stats: {
    fetches: number
    failures: number
    retries: number
    loaded: number
    gaveUp: number
    maxInFlight: number
  }
}

export interface OverridesLike {
  setDrag(source: string, offsets: Map<string, { x: number; y: number }> | null): void
  clearDragFor(ids: string[]): void
  setHidden(source: string, ids: string[] | null): void
  isHidden(id: string): boolean
  hiddenIds(): ReadonlySet<string>
  current(): ReadonlyMap<string, { opacity?: number; offset?: { x: number; y: number } }>
  flush(): void
  stats: { submits: number; skipped: number }
}

export interface GuardEvent {
  id: string
  reason: { kind: 'hidden' } | { kind: 'moving'; source: string }
  type: string
}

export interface RenderEngine {
  CaptureUpdateAction: { IMMEDIATELY: unknown; NEVER: unknown; EVENTUALLY: unknown }
  convertToExcalidrawElements(
    skeletons: readonly Record<string, unknown>[],
    opts?: { regenerateIds?: boolean },
  ): SpikeElement[]
  exportToCanvas(opts: Record<string, unknown>): Promise<HTMLCanvasElement>
  exportToSvg(opts: Record<string, unknown>): Promise<SVGSVGElement>
  FONT_FAMILY: Record<string, number>
  getCommonBounds(elements: readonly unknown[]): [number, number, number, number]
  newElementWith(element: SpikeElement, updates: Record<string, unknown>): SpikeElement
}

export interface LabExtra {
  probe: EchoProbe
  loader(opts?: { retryWindowMs?: number; maxConcurrent?: number; urls?: Record<string, string> }): LoaderLike
  overrides: OverridesLike
  guard: { enabled: boolean; setEnabled(on: boolean): void; log: GuardEvent[] }
  engine: RenderEngine
  Fonts: { loadElementsFonts(elements: readonly unknown[]): Promise<unknown> }
  fixtureUrl(versionId: string, derivative: 'thumb' | 'display'): string
  pixel(x: number, y: number): number[] | null
  dark(rect: { x: number; y: number; w: number; h: number }): number
  visibleFileIds(): string[]
}

/** The imperative API with the members the render specs call (the rest stays `unknown`). */
export type RenderApi = SpikeApi & {
  addFiles(files: { id: string; mimeType: string; dataURL: string; created: number }[]): void
  getFiles(): Record<string, { id: string; dataURL: string; mimeType: string }>
  setElementRenderOverrides(overrides: Map<string, unknown> | null): void
  setViewport(opts: Record<string, unknown>): void
  onChange(cb: (...args: unknown[]) => void): () => void
  id: string
}
