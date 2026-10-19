// OWNER: WS2 (wave W, background removal; docs/WAVE-W-CONTRACTS.md §3.4, §4.1). Asking for it, following the op, and the
// swap once it is done.
//
//   start (the edit menu's row, the palette command):
//     POST /api/files/:ver/remove-background {boardId} → 202 FileOpState (queued)
//   follow, per op this tab asked for (the tracker, one per board page):
//     the requester's `file.op` events (FILE_OP_EVENT); on every (re)connect and every POLL_MS while one is pending,
//     GET /api/file-ops/:op (an event may have been missed)
//   done: the new version's meta (the files route: it is served on this board, a NEW asset), then ONE transact that
//     points the element at it (model.ts swapToResult: one undo step). failed: its fixed message. cancelled: nothing.
//
// Only this tab's own ops are followed (an op is its requester's; another tab of the same person sees the swap through
// the board, as any edit). A reload forgets a pending op: its result stays a stored version that nothing shows (the
// file collector's grace then applies), and the person can ask again. Nothing here writes a URL into an element.

import {
  FILE_OP_EVENT,
  FileOpEvent,
  type FileOpState,
  FileOpState as FileOpStateSchema,
  FORMAT_ERROR_CODES,
  fileOpCancelPath,
  fileOpPath,
  removeBackgroundPath,
  WORKER_OP_MESSAGES,
} from '@draftroom/contracts'
import { isApiError } from '../../api/client.ts'
import { type AssetVersionMeta, metaUrl } from '../../assets/contract.ts'
import type { CanvasFeatureContext, FeatureRegistries } from '../../canvas/api/index.ts'
import { factsFromMeta } from '../../file-card/ported/insert.ts'
import { type FileFacts, factsOf } from '../../file-card/ported/model.ts'
import { REMOVE_BG_LABEL, removeBgTarget, swapToResult } from './model.ts'

type Ctx = CanvasFeatureContext

/** How often a pending op is re-read while its events may have been missed. */
export const POLL_MS = 5_000

/**
 * The notice while the op is followed: `queued` waits for the file worker (the api claims a person's request before
 * the background indexing), `running` is the removal itself. There is no local give-up timer: the api answers every
 * wait (a request still queued `WORKER_OP_LIMITS.requestedQueueDeadlineMs` after it was made fails WORKER_BUSY, a
 * queued op with no capable worker checked in for `workerAbsentMs` fails WORKER_UNAVAILABLE, a running one has its
 * lease and budgets), and the tracker reads the op on every event, reconnect and POLL_MS until it does.
 */
export function removeBgProgressText(name: string, status: 'queued' | 'running'): string {
  return status === 'queued'
    ? `Queued: waiting for the file worker to remove the background of ${name}… (beta)`
    : `Removing the background of ${name}… (beta)`
}

/** A failed op's words: its code's fixed contract message (WORKER_OP_MESSAGES), else the api's, else a plain one. */
export function removeBgFailureText(op: Pick<FileOpState, 'errorCode' | 'message'>): string {
  return (
    (op.errorCode ? WORKER_OP_MESSAGES[op.errorCode] : null) ??
    op.message ??
    'The background could not be removed from this image.'
  )
}

export interface RemoveBgDeps {
  request(ctx: Ctx, versionId: string): Promise<FileOpState>
  read(ctx: Ctx, opId: string): Promise<FileOpState | null>
  cancel(ctx: Ctx, opId: string): Promise<FileOpState | null>
  meta(ctx: Ctx, assetId: string, versionId: string): Promise<AssetVersionMeta | null>
  pollMs: number
}

