// Which canvas the sync server runs, as the api needs it for bridge release R0's contracts
// (docs/DEPLOY.md "Bridge release R0", migration 0022; docs/EXCALIDRAW-MIGRATION.md §5.10; wave 5, 2A).
//
// On the new canvas (sync with DRAFTROOM_ENGINE=excalidraw) this api writes `boards.new_canvas = true` on
// every board it creates (new, template, duplicate, restore as new, import; converted boards keep false)
// and `board_snapshots.body_version = 2` on every checkpoint body made on it; R0's refusals of such boards
// and checkpoints (tickets, duplicate, export, checkpoints, previews, restores, the asset collector's
// "unread") do not apply, and the answers carry no `newCanvas` marks: they are this build's own content.
// With the tldraw sync (this branch's default build, and what R0 is during a rollback) nothing changes:
// nothing is marked, and R0's refusals stand for whatever another build marked.
//
// The engine comes from the sync server itself (GET /internal/canvas), not from a setting, so the api
// follows the sync it talks to through the cut-over and a rollback. It is asked at most every `ttlMs`;
// while sync cannot be asked, the last answer stands (tldraw before the first one). R0's sync has no such
// route (404): tldraw.

export type CanvasEngine = 'tldraw' | 'excalidraw'

export interface CanvasEngineProbe {
  /** The sync server's engine, asked again after `ttlMs`; the last answer (or tldraw) while it cannot be. */
  current(): Promise<CanvasEngine>
  /** The last answer, without asking (tldraw before the first one). */
  known(): CanvasEngine
}

/** How long one answer is used (an engine changes only with a deploy of sync). */
export const CANVAS_ENGINE_TTL_MS = 30_000

export function createCanvasEngineProbe(
  ask: (() => Promise<CanvasEngine>) | undefined,
  opts: { ttlMs?: number; now?: () => number; log?: (message: string) => void } = {},
): CanvasEngineProbe {
  const ttlMs = opts.ttlMs ?? CANVAS_ENGINE_TTL_MS
  const now = opts.now ?? Date.now
  let known: CanvasEngine = 'tldraw'
  let at = Number.NEGATIVE_INFINITY
  let pending: Promise<CanvasEngine> | null = null
  return {
    known: () => known,
    current() {
      if (!ask || now() - at < ttlMs) return Promise.resolve(known)
      // asked inside a promise: a client that throws at once is a failed ask, never a failed request
      pending ??= Promise.resolve()
        .then(ask)
        .then((engine) => {
          if (engine !== known) opts.log?.(`sync runs the ${engine} canvas`)
          known = engine
          at = now()
          return engine
        })
        .catch(() => {
          // sync could not be asked: the last answer stands, asked again in a few seconds
          at = now() - ttlMs + Math.min(ttlMs, 5_000)
          return known
        })
        .finally(() => {
          pending = null
        })
      return pending
    },
  }
}

/** A probe for contexts without one (tests, tools): always tldraw, R0's behaviour. */
export const TLDRAW_ONLY: CanvasEngineProbe = {
  current: () => Promise.resolve('tldraw'),
  known: () => 'tldraw',
}

/**
 * Whether this api serves the new canvas now: it marks what it makes (`new_canvas`, `body_version` 2),
 * and R0's refusals of boards and checkpoints made on the new canvas do not apply.
 */
export async function onNewCanvas(ctx: { canvas?: CanvasEngineProbe }): Promise<boolean> {
  return (await (ctx.canvas ?? TLDRAW_ONLY).current()) === 'excalidraw'
}
