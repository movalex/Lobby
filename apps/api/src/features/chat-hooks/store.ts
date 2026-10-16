// Chat hook rows and what a browser may see of them (wave R, WS2; docs/WAVE-R-CONTRACTS.md §4). The sealed URL is read
// only by the delivery loop and the test route (open it, post to it, drop it); every answer to a browser is `toChatHook`,
// which carries the hint and never the URL.

import {
  type ChatHook,
  type ChatHookDisableReason,
  type ChatHookProvider,
  cleanDisplayText,
} from '@draftroom/contracts'
import type { Queryable } from '@draftroom/db'

export interface HookRow {
  id: string
  workspace_id: string
  name: string
  provider: ChatHookProvider
  url_sealed: Uint8Array
  key_id: string
  url_hint: string
  include_snippets: boolean
  created_by: string | null
  created_by_name: string | null
  created_at: Date
  disabled_at: Date | null
  disabled_reason: ChatHookDisableReason | null
  last_ok_at: Date | null
  last_error_code: string | null
}

export const HOOK_COLUMNS = `h.id, h.workspace_id, h.name, h.provider, h.url_sealed, h.key_id, h.url_hint,
  h.include_snippets, h.created_by, cu.name AS created_by_name, h.created_at, h.disabled_at, h.disabled_reason,
  h.last_ok_at, h.last_error_code`

export const HOOK_FROM = 'FROM chat_hooks h LEFT JOIN users cu ON cu.id = h.created_by'

const iso = (d: Date | null) => (d ? d.toISOString() : null)

/** The hook as a browser sees it: the hint, never the URL. */
export function toChatHook(r: HookRow): ChatHook {
  return {
    id: r.id,
    name: r.name,
    provider: r.provider,
    hint: r.url_hint,
    includeSnippets: r.include_snippets,
    createdBy:
      r.created_by && r.created_by_name !== null
        ? { id: r.created_by, name: cleanDisplayText(r.created_by_name) || 'Someone' }
        : null,
    createdAt: r.created_at.toISOString(),
    disabledAt: iso(r.disabled_at),
    disabledReason: r.disabled_reason,
    lastOkAt: iso(r.last_ok_at),
    lastErrorCode: r.last_error_code,
  }
}

/** One hook of a workspace (null: no such hook there). */
export function findHook(q: Queryable, workspaceId: string, hookId: string): Promise<HookRow | null> {
  return q.maybeOne<HookRow>(
    `SELECT ${HOOK_COLUMNS} ${HOOK_FROM} WHERE h.workspace_id = $1 AND h.id = $2`,
    [workspaceId, hookId],
  )
}

/** Every hook of a workspace, oldest first. */
export async function listHooks(q: Queryable, workspaceId: string): Promise<HookRow[]> {
  const rows = await q.query<HookRow>(
    `SELECT ${HOOK_COLUMNS} ${HOOK_FROM} WHERE h.workspace_id = $1 ORDER BY h.created_at, h.id`,
    [workspaceId],
  )
  return rows.rows
}
