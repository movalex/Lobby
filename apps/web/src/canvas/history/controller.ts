/**
 * Lobby's undo wired to the engine core (docs/EXCALIDRAW-MIGRATION.md §2.8): the field-level stack
 * (./stack.ts) fed by the core's events, installed through the scene, pushed by the core as ordinary
 * edits.
 *
 *  - Recording: `boundary()` at a step boundary (the end of a gesture, a text-editor close, one keyboard
 *    action, one `CanvasPort.transact`) diffs the scene against `lastLocal`. The `path` of an arrow whose
 *    change the core holds as derived (E10) is recorded at the stack's own last copy of it (`sceneMap`),
 *    so the held geometry never becomes a step; the arrow's other groups are recorded as they are.
 *  - A reconnect (a welcome of the same epoch) keeps both stacks; the first welcome and an epoch change
 *    (a restore) start them afresh.
 *  - Remote changes and the core's own resets (a deny, a reject, a held derived change released) arrive
 *    as the core's `applied` event and are ABSORBED, never recorded. `markPushed` follows `push`, `onAck`
 *    folds `fix` and `derived` rows (no fix or repair ever creates a step).
 *  - `undo()` / `redo()`: the compare-and-set of §2.8 against the current scene, installed as new element
 *    versions (the core then pushes them); the result says how many changes were kept ("1 change kept —
 *    Bob edited it since").
 *
 * NODE-SAFE (CONTRACTS.md): the headless client undoes with the same code the browser runs.
 */
import type { LeaseHolder } from '@draftroom/canvas-schema/protocol'
import type { LobbyEngineCore } from '../sync/core/engine.ts'
import { compareIndexThenId } from '../sync/index-keys.ts'
import type { SceneAdapter, SceneElement } from '../sync/types.ts'
import type { ApplyContext, ApplyResult } from './apply.ts'
import type { HistEl, Scene } from './diff.ts'
import { fieldGroup, type GroupName } from './fields.ts'
import { type Entry, LobbyHistory } from './stack.ts'

export interface UndoControllerOptions {
  readonly core: LobbyEngineCore
  readonly scene: SceneAdapter
  /** a local edit's new copy of an element (version + 1, a new versionNonce) */
  readonly bump: (el: SceneElement, patch: Readonly<Record<string, unknown>>) => SceneElement
  /**
   * Installs the elements of an undo or redo (the whole array, as `SceneAdapter.apply` takes it) so the
   * engine sees them as a local edit: in the browser `updateScene` (Excalidraw's onChange then feeds the
   * core); in Node the scene's apply followed by `core.onSceneChange`.
   */
  readonly install?: (elements: readonly SceneElement[]) => void
  /** label layout that depends on what an undo changed (§2.8 side effects); never a leased label */
  readonly recompute?: ApplyContext['recompute']
}

export interface UndoOutcome {
  readonly result: ApplyResult
  /** elements with a non-silent skip ("N changes kept") */
  readonly kept: number
  /** who edited what was kept, when the roster knows (for the toast) */
  readonly keptBy: string | null
}

export class UndoController {
  readonly history = new LobbyHistory()
  private readonly o: UndoControllerOptions
  private readonly off: (() => void)[] = []
  /** > 0 while `outside` installs a write (a boundary then records nothing) */
  private installingOutside = 0

  constructor(o: UndoControllerOptions) {
    this.o = o
    const sceneMap = () => this.sceneMap('live')
    // attached after the welcome: start from the scene as it is (nothing before this is undoable)
    if (o.core.welcome) this.history.reset(this.sceneMap('reset'))
    let epoch = o.core.welcome?.epoch ?? null
    this.off.push(
      o.core.on((e) => {
        if (e.kind === 'welcome') {
          // the first welcome, or a board restored to another epoch: nothing before is undoable. A
          // reconnect to the same epoch keeps the stacks (B3 L6 3f: an edit made offline is undone after
          // its replay); what changed meanwhile arrived as the core's 'applied' event and was absorbed like any remote edit
          if (epoch === null || e.welcome.epoch !== epoch) this.history.reset(this.sceneMap('reset'))
          epoch = e.welcome.epoch
        } else if (e.kind === 'applied') {
          const now = sceneMap()
          for (const id of e.ids) this.history.absorb(e.before.get(id) as HistEl | undefined, now.get(id))
        } else if (e.kind === 'push') this.history.markPushed(e.record.seq, e.ids)
      }),
      o.core.onAck((ack) => this.history.onAck(ack as never, sceneMap())),
    )
  }

