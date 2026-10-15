// OWNER: WS3 (wave Q, the Elements panel; landed by the wave Q foundation). The panel's switch. While it is false the
// 'elements' feature contributes nothing (no panel, no command, no drop handler) and the Shapes panel (features/pieces)
// is the board's, exactly as before wave Q. The lead turns it on at the wave Q integration, in the change that also
// moves 'elements.open' out of PENDING_PALETTE_COMMAND_IDS; the Shapes panel's dock entry then retires by itself
// (features/pieces/index.tsx reads elementsPanelOn(); the `pieces.*` palette commands stay).
//
// A dev-auth build (the e2e build, local dev; never a production bundle: DEV_AUTH_ENABLED) may turn the panel on for
// its page, as the speed flags do (canvas/sync/flags.ts): localStorage ELEMENTS_PANEL_KEY = '1', read once when the
// board's features load. The q3-* specs set it with an init script and reload.
import { DEV_AUTH_ENABLED } from '../../lib/identity.ts'

export const ELEMENTS_PANEL = false

/** The localStorage key a dev-auth page reads its override from ('1' on, '0' off). */
export const ELEMENTS_PANEL_KEY = 'lobby.elementsPanel'

/** The override a dev-auth page stored, or null (none, unreadable, or not a dev-auth build). */
export function elementsPanelOverride(
  devAuth: boolean = DEV_AUTH_ENABLED,
  read: () => string | null | undefined = () => globalThis.localStorage?.getItem(ELEMENTS_PANEL_KEY),
): boolean | null {
  if (!devAuth) return null
  try {
    const v = read()
    return v === '1' ? true : v === '0' ? false : null
  } catch {
    return null
  }
}

let cached: boolean | null = null

/** Whether this page has the Elements panel: the shipped switch, or a dev-auth page's override. */
export function elementsPanelOn(): boolean {
  cached ??= elementsPanelOverride() ?? ELEMENTS_PANEL
  return cached
}
