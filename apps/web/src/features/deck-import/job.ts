// OWNER: WS4 (wave W, deck import; docs/WAVE-W-CONTRACTS.md §6, §3.4). Getting a deck's page pictures ready before its
// slides are placed: the preview made pages 1..8; pages 9..min(N, 100) are asked for with
// POST /api/files/:ver/render-pages (worker ops, one per run of 30) and waited for.
//
// "Ready" is decided on the version's meta (the meta route lists every `page` derivative, the preview's and the
// ops'), asked again when the requester's `file.op` says an op of this file is done, after every event-stream
// (re)connect, and every few seconds meanwhile (an event is a hint: a missed one only delays). Failure comes from an
// op of this file reported failed or cancelled (its code's fixed message, contracts WORKER_OP_MESSAGES: WORKER_BUSY for a
// request still queued 30 minutes after it was made, WORKER_UNAVAILABLE when no capable worker checked in for 10), from
// the op's own state route when it answers (GET /api/file-ops/:op), or, last, from a local time limit that never fires
// before the api's own deadline (DECK_WAIT_MS). While the ops wait for the file worker the dialog says so (`queued`);
// once one runs it shows the pages being made. 409 NOTHING_TO_RENDER means the pages exist already; 409 FILE_OP_ACTIVE
// that someone's request is making them (then only the meta tells); 403 GUEST_ACCOUNT_REQUIRED that this person may
// place the first 8 only.
//
// Reads only: nothing here writes to the board (./place.ts does, once, after this).
import {
  FILE_OP_EVENT,
  FileOpEvent,
  FileOpState,
  FORMAT_ERROR_CODES,
  fileOpPath,
  renderPagesPath,
  WORKER_OP_LIMITS,
  WORKER_OP_MESSAGES,
  type WorkerOpStatus,
} from '@draftroom/contracts'
import type { ApiClient } from '../../api/client.ts'
import { isApiError } from '../../api/client.ts'
import type { MetaSnapshot } from '../../assets/meta-store.ts'
import type { PreviewPage } from '../../file-card/pdf-pages.ts'
import type { BoardEvents } from '../events.ts'
import { DECK_COPY, type DeckStage, missingPages, renderProgress, slidePagesOf } from './model.ts'

/** How often the meta is asked again while pages are being made (the store rate-limits a refresh too). */
export const DECK_POLL_MS = 3_000
/** Every this many polls, the state of each op of this request is asked (a failure no event told). */
export const DECK_OP_CHECK_EVERY = 4
/**
 * What one render-pages op may take once a worker claims it, per attempt, rounded up: the Office conversion (the
 * worker's 120 s) and the pages (its 90 s job budget), plus the lease (WORKER_OP_LIMITS.leaseMs) it takes the api to
 * notice a worker that died mid-run.
 */
const DECK_OP_ATTEMPT_MS = 4 * 60_000 + WORKER_OP_LIMITS.leaseMs
/**
 * Waiting stops here, and only as a last resort: the api answers first. It fails a person's op still queued
 * `requestedQueueDeadlineMs` (30 min) after the request (WORKER_BUSY), and a queued op when no capable worker checked
 * in for `workerAbsentMs` (WORKER_UNAVAILABLE); either reaches this dialog by its event or the op route. So this is
 * that deadline, plus every attempt (`maxAttempts`) of the last op to start, plus a margin: never before the api's
 * own answer (about 50 minutes).
 */
export const DECK_WAIT_MS =
  WORKER_OP_LIMITS.requestedQueueDeadlineMs + WORKER_OP_LIMITS.maxAttempts * DECK_OP_ATTEMPT_MS + 2 * 60_000

export type { DeckStage }

/** The words of a failed or cancelled op: its code's fixed contract message (WORKER_OP_MESSAGES), else the api's. */
export function opFailureText(op: Pick<FileOpState, 'errorCode' | 'message'>, fallback: string): string {
  return (op.errorCode ? WORKER_OP_MESSAGES[op.errorCode] : null) ?? op.message ?? fallback
}

export interface DeckJobDeps {
  request: ApiClient['request']
  events: Pick<BoardEvents, 'on' | 'onResync'>
  /** the version's meta, asked again (`force`: now, else at most every few seconds) */
  refresh(force?: boolean): Promise<MetaSnapshot>
  boardId: string
  versionId: string
  /** the slides wanted: pages 1..slides */
  slides: number
  signal: AbortSignal
  /** `stage`: `queued` while every op of this request still waits for the worker, else `running` */
  onProgress?(p: { ready: number; of: number; stage: DeckStage }): void
  pollMs?: number
  waitMs?: number
}

export type DeckJobOutcome =
  | { readonly kind: 'ready'; readonly pages: PreviewPage[] }
  /** a name-only guest: the first 8 slides only */
  | { readonly kind: 'guest' }
  /** `pages`: what is ready now (the dialog may offer to place those) */
  | { readonly kind: 'error'; readonly message: string; readonly pages: PreviewPage[] }
  | { readonly kind: 'cancelled' }

