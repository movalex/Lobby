// When an editor's client makes and sends the board thumbnail (docs/WAVE3-CONTRACTS.md "thumbnails").
// Plain logic over injected clocks, timers and I/O: unit-tested in Node (scheduler.test.ts).
//
// - Never on every change. Local changes only mark the board as changed; the image is rendered once
//   they have settled for RENDER_QUIET_MS and the person is not in the middle of something (no input
//   for as long, no drag, menu or dialog: capture.ts and render.ts decide "busy"), and sent once they
//   have settled for UPLOAD_QUIET_MS, at most every UPLOAD_MIN_GAP_MS.
// - Leaving: when the tab is hidden, the latest changes are rendered at once if needed and sent; when
//   the page is being unloaded (pagehide) or the board closes (navigating to the dashboard unmounts
//   it), the last rendered image is sent. Nothing asynchronous can finish then, so when the latest
//   changes have no picture yet (`needsRender`), the caller draws one synchronously and hands it over
//   with `adopt` first (F11: leaving 1.5 s after an edit used to keep the placeholder).
// - The api accepts one upload per board every THUMBNAIL_MIN_INTERVAL_MS; a 429 says when to retry.

import { THUMBNAIL_MIN_INTERVAL_MS, type ThumbnailMimeType } from '@draftroom/contracts'

export const RENDER_QUIET_MS = 3_000
export const UPLOAD_QUIET_MS = 20_000
export const UPLOAD_MIN_GAP_MS = 120_000
export const BUSY_RETRY_MS = 1_000
/** After a failure that may pass (network, 5xx) without a Retry-After. */
export const ERROR_BACKOFF_MS = 60_000

export type Rendered =
  | {
      kind: 'image'
      blob: Blob
      type: ThumbnailMimeType
      width: number
      height: number
      /** tldraw's own export, or the simplified drawing for larger areas (render.ts). */
      renderer?: 'detailed' | 'schematic'
    }
  /** Nothing to draw: the stored thumbnail (if any) should go, so the card shows its placeholder. */
  | { kind: 'empty' }

export type RenderResult =
  | Rendered
  /** The person started interacting: try again shortly. */
  | { kind: 'busy' }
  /** No acceptable image (too many shapes, too large, the renderer failed): keep what is stored. */
  | { kind: 'skipped' }

export type SendResult =
  | { ok: true; version: string | null }
  | {
      ok: false
      /** 429: when the api accepts the next one. */
      retryAfterMs?: number
      /** No permission (or signed out): stop for this board session. */
      stop?: boolean
      /** The api refused this image as such: drop it; the next change makes a new one. */
      drop?: boolean
    }

export type CaptureState =
  | 'idle'
  | 'rendering'
  | 'rendered'
  /** Nothing acceptable to send (see RenderResult 'skipped'). */
  | 'skipped'
  | 'uploading'
  | 'uploaded'
  | 'error'
  | 'off'

export interface CaptureStatus {
  state: CaptureState
  /** The version the api answered with (after an upload), null after a removal. */
  version?: string | null
  /** How long the last render took, in ms. */
  renderMs?: number
  /** Which renderer made the last image. */
  renderer?: 'detailed' | 'schematic'
}

export interface SchedulerDeps {
  now(): number
  setTimeout(fn: () => void, ms: number): unknown
  clearTimeout(handle: unknown): void
  /** The person is interacting right now (dragging, panning, typing…). */
  isBusy(): boolean
  /** `force`: the tab is being hidden; render now, whatever the person is doing. */
  render(opts: { force: boolean }): Promise<RenderResult>
  send(r: Rendered, opts: { keepalive: boolean }): Promise<SendResult>
  onStatus?(s: CaptureStatus): void
}

/** What is left to send when the board closes: sent later from outside the board (upload.ts). */
export interface Leftover {
  rendered: Rendered
  /** Epoch ms: not before the api's window allows it. */
  notBefore: number
}

