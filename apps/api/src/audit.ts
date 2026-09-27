import type { Queryable } from '@draftroom/db'

export type AuditAction =
  | 'board.create'
  | 'board.visibility'
  | 'board.archive'
  | 'board.trash'
  | 'board.restore'
  | 'board.member.put'
  | 'board.member.remove'
  | 'invitation.create'
  | 'invitation.accept'
  | 'invitation.revoke'

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
