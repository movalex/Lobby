// The thumbnail's network side: PUT the image (raw body, same origin), DELETE it when the board has no
// content, read whether one exists, and send what was left when a board closed. Every answer is mapped
// to what the scheduler should do next (scheduler.ts SendResult). No error ever reaches the person:
// a thumbnail that could not be sent just stays as it was.

import { ThumbnailMetaResponse, ThumbnailUploaded, thumbnailPath } from '@draftroom/contracts'
import { announceThumbnail } from './card-events.ts'
import type { Leftover, Rendered, SendResult } from './scheduler.ts'

/**
 * Browsers cap the bodies of all in-flight keepalive requests at 64 KiB together; a larger image goes
 * as a normal request (it still completes when the board closes in-app, not when the tab closes).
 */
export const KEEPALIVE_MAX_BYTES = 60 * 1024

type Fetch = typeof fetch

function retryAfterMs(res: Response): number {
  const s = Number(res.headers.get('retry-after'))
  return Number.isFinite(s) && s > 0 ? Math.min(s, 3600) * 1000 : 30_000
}

export async function sendThumbnail(
  boardId: string,
  r: Rendered,
  opts: { keepalive: boolean },
  fetchImpl: Fetch = (...args) => fetch(...args),
): Promise<SendResult> {
  const path = thumbnailPath(boardId)
  let res: Response
  try {
    res =
      r.kind === 'image'
        ? await fetchImpl(path, {
            method: 'PUT',
            body: r.blob,
            headers: { 'content-type': r.type },
            credentials: 'same-origin',
            cache: 'no-store',
            keepalive: opts.keepalive && r.blob.size <= KEEPALIVE_MAX_BYTES,
          })
        : await fetchImpl(path, {
            method: 'DELETE',
            credentials: 'same-origin',
            cache: 'no-store',
            keepalive: opts.keepalive,
          })
  } catch {
    return { ok: false } // offline, or the page went away mid-request
  }
  if (res.ok) {
    let version: string | null = null
    if (r.kind === 'image') {
      const parsed = ThumbnailUploaded.safeParse(await res.json().catch(() => null))
      version = parsed.success ? parsed.data.thumbnail.version : null
    }
    announceThumbnail(boardId, version)
    return { ok: true, version }
  }
  if (res.status === 429) return { ok: false, retryAfterMs: retryAfterMs(res) }
  // Signed out, or no longer allowed to edit this board: nothing more to do in this session.
  if (res.status === 401 || res.status === 403 || res.status === 404) return { ok: false, stop: true }
  // The api refused this image as such (400, 413, 415): trying it again would not help.
  if (res.status >= 400 && res.status < 500) return { ok: false, drop: true }
  return { ok: false }
}

/** Whether the board has a thumbnail: true/false, or undefined when that could not be read. */
export async function hasStoredThumbnail(
  boardId: string,
  signal: AbortSignal,
  fetchImpl: Fetch = (...args) => fetch(...args),
): Promise<boolean | undefined> {
  try {
    const res = await fetchImpl(`${thumbnailPath(boardId)}/meta`, {
      headers: { accept: 'application/json' },
      credentials: 'same-origin',
      cache: 'no-store',
      signal,
    })
    if (!res.ok) return undefined
    const parsed = ThumbnailMetaResponse.safeParse(await res.json().catch(() => null))
    return parsed.success ? parsed.data.thumbnail !== null : undefined
  } catch {
    return undefined
  }
}

/** Leftovers per board, sent once their window opens (a newer one for the same board replaces it). */
const leftovers = new Map<string, ReturnType<typeof setTimeout>>()

/**
 * Sends what a closed board had rendered but not sent. Runs outside the board (the page lives on:
 * closing a board is an in-app navigation), once the api's per-board window allows it.
 */
export function sendLeftover(
  boardId: string,
  leftover: Leftover,
  deps: { now?: () => number; send?: typeof sendThumbnail } = {},
): void {
  const now = deps.now ?? Date.now
  const send = deps.send ?? sendThumbnail
  const waiting = leftovers.get(boardId)
  if (waiting !== undefined) clearTimeout(waiting)
  const go = () => {
    leftovers.delete(boardId)
    void send(boardId, leftover.rendered, { keepalive: true })
  }
  const delay = leftover.notBefore - now()
  if (delay <= 0) {
    leftovers.delete(boardId)
    go()
    return
  }
  leftovers.set(boardId, setTimeout(go, delay))
}
