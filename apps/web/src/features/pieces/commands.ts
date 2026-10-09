// L8-3: the pieces' commands and the drop handler. One command per piece for the palette ('Insert decision'),
// one to open the panel, and the content handler that turns a piece dragged from the panel onto the board
// into the piece, at the pointer.
import { insertLabel, PIECE_CATEGORIES, PIECES, type PieceInfo } from '@draftroom/templates/pieces/catalog'
import { isReadonlyRole } from '../../board/access.ts'
import type { CanvasFeatureContext, CommandSpec, ContentHandlerSpec } from '../../canvas/api/index.ts'
import { failureText, insertPiece } from './insert.ts'
import { pieceOfDrop } from './model.ts'

export const PANEL_ID = 'pieces'
export const PIECE_COMMAND_IDS = {
  open: 'pieces.open',
  insert: (id: string) => `pieces.insert.${id}`,
} as const

const categoryLabel = (info: PieceInfo) =>
  PIECE_CATEGORIES.find((c) => c.id === info.category)?.label ?? info.category

/** Tells the person why an insert did not happen. */
async function insertAndTell(
  ctx: CanvasFeatureContext,
  info: PieceInfo,
  at?: { x: number; y: number } | null,
) {
  const r = await insertPiece(ctx.canvas, info.id, at ? { at } : {})
  if (!r.ok)
    ctx.notify({
      key: 'piece-insert',
      tone: 'error',
      text: failureText(r.reason),
      testId: 'piece-insert-failed',
    })
  else ctx.canvas.focus({ preventScroll: true })
}

export const COMMANDS: readonly CommandSpec[] = [
  {
    id: PIECE_COMMAND_IDS.open,
    label: 'Pieces',
    group: 'Insert',
    keywords: ['shapes', 'kit', 'flowchart', 'wireframe', 'org chart', 'storyboard', 'library'],
    run: (ctx) => ctx.openPanel(ctx.activePanel === PANEL_ID ? null : PANEL_ID),
  },
  ...PIECES.map(
    (info): CommandSpec => ({
      id: PIECE_COMMAND_IDS.insert(info.id),
      label: insertLabel(info),
      group: 'Insert',
      keywords: [info.name, categoryLabel(info), ...info.keywords, 'piece'],
      run: (ctx) => insertAndTell(ctx, info),
    }),
  ),
]

/** A piece dropped on the board (text/plain `lobby-piece:<id>`, from the panel): it lands at the pointer. */
export const DROP_HANDLER: ContentHandlerSpec = {
  id: 'pieces.drop',
  kinds: ['text'],
  // above every text handler (bulk paste 50, link cards 100): this text is never words to make notes of
  priority: 200,
  async handle(content, ctx, at, source) {
    if (content.kind !== 'text' || source !== 'drop') return false
    const id = pieceOfDrop(content.text)
    if (!id) return false
    const info = PIECES.find((p) => p.id === id)
    if (!info) return false
    // a viewer's drop never reaches here (the input layer takes it); a locked-down board says why
    if (isReadonlyRole(ctx.role, ctx.board.status) || ctx.canvas.readOnly()) return true
    await insertAndTell(ctx, info, at)
    return true
  },
}
