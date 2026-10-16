// OWNER: WS4 (wave R, board backup and restore). The web side of the backup routes (@draftroom/contracts
// board-backup.ts; docs/WAVE-R-CONTRACTS.md §5).
//
// Frozen signatures:
//   backupTicket(boardId): Promise<BackupTicketResponse>   then open `url` as a download (the api's own origin; it
//                                                          counts as a download in the e2e policy)
//   restoreBackup(workspaceId, file, query): Promise<StartImportResponse>   the .lobby file as the request body
//                                                          (application/vnd.lobby.board+zip), then poll the job
// Both reject with ImportRequestError (`code`: 'unavailable' when the request never got an answer, or the api's:
// BACKUP_TOO_LARGE, BACKUP_INVALID, BACKUP_FROM_NEWER_LOBBY, EXPORT_DISABLED, QUOTA_EXCEEDED, CREATOR_REQUIRED, …).
// Files are read through an <input type=file>, never the File System Access picker. Same origin, the session cookie,
// LOBBY_CLIENT_HEADER; nothing is logged or stored in the browser.
import {
  BACKUP_MIME_TYPE,
  BackupTicketResponse,
  backupTicketPath,
  LOBBY_CLIENT_HEADER,
  LOBBY_CLIENT_REV,
  type RestoreBackupQuery,
  restoreBackupPath,
  StartImportResponse,
} from '@draftroom/contracts'
import type { z } from 'zod'
import { ImportRequestError } from '../imports/client.ts'

async function send<S extends z.ZodType>(
  path: string,
  init: { body?: Blob; contentType?: string },
  schema: S,
): Promise<z.output<S>> {
  const headers: Record<string, string> = {
    accept: 'application/json',
    [LOBBY_CLIENT_HEADER]: String(LOBBY_CLIENT_REV),
  }
  if (init.contentType) headers['content-type'] = init.contentType
  let res: Response
  try {
    res = await fetch(path, {
      method: 'POST',
      headers,
      body: init.body,
      credentials: 'same-origin',
      cache: 'no-store',
    })
  } catch {
    throw new ImportRequestError('unavailable')
  }
  const raw: unknown = await res.json().catch(() => null)
  if (!res.ok) {
    const code = (raw as { error?: { code?: unknown } } | null)?.error?.code
    throw new ImportRequestError(typeof code === 'string' ? code : `HTTP_${res.status}`, res.status)
  }
  const parsed = schema.safeParse(raw)
  if (!parsed.success) throw new ImportRequestError('BAD_RESPONSE', res.status)
  return parsed.data
}

export function backupTicket(boardId: string): Promise<BackupTicketResponse> {
  return send(backupTicketPath(boardId), {}, BackupTicketResponse)
}

export function restoreBackup(
  workspaceId: string,
  file: Blob,
  query: RestoreBackupQuery = {},
): Promise<StartImportResponse> {
  const qs = new URLSearchParams()
  if (query.projectId) qs.set('projectId', query.projectId)
  if (query.title) qs.set('title', query.title)
  const search = qs.toString()
  const path = `${restoreBackupPath(workspaceId)}${search ? `?${search}` : ''}`
  return send(path, { body: file, contentType: BACKUP_MIME_TYPE }, StartImportResponse)
}

/** What the dialog and the board say for a refusal (the api's own codes; anything else is generic). */
export const BACKUP_ERROR_TEXT: Readonly<Record<string, string>> = {
  BACKUP_INVALID: 'This file is not a Lobby backup this server can read.',
  BACKUP_TOO_LARGE: 'This backup is larger than Lobby can take (at most 5,000 files and 2 GB of them).',
  BACKUP_FROM_NEWER_LOBBY:
    'This backup was made by a newer version of Lobby. Try again once this one is updated.',
  EXPORT_DISABLED: 'The board’s owner turned off downloads for you on this board.',
  QUOTA_EXCEEDED:
    'This backup doesn’t fit in the workspace’s file storage. Ask the workspace owner for more space.',
  CREATOR_REQUIRED: 'Only people who can create boards here can restore a backup.',
  IMPORT_BUSY: 'An import is already running. Wait for it to finish, then try again.',
  IMPORT_DAILY_LIMIT: 'You started the most imports allowed for today. Try again tomorrow.',
  GUEST_ACCOUNT_REQUIRED:
    'Board backups are for people with an account. Sign in with an account to use them.',
  unavailable: 'Can’t reach Lobby. Check your connection and try again.',
}
export const backupErrorText = (code: string) =>
  BACKUP_ERROR_TEXT[code] ?? 'Lobby could not do that. Try again in a moment.'
