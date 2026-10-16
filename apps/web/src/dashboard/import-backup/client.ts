// OWNER: WS4 (wave R, board backup and restore; a stub landed by the wave R foundation). The web side of the backup
// routes (@draftroom/contracts board-backup.ts; docs/WAVE-R-CONTRACTS.md §5).
//
// Frozen signatures:
//   backupTicket(boardId): Promise<BackupTicketResponse>   then open `url` as a download (the api's own origin; it
//                                                          counts as a download in the e2e policy)
//   restoreBackup(workspaceId, file, query): Promise<StartImportResponse>   the .lobby file as the request body
//                                                          (application/vnd.lobby.board+zip), then poll the job
// Both reject with ImportRequestError (`code`: 'unavailable', or the api's: BACKUP_TOO_LARGE, BACKUP_INVALID,
// BACKUP_FROM_NEWER_LOBBY, EXPORT_DISABLED, QUOTA_EXCEEDED, CREATOR_REQUIRED, …). Files are read through an
// <input type=file>, never the File System Access picker.
//
// The stub: both reject 'unavailable' without a request.
import type { BackupTicketResponse, RestoreBackupQuery, StartImportResponse } from '@draftroom/contracts'
import { importUnavailable } from '../imports/client.ts'

export function backupTicket(_boardId: string): Promise<BackupTicketResponse> {
  return importUnavailable()
}

export function restoreBackup(
  _workspaceId: string,
  _file: Blob,
  _query: RestoreBackupQuery = {},
): Promise<StartImportResponse> {
  return importUnavailable()
}
