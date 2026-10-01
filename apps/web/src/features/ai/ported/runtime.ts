// OWNER: 3h. AI state per canvas on the Excalidraw board page (the tldraw twin is ../runtime.ts): what
// the api says this person may do, the open menu, the running request and the summary panel. Signals
// (lib/signals.ts), so the selection-bar button, the context menu and the overlay read them with narrow
// useValue selectors; nothing here runs per frame.

import type { AiAction, AiStatus } from '@draftroom/contracts'
import type { CanvasFeatureContext, LobbyCanvas } from '../../../canvas/api/index.ts'
import { type Atom, atom } from '../../../lib/signals.ts'
import type { AiTarget } from './target.ts'

/** The same labels as ../runtime.ts (a tldraw module until wave 4). */
export const ACTION_LABELS: Record<AiAction, string> = {
  summarize: 'Summarize',
  themes: 'Group into themes',
  actions: 'Action items',
  ideas: 'Generate ideas',
}

export const BUSY_LABELS: Record<AiAction, string> = {
  summarize: 'Summarizing…',
  themes: 'Grouping into themes…',
  actions: 'Finding action items…',
  ideas: 'Generating ideas…',
}

function perCanvas<T>(make: (canvas: LobbyCanvas) => T) {
  const map = new WeakMap<LobbyCanvas, T>()
  return (canvas: LobbyCanvas): T => {
    let v = map.get(canvas)
    if (v === undefined) {
      v = make(canvas)
      map.set(canvas, v)
    }
    return v
  }
}

/** A request the person asked for (it may still wait for the privacy notice). */
export interface AiRequest {
  action: AiAction
  /** summarize: the web always asks for 'panel' (editors add it to the board from the panel). */
  mode?: 'insert' | 'panel'
  prompt?: string
  count?: number
}

export interface AiMenuState {
  /** Where the popover points, in px from the canvas container's top-left. */
  at: { x: number; top: number; bottom: number }
  /** 'regroup': asked before grouping notes that already sit in groups (DANA-10). */
  view: 'menu' | 'ideas' | 'notice' | 'regroup'
  target: AiTarget
  /** The request waiting for the notice (view 'notice'). */
  pending: AiRequest | null
}

export interface AiJob {
  id: number
  action: AiAction
  label: string
  abort: AbortController
  /** What had the keyboard when the popover that asked for it opened (W5-47); null from a menu. */
  opener: HTMLElement | null
}

export interface AiPanelState {
  summary: string
  about: string
  truncated: boolean
  /** What was summarized: "Add to board" puts the card there (DANA-04: nothing lands unasked). */
  target: AiTarget
  /** Where the keyboard goes back to when the panel closes from it (W5-47): the AI button, else the board. */
  opener: HTMLElement | null
}

/** Null until the api answered (the feature stays hidden until then). */
export const aiStatus = perCanvas<Atom<AiStatus | null>>(() => atom<AiStatus | null>('lobby-ai-status', null))
export const aiMenu = perCanvas<Atom<AiMenuState | null>>(() =>
  atom<AiMenuState | null>('lobby-ai-menu', null),
)
export const aiJob = perCanvas<Atom<AiJob | null>>(() => atom<AiJob | null>('lobby-ai-job', null))
export const aiPanel = perCanvas<Atom<AiPanelState | null>>(() =>
  atom<AiPanelState | null>('lobby-ai-panel', null),
)

/**
 * A11Y-15, W5-47: what had the keyboard as the AI popover opened (the selection bar's AI button, or the
 * board), per canvas. The popover remounts for each of its views and closes as a request starts, so this
 * outlives any one of them; a request takes it along (AiJob.opener) to the summary panel it opens.
 */
const openers = new WeakMap<LobbyCanvas, HTMLElement>()
export const aiOpener = {
  get: (canvas: LobbyCanvas): HTMLElement | null => openers.get(canvas) ?? null,
  set: (canvas: LobbyCanvas, el: HTMLElement) => void openers.set(canvas, el),
  clear: (canvas: LobbyCanvas) => void openers.delete(canvas),
}

/** The latest feature context, for code that only has the canvas. */
const contexts = new WeakMap<LobbyCanvas, CanvasFeatureContext>()
export const setAiCtx = (ctx: CanvasFeatureContext) => contexts.set(ctx.canvas, ctx)
export const getAiCtx = (canvas: LobbyCanvas) => contexts.get(canvas)
