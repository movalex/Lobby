// F4 (round-2 demo walk): at 1440 px, once a workshop was running (timer, "Private brainstorm 3 from
// 2", a raised hand, "Link: edit · until …"), the board title was cut to "Lobby t…". The bar now
// makes room for the title before it truncates it below about 24 characters: it compacts in steps
// (each keeps the ones before it), and only when even the most compact bar cannot fit, the feature
// controls move into the "⋯" menu, as on a tablet. Pure; TopBar.tsx measures and styles.css draws the
// steps (`.dr-topbar[data-compact~="<step>"]`).
//
// K2-5 (wave K, UXD-01, F3, UXP-11, UXP-5): a calmer bar. Saved and Live are one status dot (words only when
// something needs attention; the tooltip and the screen-reader text say both, and never "Saved" before the
// board is live), the comment tool leaves the bar (the toolbar's Comment and the rail's Comments stay), the
// "Shared outside" pill is a badge on Share and the sharing link pill sits against it, and a Feedback pill is
// always there (in the "⋯" menu on a phone, with the bell and the comment tool). `topBarPlan` is the list of
// what goes where per width; `statusView` is the dot.
//
// Wave M (M3-1): the command palette's "Search or do… Ctrl+K" is a feature item of the top bar (the topBar registry,
// features/command-palette), not pinned: it is part of `features` below, so a tablet, a phone and a crowded bar fold it
// into "⋯" with the other feature controls, and a bar that is only a little crowded keeps its magnifier (the `palette`
// compact step).
import { saveLabel, saveTitle } from '../sync-quality/copy.ts'
import type { DisplayState, Rejection } from '../sync-quality/save-state.ts'

