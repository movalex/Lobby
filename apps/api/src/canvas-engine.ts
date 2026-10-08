// Which canvas the sync server runs, as the api needs it for bridge release R0's contracts
// (docs/DEPLOY.md "Bridge release R0", migration 0022; docs/EXCALIDRAW-MIGRATION.md §5.10; wave 5, 2A).
//
// On the new canvas (this build's sync, the Excalidraw engine) this api writes `boards.new_canvas = true` on
// every board it creates (new, template, duplicate, restore as new, import; converted boards keep false)
// and `board_snapshots.body_version = 2` on every checkpoint body made on it; R0's refusals of such boards
// and checkpoints (tickets, duplicate, export, checkpoints, previews, restores, the asset collector's
// "unread") do not apply, and the answers carry no `newCanvas` marks: they are this build's own content.
// With the tldraw sync (bridge release R0: the deploy window of the cut-over, and what a rollback is)
// nothing changes: nothing is marked, and R0's refusals stand for whatever another build marked.
//
// The engine comes from the sync server itself (GET /internal/canvas), not from a setting, so the api
// follows the sync it talks to through the cut-over and a rollback: this build's sync always answers
// `excalidraw` (wave 4 part 2: it runs no other engine), R0's sync has no such route (404) and reads as
// `tldraw`. It is asked at most every `ttlMs`; while sync cannot be asked, the last answer stands.
//
// K6-1 (wave K): before the FIRST answer the engine is `unknown`, not tldraw. An api that started while it
// could not reach sync (a deploy: 8 of 68 tickets in the 10-07 window) used to read as tldraw and answer the
// new canvas's own boards 409 NEW_CANVAS ("made on the new canvas"), a ~30 s reconnect stall, and the same
// guess decided whether the boards it created meanwhile were marked `new_canvas`. Now:
// - the api asks at start-up (`start`), again and again with a short backoff until sync answers;
// - a request that needs the engine while it is unknown joins the ask in flight (or starts one) and waits
//   for it at most `waitMs`; still unknown, `onNewCanvas` answers 503 CANVAS_STARTING with Retry-After (the
//   web retries it quickly, "Connecting"): a ticket, a board creation (which therefore never writes
//   `new_canvas = false` on this build), a refusal that only applies off the new canvas;
// - display marks (`showsR0Marks`) and the asset collector treat unknown as "not known to be tldraw" and
//   "not known to read v2 bodies" respectively: no badge that this build's boards "open again later", and no
//   file deleted on a guess;
// - a sync that ANSWERS 404 (R0's sync, the rollback case) is an answer: tldraw, R0's refusals intact.
// A probe without a way to ask (`ask` undefined: test fakes, tools; a sync client without `engine()`) is a
// tldraw sync from the start, as before.

import {
  CANVAS_STARTING_ERROR,
  CANVAS_STARTING_MESSAGE,
  CANVAS_STARTING_RETRY_AFTER_S,
} from '@draftroom/contracts'
import { ApiError } from './errors.ts'

export type CanvasEngine = 'tldraw' | 'excalidraw'
/** What the api knows of its sync's engine: `unknown` only before sync's first answer. */
export type CanvasEngineState = CanvasEngine | 'unknown'

export interface CanvasEngineProbe {
  /**
   * The sync server's engine, asked again after `ttlMs`; the last answer while it cannot be. Before the first
   * answer: waits for an ask (at most `waitMs`), then `unknown`.
   */
  current(): Promise<CanvasEngineState>
  /** The last answer, without asking (`unknown` before the first one). */
  known(): CanvasEngineState
  /** Asks now and keeps asking with a short backoff until the first answer (app start-up). Idempotent. */
  start?(): void
  /** Stops the start-up asks (app close). */
  stop?(): void
}

/** How long one answer is used (an engine changes only with a deploy of sync). */
export const CANVAS_ENGINE_TTL_MS = 30_000
/** How long a request waits for the first answer before it is told to retry (503 CANVAS_STARTING). */
export const CANVAS_ENGINE_WAIT_MS = 2_500
/** The start-up asks' waits while sync cannot be asked yet: short at first, then every 5 s. */
export const CANVAS_ENGINE_START_BACKOFF_MS: readonly number[] = [250, 500, 1_000, 2_000, 5_000]
/** Before the first answer, a request may start an ask of its own at most this often (sync down: no storm). */
export const CANVAS_ENGINE_UNKNOWN_ASK_GAP_MS = 500
/** After this many failed start-up asks the api says so in its log, once (an operator's clue). */
export const CANVAS_ENGINE_SILENT_ASKS = 5

export interface CanvasEngineProbeOptions {
  ttlMs?: number
  waitMs?: number
  startBackoffMs?: readonly number[]
  now?: () => number
  log?: (message: string) => void
  /** Test seams (default: the global timers, unref'd so a probe never keeps a process alive). */
  setTimer?: (fn: () => void, ms: number) => unknown
  clearTimer?: (handle: unknown) => void
}

