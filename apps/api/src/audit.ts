import type { Queryable } from '@draftroom/db'

/**
 * Every action the audit log records, in one list (wave W WS5: the three that were written by raw SQL, the file
 * collector's `asset.gc_delete`, the Internal-only switches and a board owner's `comment.moderate_delete`, moved in
 * here, and every writer now goes through `audit()` below). The workspace admin page shows each one through its entry
 * in features/workspace-admin/audit-view.ts; a test fails when an action has none, or when a module writes the table
 * itself.
 */
export const AUDIT_ACTIONS = [
  'board.create',
  'board.visibility',
  'board.archive',
  'board.trash',
  'board.restore',
  'board.checkpoint.delete',
  'board.member.put',
  'board.member.remove',
  'invitation.create',
  'invitation.accept',
  'invitation.revoke',
  'invitation.extend',
  // G2: a link that already exists changed whether people can join it with just a name
  'invitation.update',
  // authz-006: a workspace member's role changed, or the member was removed (with their board grants)
  'workspace.member.role',
  'workspace.member.remove',
  // wave Q (WS2, features/library): an element library item saved, deleted or restored, a library imported, a
  // folder made or deleted (ids, scopes and counts only: never names or content)
  'library.item.create',
  'library.item.delete',
  'library.item.restore',
  'library.import',
  'library.folder.create',
  'library.folder.delete',
  // wave R (the foundation's import runner, features/imports): an import job's board was started (an `importing`
  // row nobody sees), or removed again (failed, cancelled, expired); its activation writes `board.create` with
  // `via` (ids, sources and counts only: never a token, a URL or content)
  'board.import.start',
  'board.import.discard',
  // wave R (WS2, features/chat-hooks): a chat hook added, changed or removed (ids and providers only, never a URL)
  'chat_hook.create',
  'chat_hook.update',
  'chat_hook.delete',
  // the file collector deleted a version nothing referenced (files/gc.ts; no person: actor null)
  'asset.gc_delete',
  // wave J: the "Internal only" switch of a workspace or a project (features/dashboard/outside.ts)
  'workspace.internal_only',
  'project.internal_only',
  // a board owner deleted someone else's comment (features/comments; the body is never copied into the log)
  'comment.moderate_delete',
] as const

export type AuditAction = (typeof AUDIT_ACTIONS)[number]

/** Written in the same transaction as the change it describes, so the log never disagrees with it. */
export async function audit(
  tx: Queryable,
  e: {
    workspaceId: string
    /** null: no person did it (a sweep) */
    actorId: string | null
    action: AuditAction
    target: string
    detail?: object
    at: Date
  },
): Promise<void> {
  await tx.query(
    'INSERT INTO audit_events (workspace_id, actor_id, action, target, detail, at) VALUES ($1, $2, $3, $4, $5::jsonb, $6)',
    [e.workspaceId, e.actorId, e.action, e.target, JSON.stringify(e.detail ?? {}), e.at],
  )
}