export const HTTP_DEPS: RemoveBgDeps = {
  request: (ctx, versionId) =>
    ctx.api.request('POST', removeBackgroundPath(versionId), {
      body: { boardId: ctx.board.id },
      schema: FileOpStateSchema,
    }),
  read: async (ctx, opId) => {
    try {
      return await ctx.api.request('GET', fileOpPath(opId), { schema: FileOpStateSchema })
    } catch (e) {
      if (isApiError(e) && e.status === 404) return null
      throw e
    }
  },
  cancel: async (ctx, opId) => {
    try {
      return await ctx.api.request('POST', fileOpCancelPath(opId), { schema: FileOpStateSchema })
    } catch (e) {
      if (isApiError(e) && (e.status === 404 || e.status === 409)) return null
      throw e
    }
  },
  meta: async (ctx, assetId, versionId) => {
    const res = await fetch(metaUrl(ctx.board.id, assetId, versionId), {
      cache: 'no-store',
      credentials: 'same-origin',
      headers: { accept: 'application/json' },
    })
    if (!res.ok) return null
    const meta = (await res.json()) as AssetVersionMeta
    return meta?.versionId === versionId && meta.assetId === assetId ? meta : null
  },
  pollMs: POLL_MS,
}

interface Pending {
  readonly opId: string
  readonly elementId: string
  readonly sourceVersionId: string
  readonly name: string
  readonly key: string
}

const noticeKey = (opId: string) => `remove-bg:${opId}`

/** Follows this tab's background-removal ops on one board page and swaps each result in once it is done. */
export class RemoveBgTracker {
  private readonly pending = new Map<string, Pending>()
  private readonly finishing = new Set<string>()
  private timer: ReturnType<typeof setInterval> | null = null
  private readonly offs: (() => void)[] = []
  private disposed = false
  private readonly ctx: Ctx
  private readonly deps: RemoveBgDeps

  constructor(ctx: Ctx, deps: RemoveBgDeps = HTTP_DEPS) {
    this.ctx = ctx
    this.deps = deps
    this.offs.push(
      ctx.events.on(FILE_OP_EVENT, (data) => {
        const parsed = FileOpEvent.safeParse(data)
        if (parsed.success) void this.onState(parsed.data.op)
      }),
      ctx.events.onResync(() => void this.refresh()),
    )
  }

  /** The ops this tab is waiting for (tests). */
  pendingIds(): string[] {
    return [...this.pending.keys()]
  }

  track(state: FileOpState, elementId: string, facts: FileFacts): void {
    if (this.disposed) return
    const p: Pending = {
      opId: state.id,
      elementId,
      sourceVersionId: facts.versionId,
      name: facts.name || 'the image',
      key: noticeKey(state.id),
    }
    this.pending.set(state.id, p)
    if (state.status === 'queued' || state.status === 'running') this.progress(p, state.status)
    if (!this.timer) this.timer = setInterval(() => void this.refresh(), this.deps.pollMs)
    void this.onState(state)
  }

  async refresh(): Promise<void> {
    for (const id of [...this.pending.keys()]) {
      let state: FileOpState | null
      try {
        state = await this.deps.read(this.ctx, id)
      } catch {
        continue // offline for a moment: the next poll or reconnect asks again
      }
      if (state) await this.onState(state)
      else this.drop(id, 'This background removal is no longer available.')
    }
  }

  async onState(op: FileOpState): Promise<void> {
    const p = this.pending.get(op.id)
    if (!p || this.disposed) return
    if (op.status === 'queued' || op.status === 'running') return this.progress(p, op.status)
    if (op.status === 'cancelled') {
      this.forget(op.id)
      this.ctx.dismiss(p.key)
      return
    }
    if (op.status === 'failed') {
      this.forget(op.id)
      this.ctx.dismiss(p.key)
      this.ctx.notify({
        key: `${p.key}:failed`,
        text: removeBgFailureText(op),
        tone: 'error',
        testId: 'remove-bg-failed',
      })
      return
    }
    await this.finish(op, p)
  }

