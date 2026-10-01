// Canvas defaults canvas-ux sets on the Excalidraw canvas (the tldraw page's ../defaults.ts rules):
//  - MAK-02: alignment guides (snapping) on for someone who never chose. The canvas's settings are a local
//    preference (canvas.settings, this browser only); canvas-ux turns snapping on once per browser and
//    marks that it did, so a later "off" (Preferences → Always snap) is kept;
//  - RETRO-21a: new text uses the sans font (Nunito, 6), like the templates' notes;
//  - PRI-13: on a touch-first device, people who cannot edit start on the Hand tool where the canvas lets
//    them have it (on this engine a one-finger drag already pans for read-only roles).
// The tldraw page's shape cap and camera timeout are the server's limits and the engine's own here
// (docs/EXCALIDRAW-CONTRACTS.md §4: `options` → canvas-schema limits, the engine's config).
import type { LobbyCanvas } from '../../../canvas/api/index.ts'
import { FONT_FAMILY } from './style-vocabulary.ts'

/** Set once canvas-ux has turned snapping on in this browser (the default is then done). */
export const SNAP_DEFAULT_KEY = 'lobby:canvas-ux:snap-default'

/** MAK-02: turns snapping on unless this browser already had the default. Returns whether it did. */
export function applySnapDefault(
  canvas: Pick<LobbyCanvas, 'settings'>,
  storage: Pick<Storage, 'getItem' | 'setItem'> | null,
): boolean {
  let done = false
  try {
    done = storage?.getItem(SNAP_DEFAULT_KEY) === '1'
  } catch {
    done = false
  }
  if (done) return false
  try {
    storage?.setItem(SNAP_DEFAULT_KEY, '1')
  } catch {
    // storage blocked: the default is applied again next time, which is harmless
  }
  if (canvas.settings.get().snap) return false
  canvas.settings.set({ snap: true })
  return true
}

/** RETRO-21a: sans for the next text unless it already is. Returns whether it changed it. */
export function applyFontDefault(canvas: Pick<LobbyCanvas, 'styles'>): boolean {
  if (canvas.styles.next().fontFamily === FONT_FAMILY.sans) return false
  canvas.styles.setNext({ fontFamily: FONT_FAMILY.sans })
  return true
}

/** PRI-13 (pure): the start tool for a role on a device, or null to keep the select tool. */
export function startToolFor(opts: { coarsePointer: boolean; readonly: boolean }): 'hand' | null {
  return opts.coarsePointer && opts.readonly ? 'hand' : null
}
