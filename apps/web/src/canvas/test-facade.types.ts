/**
 * `window.lobbyCanvas`: the e2e test facade (docs/EXCALIDRAW-MIGRATION.md §6.3), frozen at the spike B
 * contracts step C0 (docs/research/excalidraw/spike-b/CONTRACTS.md). Lead-owned; O3 implements it in
 * `canvas/test-facade.ts` on `CanvasPort`, installed only behind the dev-auth guard (the spike board page
 * is reachable only behind it).
 *
 * Every write goes through `CanvasPort.transact` and then the sync engine, never straight into
 * `updateScene`, so specs test the real path. Every return value is JSON-serializable (specs call these
 * through `page.evaluate`).
 */
import type { LeaseHolder, RosterEntry } from '@draftroom/canvas-schema/protocol'
import type { Bounds, CanvasElement, ItemKind, ScenePoint, ScreenPoint } from './port.ts'
import type { PushRecord, SaveStatus } from './sync/types.ts'

export interface LeaseStateView {
  /** lease ids this tab holds */
  readonly held: readonly string[]
  /** lease ids this tab asked for and has no answer for yet */
  readonly pending: readonly string[]
  /** every leased id and its holder (this tab included) */
  readonly holders: Readonly<Record<string, LeaseHolder>>
}

export interface LobbyCanvasFacade {
  /** live elements, as copies */
  items(): CanvasElement[]
  get(id: string): CanvasElement | null
  create(kind: ItemKind, props: Record<string, unknown>): string
  update(id: string, patch: Record<string, unknown>): void
  delete(id: string): void
  select(ids: string[]): void
  selection(): string[]
  tool(): string | null
  setTool(tool: string): boolean
  sceneToScreen(point: ScenePoint): ScreenPoint
  bounds(id: string): Bounds | null
  zoomToFit(): void
  /** the lease id of this tab's open editor */
  editingId(): string | null
  leaseHolder(id: string): LeaseHolder | null
  collaborators(): RosterEntry[]
  saveState(): SaveStatus
  /** the convergence hash (packages/canvas-schema hash.ts) of the engine core's map, deleted elements included */
  hash(): Promise<string>
  /** every push this tab sent (B10's recorder reads it) */
  pushedOps(): PushRecord[]
  leaseState(): LeaseStateView
}

declare global {
  interface Window {
    lobbyCanvas?: LobbyCanvasFacade
  }
}
