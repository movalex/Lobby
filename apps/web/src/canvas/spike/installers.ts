/**
 * The one module the spike board page calls (docs/EXCALIDRAW-MIGRATION.md §8.6.2): `installAll(port,
 * registries)` installs O3's test facade and O5's features, so neither ever edits O2's board page and the
 * board page never imports them directly. Lead-owned, frozen at the contracts step C0.
 */
import type { CanvasPort } from '../port.ts'
import { type CanvasRegistries, registerInstaller, runInstallers } from '../registries.ts'
import { install as installFacade } from '../test-facade.ts'
import { install as installFeatures } from './features/index.ts'

registerInstaller('test-facade', installFacade)
registerInstaller('spike-features', installFeatures)

/** Installs everything registered; returns one uninstall for all of it. */
export function installAll(port: CanvasPort, registries: CanvasRegistries): () => void {
  return runInstallers(port, registries)
}
