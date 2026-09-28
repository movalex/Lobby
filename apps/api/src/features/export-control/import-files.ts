// Export control for board imports (features/history, POST /api/workspaces/:wid/boards/import).
//
// An import links every file its records name that the importer can VIEW on some board of the workspace
// (history/files.ts filesViewableBy), and the new board is the importer's own, where no policy limits
// them. A viewer limited on a board (policy 'editors') sees its asset and version ids through sync, so a
// hand-made archive naming them would link the files to a board of their own and hand out the originals
// there. So an import keeps only the files the importer may also DOWNLOAD through some board that
// shows them; the rest are dropped like files they cannot see (they show as missing).
//
// Kept apart from ./policy.ts, which files-auth.ts imports: this module needs files-auth.ts in turn.

import type { Queryable } from '@draftroom/db'
import { can } from '@draftroom/permissions'
import { loadBoardAccess } from '../../access.ts'
import { loadVersionRows } from '../../files/meta.ts'
import { boardsShowingAsset } from '../../files-auth.ts'
import { mayExport } from './policy.ts'

interface FileRef {
  assetId: string
  versionId: string
}

/** Of `refs`, those shown on a board of the workspace where `userId` may view AND download. */
export async function keepDownloadableFiles<T extends FileRef>(
  q: Queryable,
  workspaceId: string,
  userId: string,
  refs: readonly T[],
): Promise<{ kept: T[]; dropped: T[] }> {
  const kept: T[] = []
  const dropped: T[] = []
  const allowedOn = new Map<string, boolean>()
  const rows = await loadVersionRows(q, refs)
  for (const ref of refs) {
    const row = rows.get(`${ref.assetId}/${ref.versionId}`)
    let ok = false
    if (row) {
      for (const boardId of await boardsShowingAsset(q, workspaceId, {
        ...ref,
        ownerBoardId: row.board_id,
      })) {
        if (!allowedOn.has(boardId)) {
          const access = await loadBoardAccess(q, boardId, userId)
          allowedOn.set(
            boardId,
            !!access && can(access.role, 'view', access.board.status) && (await mayExport(q, access)),
          )
        }
        if (allowedOn.get(boardId)) {
          ok = true
          break
        }
      }
    }
    ;(ok ? kept : dropped).push(ref)
  }
  return { kept, dropped }
}
