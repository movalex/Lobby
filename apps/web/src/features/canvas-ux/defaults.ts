// Editor defaults canvas-ux changes (pure, unit-tested).

/**
 * PRF-02: tldraw refuses a whole create batch once a page would exceed maxShapesPerPage (default 4,000),
 * which breaks the 5,000-object gate and 500-note pastes. 20,000 leaves headroom; the server has no cap.
 */
export const MAX_SHAPES_PER_PAGE = 20_000

/**
 * MAK-02: alignment guides on by default. tldraw's `isSnapMode` preference defaults to off and is only
 * stored once someone sets it (TLUserPreferences: fresh prefs are just { id, color }), so an unset value
 * means "never chose": turn it on then, and never touch an explicit choice (on or off). Holding Ctrl/Cmd
 * while dragging still inverts it for that drag.
 */
export function snapDefaultPatch(stored: { isSnapMode?: boolean | null }): { isSnapMode: true } | null {
  return stored.isSnapMode === undefined || stored.isSnapMode === null ? { isSnapMode: true } : null
}
