// OWNER: W2 (wave L, L2-1d). "Remove this AI result": one transact that deletes what one AI run made, except
// what anyone changed since. A run's elements are those whose `customData.lobby.ai.run` is the run id, and what a
// frame of the run held as made in the same step without provenance of its own (the Recap frame's table and the
// room's votes). One is removed only while
//  - its server stamps still say nobody edited its words (`lobbyServer.lastEditedAt` equals `createdAt`, for
//    the element and for its bound label), and
//  - its version (and its label's) is the one this tab saw once the run had been saved: a move, a recolour or
//    any other edit by anyone (this tab included) changes it.
// It never deletes anything else, never deletes a frame that keeps something, and never revives anything (it
// only deletes live elements). Wave M (M4-2): nor what is locked or under a text lease right now (the apply's skip
// rules); those stay and are counted with what someone changed. This tab knows the versions only of runs it wrote itself (any writer: the AI
// menus, public.ts callers): the record is in memory, gone with the page. A themes run moved notes that existed
// before it: those are not deleted but put back from History (the before_ai_themes checkpoint), so its labels
// link there instead.
//
// The record (`watchAiRuns`, installed by the feature's onMount): every element this tab creates with an AI run
// id of its own person is noted, and its version (with its label's) is taken once the tab's saves have settled
// (the server's stamps and fixes are then applied), so the record is what the server keeps.

import type { CanvasElement, CanvasFeatureContext, LobbyCanvas } from '../../../canvas/api/index.ts'
import { items } from '../../../canvas/api/index.ts'
import { countUsage } from '../../../lib/usage.ts'
import { plural } from '../copy.ts'
import { endUndoOffer } from './actions.ts'
import { aiKindWord, aiOf, stampsOf } from './provenance.ts'
import { perCanvas } from './runtime.ts'

/** What this tab saw of one run it wrote: each element's version (labels included) once saved. */
export interface RunRecord {
  readonly versions: Map<string, number>
  /** the kinds of what it made ('theme-label', 'action-item', …) */
  readonly kinds: Set<string>
  /** created and not yet settled: their versions are taken at the next settle */
  readonly pending: Set<string>
}

export const runRecords = perCanvas<Map<string, RunRecord>>(() => new Map())

const versionOf = (el: CanvasElement | undefined) => (el as { version?: number } | undefined)?.version ?? -1
const live = (el: CanvasElement | undefined): el is CanvasElement =>
  !!el && !(el as { isDeleted?: boolean }).isDeleted
const labelIdOf = (canvas: Pick<LobbyCanvas, 'get'>, el: CanvasElement) =>
  items.labelOf(el, (id) => canvas.get(id))?.id ?? null

const isLabel = (el: CanvasElement) =>
  el.type === 'text' && !!(el as { containerId?: string | null }).containerId

/**
 * Notes `ids` (just created by this tab, in one step) under their run, when they carry one of `me`'s runs. What
 * a run's frame made in the same step holds without AI provenance of its own (the Recap frame's planned-vs-actual
 * table and the room's top-voted lines: the room's results, never stamped as AI) is part of that run too, so the
 * frame can go with everything in it. Anything put into the frame later is not: the frame then stays.
 */
export function noteCreated(canvas: LobbyCanvas, ids: readonly string[], me: string): boolean {
  let any = false
  const recordOf = (run: string): RunRecord => {
    const rec = runRecords(canvas).get(run) ?? { versions: new Map(), kinds: new Set(), pending: new Set() }
    runRecords(canvas).set(run, rec)
    return rec
  }
  /** this step's frames of a run of `me`'s: frame id → run */
  const frames = new Map<string, string>()
  for (const id of ids) {
    const el = canvas.get(id)
    const ai = aiOf(el)
    if (!el || !ai?.run || ai.by !== me || isLabel(el)) continue
    const rec = recordOf(ai.run)
    rec.pending.add(id)
    const kind = aiKindWord(el)
    if (kind) rec.kinds.add(kind)
    if (el.type === 'frame') frames.set(id, ai.run)
    any = true
  }
  if (frames.size)
    for (const id of ids) {
      const el = canvas.get(id)
      if (!el || aiOf(el) || isLabel(el)) continue
      const run = el.frameId ? frames.get(el.frameId) : undefined
      if (!run) continue
      recordOf(run).pending.add(id)
      any = true
    }
  return any
}

/** The server has stamped it (`lobbyServer.createdAt`): its version is the one the server keeps. */
const stamped = (el: CanvasElement | undefined) => !!el && stampsOf(el).createdAt !== null

