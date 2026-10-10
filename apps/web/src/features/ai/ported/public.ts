// OWNER: W2 (wave L, "AI on the board"). The web AI feature's cross-workstream API: W3 (the palette and
// plain-language commands), W4 (Diagram from words), W5 (Facilitate > Wrap up) and W8 (sort by a lens, 2x2
// placement) import ONLY this file from features/ai. Frozen at the wave L foundation: the names, signatures
// and semantics below. W2's bodies (wave L):
// - runAi: ./actions.ts `runPublic` (the menus' gate, notice, busy pill and error notices);
// - showAiPreview: ./preview.tsx (the screen-layer preview with Apply, Try again and Discard);
// - findSpot: ./apply.ts `spotNear` (the rules AI notes are placed by);
// - aiCustomData: ./provenance.ts (pure).
// The command ids are registered by W2 in ./menus.tsx; running an id nobody registered is a no-op (canvas-ux
// runCommand answers false).

import type { AiResult, AiRunInput } from '@draftroom/contracts'
import type { CanvasFeatureContext } from '../../../canvas/api/index.ts'
import { runPublic } from './actions.ts'
import { spotNear } from './apply.ts'
import { showPreview } from './preview.tsx'

// ---- running an AI action --------------------------------------------------------------------------------

/**
 * Runs one AI action on the board through POST /api/boards/:bid/ai/run and resolves its result, or null when
 * there is nothing to apply: AI is off or not offered to this person, the person dismissed the "Sends the
 * selected text to OpenAI" notice, the call was refused or failed (W2's body tells the person why, in the
 * AI feature's own notice), or another AI request of this tab is still running. It never applies anything:
 * the caller applies the result (through showAiPreview first when it moves or recolours more than a few
 * elements). W2's body sends `at` (the selection's bounds) for the live "is using AI here" shimmer when the
 * caller gave none, waits for this tab's pending pushes first (the api reads the server's copy), and makes a
 * new budgeted call each time (Try again is a new call with a new run id).
 */
export function runAi(ctx: CanvasFeatureContext, input: AiRunInput): Promise<AiResult | null> {
  return runPublic(ctx, input).catch(() => null)
}

// ---- the shared preview ----------------------------------------------------------------------------------

/** What an AI (or a grammar) plan would change, drawn before anything is written (L2-1b). */
export interface AiPreviewPlan {
  /** the AiResult's run id (a grammar-only plan, W3: any stable id of the plan) */
  readonly runId: string
  /** the preview's heading ('Group into themes', 'Make 6 notes yellow') */
  readonly title: string
  /** the count line ('Moves 23 notes into 5 themes') */
  readonly summary: string
  /** elements that move: their new top-left, scene units */
  readonly moves: readonly { readonly id: string; readonly x: number; readonly y: number }[]
  /** elements that change colour: the new colour (a Lobby palette name or a literal the styles part accepts) */
  readonly recolors: readonly { readonly id: string; readonly to: string }[]
  /** what will be created: its bounds, scene units, and a kind for the outline ('note', 'frame', 'arrow', …) */
  readonly creates: readonly {
    readonly x: number
    readonly y: number
    readonly w: number
    readonly h: number
    readonly kind: string
    /**
     * Wave M (W4, M4-1; optional, additive): the words the new element will say (a theme's or a column's name, a
     * diagram node's label), drawn in its outline so the person can judge them before Apply.
     */
    readonly label?: string
  }[]
  /**
   * Wave M (W4, M4-1; optional, additive): the groups the plan makes and how many notes each holds, in order, listed
   * in the panel as "Sooner (2) · Later (2)". A plan that names no groups shows only its count line.
   */
  readonly groups?: readonly { readonly name: string; readonly count: number }[]
}

/** The person's choice: apply the plan, ask again (a new budgeted call), or drop it. */
export type AiPreviewChoice = 'apply' | 'retry' | 'discard'