/** In order: what goes first when the title needs room. */
export const COMPACT_STEPS = [
  /** The sharing badge keeps its icon ("Link: edit · until Sep 28, 1:35 AM" is in its tooltip). */
  'link',
  /** "Saved" / "Live" keep their check mark and dot (the words stay for screen readers). */
  'status',
  /** "Private brainstorm" keeps its lock and counts; an idle timer keeps its stopwatch. */
  'chips',
  /** M3-1: "Search or do… Ctrl+K" keeps its magnifier ("Search or do…" stays its name and tooltip; the key still works). */
  'palette',
  /** K2-5: the Feedback pill keeps its speech bubble ("Send feedback" stays its name and tooltip). */
  'feedback',
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

// ---- K2-5: what goes where ---------------------------------------------------------------------------------

/** The top bar's layouts (ui/useMedia.ts PRI-02 breakpoints: 768 px and 480 px). */
export type BarWidth = 'wide' | 'tablet' | 'phone'

/** The bar's layout at a viewport width in px (the same breakpoints as ui/useMedia.ts `useTopBarWidth`). */
export function barWidthAt(px: number): BarWidth {
  return px <= 480 ? 'phone' : px <= 768 ? 'tablet' : 'wide'
}

/**
 * The parts of the bar's right side:
 *  - `feedback`: the Feedback pill (wave J5's dialog, features/feedback/state.ts `openFeedback`);
 *  - `live`: present-live's rejoin chip; `people`: who is here;
 *  - `status`: the one status dot (Saved and Live);
 *  - `features`: every feature control (the bell, Facilitate, Present, the sharing link badge…); `pinned`: only
 *    the ones that stay in the bar on a narrow screen;
 *  - `comments`: the comment tool and the bell (in the phone menu; elsewhere the bell is a pinned control and the
 *    comment tool is the toolbar's);
 *  - `overflow`: the "⋯" button; `share`: Share with its badges; `account`: the account button.
 */
export type BarPart =
  | 'feedback'
  | 'live'
  | 'people'
  | 'status'
  | 'features'
  | 'pinned'
  | 'comments'
  | 'overflow'
  | 'share'
  | 'account'

export interface BarPlan {
  /** In the bar, in order (the logo, the breadcrumb and the title always come first). */
  readonly bar: readonly BarPart[]
  /** In the "⋯" menu, in order (empty: no menu). */
  readonly menu: readonly BarPart[]
}

/**
 * K2-5 (pure): where each part goes. A wide bar shows everything; a crowded wide bar or a tablet moves the
 * feature controls that are not pinned into "⋯"; a phone keeps the title, the dot, the pinned controls and
 * Share, and moves the rest (with the bell, the comment tool, the people list, Feedback and the account) into "⋯".
 */
export function topBarPlan(width: BarWidth, crowded = false): BarPlan {
  if (width === 'phone')
    return {
      bar: ['live', 'status', 'pinned', 'overflow', 'share'],
      menu: ['features', 'comments', 'people', 'feedback', 'account'],
    }
  if (width === 'tablet' || crowded)
    return {
      bar: ['feedback', 'live', 'people', 'status', 'pinned', 'overflow', 'share', 'account'],
      menu: ['features'],
    }
  return { bar: ['feedback', 'live', 'people', 'status', 'features', 'share', 'account'], menu: [] }
}

// ---- K2-5: the status dot ----------------------------------------------------------------------------------

/** The socket only ("Live"): never evidence that anything was saved. */
export type ConnState = 'connecting' | 'online' | 'offline' | 'error'

export const CONN_LABEL: Readonly<Record<ConnState, string>> = {
  connecting: 'Connecting…',
  online: 'Live',
  offline: 'Offline',
  error: 'Disconnected',
}
export const CONN_TITLE: Readonly<Record<ConnState, string>> = {
  connecting: 'Connecting to the board server',
  online: 'Connected: your changes are sent to everyone on this board as you make them',
  offline:
    'Offline: changes are kept in this tab only until the connection returns. Reloading now would lose them',
  error: 'The connection to this board ended',
}

/** What the dot needs of the save indicator (sync-quality/SaveStatus.tsx `SaveStatusView`). */
export interface DotSave {
  readonly state: DisplayState
  readonly rejection: Rejection | null
  readonly readonly: boolean
  readonly uploading?: number
  readonly role?: string
  readonly label?: string
  readonly title?: string
}

export type DotTone = 'ok' | 'busy' | 'warn' | 'danger'

export interface DotView {
  readonly tone: DotTone
  /** Words drawn beside the dot, or null (the calm state, and the "Saving…" of every edit, are the dot alone). */
  readonly label: string | null
  /** The tooltip: both halves (what is saved, and the connection). */
  readonly title: string
  /** The save half's words for screen readers ('' while the board is not live: never "Saved" then). */
  readonly saveText: string
  /** The connection half's words ("Live", "Offline"…). */
  readonly connText: string
  /** Each half's own tooltip (the save half's is null while it says nothing). */
  readonly saveTitle: string | null
  readonly connTitle: string
}

const DANGER: ReadonlySet<DisplayState> = new Set<DisplayState>(['rejected', 'error'])
// K.1 (follow-up 6): 'unsupported' (a protocol this build cannot read: nothing is confirmed saved) warns, never green
const WARN: ReadonlySet<DisplayState> = new Set<DisplayState>([
  'offline',
  'offline-pending',
  'retrying',
  'unsupported',
])
const BUSY: ReadonlySet<DisplayState> = new Set<DisplayState>(['connecting', 'saving'])

const sentence = (s: string) => {
  const t = s.trim()
  return t.endsWith('.') ? t : `${t}.`
}

/**
 * K2-5 (pure): the status dot for a save state and a connection. `saveHidden`: the role pill already says what
 * this person can do (a viewer's "View only"), so the dot is the connection alone.
 */
export function statusView(save: DotSave, conn: ConnState, saveHidden = false): DotView {
  const live = conn === 'online'
  const words = save.label ?? saveLabel(save.state, save.role)
  // never "Saved" before the board is live: the connection's words say where it is then
  const quietSave = saveHidden || (!live && save.state === 'saved')
  const saveText = quietSave ? '' : words
  const connText = CONN_LABEL[conn]
  const state = saveHidden ? null : save.state
  const tone: DotTone =
    conn === 'error' || (state !== null && DANGER.has(state))
      ? 'danger'
      : conn === 'offline' || (state !== null && WARN.has(state))
        ? 'warn'
        : conn === 'connecting' || (state !== null && BUSY.has(state))
          ? 'busy'
          : 'ok'
  let label: string | null = null
  if (tone === 'danger' || tone === 'warn') label = saveText && state !== 'saved' ? saveText : connText
  else if (tone === 'busy' && state === 'cached')
    // N1 (wave M W6): the board is showing this device's last copy while it connects; the canvas pill says so, and the
    // bar says the same words (not a bare "Connecting…" beside a board that already shows a copy)
    label = saveText || CONN_LABEL.connecting
  else if (tone === 'busy' && (conn === 'connecting' || state === 'connecting')) label = CONN_LABEL.connecting
  const saveTip = quietSave
    ? null
    : (save.title ?? saveTitle(save.state, save.rejection, save.readonly, save.uploading, save.role))
  const parts = live
    ? [saveTip ? `${words}: ${saveTip}` : null, CONN_TITLE.online]
    : [CONN_TITLE[conn], saveTip && state !== 'connecting' ? saveTip : null]
  const title = parts
    .filter((p): p is string => !!p)
    .map(sentence)
    .join(' ')
  return { tone, label, title, saveText, connText, saveTitle: saveTip, connTitle: CONN_TITLE[conn] }
}