const done = (s: MetaSnapshot, slides: number) => !!s.meta && missingPages(s.meta, slides).length === 0

export async function prepareDeck(d: DeckJobDeps): Promise<DeckJobOutcome> {
  let snap = await d.refresh(true)
  const pages = () => slidePagesOf(snap.meta, d.slides)
  const fail = (message: string): DeckJobOutcome => ({ kind: 'error', message, pages: pages() })
  if (d.signal.aborted) return { kind: 'cancelled' }
  if (snap.missing || !snap.meta) return fail('This file is missing. Upload it again and retry.')
  // the ops of this request this tab knows of, by their last status (the POST answers with the first; events tell
  // of the others as they change)
  const known = new Map<string, WorkerOpStatus>()
  // `queued` while every op known still waits for the worker; a running one, or none known (someone else's request,
  // or between runs), reads as being made
  const stage = (): DeckStage => {
    const s = [...known.values()]
    return s.includes('running') || !s.includes('queued') ? 'running' : 'queued'
  }
  const progress = () => {
    if (snap.meta) d.onProgress?.({ ...renderProgress(snap.meta, d.slides), stage: stage() })
  }
  progress()
  if (done(snap, d.slides)) return { kind: 'ready', pages: pages() }

  try {
    const s = await d.request('POST', renderPagesPath(d.versionId), {
      body: { boardId: d.boardId },
      schema: FileOpState,
      signal: d.signal,
    })
    if (s.status === 'failed' || s.status === 'cancelled')
      return fail(opFailureText(s, DECK_COPY.unavailable))
    known.set(s.id, s.status)
    progress()
  } catch (e) {
    if (d.signal.aborted) return { kind: 'cancelled' }
    if (!isApiError(e)) return fail(DECK_COPY.unavailable)
    if (e.code === FORMAT_ERROR_CODES.nothingToRender) {
      snap = await d.refresh(true)
      return done(snap, d.slides) ? { kind: 'ready', pages: pages() } : fail(DECK_COPY.unavailable)
    }
    if (e.code === 'GUEST_ACCOUNT_REQUIRED') return { kind: 'guest' }
    if (e.status === 404) return fail(DECK_COPY.unavailable)
    if (e.code !== FORMAT_ERROR_CODES.opActive) return fail(e.message)
    // someone's request is making them: wait for the pages
  }

  return new Promise<DeckJobOutcome>((resolve) => {
    let over = false
    let polls = 0
    const offs: (() => void)[] = []
    const finish = (out: DeckJobOutcome) => {
      if (over) return
      over = true
      for (const off of offs.splice(0)) off()
      resolve(out)
    }
    const check = async (force = false) => {
      if (over) return
      try {
        snap = await d.refresh(force)
      } catch {
        return // a hiccup: the next poll asks again
      }
      if (over) return
      progress()
      if (done(snap, d.slides)) finish({ kind: 'ready', pages: pages() })
    }
    const checkOps = async () => {
      for (const id of [...known.keys()]) {
        try {
          const s = await d.request('GET', fileOpPath(id), { schema: FileOpState, signal: d.signal })
          if (over) return
          if (s.status === 'failed' || s.status === 'cancelled') {
            finish(fail(opFailureText(s, DECK_COPY.unavailable)))
            return
          }
          if (s.status === 'done') known.delete(id)
          else known.set(id, s.status)
          progress()
        } catch {
          // not answered (an api whose op route is not there, a hiccup): the events and the meta decide
        }
      }
    }
    offs.push(
      d.events.on(FILE_OP_EVENT, (data) => {
        const ev = FileOpEvent.safeParse(data)
        if (!ev.success) return
        const op = ev.data.op
        if (op.kind !== 'render-pages' || op.sourceVersionId !== d.versionId) return
        if (op.status === 'failed' || op.status === 'cancelled') {
          finish(fail(opFailureText(op, DECK_COPY.unavailable)))
          return
        }
        if (op.status === 'done') {
          known.delete(op.id)
          void check(true)
        } else {
          known.set(op.id, op.status)
          progress()
        }
      }),
      d.events.onResync(() => void check(true)),
    )
    const poll = setInterval(() => {
      polls++
      void check()
      if (polls % DECK_OP_CHECK_EVERY === 0) void checkOps()
    }, d.pollMs ?? DECK_POLL_MS)
    const limit = setTimeout(() => finish(fail(DECK_COPY.slow)), d.waitMs ?? DECK_WAIT_MS)
    const onAbort = () => finish({ kind: 'cancelled' })
    d.signal.addEventListener('abort', onAbort)
    offs.push(
      () => clearInterval(poll),
      () => clearTimeout(limit),
      () => d.signal.removeEventListener('abort', onAbort),
    )
    if (d.signal.aborted) onAbort()
  })
}
