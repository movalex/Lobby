// Canvas defaults canvas-ux sets on the Excalidraw canvas (the tldraw page's ../defaults.ts rules):
//  - MAK-02: alignment guides (snapping) on for someone who never chose. The canvas's settings are a local
//    preference (canvas.settings, this browser only); canvas-ux turns snapping on once per browser and
//    marks that it did, so a later "off" (Preferences → Always snap) is kept;
//  - RETRO-21a: new text uses the sans font (Nunito, 6), like the templates' notes;
//  - PRI-13: on a touch-first device, people who cannot edit start on the Hand tool where the canvas lets
//    them have it (on this engine a one-finger drag already pans for read-only roles);
//  - K2-3 (wave K, UXD-12): new rectangles, ellipses, diamonds and polygons get a solid light fill (tldraw's
//    "Semi", the canvas's own light colour; Excalidraw's dark mode draws it dark, canvas/engine/theme.ts), so
//    they can be grabbed and dragged anywhere, not only by their outline. Connectors, lines and the pen keep
//    no fill (a filled pen stroke would fill its loop). A fill the person picked in the style panel is never
//    overridden; Fill: None stays one click away there.
// The tldraw page's shape cap and camera timeout are the server's limits and the engine's own here
// (docs/EXCALIDRAW-CONTRACTS.md §4: `options` → canvas-schema limits, the engine's config).
import type { CanvasFeatureContext, LobbyCanvas, StyleValues } from '../../../canvas/api/index.ts'
import { POLYGON_TOOLS } from './polygons.ts'
import { uxState } from './state.ts'
import { FONT_FAMILY, SEMI_FILL, TRANSPARENT } from './style-vocabulary.ts'

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

/** K2-3: the tools whose new shapes get the light fill by default (the engine's three and D4's polygons). */
export const FILLED_SHAPE_TOOLS: ReadonlySet<string> = new Set([
  'rectangle',
  'ellipse',
  'diamond',
  ...POLYGON_TOOLS.map((t) => t.id),
])

/** K2-3: the tools that draw no fill (a connector, a line, the pen and the highlighter). */
export const UNFILLED_TOOLS: ReadonlySet<string> = new Set(['arrow', 'line', 'freedraw', 'highlight'])

/** K2-3: the shapes' default fill: solid, in the canvas's light colour (the style panel's "Semi"). */
export const DEFAULT_SHAPE_FILL = Object.freeze({ backgroundColor: SEMI_FILL, fillStyle: 'solid' } as const)

const isNone = (bg: string | undefined) => bg === undefined || bg === null || bg.toLowerCase() === TRANSPARENT

/**
 * K2-3 (pure): the next-style change when `tool` is picked, or null. A shape tool with no fill yet gets the
 * light default; a tool that draws no fill drops the default (only the default: a fill the person picked
 * stays, `chosen`).
 */
export function shapeFillPatch(tool: string | null, next: StyleValues, chosen: boolean): StyleValues | null {
  if (!tool || chosen) return null
  if (FILLED_SHAPE_TOOLS.has(tool) && isNone(next.backgroundColor)) return { ...DEFAULT_SHAPE_FILL }
  if (
    UNFILLED_TOOLS.has(tool) &&
    next.backgroundColor?.toLowerCase() === DEFAULT_SHAPE_FILL.backgroundColor &&
    next.fillStyle === DEFAULT_SHAPE_FILL.fillStyle
  )
    return { backgroundColor: TRANSPARENT }
  return null
}

/** K2-3: applies `shapeFillPatch` whenever the tool changes (editors only; a next style is never written). */
export function installShapeFillDefault(ctx: Pick<CanvasFeatureContext, 'canvas'>): () => void {
  const { canvas } = ctx
  const apply = (tool: string | null) => {
    if (canvas.readOnly()) return
    const patch = shapeFillPatch(tool, canvas.styles.next(), uxState(canvas).fillChosen.get())
    if (patch) canvas.styles.setNext(patch)
  }
  apply(canvas.tool())
  return canvas.on('toolChanged', () => apply(canvas.tool()))
}