/**
 * Takes the versions of the pending elements (and their labels): the saves have settled. Wave M (M4-2): only of
 * those the server has stamped, with their labels (a save that had not been sent yet left the record one version
 * behind, so Remove kept everything as "changed since"); the others stay pending for the next settle. `force`
 * takes them all (the wait is over, or Remove is asked now). Returns how many are still pending.
 */
export function settleRecords(canvas: LobbyCanvas, force = true): number {
  let left = 0
  for (const rec of runRecords(canvas).values()) {
    for (const id of [...rec.pending]) {
      const el = canvas.get(id)
      if (!live(el)) {
        rec.pending.delete(id)
        continue
      }
      const label = labelIdOf(canvas, el)
      const l = label ? canvas.get(label) : undefined
      if (!force && (!stamped(el) || (label && !stamped(l)))) {
        left++
        continue
      }
      rec.versions.set(id, versionOf(el))
      if (label) rec.versions.set(label, versionOf(l))
      rec.pending.delete(id)
    }
  }
  return left
}

/** How long the record waits for this tab's saves to settle after an AI write, at most. */
export const SETTLE_WAIT_MS = 20_000
const SETTLE_POLL_MS = 120

/**
 * Keeps the run records of `ctx.canvas` (see the header): created elements with one of this person's run ids
 * are noted on every local change, and their versions taken once the tab's saves have settled. Returns the stop.
 */
export function watchAiRuns(ctx: CanvasFeatureContext): () => void {
  const { canvas } = ctx
  let timer: ReturnType<typeof setTimeout> | null = null
  let since = 0
  const settled = () => {
    const s = canvas.saveStatus()
    return s.state === 'saved' || (s.state !== 'offline' && s.pending === 0)
  }
  const poll = () => {
    timer = null
    const late = Date.now() - since > SETTLE_WAIT_MS
    // the saves settled, and the server stamped what was made (else wait on, up to SETTLE_WAIT_MS)
    if ((settled() && settleRecords(canvas, false) === 0) || late) {
      if (late) settleRecords(canvas)
      return
    }
    timer = setTimeout(poll, SETTLE_POLL_MS)
  }
  const off = canvas.on('change', (change) => {
    if (change.source !== 'local' || !change.created.length) return
    if (!noteCreated(canvas, change.created, ctx.me.user.id)) return
    since = Date.now()
    if (timer === null) timer = setTimeout(poll, SETTLE_POLL_MS)
  })
  return () => {
    off()
    if (timer !== null) clearTimeout(timer)
  }
}

/** What Remove would do with one run right now (pure over the canvas reads). */
export interface RemovalPlan {
  readonly runId: string
  /** element ids to delete (a note's label goes with it) */
  readonly remove: string[]
  /** the run's elements that stay: someone changed them (or this tab never saw them settle) */
  readonly kept: string[]
  /** the run's frames that stay, unchanged, only because they hold something that is not removed */
  readonly held: string[]
  /** a themes run: its notes are put back from History, not deleted */
  readonly themes: boolean
}

/** Whether `rec` holds `id` (made by its run, or held in its frame as made in the same step). */
const recorded = (rec: RunRecord, id: string) => rec.versions.has(id) || rec.pending.has(id)

/**
 * The run of an element (its own, or its container's for a label; for a piece of a run's frame with no AI
 * provenance, the run it was recorded under), if this tab recorded it.
 */
export function recordedRunOf(canvas: LobbyCanvas, id: string): string | null {
  const el = canvas.get(id)
  if (!el) return null
  const root = items.containerOf(el, (x) => canvas.get(x))
  const run = aiOf(root)?.run ?? null
  if (run) return runRecords(canvas).has(run) ? run : null
  const rootId = root?.id ?? id
  for (const [r, rec] of runRecords(canvas)) if (recorded(rec, rootId)) return r
  return null
}

/**
 * Wave M (M4-2): someone holds it now: locked, or its words (or its label's) under a text lease, this tab's open
 * editor included. Remove leaves it, as the apply's skip rules leave a note that is locked or being typed in.
 */
function heldNow(canvas: LobbyCanvas, id: string): boolean {
  return canvas.isLocked(id) || canvas.editingId() === id || canvas.leaseHolder(id) !== null
}