export function createCanvasEngineProbe(
  ask: (() => Promise<CanvasEngine>) | undefined,
  opts: CanvasEngineProbeOptions = {},
): CanvasEngineProbe {
  // No way to ask: a tldraw sync (R0's behaviour), never unknown.
  if (!ask) return TLDRAW_ONLY
  const ttlMs = opts.ttlMs ?? CANVAS_ENGINE_TTL_MS
  const waitMs = opts.waitMs ?? CANVAS_ENGINE_WAIT_MS
  const backoff = opts.startBackoffMs ?? CANVAS_ENGINE_START_BACKOFF_MS
  const now = opts.now ?? Date.now
  const setTimer =
    opts.setTimer ??
    ((fn: () => void, ms: number) => {
      const t = setTimeout(fn, ms)
      t.unref?.()
      return t
    })
  const clearTimer = opts.clearTimer ?? ((h: unknown) => clearTimeout(h as ReturnType<typeof setTimeout>))
  let known: CanvasEngineState = 'unknown'
  /** When the current answer was given (or, after a failure once known, set so the next ask is soon). */
  let at = Number.NEGATIVE_INFINITY
  /** When the last ask before the first answer failed (the gap before a request asks again). */
  let failedAt = Number.NEGATIVE_INFINITY
  let pending: Promise<CanvasEngineState> | null = null
  let timer: unknown = null
  let attempts = 0
  let stopped = false

  const askNow = (): Promise<CanvasEngineState> => {
    // asked inside a promise: a client that throws at once is a failed ask, never a failed request
    pending ??= Promise.resolve()
      .then(ask)
      .then((engine): CanvasEngineState => {
        if (engine !== known) opts.log?.(`sync runs the ${engine} canvas`)
        known = engine
        at = now()
        return engine
      })
      .catch((): CanvasEngineState => {
        // sync could not be asked: a known answer stands, asked again in a few seconds; unknown stays so
        if (known !== 'unknown') at = now() - ttlMs + Math.min(ttlMs, 5_000)
        else failedAt = now()
        return known
      })
      .finally(() => {
        pending = null
      })
    return pending
  }

  /** The start-up loop: ask, and on failure ask again after the next backoff step, until an answer. */
  const loop = () => {
    timer = null
    if (stopped || known !== 'unknown') return
    void askNow().then(() => {
      if (stopped || known !== 'unknown' || timer !== null) return
      const ms = backoff[Math.min(attempts, backoff.length - 1)] ?? 5_000
      attempts++
      // once: tickets of new-canvas boards and new boards wait for this (a wrong sync URL or secret, sync down)
      if (attempts === CANVAS_ENGINE_SILENT_ASKS)
        opts.log?.(
          `sync has not said which canvas it runs (${attempts} asks since start-up); new-canvas boards' tickets and new boards answer 503 CANVAS_STARTING until it does`,
        )
      timer = setTimer(loop, ms)
    })
  }

  /** Waits for `p`, but at most `waitMs`: then the state as it is (unknown). */
  const bounded = (p: Promise<CanvasEngineState>): Promise<CanvasEngineState> => {
    let handle: unknown = null
    const timeout = new Promise<CanvasEngineState>((resolve) => {
      handle = setTimer(() => resolve(known), waitMs)
    })
    return Promise.race([p, timeout]).finally(() => clearTimer(handle))
  }

  return {
    known: () => known,
    current() {
      if (known !== 'unknown') {
        if (now() - at < ttlMs) return Promise.resolve(known)
        return askNow() // the last answer stands if this fails
      }
      // Before the first answer: join the ask in flight, or start one (not more often than the gap).
      if (pending) return bounded(pending)
      if (now() - failedAt < CANVAS_ENGINE_UNKNOWN_ASK_GAP_MS) return Promise.resolve(known)
      return bounded(askNow())
    },
    start() {
      if (stopped || timer !== null || known !== 'unknown') return
      loop()
    },
    stop() {
      stopped = true
      if (timer !== null) clearTimer(timer)
      timer = null
    },
  }
}

/** A probe for contexts without one (tests, tools): always tldraw, R0's behaviour. */
export const TLDRAW_ONLY: CanvasEngineProbe = {
  current: () => Promise.resolve('tldraw'),
  known: () => 'tldraw',
}

/** 503 CANVAS_STARTING with Retry-After: the api does not know its sync's engine yet (K6-1). */
export const canvasStarting = () =>
  new ApiError(503, CANVAS_STARTING_ERROR, CANVAS_STARTING_MESSAGE, {
    'retry-after': String(CANVAS_STARTING_RETRY_AFTER_S),
  })

/**
 * Whether this api serves the new canvas now: it marks what it makes (`new_canvas`, `body_version` 2),
 * and R0's refusals of boards and checkpoints made on the new canvas do not apply. Throws 503
 * CANVAS_STARTING (canvasStarting) while the engine is unknown: a decision that writes or refuses waits for
 * sync's answer, it is never guessed.
 */
export async function onNewCanvas(ctx: { canvas?: CanvasEngineProbe }): Promise<boolean> {
  const engine = await (ctx.canvas ?? TLDRAW_ONLY).current()
  if (engine === 'unknown') throw canvasStarting()
  return engine === 'excalidraw'
}

/**
 * Whether answers carry R0's `newCanvas` display marks (the dashboard's "New canvas" badge, a checkpoint's
 * "made on the new canvas"): only when sync is KNOWN to be a tldraw one. Unknown (sync not reached since
 * start-up) shows none: this build's boards are not "opening again later". Never decides a write or a refusal.
 */
export async function showsR0Marks(ctx: { canvas?: CanvasEngineProbe }): Promise<boolean> {
  return (await (ctx.canvas ?? TLDRAW_ONLY).current()) === 'tldraw'
}
