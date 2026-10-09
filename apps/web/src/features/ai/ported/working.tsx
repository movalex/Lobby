// OWNER: W2 (wave L, L2-1e). "Dana is using AI here": while someone runs AI on the board, everyone else sees a
// soft shimmer over the area it is about (the run's `at`: the selection's bounds the runner's tab sent) with
// the runner's name, so nobody edits underneath it. The api publishes `ai.working` once a run passed its gate and
// reserved its budget, and `ai.done` when it settled (AI_EVENTS; never for a refused call). A shimmer clears on
// its `ai.done`, or by itself after AI_WORKING_TTL_MS. Ephemeral: never stored, never sent, nothing written; the
// payload carries a name and a rect only. Shown to everyone who can see the board (guests and viewers too), not
// to the runner's own tab (it has its own busy pill). Static under reduced motion.

import { AI_EVENTS, AI_WORKING_TTL_MS, AiDoneEvent, AiWorkingEvent } from '@draftroom/contracts'
import type { CanvasFeatureContext, LobbyCanvas } from '../../../canvas/api/index.ts'
import { type Atom, atom, useValue } from '../../../lib/signals.ts'
import { SparkIcon } from '../icons.tsx'
import { useReducedMotion } from './Placeholders.tsx'
import { aiJob, perCanvas } from './runtime.ts'
import { onScreen, toPixels } from './shimmer.ts'

export interface WorkingEntry {
  readonly runId: string
  readonly name: string
  readonly action: string
  readonly rect: { readonly x: number; readonly y: number; readonly w: number; readonly h: number } | null
  /** when it clears without an `ai.done` (ms since the epoch, this tab's clock) */
  readonly until: number
}

/** Most shimmers shown at once (a busy board): the newest. */
export const WORKING_MAX = 6

/** The live runs of others on each canvas. */
export const aiWorking = perCanvas<Atom<readonly WorkingEntry[]>>(() =>
  atom<readonly WorkingEntry[]>('lobby-ai-working', []),
)

/** An `ai.working` event applied (pure): a new run, or the same run again (its time renewed). */
export function addWorking(list: readonly WorkingEntry[], ev: AiWorkingEvent, now: number): WorkingEntry[] {
  const entry: WorkingEntry = {
    runId: ev.runId,
    name: ev.name,
    action: ev.action,
    rect: ev.rect,
    until: now + AI_WORKING_TTL_MS,
  }
  return [...list.filter((e) => e.runId !== ev.runId), entry].slice(-WORKING_MAX)
}

/** An `ai.done` applied (pure). */
export const endWorking = (list: readonly WorkingEntry[], runId: string): WorkingEntry[] =>
  list.filter((e) => e.runId !== runId)

/** What is still live at `now` (pure). */
export const liveWorking = (list: readonly WorkingEntry[], now: number): WorkingEntry[] =>
  list.filter((e) => e.until > now)

/** The words over the shimmer: "Dana is using AI here". */
export const workingLabel = (name: string) => `${name.trim() || 'Someone'} is using AI here`

/**
 * Listens for `ai.working` and `ai.done` on the board's event stream and keeps `aiWorking` (see the header).
 * `isMine(ev)`: the event is this tab's own run (its busy pill shows it). Returns the stop.
 */
export function listenAiWorking(
  ctx: Pick<CanvasFeatureContext, 'canvas' | 'events'>,
  isMine: (ev: AiWorkingEvent) => boolean,
  clock: {
    now(): number
    setTimeout(fn: () => void, ms: number): unknown
    clearTimeout(h: unknown): void
  } = {
    now: () => Date.now(),
    setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
    clearTimeout: (h) => globalThis.clearTimeout(h as ReturnType<typeof setTimeout>),
  },
): () => void {
  const slot = aiWorking(ctx.canvas)
  const timers = new Map<string, unknown>()
  const sweep = () => slot.set(liveWorking(slot.get(), clock.now()))
  const offWorking = ctx.events.on(AI_EVENTS.working, (data) => {
    const ev = AiWorkingEvent.safeParse(data)
    if (!ev.success || isMine(ev.data)) return
    slot.set(addWorking(slot.get(), ev.data, clock.now()))
    const old = timers.get(ev.data.runId)
    if (old !== undefined) clock.clearTimeout(old)
    timers.set(
      ev.data.runId,
      clock.setTimeout(() => {
        timers.delete(ev.data.runId)
        sweep()
      }, AI_WORKING_TTL_MS + 50),
    )
  })
  const offDone = ctx.events.on(AI_EVENTS.done, (data) => {
    const ev = AiDoneEvent.safeParse(data)
    if (!ev.success) return
    slot.set(endWorking(slot.get(), ev.data.runId))
    const t = timers.get(ev.data.runId)
    if (t !== undefined) clock.clearTimeout(t)
    timers.delete(ev.data.runId)
  })
  return () => {
    offWorking()
    offDone()
    for (const t of timers.values()) clock.clearTimeout(t)
    timers.clear()
    slot.set([])
  }
}

/** Whether `ev` is this tab's own run: a request of this tab is running, under this person's name. */
export function isOwnRun(canvas: LobbyCanvas, myName: string, ev: AiWorkingEvent): boolean {
  return aiJob(canvas).get() !== null && ev.name.trim() === myName.trim()
}

/** The shimmer layer (a screen overlay of the AI feature, for everyone on the board). */
export function AiWorkingOverlay({ ctx }: { ctx: CanvasFeatureContext }) {
  const { canvas } = ctx
  const doc = canvas.container()?.ownerDocument ?? document
  const still = useReducedMotion(doc)
  const json = useValue('lobby-ai-working-shown', () => {
    const list = aiWorking(canvas).get()
    if (!list.length) return '[]'
    canvas.viewport.get()
    const screen = canvas.viewport.screenRect()
    return JSON.stringify(
      list.map((e) => {
        const px = e.rect ? toPixels(e.rect, (p) => canvas.sceneToOverlay(p)) : null
        return {
          runId: e.runId,
          label: workingLabel(e.name),
          box: px && onScreen(px, screen.width, screen.height) ? px : null,
        }
      }),
    )
  }, [canvas])
  const shown = JSON.parse(json) as {
    runId: string
    label: string
    box: { x: number; y: number; w: number; h: number } | null
  }[]
  if (!shown.length) return null
  return (
    <div className="dr-ai-working" data-motion={still ? 'still' : 'shimmer'}>
      {shown.map((s) =>
        s.box ? (
          <div
            key={s.runId}
            className="dr-ai-working__area"
            data-testid="ai-working"
            data-run={s.runId}
            style={{ left: s.box.x - 6, top: s.box.y - 6, width: s.box.w + 12, height: s.box.h + 12 }}
          >
            <span className="dr-ai-working__label" role="status">
              <SparkIcon size={12} /> {s.label}
            </span>
          </div>
        ) : (
          <div
            key={s.runId}
            className="dr-ai-working__pill"
            data-testid="ai-working"
            data-run={s.runId}
            role="status"
          >
            <SparkIcon size={12} /> {s.label.replace(/ here$/, '')}
          </div>
        ),
      )}
    </div>
  )
}
