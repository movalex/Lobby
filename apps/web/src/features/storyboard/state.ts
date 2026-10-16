// OWNER: WS2 (wave T, storyboards). This tab's storyboard UI state, per canvas (nothing here is synced or stored):
// which storyboard the strip shows, the open dialog and its draft, the panel being dragged in the strip. And the
// reads every part shares: the board's storyboards (features/planning model.ts storyboardsOn, over canvas.index only),
// the one the selection is in, and a panel's words (its field boxes by kind).
import type { StoryboardAspect } from '@draftroom/canvas-schema/planning'
import { type CanvasElement, items, type LobbyCanvas } from '../../canvas/api/index.ts'
import { type Atom, atom } from '../../lib/signals.ts'
import { planningOffered, planningShown, storyboardOfSelection, storyboardsOn } from '../planning/index.ts'
import { isFieldKind, type Provenance } from './build.ts'
import type { FieldKind } from './model.ts'
import type { Sb } from './ops.ts'
import type { Beat, ScriptFormat } from './script/parse.ts'

export interface ScriptDraft {
  readonly text: string
  /** null: detect it */
  readonly format: ScriptFormat | null
  readonly aspect: StoryboardAspect
  readonly title: string
  /** the preview: the parser's beats, edited, or the AI's panels */
  readonly beats: readonly Beat[] | null
  /** the beats came from "Break down with AI" (provenance on what is made) */
  readonly ai: Provenance | null
}

export type SbDialog =
  | { readonly kind: 'new' }
  | { readonly kind: 'script'; readonly draft: ScriptDraft }
  | null

export interface SbState {
  /** the storyboard the strip shows (it stays until closed or the storyboard is gone) */
  readonly strip: Atom<string | null>
  readonly dialog: Atom<SbDialog>
  /** an AI breakdown is running for the dialog (it is closed meanwhile: the AI notice must be reachable) */
  readonly aiBusy: Atom<boolean>
}

const states = new WeakMap<object, SbState>()

export function sbState(canvas: object): SbState {
  let s = states.get(canvas)
  if (!s) {
    s = {
      strip: atom<string | null>('storyboard.strip', null),
      dialog: atom<SbDialog>('storyboard.dialog', null),
      aiBusy: atom<boolean>('storyboard.ai-busy', false),
    }
    states.set(canvas, s)
  }
  return s
}

/** Whether this page shows storyboards at all (the switch). */
export const shown = (): boolean => planningShown('storyboard')

/** Whether this page may change storyboards here (the switch, a rev-14 room, not read-only). */
export const offered = (canvas: Pick<LobbyCanvas, 'room' | 'readOnly'>): boolean =>
  planningOffered('storyboard', canvas)

/** The board's storyboards (reactive inside a signal read). */
export const boardsOf = (canvas: Pick<LobbyCanvas, 'index'>): Map<string, Sb> =>
  storyboardsOn(canvas) as Map<string, Sb>

/** The storyboard one selected element belongs to (a head, a panel, an element in a panel). */
export function selectedStoryboard(canvas: Pick<LobbyCanvas, 'index' | 'selection' | 'get'>): Sb | null {
  const sel = canvas.selection
  if (!sel.length) return null
  const boards = boardsOf(canvas)
  if (!boards.size) return null
  for (const id of sel) {
    const el = canvas.get(id)
    if (!el) continue
    const container = items.containerOf(el, (x) => canvas.get(x))
    const sb = storyboardOfSelection(boards, container)
    if (sb) return sb
  }
  return null
}

/** The panel of `sb` a selected element is (or is in), else null. */
export function selectedPanelIndex(canvas: Pick<LobbyCanvas, 'selection' | 'get'>, sb: Sb): number {
  for (const id of canvas.selection) {
    const el = canvas.get(id)
    if (!el) continue
    const container = items.containerOf(el, (x) => canvas.get(x))
    const i = sb.panels.findIndex((p) => p.id === container.id || p.id === container.frameId)
    if (i >= 0) return i
  }
  return -1
}

/** A panel's words, by field kind (the field boxes' labels; '' for an empty field or a panel without one). */
export function panelWords(
  canvas: Pick<LobbyCanvas, 'index' | 'get'>,
  panelId: string,
): Record<FieldKind, string> {
  const out: Record<FieldKind, string> = { 'sb-camera': '', 'sb-action': '', 'sb-dialogue': '' }
  for (const el of canvas.index.byFrame(panelId)) {
    const kind = items.lobbyValue(el, 'kind')
    if (!isFieldKind(kind) || el.isDeleted) continue
    const label = items.labelOf(el, (x) => canvas.get(x))
    out[kind] = label ? String((label as { originalText?: string }).originalText ?? '') : ''
  }
  return out
}

/** The head's title (its text), or "Untitled storyboard" when it is gone. */
export function titleOf(canvas: Pick<LobbyCanvas, 'get'>, sb: Sb): string {
  const head = sb.head ? canvas.get(sb.head.id) : undefined
  if (!head || head.isDeleted) return 'Untitled storyboard'
  return String((head as CanvasElement & { originalText?: string }).originalText ?? '').trim() || 'Storyboard'
}
