// Boundary between the file routes (apps/api/src/files/**) and the rest of the API.
// The API core supplies `authorize`; the file routes never read sessions or ACL tables themselves.

import type { DataLayout } from '@draftroom/dev-assets'
import type { FastifyRequest } from 'fastify'

export type FileAction = 'view' | 'edit'

export type FileAuthorization =
  | { ok: true; userId: string }
  /** 401 = not signed in; 404 = cannot view the board (never reveal it exists); 403 = can view but not edit. */
  | { ok: false; status: 401 | 403 | 404 }

export interface FilesDeps {
  layout: DataLayout
  authorize(req: FastifyRequest, boardId: string, action: FileAction): Promise<FileAuthorization>
}
