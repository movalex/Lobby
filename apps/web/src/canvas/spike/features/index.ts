/**
 * O5's minimal features for spike B (docs/EXCALIDRAW-MIGRATION.md §8.1 "Web"; checks B1.2, U1, U2, R2,
 * F13, B7, B12): tags chip, +1, comment pin tool, vote tool, phone sheet, timer, guest at 390 px and the
 * mind-map collapse prototype, registered through `registries.ts` and its slots, plus the board page's
 * image loading and exports. `canvas/spike/installers.ts` calls `install`; the board page never imports
 * this file.
 *
 * What the board page provides (O2): the port, the registries, and one call to `installBoardOverrides`
 * (canvas/overrides.ts) with its Excalidraw API and wrapper once the engine is ready. Everything that
 * needs the engine here waits for it (`onBoardEngine`, `onOverrides`), so the installers may run first.
 *
 * Writes: canvas writes only through `CanvasPort.transact` (one undo step each), doc keys through the
 * engine core's `setDoc` (the CR on sync/types.ts), api calls only same-origin under `/api`.
 */
import type { CanvasPort } from '../../port.ts'
import type { CanvasRegistries } from '../../registries.ts'
import { installFeatureHooks } from './test-hooks.ts'
import { installFeatureSet } from './wiring.ts'

export function install(port: CanvasPort, registries: CanvasRegistries): (() => void) | undefined {
  const set = installFeatureSet(port, registries)
  const unhook = installFeatureHooks(set)
  return () => {
    unhook()
    set.dispose()
  }
}
