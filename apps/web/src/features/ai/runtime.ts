// AI state per editor (docs/WAVE4-CONTRACTS.md §4 ai-assist): what the api says this person may do, the
// open menu, the running request and the summary panel. Atoms, so the selection-bar button, the context
// menu and the overlay read them with narrow useValue selectors; nothing here runs per frame.

import type { AiAction, AiStatus } from '@draftroom/contracts'
import { type Atom, atom, type Editor } from 'tldraw'
import type { FeatureContext } from '../types.ts'
import type { AiTarget } from './target.ts'

function perEditor<T>(make: (editor: Editor) => T) {
  const map = new WeakMap<Editor, T>()
  return (editor: Editor): T => {
    let v = map.get(editor)
    if (v === undefined) {
      v = make(editor)
      map.set(editor, v)
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
  /** Where the popover points, in px from the editor container's top-left. */
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
}

export interface AiPanelState {
  summary: string
  about: string
  truncated: boolean
  /** What was summarized: "Add to board" puts the card there (DANA-04: nothing lands unasked). */
  target: AiTarget
}

/** Null until the api answered (the feature stays hidden until then). */
export const aiStatus = perEditor<Atom<AiStatus | null>>(() => atom<AiStatus | null>('dr-ai-status', null))
export const aiMenu = perEditor<Atom<AiMenuState | null>>(() => atom<AiMenuState | null>('dr-ai-menu', null))
export const aiJob = perEditor<Atom<AiJob | null>>(() => atom<AiJob | null>('dr-ai-job', null))
export const aiPanel = perEditor<Atom<AiPanelState | null>>(() =>
  atom<AiPanelState | null>('dr-ai-panel', null),
)

/** The latest feature context, for module-level UI (the selection-bar button, the context menu). */
const contexts = new WeakMap<Editor, FeatureContext>()
export const setAiCtx = (editor: Editor, ctx: FeatureContext) => contexts.set(editor, ctx)
export const getAiCtx = (editor: Editor) => contexts.get(editor)

/** AI is offered here at all (the api said so). */
export const aiEnabled = (editor: Editor) => aiStatus(editor).get()?.enabled === true

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
