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

/**
 * PERF-04: tldraw keeps the camera "moving" for this long after the last camera change (default 64 ms)
 * and re-renders shapes at the new zoom once it is idle. On a heavy board one slow frame (> 64 ms) ends
 * the "moving" state mid-gesture, the full re-render makes the next frame slow too, and zooming falls
 * into a 7–9 fps loop. ~280 ms bridges a slow frame; shapes still re-render sharp right after the
 * gesture ends.
 */
export const CAMERA_MOVING_TIMEOUT_MS = 280

/**
 * RETRO-21a: new shapes use the sans font, like the templates' notes, instead of tldraw's handwriting
 * default. `stylesForNextShape` (TLInstance) only holds a font once someone picked one, so an unset
 * value means "never chose": set sans then, and never touch an explicit choice.
 */
export function fontDefaultPatch(
  stylesForNextShape: Readonly<Record<string, unknown>> | undefined,
): 'sans' | null {
  const chosen = stylesForNextShape?.['tldraw:font']
  return chosen === undefined || chosen === null ? 'sans' : null
}

/**
 * PRI-13: on a touch-first device (primary pointer coarse), people who cannot edit (viewers,
 * commenters) start on the Hand tool, so a one-finger drag pans instead of drawing a selection box.
 * Pinch still zooms and the comment tool is one tap away. Editors keep the select tool.
 */
export function startToolFor(opts: { coarsePointer: boolean; readonly: boolean }): 'hand' | null {
  return opts.coarsePointer && opts.readonly ? 'hand' : null
}