/** Unchanged since the run: the words never edited (server stamps) and the version this tab recorded. */
function untouched(canvas: LobbyCanvas, rec: RunRecord, el: CanvasElement): boolean {
  const parts = [el]
  const label = labelIdOf(canvas, el)
  const l = label ? canvas.get(label) : undefined
  if (l) parts.push(l)
  // still this tab's own, not yet stamped by the server (its save is on its way): nobody else has had it
  const own = rec.pending.has(el.id)
  for (const p of parts) {
    if (heldNow(canvas, p.id)) return false
    if (own) continue
    const s = stampsOf(p)
    if (s.createdAt !== null && s.lastEditedAt !== null && s.lastEditedAt !== s.createdAt) return false
    const seen = rec.versions.get(p.id)
    if (seen === undefined || seen !== versionOf(p)) return false
  }
  return true
}

/** Wave M (M4-2): whether this tab's run `runId` grouped notes into themes (a read only: it settles nothing). */
export const isThemesRun = (canvas: LobbyCanvas, runId: string): boolean =>
  runRecords(canvas).get(runId)?.kinds.has('theme-label') ?? false

export function removalPlan(canvas: LobbyCanvas, runId: string): RemovalPlan | null {
  const rec = runRecords(canvas).get(runId)
  if (!rec) return null
  // M4-2: what the server stamped meanwhile is taken now; what it has not stamped yet stays this tab's own (never
  // forced: a version taken before the stamp would make Remove keep it as "changed since" afterwards)
  if (rec.pending.size) settleRecords(canvas, false)
  // the run's elements: stamped with it, or held in its frame as made in the same step (noteCreated)
  const mine = canvas
    .items()
    .filter((e) => live(e) && !isLabel(e) && (aiOf(e)?.run === runId || recorded(rec, e.id)))
  const remove = new Set<string>()
  const kept: string[] = []
  const held: string[] = []
  for (const el of mine) {
    if (el.type === 'frame') continue
    if (untouched(canvas, rec, el)) remove.add(el.id)
    else kept.push(el.id)
  }
  // A frame of the run goes only with everything in it.
  for (const f of mine.filter((e) => e.type === 'frame')) {
    const inside = items.childrenOf(f.id, canvas.items()).filter((id) => live(canvas.get(id)))
    const roots = inside.filter((id) => {
      const c = canvas.get(id)
      return !!c && !isLabel(c)
    })
    if (!untouched(canvas, rec, f)) kept.push(f.id)
    else if (roots.every((id) => remove.has(id))) remove.add(f.id)
    else held.push(f.id)
  }
  return { runId, remove: [...remove], kept, held, themes: rec.kinds.has('theme-label') }
}

/** Removes what `plan` names in one transact (one undo step). Returns how many went. */
export function applyRemoval(canvas: LobbyCanvas, plan: RemovalPlan): number {
  const ids = plan.remove.filter((id) => live(canvas.get(id)))
  if (!ids.length) return 0
  canvas.transact('ai: remove result', (tx) => {
    for (const id of ids) tx.delete(id)
  })
  canvas.select([])
  return ids.length
}

/**
 * The toast after a removal: what went, what stayed because someone changed it, and a frame that stayed (unchanged)
 * because it holds something else.
 */
export function removedText(removed: number, kept: number, held = 0): string {
  const frames = held
    ? held === 1
      ? ' Kept the frame: it holds other content.'
      : ` Kept ${held} frames: they hold other content.`
    : ''
  if (!removed) {
    if (kept) return `Nothing removed: ${plural(kept, 'part')} changed since.${frames}`
    return held ? `Nothing removed.${frames}` : 'Nothing left to remove.'
  }
  const base = `Removed ${plural(removed, 'AI-made item')}.`
  return `${base}${kept ? ` Kept ${plural(kept, 'item')} someone changed.` : ''}${frames}`
}

/**
 * "Remove this AI result" (L2-1d): one transact deleting what the run made that nobody changed since (./remove.ts).
 * A themes run moved notes that were there before: History puts them back (its before_ai_themes checkpoint).
 */
export function removeResult(ctx: CanvasFeatureContext, runId: string): void {
  const { canvas } = ctx
  const plan = removalPlan(canvas, runId)
  if (!plan || canvas.readOnly()) return
  countUsage('ai.open:remove-result')
  if (plan.themes) {
    ctx.openPanel('history')
    ctx.notify({
      key: 'dr-ai',
      text: 'To put the notes back, restore “Before AI grouped notes into themes” in History.',
      testId: 'ai-done',
      timeoutMs: 8000,
    })
    return
  }
  // the last result's Undo toast must not take this step for its own (and dismiss this toast)
  endUndoOffer(canvas)
  const removed = applyRemoval(canvas, plan)
  ctx.notify({
    key: 'dr-ai',
    text: removedText(removed, plan.kept.length, plan.held.length),
    testId: 'ai-removed',
    timeoutMs: 7000,
  })
}
