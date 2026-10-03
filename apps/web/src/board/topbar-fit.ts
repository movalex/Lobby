// F4 (round-2 demo walk): at 1440 px, once a workshop was running (timer, "Private brainstorm 3 from
// 2", a raised hand, "Link: edit · until …"), the board title was cut to "Lobby t…". The bar now
// makes room for the title before it truncates it below about 24 characters: it compacts in steps
// (each keeps the ones before it), and only when even the most compact bar cannot fit, the feature
// controls move into the "⋯" menu, as on a tablet. Pure; TopBar.tsx measures and styles.css draws the
// steps (`.dr-topbar[data-compact~="<step>"]`).

/** In order: what goes first when the title needs room. */
export const COMPACT_STEPS = [
  /** The sharing badge keeps its icon ("Link: edit · until Sep 28, 1:35 AM" is in its tooltip). */
  'link',
  /** "Saved" / "Live" keep their check mark and dot (the words stay for screen readers). */
  'status',
  /** "Private brainstorm" keeps its lock and counts; an idle timer keeps its stopwatch. */
  'chips',
  /** The workspace name before the title (the logo still goes back to the workspace). */
  'crumb',
  /** "Present" keeps its play icon. */
  'present',
] as const
export type CompactStep = (typeof COMPACT_STEPS)[number]

/** The title keeps at least this many characters (then an ellipsis) before anything else goes. */
export const MIN_TITLE_CHARS = 24

/** The `data-compact` value for the first `level` steps ('' = nothing compacted). */
export function compactValue(level: number): string {
  return COMPACT_STEPS.slice(0, Math.max(0, level)).join(' ')
}

export interface TitleMeasure {
  /** The title box's inner width (clientWidth: padding included). */
  client: number
  /** Its content's full width (scrollWidth). */
  scroll: number
  /** What MIN_TITLE_CHARS characters and an ellipsis need, padding included (Infinity for short titles). */
  need: number
}

/** The title shows in full, or at least MIN_TITLE_CHARS characters of it. */
export function titleFits(m: TitleMeasure | null): boolean {
  if (!m) return true
  return m.scroll <= m.client + 1 || m.client + 1 >= m.need
}

/** What `need` is for a title: short ones must show in full. */
export function titleNeed(title: string, measure: (text: string) => number, padding: number): number {
  const chars = Array.from(title)
  if (chars.length <= MIN_TITLE_CHARS) return Number.POSITIVE_INFINITY
  return measure(`${chars.slice(0, MIN_TITLE_CHARS).join('')}…`) + padding
}

/**
 * The first level (0 = nothing compacted … COMPACT_STEPS.length = all steps) at which `fits(level)`
 * holds, or null when even the most compact bar is too full (the controls go into the "⋯" menu).
 * `fits` applies the level before it measures.
 */
export function firstFittingLevel(fits: (level: number) => boolean): number | null {
  for (let level = 0; level <= COMPACT_STEPS.length; level++) {
    if (fits(level)) return level
  }
  return null
}

/** Grow this much past the width that needed the "⋯" menu before the controls come back to the bar. */
export const MENU_HYSTERESIS_PX = 16

/** Whether a bar that moved its controls into "⋯" at `crowdedAt` px may try them in the bar again. */
export function mayLeaveMenu(width: number, crowdedAt: number): boolean {
  return width > crowdedAt + MENU_HYSTERESIS_PX
}

/**
 * Whether a render prop's result draws anything (W5-50): `null`, `undefined`, `false` and `''` do not. The
 * phone "⋯" menu leaves out the caption of a row whose content is nothing (the people row, when the
 * people feature has its own chip in the bar).
 */
export function hasContent(node: unknown): boolean {
  return node !== null && node !== undefined && node !== false && node !== ''
}
