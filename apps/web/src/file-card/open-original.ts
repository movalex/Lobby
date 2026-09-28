import type { FileCardShape } from '@draftroom/canvas-schema'
import type { Editor } from 'tldraw'
import { originalUrl } from '../assets/contract.ts'
import type { AssetMetaStore } from '../assets/meta-store.ts'
import { guardExport } from '../features/sharing/export-policy.ts'

interface CardBoard {
  boardId: string
  metaStore: AssetMetaStore | null
}

// The shape util has no React context; the mounted cards tell it which board its editor shows.
const boards = new WeakMap<Editor, CardBoard>()

export function registerCardBoard(editor: Editor, board: CardBoard) {
  boards.set(editor, board)
}

/**
 * The card's original file, through the same board-authorized URL as its Download link, or null
 * when the card is not on a mounted board or its version does not exist.
 */
export function cardOriginalUrl(editor: Editor, props: FileCardShape['props']): string | null {
  const board = boards.get(editor)
  if (!board) return null
  if (board.metaStore?.get(board.boardId, props.assetId, props.versionId).missing) return null
  return originalUrl(board.boardId, props.assetId, props.versionId)
}

/**
 * Opens the original in a new tab: PDFs and videos are served inline, so the browser shows them;
 * anything else is served as an attachment and simply downloads. While the board owner turned
 * downloads off for this person it only says so (and counts as handled).
 */
export function openCardOriginal(editor: Editor, shape: FileCardShape): boolean {
  if (!guardExport(editor)) return true
  const url = cardOriginalUrl(editor, shape.props)
  if (!url) return false
  window.open(url, '_blank', 'noopener,noreferrer')
  return true
}
