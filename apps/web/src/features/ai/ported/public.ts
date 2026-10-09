// OWNER: W2 (wave L, "AI on the board"). The web AI feature's cross-workstream API: W3 (the palette and
// plain-language commands), W4 (Diagram from words), W5 (Facilitate > Wrap up) and W8 (sort by a lens, 2x2
// placement) import ONLY this file from features/ai. Frozen at the wave L foundation: the names, signatures
// and semantics below; W2 replaces the bodies.
//
// Foundation state (safe defaults, nothing changes for anyone today):
// - runAi resolves null and sends nothing (callers treat null as "nothing to apply");
// - showAiPreview resolves 'discard' and writes nothing (nothing is applied without the preview);
// - findSpot returns the view's centre, with no frame (W2's body uses apply.ts's spot rules);
// - aiCustomData is final (pure).
// The command ids are registered by W2 ('ai.themes' and 'ai.actions' already are, in ./menus.tsx); running an
// id nobody registered yet is a no-op (canvas-ux runCommand answers false).

import type { AiResult, AiRunInput } from '@draftroom/contracts'
import type { CanvasFeatureContext } from '../../../canvas/api/index.ts'

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
 *
 * Foundation stub: resolves null, sends nothing.
 */
export async function runAi(ctx: CanvasFeatureContext, input: AiRunInput): Promise<AiResult | null> {
  void ctx
  void input
  return null
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
  }[]
}

/** The person's choice: apply the plan, ask again (a new budgeted call), or drop it. */
export type AiPreviewChoice = 'apply' | 'retry' | 'discard'

/**
 * Shows `plan` over the board (a screen-layer overlay: destination outlines, move arrows, recolour swatches,
 * the bounds of new elements and the count line, static under reduced motion) and resolves the person's
 * choice. Nothing is written before it resolves; the caller writes on 'apply' (one transact), calls again on
 * 'retry' and does nothing on 'discard'. One preview at a time per canvas: a second call while one is open
 * resolves the first with 'discard'. Escape, closing the board or losing edit rights is 'discard'.
 *
 * Foundation stub: resolves 'discard' (nothing is ever applied without the preview).
 */
export async function showAiPreview(
  ctx: CanvasFeatureContext,
  plan: AiPreviewPlan,
): Promise<AiPreviewChoice> {
  void ctx
  void plan
  return 'discard'
}

// ---- provenance ------------------------------------------------------------------------------------------

/** The `customData.lobby.kind` prefix of AI-made elements. */
export const AI_KIND_PREFIX = 'ai-'
/** A kind word after the prefix: what canvas-schema's `kind` value allows (32 characters with the prefix). */
const KIND_WORD = /^[a-z][a-z0-9-]{0,28}$/

/**
 * The `customData` an AI-made element is created with (L2-1a): `lobby.ai = { by, run }` (canvas-schema
 * AiValue: `run` is the AiResult's run id) and `lobby.kind = 'ai-' + kind` ('theme-label', 'recap-heading',
 * 'recap-item', 'answer', 'diagram-node', …). `run` null or absent leaves it out (an element made before wave
 * L, or by a path with no run). Throws for a kind word the schema would refuse (a programming error).
 */
export function aiCustomData(
  by: string,
  kind: string,
  run?: string | null,
): { lobby: { ai: { by: string; run?: string }; kind: string } } {
  if (!KIND_WORD.test(kind)) throw new Error(`aiCustomData: not a kind word: ${JSON.stringify(kind)}`)
  return { lobby: { ai: run ? { by, run } : { by }, kind: `${AI_KIND_PREFIX}${kind}` } }
}

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
 * centre; never over existing content. Reads the canvas only.
 *
 * Foundation stub: the view's centre, on the open canvas (no frame, no obstacle check).
 */
export function findSpot(ctx: CanvasFeatureContext, req: AiSpotRequest): AiSpot {
  const v = ctx.canvas.viewport.get()
  return {
    x: v.x + v.width / 2 - req.size.w / 2,
    y: v.y + v.height / 2 - req.size.h / 2,
    frameId: null,
  }
}

// ---- command ids (CommandSpec ids W2 registers; canvas-ux runCommand(ctx, id, source, args)) -------------

export const AI_COMMAND_IDS = {
  /** Ask this board (L2-2); args AiAskArgs: the palette's "Ask: <query>" prefills the question */
  ask: 'ai.ask',
  /** Wrap up / Catch me up (L2-3); args AiRecapArgs */
  recap: 'ai.recap',
  /** Group into themes (registered since wave 3) */
  themes: 'ai.themes',
  /** Action items (registered since wave 3); args AiActionsArgs: vote-weighted with a revealed vote (L1-7) */
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