export class CaptureScheduler {
  private readonly d: SchedulerDeps
  /** Local content changes so far; `rendered.seq` / `sentSeq` say how far each step got. */
  private changeSeq = 0
  private lastChangeAt = Number.NEGATIVE_INFINITY
  /** The change the last render attempt covered (a skipped one included). */
  private attemptedSeq = 0
  private rendered: { seq: number; result: Rendered } | null = null
  private sentSeq = 0
  /** The change the upload in flight covers (meaningful while `sending`). */
  private sendingSeq = 0
  private lastSentAt = Number.NEGATIVE_INFINITY
  private retryAt = 0
  /** Whether the api holds a thumbnail for this board (null: not known yet). */
  private remote: boolean | null = null
  private rendering = false
  private sending = false
  private stopped = false
  private timer: unknown = null

  constructor(deps: SchedulerDeps) {
    this.d = deps
  }

  /** A local change to the board's content. */
  noteChange(): void {
    if (this.stopped) return
    this.changeSeq += 1
    this.lastChangeAt = this.d.now()
    this.schedule(RENDER_QUIET_MS)
  }

  /** The api has (or has no) thumbnail for this board. */
  setRemote(has: boolean): void {
    this.remote = has
  }

  /** The latest changes have no picture yet (none rendered, or a render still in progress). */
  needsRender(): boolean {
    return !this.stopped && this.attemptedSeq < this.changeSeq
  }

  /**
   * A picture of the latest changes made outside the schedule: drawn synchronously by the caller when
   * the board is closing or the page is going away (F11), where an asynchronous render could not
   * finish. It is sent like any other: by `leave`, or handed over by `dispose`.
   */
  adopt(result: RenderResult): void {
    if (this.stopped || result.kind === 'busy') return
    const seq = this.changeSeq
    this.attemptedSeq = seq
    this.rendered = result.kind === 'skipped' ? null : { seq, result }
  }

  /** The tab was hidden (`hidden`) or the page is being unloaded (`pagehide`). */
  leave(reason: 'hidden' | 'pagehide'): void {
    if (this.stopped || this.sentSeq >= this.changeSeq) return
    // Afterwards the usual schedule carries on (e.g. the api's window was still closed, or the person
    // came back and kept editing): a timer that fired meanwhile found the scheduler busy.
    if (reason === 'hidden' && this.attemptedSeq < this.changeSeq && !this.rendering) {
      // The board is still here: render the latest changes now (nobody is looking), then send.
      void this.renderNow(true)
        .then(() => this.sendNow(true))
        .then(() => this.tick())
      return
    }
    void this.sendNow(true).then(() => this.tick())
  }

  /** The board closes. Returns what should still be sent (the caller outlives the board). */
  dispose(): Leftover | null {
    if (this.stopped) return null
    this.stopped = true
    this.clear()
    if (!this.hasPending()) return null
    const pending = this.rendered
    if (!pending) return null
    if (this.sending) {
      // An upload is in flight. If it carries this very picture there is nothing left; if the picture
      // is newer (drawn on leaving), it goes once the api's window after that upload opens.
      if (pending.seq <= this.sendingSeq) return null
      return {
        rendered: pending.result,
        notBefore: Math.max(this.d.now() + THUMBNAIL_MIN_INTERVAL_MS, this.retryAt),
      }
    }
    return {
      rendered: pending.result,
      notBefore: Math.max(this.lastSentAt + THUMBNAIL_MIN_INTERVAL_MS, this.retryAt),
    }
  }

  // ---- internals ---------------------------------------------------------------------------------

  private hasPending(): boolean {
    const r = this.rendered
    if (!r || r.seq <= this.sentSeq) return false
    // Nothing to draw and nothing stored: nothing to do.
    return !(r.result.kind === 'empty' && this.remote === false)
  }

  private status(s: CaptureStatus) {
    this.d.onStatus?.(s)
  }

  private clear() {
    if (this.timer !== null) this.d.clearTimeout(this.timer)
    this.timer = null
  }

