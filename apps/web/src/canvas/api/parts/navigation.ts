/**
 * OWNER: 3b (navigation). The camera members of LobbyCanvas beyond the C0 port: Lobby's own zoom-to and
 * fit camera (below Excalidraw's 0.1 clamp, docs/EXCALIDRAW-MIGRATION.md §4.2), ensure-visible, zoom
 * steps and limits. Stubs until 3b lands them.
 */
import type { LobbyViewport } from '../lobby-canvas.ts'
import { notImplemented } from '../owners.ts'
import type { PartDeps } from './types.ts'

export type NavigationPart = Pick<
  LobbyViewport,
  'zoomTo' | 'centerOn' | 'ensureVisible' | 'zoomStep' | 'limits'
>

export function createNavigationPart(_deps: PartDeps): NavigationPart {
  return {
    zoomTo: notImplemented('3b', 'viewport.zoomTo'),
    centerOn: notImplemented('3b', 'viewport.centerOn'),
    ensureVisible: notImplemented('3b', 'viewport.ensureVisible'),
    zoomStep: notImplemented('3b', 'viewport.zoomStep'),
    limits: notImplemented('3b', 'viewport.limits'),
  }
}
