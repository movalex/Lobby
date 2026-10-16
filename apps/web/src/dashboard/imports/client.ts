// OWNER: WS1 (wave R; a stub landed by the wave R foundation, made live against WS1's job routes; WS4 uses it as it
// is). The web side of import jobs (@draftroom/contracts imports.ts; docs/WAVE-R-CONTRACTS.md §2).
//
// Frozen signatures (same origin, the session cookie, LOBBY_CLIENT_HEADER; every answer parsed with its contract schema;
// a 404 from an api without the routes, a refusal, an unreadable body or a network error is never thrown by the reads):
//   importsAvailable(): boolean                                        whether the dashboard offers any import job UI
//   getImportJob(importId): Promise<ImportJobView | null>              poll it every IMPORT_POLL_MS; null: unavailable
//   listImportJobs(workspaceId, { mine }): Promise<ImportJobView[]>    the "Imports" chip; [] when unavailable
//   importReportHref(importId): string                                 the CSV, opened as a download
// The writes reject with ImportRequestError (`code`: 'unavailable', or the api's: IMPORT_BUSY, IMPORT_WRONG_STATE,
// IMPORT_SECRET_REQUIRED, CREATOR_REQUIRED, …):
//   cancelImport(importId) / pauseImport(importId): Promise<ImportJobView>
//   resumeImport(importId, token?): Promise<ImportJobView>             a Miro job sends its token again (in the body)
//
// The stub: importsAvailable() is false, every read answers empty without a request, every write rejects
// 'unavailable'. Nothing is logged; nothing is stored in the browser (a token is never stored anywhere).
import { type ImportJobView, importReportPath } from '@draftroom/contracts'

/** An import request that did not happen: 'unavailable' (no api routes, offline) or the api's error code. */
export class ImportRequestError extends Error {
  readonly code: string
  readonly status: number | null
  constructor(code: string, status: number | null = null) {
    super(`import request failed: ${code}`)
    this.name = 'ImportRequestError'
    this.code = code
    this.status = status
  }
}

export const importUnavailable = <T>(): Promise<T> => Promise.reject(new ImportRequestError('unavailable'))

export function importsAvailable(): boolean {
  return false
}

export async function getImportJob(_importId: string): Promise<ImportJobView | null> {
  return null
}

export async function listImportJobs(
  _workspaceId: string,
  _opts: { mine?: boolean } = {},
): Promise<ImportJobView[]> {
  return []
}

export const importReportHref = (importId: string) => importReportPath(importId)

export function cancelImport(_importId: string): Promise<ImportJobView> {
  return importUnavailable()
}

export function pauseImport(_importId: string): Promise<ImportJobView> {
  return importUnavailable()
}

export function resumeImport(_importId: string, _token?: string): Promise<ImportJobView> {
  return importUnavailable()
}
