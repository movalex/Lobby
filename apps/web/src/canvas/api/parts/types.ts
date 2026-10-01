/**
 * What a LobbyCanvas part gets (docs/EXCALIDRAW-CONTRACTS.md §2.3). The members owned by wave-3 owners
 * are built in their own part module (./navigation.ts 3b, ./styles.ts 3a, ./follow.ts 3c, ./export.ts 3e,
 * ./files.ts 3g), so no owner edits 2C's ../impl.ts. Frozen at wave 1: the part signatures below; each
 * part's body is its owner's.
 *
 * A part that needs the engine reads the board page's handles through canvas/overrides.ts
 * `boardEngineOf(deps.registries)` (the Excalidraw API, the wrapper; 2C attaches them), and writes only
 * through `deps.self().transact`.
 */
import type { CanvasPort } from '../../port.ts'
import type { LobbyCanvas } from '../lobby-canvas.ts'
import type { FeatureRegistries } from '../registries.ts'

export interface PartDeps {
  readonly port: CanvasPort
  readonly registries: FeatureRegistries
  /** the whole canvas (for composing other members); valid once createLobbyCanvas has returned */
  self(): LobbyCanvas
}