  dispose(): void {
    for (const f of this.off.splice(0)) f()
  }

  /**
   * The scene as undo sees it. `live`: the scene as it is (the compare-and-set of an undo, `absorb`).
   * `record` and `reset` hide what this tab cannot write, so it is never part of a step:
   *
   *  - the `path` of an arrow whose change the core holds as derived (E10, §2.5.2: its bound ends follow
   *    their targets; the server re-snaps it and the core installs that), and the `layout` of its label
   *    when it moved with it (held the same way). At a boundary (`record`) that group is the stack's own
   *    last copy of it (`lastLocal`: as of the previous boundary, or as the last undo or redo wrote it),
   *    whatever the scene shows now; the server's re-snap arrives as the core's `applied` event and is
   *    absorbed. At a `reset` (a welcome) it is the server copy's. Only the held group is replaced: the
   *    element's other groups are the user's own (an arrow's life, bindings and style), and they may be
   *    changed, unsent or in flight at that moment. Before (wave 4d, 2A): the WHOLE server copy
   *    stood in for a held arrow, so an undo that revived a bound arrow (its life and bindings pushed, its
   *    before-side path held as derived), followed by a boundary before that push's ack, recorded the
   *    server's post-delete copy as a new step and dropped the redo stack (collab-conflicts.spec.ts
   *    "undo … step by step": the third Ctrl+Z brought the arrow back in its deleted-end form). The
   *    record's version fast path hid it while the ack came before the next press; the room's commit
   *    pacing (ac72d87, 40 ms) and any real network make that order unreliable;
   *  - the `text` and `layout` fields of a text whose lease another session holds (this tab cannot write
   *    them: the core puts them back, §2.9.2). B3 L6 (4): B's frame drag moves N's label locally while A
   *    types in it; recording that move made B's undo of the drag report "1 change kept" for a label
   *    position B never wrote.
   */
  private sceneMap(mode: 'live' | 'record' | 'reset'): Scene {
    const m = new Map<string, HistEl>()
    const hide = mode !== 'live'
    const holders = hide ? this.o.core.leaseHolders() : null
    const me = this.o.core.sid
    for (const el of this.o.scene.read().elements) {
      if (hide && this.o.core.isDerivedHeld(el.id)) {
        const conf = this.o.core.confirmed(el.id)
        const base = (mode === 'record' ? this.history.lastLocalOf(el.id) : undefined) ?? conf
        if (base) {
          m.set(
            el.id,
            withGroupsFrom(el, base as unknown as SceneElement, heldGroups(el)) as unknown as HistEl,
          )
          continue
        }
      }
      if (holders && el.type === 'text') {
        const leaseId = (el as { containerId?: string | null }).containerId || el.id
        const h = holders.get(leaseId)
        const conf = h && h.sid !== me ? this.o.core.confirmed(el.id) : undefined
        if (conf) {
          m.set(el.id, withGroupsFrom(el, conf, LEASED_GROUPS) as unknown as HistEl)
          continue
        }
      }
      m.set(el.id, el as unknown as HistEl)
    }
    return m
  }

  /** A step boundary: one entry for everything the user changed since the previous one (or null). */
  boundary(label?: string): Entry | null {
    // inside `outside`: the write is being installed, and is never part of a step
    if (this.installingOutside > 0) return null
    return this.history.record(this.sceneMap('record'), label)
  }

  /**
   * A write outside this tab's history (`transact(…, {skipUndo: true})`: a +1, W5-26). `install` puts it
   * in the scene (and the core scans it); `changed` lists the elements it wrote, each as it was before
   * (undefined: the write created it). It records no step and joins none, and the redo stack stays: what
   * the write changed moves into the stack's copy of the scene as a remote change does (`absorb`), so the
   * next boundary does not record it either, while a local change not recorded yet stays a change (an
   * open text editor's typing still becomes its own step). An undo of an earlier step that changed the
   * same field compares against the write's value and keeps it ("1 change kept"). The push carries it
   * like any edit; a `fix` the server answers for it folds into the stack's copy (`onAck`), never a step.
   */
  outside(install: () => void, changed: Iterable<readonly [string, SceneElement | undefined]>): void {
    this.installingOutside++
    try {
      install()
    } finally {
      this.installingOutside--
    }
    const now = this.sceneMap('live')
    for (const [id, before] of changed) this.history.absorb(before as HistEl | undefined, now.get(id))
  }

