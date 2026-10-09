// OWNER: W3 (wave L, L3-3). Running board command ops on the board: compiled into one transact
// (./compile.ts), shown first in the shared AI preview (features/ai/ported/public.ts showAiPreview) when they
// change more than one element (grammar results too: "make all red notes yellow" is a preview, then one undo
// step), then selection and camera, and a toast that names what was left alone.
import type { AiCommandOp } from '@draftroom/contracts'
import type { CanvasFeatureContext } from '../../../canvas/api/index.ts'
import { showAiPreview } from '../ported/public.ts'
import {
  applyCompiled,
  type CommandMode,
  type CompiledCommand,
  compileCommand,
  skipsText,
  writesAnything,
} from './compile.ts'

export interface BoardCommand {
  readonly ops: readonly AiCommandOp[]
  readonly mode: CommandMode
  /** what it does, in words: the preview's heading and the undo step's label */
  readonly title: string
  /** the AI run's id, or the grammar's own id for the plan */
  readonly runId: string
}

export type BoardCommandOutcome = 'applied' | 'moved-camera' | 'discarded' | 'nothing' | 'read-only'

/** The preview's count line ('Changes 6 notes: 4 recoloured, 2 moved'). */
export function summaryOf(c: CompiledCommand): string {
  const n = c.changed.length
  const parts: string[] = []
  if (c.preview.recolors.length) parts.push(`${c.preview.recolors.length} recoloured`)
  if (c.preview.moves.length) parts.push(`${c.preview.moves.length} moved`)
  if (c.frames.length)
    parts.push(`${c.frames.length === 1 ? 'a new frame' : `${c.frames.length} new frames`}`)
  const head = `Changes ${n} ${n === 1 ? 'item' : 'items'}`
  return parts.length ? `${head}: ${parts.join(', ')}` : head
}

let grammarRuns = 0
/** A stable id for one grammar plan (the preview's runId: grammar plans have no AI run). */
export const grammarRunId = (): string => `grammar-${Date.now().toString(36)}-${(++grammarRuns).toString(36)}`

/**
 * Runs `cmd` on the board. `retry`: the preview's Try again (an AI command asks again, a new budgeted call);
 * without it Try again is Discard. Resolves what happened.
 */
export async function runBoardCommand(
  ctx: CanvasFeatureContext,
  first: BoardCommand,
  retry?: () => Promise<BoardCommand | null>,
): Promise<BoardCommandOutcome> {
  const { canvas } = ctx
  let cmd = first
  let compiled = compileCommand(canvas, cmd.ops, cmd.mode)
  for (;;) {
    if (!writesAnything(compiled)) break
    if (canvas.readOnly()) {
      ctx.notify({
        key: 'board-command',
        text: 'You can view this board, not change it.',
        testId: 'board-command-notice',
      })
      return 'read-only'
    }
    if (compiled.changed.length <= 1) break
    const choice = await showAiPreview(ctx, {
      runId: cmd.runId,
      title: cmd.title,
      summary: summaryOf(compiled),
      ...compiled.preview,
    })
    if (choice === 'retry' && retry) {
      const next = await retry()
      if (!next) return 'nothing'
      cmd = next
      compiled = compileCommand(canvas, cmd.ops, cmd.mode)
      continue
    }
    if (choice !== 'apply') return 'discarded'
    // the board may have moved on while the preview was open: write what holds now
    compiled = compileCommand(canvas, cmd.ops, cmd.mode)
    break
  }
  const wrote = writesAnything(compiled) && !canvas.readOnly()
  if (wrote) applyCompiled(canvas, compiled, cmd.title)
  if (compiled.select) canvas.select(compiled.select)
  if (compiled.zoom?.length) {
    const b = canvas.boundsOf(compiled.zoom)
    if (b) canvas.viewport.zoomTo(b, { maxZoom: 1, inset: 60, animate: { durationMs: 260 } })
  }
  const notes = [skipsText(compiled.skipped), ...compiled.problems].filter((x): x is string => !!x)
  const nothing = !wrote && !compiled.select && !compiled.zoom
  if (nothing && !notes.length) notes.unshift('Nothing on this board needed changing.')
  if (notes.length)
    ctx.notify({
      key: 'board-command',
      text: notes.join(' '),
      testId: 'board-command-notice',
      timeoutMs: 7000,
    })
  canvas.focus({ preventScroll: true })
  if (wrote) return 'applied'
  return compiled.select || compiled.zoom ? 'moved-camera' : 'nothing'
}
