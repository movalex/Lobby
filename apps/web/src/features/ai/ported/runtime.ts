// OWNER: 3h. AI state per canvas on the Excalidraw board page (the tldraw twin is ../runtime.ts): what
// the api says this person may do, the open menu, the running request and the summary panel. Signals
// (lib/signals.ts), so the selection-bar button, the context menu and the overlay read them with narrow
// useValue selectors; nothing here runs per frame.

// Wave L (W2): the menus' own requests (AiRequest) stay the four legacy actions; a job (the busy pill) can be
// any action, since public.ts `runAi` runs the wave L ones for every workstream.
import type { AiAction, AiLegacyAction, AiStatus } from '@draftroom/contracts'
import type { CanvasFeatureContext, LobbyCanvas } from '../../../canvas/api/index.ts'
import { type Atom, atom } from '../../../lib/signals.ts'
import type { ShimmerPlan } from './shimmer.ts'
import type { AiTarget } from './target.ts'

/** The same labels as ../runtime.ts (a tldraw module until wave 4), and the wave L actions'. */
export const ACTION_LABELS: Record<AiAction, string> = {
  summarize: 'Summarize',
  themes: 'Group into themes',
  actions: 'Action items',
  ideas: 'Generate ideas',
  recap: 'Wrap up',
  ask: 'Ask this board',
  command: 'Board command',
  diagram: 'Diagram from words',
  sort: 'Sort by a lens',
  score: 'Place on a 2x2',
}

export const BUSY_LABELS: Record<AiAction, string> = {
  summarize: 'Summarizing…',
  themes: 'Grouping into themes…',
  actions: 'Finding action items…',
  ideas: 'Generating ideas…',
  recap: 'Writing the recap…',
  ask: 'Reading the board…',
  command: 'Working it out…',
  diagram: 'Drawing the diagram…',
  sort: 'Sorting…',
  score: 'Placing on the 2x2…',
}

/** The busy pill's words: the action's, or what the ideas are for. */
export function busyLabel(job: { action: AiAction; into?: AiInto }): string {
  if (job.into?.kind === 'expand') return 'Expanding the topic…'
  if (job.into?.kind === 'mindmap') return 'Drafting your mind map…'
  return BUSY_LABELS[job.action]
}

/** One value per canvas (a WeakMap: a closed board leaves nothing behind). */
export function perCanvas<T>(make: (canvas: LobbyCanvas) => T) {
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

/**
 * Where the answer of an 'ideas' request goes besides sticky notes (K7): new sub-topics under a mind-map
 * topic ("Expand with AI"), or the first ring of a new mind map whose centre is the prompt ("Mind map from
 * a prompt"). The api only ever sees the existing 'ideas' action; this is what the web does with the answer.
 */
export type AiInto = { kind: 'expand'; topicId: string } | { kind: 'mindmap' }

/** A request the person asked for from the AI menus (it may still wait for the privacy notice). */
export interface AiRequest {
  action: AiLegacyAction
  /** actions (L2-4, vote-weighted): order the items by this revealed vote */
  voteSessionId?: string
  /** summarize: the web always asks for 'panel' (editors add it to the board from the panel). */
  mode?: 'insert' | 'panel'
  prompt?: string
  count?: number
  /** ideas only: build a mind map with the answer instead of sticky notes. */
  into?: AiInto
}

export interface AiMenuState {
  /** Where the popover points, in px from the canvas container's top-left. */
  at: { x: number; top: number; bottom: number }
  /** 'regroup': asked before grouping notes that already sit in groups (DANA-10); 'ask': Ask this board (L2-2). */
  view: 'menu' | 'ideas' | 'mindmap' | 'notice' | 'regroup' | 'ask'
  target: AiTarget
  /** The request waiting for the notice (view 'notice'). */
  pending: AiRequest | null
  /**
   * Wave L: a notice asked by public.ts `runAi` (any action, any caller): what it will do and send, and the
   * answer (Continue: true; Cancel, Escape or closing it any other way: false).
   */
  notice?: { verb: string; what: string; confirm(ok: boolean): void }
  /** view 'ask': the question to start with (the palette's "Ask: …") */
  question?: string
}

export interface AiJob {
  id: number
  action: AiAction
  /** Where an 'ideas' answer goes when it is not sticky notes (K7). */
  into?: AiInto
  /** What the placeholder shows where the result will land (scene space, K7-4); empty: nowhere on the board. */
  landing: ShimmerPlan | null
  label: string
  abort: AbortController
  /** What had the keyboard when the popover that asked for it opened (W5-47); null from a menu. */
  opener: HTMLElement | null
}

export interface AiPanelState {
  summary: string
  about: string
  truncated: boolean
  /** The summary's run id (provenance of the card "Add to board" makes); null from a wave K api. */
  runId: string | null
  /** What was summarized: "Add to board" puts the card there (DANA-04: nothing lands unasked). */
  target: AiTarget
  /** Where the keyboard goes back to when the panel closes from it (W5-47): the AI button, else the board. */
  opener: HTMLElement | null
}

/** What the result just wrote, for the brief highlight (overlay only, never stored): ids in scene space. */
export interface AiFlashState {
  n: number
  ids: string[]
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
export const aiFlash = perCanvas<Atom<AiFlashState | null>>(() =>
  atom<AiFlashState | null>('lobby-ai-flash', null),
)

/**
 * Wave L: the private panels (the summary, Ask's answer, the recap) are one at a time per canvas: opening one
 * closes the others. Each module registers how its own panel closes (so this module imports none of them).
 */
export type AiPrivatePanel = 'summary' | 'answer' | 'recap'
const panelClosers = new Map<AiPrivatePanel, (canvas: LobbyCanvas) => void>()
export const registerPrivatePanel = (name: AiPrivatePanel, close: (canvas: LobbyCanvas) => void) =>
  void panelClosers.set(name, close)
/** `name` is opening on `canvas`: the other private panels close. */
export function openingPrivatePanel(canvas: LobbyCanvas, name: AiPrivatePanel): void {
  for (const [other, close] of panelClosers) if (other !== name) close(canvas)
}
registerPrivatePanel('summary', (canvas) => aiPanel(canvas).set(null))

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