/**
 * Shows `plan` over the board (a screen-layer overlay: destination outlines, move arrows, recolour swatches,
 * the bounds of new elements and the count line, static under reduced motion) and resolves the person's
 * choice. Nothing is written before it resolves; the caller writes on 'apply' (one transact), calls again on
 * 'retry' and does nothing on 'discard'. One preview at a time per canvas: a second call while one is open
 * resolves the first with 'discard'. Escape, closing the board or losing edit rights is 'discard'.
 */
export function showAiPreview(ctx: CanvasFeatureContext, plan: AiPreviewPlan): Promise<AiPreviewChoice> {
  return showPreview(ctx, plan)
}

// ---- provenance ------------------------------------------------------------------------------------------

/**
 * `AI_KIND_PREFIX` ('ai-') and `aiCustomData(by, kind, run?)`: the `customData` an AI-made element is created
 * with (L2-1a), `lobby.ai = { by, run }` and `lobby.kind = 'ai-' + kind`. Implemented in ./provenance.ts (the
 * AI feature's own writers import it from there); the signatures are the frozen ones.
 */
export { AI_KIND_PREFIX, aiCustomData } from './provenance.ts'

// ---- placement -------------------------------------------------------------------------------------------

/** Where new AI content of `size` should go: near `near` (element ids), else the view. */
export interface AiSpotRequest {
  readonly size: { readonly w: number; readonly h: number }
  readonly near?: readonly string[]
}

/** A free spot: the top-left (scene units) and the frame it is inside, or null on the open canvas. */
export interface AiSpot {
  readonly x: number
  readonly y: number
  readonly frameId: string | null
}

/**
 * A spot for new content (W4's diagrams, W2's recap frame, W8's matrix frame): inside the home frame of `near`
 * when it has room there, else beside `near` (right of or below it, clear of what is around), else the view's
 * centre; never over existing content. Reads the canvas only (a frame that would have to grow to hold it is
 * not grown: the spot goes beside it).
 */
export function findSpot(ctx: CanvasFeatureContext, req: AiSpotRequest): AiSpot {
  return spotNear(ctx.canvas, req.size, req.near ?? [])
}

// ---- command ids (CommandSpec ids W2 registers; canvas-ux runCommand(ctx, id, source, args)) -------------

export const AI_COMMAND_IDS = {
  /** Ask this board (L2-2); args AiAskArgs: with a question it asks at once (the palette), else the question box */
  ask: 'ai.ask',
  /** Wrap up / Catch me up (L2-3); args AiRecapArgs */
  recap: 'ai.recap',
  /** Group into themes on the selection, else the frame in view (a command since wave L; the menus since wave 3) */
  themes: 'ai.themes',
  /** Action items (a command since wave L); args AiActionsArgs: vote-weighted with a revealed vote (L1-7) */
  actions: 'ai.actions',
} as const

export interface AiAskArgs {
  readonly question?: string
}
/** 'session': since the presenter's agenda started (else the first edit today); 'selection': the selected frames; 'catch-up': since this device's last visit. */
export interface AiRecapArgs {
  readonly scope?: 'session' | 'selection' | 'catch-up'
}
export interface AiActionsArgs {
  readonly voteSessionId?: string
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null

/** The args of 'ai.ask' as a caller passed them (anything else is ignored). */
export function aiAskArgs(args: unknown): AiAskArgs {
  const q = isObj(args) && typeof args.question === 'string' ? args.question.trim() : ''
  return q ? { question: q } : {}
}

export function aiRecapArgs(args: unknown): AiRecapArgs {
  const s = isObj(args) ? args.scope : undefined
  return s === 'session' || s === 'selection' || s === 'catch-up' ? { scope: s } : {}
}

export function aiActionsArgs(args: unknown): AiActionsArgs {
  const id = isObj(args) ? args.voteSessionId : undefined
  return typeof id === 'string' && /^vot_[0-9A-Za-z]{10,40}$/.test(id) ? { voteSessionId: id } : {}
}
