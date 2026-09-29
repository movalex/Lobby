/**
 * OWNER: 3a (canvas tools). The style panel's reads and writes: the shared style of a selection
 * (`mixed` per field) and applying a patch as one undo step. `styles.next`/`setNext` (the engine's
 * current-item state) stay 2C's in ../impl.ts. Stubs until 3a lands them.
 */
import type { LobbyStyles } from '../lobby-canvas.ts'
import { notImplemented } from '../owners.ts'
import type { PartDeps } from './types.ts'

export type StylesPart = Pick<LobbyStyles, 'of' | 'apply'>

export function createStylesPart(_deps: PartDeps): StylesPart {
  return {
    of: notImplemented('3a', 'styles.of'),
    apply: notImplemented('3a', 'styles.apply'),
  }
}
