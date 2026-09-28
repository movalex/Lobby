// The "Lobby tour" sample board (docs/WAVE3-CONTRACTS.md §2 sample-board): what the empty dashboard's
// "Start with the sample board" creates. Kept apart from template-catalog.ts, which pulls in the
// template builders; template-catalog.test.ts checks these values against the real template.

import { newBoardPath } from './template-paths.ts'

export const SAMPLE_BOARD = { templateId: 'lobby-tour', title: 'Lobby tour' } as const

export type CreateBoardFn = (
  workspaceId: string,
  input: { title: string; projectId: string | null },
) => Promise<{ id: string }>

/**
 * Creates an ordinary private board titled "Lobby tour" (the api checks that the caller may create
 * boards in the workspace) and returns where to open it: the board page inserts the tour once, on
 * that first open, like any template picked in the gallery.
 */
export async function createSampleBoard(
  createBoard: CreateBoardFn,
  workspaceId: string,
  projectId: string | null,
): Promise<string> {
  const board = await createBoard(workspaceId, { title: SAMPLE_BOARD.title, projectId })
  return newBoardPath(board.id, SAMPLE_BOARD.templateId)
}
