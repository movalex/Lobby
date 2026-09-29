/**
 * O3's e2e test facade, `window.lobbyCanvas` (types: ./test-facade.types.ts). EMPTY STUB written by the
 * lead at the spike B contracts step C0; O3 owns this file from C0 on. `canvas/spike/installers.ts` calls
 * `install`; nothing else imports this file.
 */
import type { CanvasPort } from './port.ts'
import type { CanvasRegistries } from './registries.ts'

export function install(port: CanvasPort, registries: CanvasRegistries): (() => void) | undefined {
  void port
  void registries
  return undefined // not implemented yet (O3)
}
