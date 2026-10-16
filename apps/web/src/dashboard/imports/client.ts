// OWNER: WS1 (wave R; landed as a stub by the wave R foundation, live against WS1's job routes; WS4 uses it as it is).
// The web side of import jobs (@draftroom/contracts imports.ts; docs/WAVE-R-CONTRACTS.md §2).
//
// Frozen signatures (same origin, the session cookie, LOBBY_CLIENT_HEADER through the api client; every answer parsed
// with its contract schema; a 404 from an api without the routes, a refusal, an unreadable body or a network error is
// never thrown by the reads):
//   importsAvailable(): boolean                                        whether the dashboard offers any import job UI
//   getImportJob(importId): Promise<ImportJobView | null>              poll it every IMPORT_POLL_MS; null: unavailable
//   listImportJobs(workspaceId, { mine }): Promise<ImportJobView[]>    the "Imports" chip; [] when unavailable
//   importReportHref(importId): string                                 the CSV, opened as a download
// The writes reject with ImportRequestError (`code`: 'unavailable', or the api's: IMPORT_BUSY, IMPORT_WRONG_STATE,
// IMPORT_SECRET_REQUIRED, CREATOR_REQUIRED, …):
//   cancelImport(importId) / pauseImport(importId): Promise<ImportJobView>    202
//   resumeImport(importId, token?): Promise<ImportJobView>             202; a Miro job sends its token again, in the
//                                                                       JSON body only (never a URL or a header)
//
// Nothing is logged; nothing is stored in the browser (a token is never stored anywhere). An error carries a code and
// a status only, never the server's words or anything that was sent.
import {
  ImportJobView,
  importCancelPath,
  importJobPath,
  importListPath,
  importPausePath,
  importReportPath,
  importResumePath,
  ListImportJobsResponse,
} from '@draftroom/contracts'
import { api, isApiError } from '../../api/client.ts'

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

/** Codes the api client makes up when the api said nothing it could read: no answer, an unreadable one. */
const SYNTHETIC_CODE = /^(?:HTTP_\d+|NETWORK|BAD_RESPONSE)$/

/**
 * What a failed import request becomes: the api's own error code (from its `{ error: { code, message } }` body) with
 * the status, or 'unavailable' (offline, an answer without a readable error body, a 2xx this build cannot parse).
 */
export function importErrorOf(e: unknown): ImportRequestError {
  if (e instanceof ImportRequestError) return e
  if (isApiError(e)) {
    if (e.kind === 'network' || SYNTHETIC_CODE.test(e.code))
      return new ImportRequestError('unavailable', e.status || null)
    return new ImportRequestError(e.code, e.status)
  }
  return new ImportRequestError('unavailable')
}

export function importsAvailable(): boolean {
  return true
}

export async function getImportJob(importId: string): Promise<ImportJobView | null> {
  try {
    return await api.request('GET', importJobPath(importId), { schema: ImportJobView })
  } catch {
    return null
  }
}

export async function listImportJobs(
  workspaceId: string,
  opts: { mine?: boolean } = {},
): Promise<ImportJobView[]> {
  try {
    const r = await api.request('GET', importListPath(workspaceId, opts.mine === true), {
      schema: ListImportJobsResponse,
    })
    return r.imports
  } catch {
    return []
  }
}

export const importReportHref = (importId: string) => importReportPath(importId)

async function write(path: string, body?: { token: string }): Promise<ImportJobView> {
  try {
    return await api.request(
      'POST',
      path,
      body === undefined ? { schema: ImportJobView } : { schema: ImportJobView, body },
    )
  } catch (e) {
    throw importErrorOf(e)
  }
}

export function cancelImport(importId: string): Promise<ImportJobView> {
  return write(importCancelPath(importId))
}

export function pauseImport(importId: string): Promise<ImportJobView> {
  return write(importPausePath(importId))
}

export function resumeImport(importId: string, token?: string): Promise<ImportJobView> {
  return write(importResumePath(importId), token === undefined ? undefined : { token })
}
