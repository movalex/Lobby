// OWNER: W3 (wave L, L3-3). The palette's "Do" lines: what is typed, read as a board command.
//  - The local grammar first (./grammar.ts): a phrase it knows becomes "Make 3 red notes in “Ideas” yellow",
//    the top line, at no cost and with no call. One it understands but cannot do here says why.
//  - When the grammar does not know the phrase and AI is offered to this person on this board, "Do with AI:
//    <text>" (editors: mode 'do') or "Find with AI: <text>" (read-only roles: mode 'find', select and zoom
//    only) calls W2's runAi with action 'command'; its ops go through the same compile, preview and toast.
//  - "Ask: <text>" opens W2's Ask this board ('ai.ask') with the question filled in.
// Whether AI is offered here is the AI feature's to say: 'ai.ask' is registered and may run (W2 registers it
// with the board's AI status), so nothing is offered before W2's feature lands, and a guest never sees it.
import type { AiCommandOp } from '@draftroom/contracts'
import { type CanvasFeatureContext, commandRunnable } from '../../../canvas/api/index.ts'
import { runCommand } from '../../canvas-ux/ported/commands.ts'
import type { PaletteEntry } from '../../command-palette/model.ts'
import { AI_COMMAND_IDS, runAi } from '../ported/public.ts'
import { boardFacts, selectionRoots } from './facts.ts'
import { parseCommand, type Resolved, resolveCommand } from './grammar.ts'
import { type BoardCommand, grammarRunId, runBoardCommand } from './run.ts'

/** A query shorter than this offers no Do or Ask line. */
export const DO_MIN_CHARS = 3
const READ_ONLY = 'You can find and select on this board, not change it'

/** Whether AI is offered to this person here (W2's 'ai.ask' is registered and may run). */
export function aiOffered(ctx: CanvasFeatureContext): boolean {
  const ask = ctx.registries.commands.get(AI_COMMAND_IDS.ask)
  return !!ask && commandRunnable(ask, ctx)
}

/** Words that point at the selection: then AI is asked about the selection, else about the whole board. */
const POINTS_AT_SELECTION = /\b(?:these|this|those|that|them|it|selected|selection)\b/i

/** Runs the AI fallback: one budgeted call; its ops are compiled, previewed and applied like the grammar's. */
export async function runAiCommand(ctx: CanvasFeatureContext, instruction: string): Promise<void> {
  const mode = ctx.canvas.readOnly() ? 'find' : 'do'
  const scope = POINTS_AT_SELECTION.test(instruction)
    ? selectionRoots(ctx.canvas).map((id) => `shape:${id}`)
    : []
  const ask = async (): Promise<BoardCommand | null> => {
    const result = await runAi(ctx, { action: 'command', instruction, mode, shapeIds: scope })
    if (result?.action !== 'command') return null
    if (!result.ops.length) {
      ctx.notify({
        key: 'board-command',
        text: result.explain ? `AI found nothing to do: ${result.explain}` : 'AI found nothing to do.',
        testId: 'board-command-notice',
        timeoutMs: 7000,
      })
      return null
    }
    return {
      ops: result.ops as readonly AiCommandOp[],
      mode,
      title: result.explain || instruction,
      runId: result.runId,
    }
  }
  const first = await ask()
  if (first) await runBoardCommand(ctx, first, ask)
}

/** The Do and Ask lines for `query` (none for a short one). */
export function commandEntries(ctx: CanvasFeatureContext, query: string): PaletteEntry[] {
  const q = query.trim()
  if ([...q].length < DO_MIN_CHARS) return []
  const out: PaletteEntry[] = []
  const readOnly = ctx.canvas.readOnly()
  const sentence = q.split(/\s+/).length >= 3
  // the words first (cheap): the board is read only for a phrase the grammar knows
  const parsed = parseCommand(q)
  const resolved: Resolved | null = parsed ? resolveCommand(parsed, boardFacts(ctx.canvas)) : null
  const r = resolved && !resolved.ok && resolved.fallThrough ? null : resolved
  if (r?.ok) {
    out.push({
      id: 'do:grammar',
      label: r.title,
      group: 'Do',
      detail: r.find ? 'Selects and shows; changes nothing' : 'One undo step',
      pinned: 2000,
      disabledReason: !r.find && readOnly ? READ_ONLY : null,
      run: () => {
        void runBoardCommand(ctx, {
          ops: r.ops,
          mode: r.find ? 'find' : 'do',
          title: r.title,
          runId: grammarRunId(),
        })
      },
    })
  } else if (r) {
    out.push({
      id: 'do:grammar',
      label: `Do: ${q}`,
      group: 'Do',
      pinned: 2000,
      disabledReason: r.reason,
      run: () => {},
    })
  }
  const ai = aiOffered(ctx)
  if (ai && !r?.ok) {
    out.push({
      id: 'do:ai',
      label: `${readOnly ? 'Find' : 'Do'} with AI: ${q}`,
      group: 'AI',
      detail: readOnly ? 'Selects and shows what matches' : 'Shows a preview before anything changes',
      pinned: sentence ? 560 : 260,
      run: () => {
        void runAiCommand(ctx, q)
      },
    })
  }
  if (ai) {
    out.push({
      id: 'ask',
      label: `Ask: ${q}`,
      group: 'AI',
      detail: 'Ask this board, with sources',
      pinned: sentence ? 550 : 250,
      run: () => {
        runCommand(ctx, AI_COMMAND_IDS.ask, 'palette', { question: q })
      },
    })
  }
  return out
}