  private async finish(op: FileOpState, p: Pending): Promise<void> {
    if (this.finishing.has(op.id)) return
    this.finishing.add(op.id)
    try {
      const versionId = op.resultVersionId
      const assetId = op.resultAssetId ?? null
      const meta =
        versionId && assetId ? await this.deps.meta(this.ctx, assetId, versionId).catch(() => null) : null
      if (this.disposed) return
      this.forget(op.id)
      this.ctx.dismiss(p.key)
      if (!meta) {
        this.ctx.notify({
          key: `${p.key}:failed`,
          text: 'The background was removed, but the new picture could not be loaded. Try again.',
          tone: 'error',
          testId: 'remove-bg-failed',
        })
        return
      }
      const outcome = swapToResult(this.ctx, p.elementId, p.sourceVersionId, factsFromMeta(meta))
      this.ctx.notify(
        outcome === 'swapped'
          ? {
              key: `${p.key}:done`,
              text: 'Background removed (beta). Undo puts the original back.',
              testId: 'remove-bg-done',
            }
          : {
              key: `${p.key}:done`,
              text: `${p.name} was changed, locked or deleted meanwhile, so it was left as it is.`,
              testId: 'remove-bg-skipped',
            },
      )
    } finally {
      this.finishing.delete(op.id)
    }
  }

  private progress(p: Pending, status: 'queued' | 'running'): void {
    this.ctx.notify({
      key: p.key,
      text: removeBgProgressText(p.name, status),
      timeoutMs: null,
      testId: 'remove-bg-progress',
      ...(status === 'queued'
        ? {
            action: {
              label: 'Cancel',
              testId: 'remove-bg-cancel',
              onClick: () => {
                void this.deps.cancel(this.ctx, p.opId).then((s) => (s ? this.onState(s) : undefined))
              },
            },
          }
        : {}),
    })
  }

  private drop(id: string, text: string): void {
    const p = this.pending.get(id)
    this.forget(id)
    if (!p) return
    this.ctx.dismiss(p.key)
    this.ctx.notify({ key: `${p.key}:failed`, text, tone: 'error', testId: 'remove-bg-failed' })
  }

  private forget(id: string): void {
    this.pending.delete(id)
    if (!this.pending.size && this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
  }

  dispose(): void {
    this.disposed = true
    for (const off of this.offs.splice(0)) off()
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    this.pending.clear()
  }
}

const trackers = new WeakMap<FeatureRegistries, RemoveBgTracker>()

/** The board page's tracker (the feature's onMount makes it). */
export const trackerOf = (registries: FeatureRegistries): RemoveBgTracker | null =>
  trackers.get(registries) ?? null

export function mountTracker(ctx: Ctx, deps: RemoveBgDeps = HTTP_DEPS): () => void {
  const t = new RemoveBgTracker(ctx, deps)
  trackers.set(ctx.registries, t)
  return () => {
    t.dispose()
    if (trackers.get(ctx.registries) === t) trackers.delete(ctx.registries)
  }
}

/** Asks for the background of the one selected image to be removed, then follows it. Resolves once it is asked. */
export async function startRemoveBackground(
  ctx: Ctx,
  ids: readonly string[] = ctx.canvas.selection,
  deps: RemoveBgDeps = HTTP_DEPS,
): Promise<FileOpState | null> {
  const el = removeBgTarget(ctx, ids)
  const facts = el ? factsOf(el) : null
  const tracker = trackerOf(ctx.registries)
  if (!el || !facts || !tracker) return null
  const key = `remove-bg:start:${el.id}`
  ctx.notify({ key, text: `${REMOVE_BG_LABEL}: asking…`, timeoutMs: null, testId: 'remove-bg-progress' })
  let state: FileOpState
  try {
    state = await deps.request(ctx, facts.versionId)
  } catch (e) {
    ctx.dismiss(key)
    ctx.notify({
      key: `${key}:refused`,
      text:
        isApiError(e) && e.code === FORMAT_ERROR_CODES.opActive
          ? 'The background of this image is already being removed.'
          : isApiError(e) && e.status === 404
            ? 'Background removal is not available right now.'
            : isApiError(e)
              ? e.message
              : 'The background could not be removed. Try again.',
      tone: 'error',
      testId: 'remove-bg-refused',
    })
    return null
  }
  ctx.dismiss(key)
  tracker.track(state, el.id, facts)
  return state
}
