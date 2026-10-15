import type { Queryable } from '@draftroom/db'

export type AuditAction =
  | 'board.create'
  | 'board.visibility'
  | 'board.archive'
  | 'board.trash'
  | 'board.restore'
  | 'board.checkpoint.delete'
  | 'board.member.put'
  | 'board.member.remove'
  | 'invitation.create'
  | 'invitation.accept'
  | 'invitation.revoke'
  | 'invitation.extend'
  // G2: a link that already exists changed whether people can join it with just a name
  | 'invitation.update'
  // authz-006: a workspace member's role changed, or the member was removed (with their board grants)
  | 'workspace.member.role'
  | 'workspace.member.remove'
  // wave Q (WS2, features/library): an element library item saved, deleted or restored, a library imported, a
  // folder made or deleted (ids, scopes and counts only: never names or content)
  | 'library.item.create'
  | 'library.item.delete'
  | 'library.item.restore'
  | 'library.import'
  | 'library.folder.create'
  | 'library.folder.delete'

/** Written in the same transaction as the change it describes, so the log never disagrees with it. */
export async function audit(
  tx: Queryable,
  e: { workspaceId: string; actorId: string; action: AuditAction; target: string; detail?: object; at: Date },
): Promise<void> {
  await tx.query(
    'INSERT INTO audit_events (workspace_id, actor_id, action, target, detail, at) VALUES ($1, $2, $3, $4, $5::jsonb, $6)',
    [e.workspaceId, e.actorId, e.action, e.target, JSON.stringify(e.detail ?? {}), e.at],
  )
}
