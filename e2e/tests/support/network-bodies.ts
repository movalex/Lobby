// How NetworkLog (./workshops.ts) reads one /api response body, apart from Playwright so it can be unit-tested
// (./network-bodies.test.ts). Wave N.1 (wave N follow-up 5): `settle()` waited for every body, and the body of a
// thumbnail upload the api refused (a 429 while another tab's picture is fresh: it answers before reading the upload)
// could stay pending for good, so a spec that settled hung until its timeout. Now:
//  - a refused thumbnail upload's body is not read (the api's error JSON, nothing a spec looks for): recorded as
//    unread at once;
//  - any other body that takes longer than BODY_READ_TIMEOUT_MS is recorded as unread too, so settle() always ends,
//    and a spec that must see every body can assert that none went unread (NetworkLog.unread).

/** The part of a Playwright Response this reads. */
export interface BodyResponse {
  status(): number
  text(): Promise<string>
  request(): { method(): string }
}

/** A body still not read after this long is recorded as unread (ms). */
export const BODY_READ_TIMEOUT_MS = 10_000

const THUMBNAIL_UPLOAD = /^\/api\/boards\/[^/]+\/thumbnail$/
const TIMEOUT = Symbol('timeout')

/** A thumbnail upload the api refused: its body is never waited for. */
export const isRefusedUpload = (method: string, path: string, status: number): boolean =>
  method === 'PUT' && THUMBNAIL_UPLOAD.test(path) && status >= 400

export type BodyRead =
  | { readonly body: string; readonly unread: null }
  | { readonly body: ''; readonly unread: 'refused-upload' | 'timeout' }
  /** the browser could not give the body (a failed or aborted request): not recorded, as before */
  | null

/** Reads `res`'s body for the log, never waiting longer than `timeoutMs`. */
export async function readBody(
  res: BodyResponse,
  path: string,
  timeoutMs: number = BODY_READ_TIMEOUT_MS,
): Promise<BodyRead> {
  if (isRefusedUpload(res.request().method(), path, res.status()))
    return { body: '', unread: 'refused-upload' }
  let timer: ReturnType<typeof setTimeout> | null = null
  const timeout = new Promise<typeof TIMEOUT>((resolve) => {
    timer = setTimeout(() => resolve(TIMEOUT), timeoutMs)
  })
  try {
    const got = await Promise.race([res.text(), timeout])
    return got === TIMEOUT ? { body: '', unread: 'timeout' } : { body: got, unread: null }
  } catch {
    return null
  } finally {
    if (timer) clearTimeout(timer)
  }
}