  private schedule(ms: number) {
    this.clear()
    if (this.stopped) return
    this.timer = this.d.setTimeout(
      () => {
        this.timer = null
        this.tick()
      },
      Math.max(0, ms),
    )
  }

  private tick(): void {
    if (this.stopped || this.rendering || this.sending) return
    const t = this.d.now()
    if (this.attemptedSeq < this.changeSeq) {
      const wait = this.lastChangeAt + RENDER_QUIET_MS - t
      if (wait > 0) this.schedule(wait)
      else if (this.d.isBusy()) this.schedule(BUSY_RETRY_MS)
      // A render that found the person busy has already scheduled its retry.
      else void this.renderNow(false).then((done) => done && this.tick())
      return
    }
    if (!this.hasPending()) {
      // Settled with nothing to send (e.g. the changes cancelled out to an empty, unstored board).
      if (this.rendered && this.rendered.seq > this.sentSeq) this.sentSeq = this.rendered.seq
      return
    }
    const due = Math.max(
      this.lastChangeAt + UPLOAD_QUIET_MS,
      this.lastSentAt + UPLOAD_MIN_GAP_MS,
      this.retryAt,
    )
    if (t < due) this.schedule(due - t)
    else void this.sendNow(false).then(() => this.tick())
  }

  /** Resolves to whether the render counted (false: busy, or it could not start). */
  private async renderNow(force: boolean): Promise<boolean> {
    if (this.rendering || this.stopped) return false
    this.rendering = true
    const seq = this.changeSeq
    const started = this.d.now()
    this.status({ state: 'rendering' })
    let result: RenderResult
    try {
      result = await this.d.render({ force })
    } catch {
      result = { kind: 'skipped' }
    } finally {
      this.rendering = false
    }
    const renderMs = Math.round(this.d.now() - started)
    // A newer picture was adopted meanwhile (drawn on leaving): this older one must not replace it.
    if (seq < this.attemptedSeq) return true
    if (result.kind === 'busy') {
      this.status({ state: 'idle' })
      this.schedule(BUSY_RETRY_MS)
      return false
    }
    this.attemptedSeq = seq
    // A skipped render leaves no image: an older one would show a board that no longer exists.
    this.rendered = result.kind === 'skipped' ? null : { seq, result }
    this.status({
      state: result.kind === 'skipped' ? 'skipped' : 'rendered',
      renderMs,
      ...(result.kind === 'image' && result.renderer ? { renderer: result.renderer } : {}),
    })
    return true
  }

  private async sendNow(keepalive: boolean): Promise<void> {
    if (this.sending || this.stopped || !this.hasPending()) return
    const t = this.d.now()
    // Inside the api's window (our own last upload, or its Retry-After): it would only answer 429.
    if (t < Math.max(this.lastSentAt + THUMBNAIL_MIN_INTERVAL_MS, this.retryAt)) {
      if (!keepalive) this.schedule(Math.max(this.lastSentAt + THUMBNAIL_MIN_INTERVAL_MS, this.retryAt) - t)
      return
    }
    const pending = this.rendered
    if (!pending) return
    this.sending = true
    this.sendingSeq = pending.seq
    this.status({ state: 'uploading' })
    let res: SendResult
    try {
      res = await this.d.send(pending.result, { keepalive })
    } catch {
      res = { ok: false }
    } finally {
      this.sending = false
    }
    const now = this.d.now()
    if (res.ok) {
      this.sentSeq = Math.max(this.sentSeq, pending.seq)
      this.lastSentAt = now
      this.remote = pending.result.kind === 'image'
      this.status({ state: 'uploaded', version: res.version })
      return
    }
    if (res.stop) {
      this.stopped = true
      this.clear()
      this.status({ state: 'off' })
      return
    }
    if (res.drop) this.sentSeq = Math.max(this.sentSeq, pending.seq)
    this.retryAt = now + (res.retryAfterMs ?? (res.drop ? 0 : ERROR_BACKOFF_MS))
    this.status({ state: 'error' })
  }
}
