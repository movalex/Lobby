import { type AssetVersionMeta, isId, sanitizeDisplayName, uploadUrl } from './contract.ts'

export class UploadError extends Error {
  readonly code: string
  readonly status: number
  /** the error body's other top-level keys (wave S: VERSION_NOT_LATEST's latestVersionId) */
  readonly details: Readonly<Record<string, unknown>>
  constructor(
    code: string,
    message: string,
    status: number,
    details: Readonly<Record<string, unknown>> = {},
  ) {
    super(message)
    this.name = 'UploadError'
    this.code = code
    this.status = status
    this.details = details
  }
}

export interface UploadOptions {
  boardId: string
  file: File
  signal?: AbortSignal
  fetchImpl?: typeof fetch
  /** more request headers (wave S: X-Lobby-Supersedes, versions/client.ts supersedesHeader) */
  headers?: Record<string, string>
}

/**
 * POSTs the raw bytes to the board's upload route (docs/M1-CONTRACTS.md §5: needs `edit` on the board;
 * identity comes from the session cookie, which a same-origin fetch sends). The browser sets
 * Content-Length for a File body; the server rejects uploads without it (411) and enforces the size
 * limits itself.
 */
export async function uploadFile({
  boardId,
  file,
  signal,
  fetchImpl = fetch,
  headers,
}: UploadOptions): Promise<AssetVersionMeta> {
  const url = uploadUrl(boardId)
  let res: Response
  try {
    res = await fetchImpl(url, {
      method: 'POST',
      body: file,
      signal,
      credentials: 'same-origin',
      headers: {
        ...headers,
        'Content-Type': file.type || 'application/octet-stream',
        'X-File-Name': encodeURIComponent(sanitizeDisplayName(file.name)),
      },
    })
  } catch (e) {
    if (signal?.aborted) throw e
    throw new UploadError('NETWORK', 'Upload failed: the server could not be reached.', 0)
  }
  if (!res.ok) throw await errorFromResponse(res)
  const meta = (await res.json().catch(() => null)) as AssetVersionMeta | null
  if (!meta || !isId('ast', meta.assetId) || !isId('ver', meta.versionId)) {
    throw new UploadError('BAD_RESPONSE', 'Upload failed: unexpected server response.', res.status)
  }
  return meta
}

const FALLBACK_MESSAGES: Record<number, string> = {
  400: 'Upload rejected.',
  401: 'Your session has ended. Sign in again to upload.',
  403: 'You cannot upload to this board.',
  411: 'Upload rejected: missing file size.',
  413: 'This file is too large.',
  415: 'This file type is not supported.',
}

async function errorFromResponse(res: Response): Promise<UploadError> {
  // Server messages are user-safe by contract; anything else gets a generic message.
  const body = (await res.json().catch(() => null)) as {
    error?: { code?: unknown; message?: unknown }
    [key: string]: unknown
  } | null
  const code = typeof body?.error?.code === 'string' ? body.error.code : `HTTP_${res.status}`
  const message =
    typeof body?.error?.message === 'string' && body.error.message.length <= 300
      ? body.error.message
      : (FALLBACK_MESSAGES[res.status] ?? 'Upload failed.')
  const { error: _error, ...details } = body && typeof body === 'object' ? body : {}
  return new UploadError(code, message, res.status, details)
}
