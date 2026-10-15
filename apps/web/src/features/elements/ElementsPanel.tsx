// OWNER: WS3 (wave Q, the Elements panel; a placeholder landed by the wave Q foundation). Mounted only while
// ELEMENTS_PANEL is on (./flags.ts). WS3 replaces it with the panel: the search combobox over all three sources, the
// All / Icons / Shapes / Library tabs and their category chips, Recents and Favourites, the insert options bar, tiles
// that insert on click, Enter or tap and drag `lobby-element:<source>:<id>` onto the board, and the phone sheet.
import type { CanvasFeatureContext } from '../../canvas/api/index.ts'

export function ElementsPanel(_props: { readonly ctx: CanvasFeatureContext; close(): void }) {
  return <section className="lobby-elements-panel" aria-label="Elements" data-testid="elements-panel" />
}