  /**
   * Runs `write` (one `CanvasPort.transact`, which records its own step) as part of this tab's previous
   * step (`LobbyHistory.mergeTop`): what the user did before and was not recorded yet becomes its own
   * step first. No join when nothing precedes it, after an undo or a redo, or when `write` recorded
   * nothing or more than one step.
   */
  joinPrevious<T>(write: () => T): T {
    this.boundary()
    const mark = this.history.mark()
    const result = write()
    this.history.mergeTop(mark)
    return result
  }

  undo(): UndoOutcome | null {
    return this.step('undo')
  }

  redo(): UndoOutcome | null {
    return this.step('redo')
  }

  private step(dir: 'undo' | 'redo'): UndoOutcome | null {
    // anything not recorded yet is its own step first (a Ctrl+Z never undoes more than one real change)
    this.boundary()
    const scene = this.sceneMap('live')
    const holders = this.o.core.leaseHolders()
    const me = this.o.core.sid
    const ctx: ApplyContext = {
      isLeasedByOther: (id) => {
        const h = holders.get(id)
        return !!h && h.sid !== me
      },
      recompute: this.o.recompute,
    }
    const result = dir === 'undo' ? this.history.undo(scene, ctx) : this.history.redo(scene, ctx)
    if (!result) return null
    if (result.patches.size) {
      let next: SceneElement[] = []
      let reindexed = false
      for (const el of this.o.scene.read().elements) {
        const patch = result.patches.get(el.id)
        if (patch && 'index' in patch && patch.index !== el.index) reindexed = true
        next.push(patch ? this.o.bump(el, patch) : el)
      }
      // An undo or a redo of a paint-order change (Excalidraw's Ctrl+G moves the grouped elements next to
      // each other, a reorder writes `index`) moves the element in the array too, as `transact` does
      // (port-impl.ts, CR-3A-3). `updateScene` re-keys every element whose `index` is out of place in the
      // array, with a version bump: before (UNDO-group-redo), the old key went in at the element's new
      // slot, was re-keyed straight back, and the board page's boundary after the press recorded that
      // re-key as a new step, which cleared the redo stack (the redo of an own Ctrl+G did nothing)
      if (reindexed) next = next.sort(compareIndexThenId)
      if (this.o.install) this.o.install(next)
      else {
        this.o.scene.apply(next)
        this.o.core.onSceneChange(this.o.scene.read())
      }
    }
    return { result, kept: result.kept, keptBy: keptBy(result, holders) }
  }
}

function keptBy(result: ApplyResult, holders: ReadonlyMap<string, LeaseHolder>): string | null {
  for (const s of result.skips) {
    if (s.silent) continue
    const h = holders.get(s.id)
    if (h) return h.name
  }
  return null
}

/** The lease-gated groups of a text (§2.9.2). */
const LEASED_GROUPS: ReadonlySet<GroupName> = new Set<GroupName>(['text', 'layout'])
/** The group the core holds for a derived change (E10, engine.ts `rebuild`): an arrow's geometry (one unit), or the layout of an arrow's label that moved with it. */
const HELD_ARROW: ReadonlySet<GroupName> = new Set<GroupName>(['path'])
const HELD_LABEL: ReadonlySet<GroupName> = new Set<GroupName>(['layout'])
const heldGroups = (el: SceneElement): ReadonlySet<GroupName> =>
  el.type === 'arrow' ? HELD_ARROW : HELD_LABEL

/** `el` with every field of `groups` taken from `src` (a field `src` lacks is removed). */
function withGroupsFrom(el: SceneElement, src: SceneElement, groups: ReadonlySet<GroupName>): SceneElement {
  const out: Record<string, unknown> = { ...(el as unknown as Record<string, unknown>) }
  const from = src as unknown as Record<string, unknown>
  for (const k of new Set([...Object.keys(out), ...Object.keys(from)])) {
    const g = fieldGroup(el, k)
    if (g === null || !groups.has(g)) continue
    if (k in from) out[k] = from[k]
    else delete out[k]
  }
  return out as unknown as SceneElement
}
