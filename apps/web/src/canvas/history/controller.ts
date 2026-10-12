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
import { type Entry, LobbyHistory, type StepResult } from './stack.ts'

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
  /**
   * Selects `ids` (F11: after an undo or a redo, the selection its step was made with, already narrowed
   * to what is live and unlocked). `groups`: the groups among them that were selected as a group (Excalidraw's
   * `selectedGroupIds`: a group comes back as one selection, not as its members; every live, unlocked member
   * of each is in `ids`). The selection is read from the scene's gesture state. Without it the selection is
   * left as it is.
   */
  readonly select?: (ids: readonly string[], groups: readonly string[]) => void
  /** The clock of the selection's settle window (`SELECTION_SETTLE_MS`); `Date.now` by default. */
  readonly now?: () => number
}

/**
 * How long after a step was recorded the selection that arrives may still be the one it ended with, when the
 * step ended with nothing selected. Excalidraw applies an `appState` update on its next render, so a select
 * made by Lobby code in the same breath as a step (the mind map selects the topic again as its editor closes,
 * in the same tick as the layout write that joins the step: runtime.ts `editorClosed`) is not yet in the
 * state the boundary reads: the step is recorded with an empty selection and its redo selected nothing. The
 * next boundary that finds a selection within this window gives it to the step. A person's own click is not
 * that fast, and a step that really ended with nothing selected (a delete) takes at worst the next thing
 * they click within the window.
 */
export const SELECTION_SETTLE_MS = 300

export interface UndoOutcome {
  readonly result: StepResult
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
  /**
   * The selection at the last boundary that recorded nothing (or at the last step, undo or redo): what
   * the next step begins with (F11). The board page calls `boundary()` on every scene change that changes
   * the gesture state, which includes the selection, so a selection made before a change is here when the
   * change's step is recorded (a delete clears the selection in the same change it deletes in).
   */
  private restSelection: readonly string[] = []
  private readonly now: () => number
  /** until when a boundary that records nothing may complete the selection of the last step (`SELECTION_SETTLE_MS`) */
  private settleUntil = 0

  constructor(o: UndoControllerOptions) {
    this.o = o
    this.now = o.now ?? (() => Date.now())
    const sceneMap = () => this.sceneMap('live')
    // attached after the welcome: start from the scene as it is (nothing before this is undoable)
    if (o.core.welcome) this.resetHistory()
    this.restSelection = this.selectionNow()
    let epoch = o.core.welcome?.epoch ?? null
    this.off.push(
      o.core.on((e) => {
        if (e.kind === 'welcome') {
          // the first welcome, or a board restored to another epoch: nothing before is undoable. A
          // reconnect to the same epoch keeps the stacks (B3 L6 3f: an edit made offline is undone after
          // its replay); what changed meanwhile arrived as the core's 'applied' event and was absorbed like any remote edit
          if (epoch === null || e.welcome.epoch !== epoch) {
            this.resetHistory()
            this.restSelection = this.selectionNow()
            this.settleUntil = 0
          }
          epoch = e.welcome.epoch
        } else if (e.kind === 'applied') {
          // (wave N.1: a new copy of the row the scene showed brings nothing to take in: `same`; and the apply's ids
          // are looked up in the scene's own map when it has one, without a walk of every element: a chunked install
          // of a large board applies about a thousand at a time)
          const get = o.scene.get
          const now = get ? null : sceneMap()
          for (const id of e.ids)
            if (!e.same?.has(id))
              this.history.absorb(
                e.before.get(id) as HistEl | undefined,
                (now ? now.get(id) : (get?.(id) as HistEl | undefined)) as HistEl | undefined,
              )
        } else if (e.kind === 'push') this.history.markPushed(e.record.seq, e.ids)
      }),
      o.core.onAck((ack) => this.history.onAck(ack as never, sceneMap())),
    )
  }

  dispose(): void {
    for (const f of this.off.splice(0)) f()
  }

  /** ids `sceneMap` gave a stand-in for (a held arrow's path, a label another session holds) at its last call */
  private substituted = new Set<string>()

  /**
   * The stacks start afresh from the scene (a first welcome, another epoch). Wave N.1: an element the scene map takes
   * as it is keeps the stack's copy of it when that copy is of the same version (LobbyHistory.reset `reuse`).
   */
  private resetHistory(): void {
    const scene = this.sceneMap('reset')
    const substituted = this.substituted
    this.history.reset(scene, (el) => !substituted.has(el.id))
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
    const substituted = new Set<string>()
    this.substituted = substituted
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
          substituted.add(el.id)
          continue
        }
      }
      if (holders && el.type === 'text') {
        const leaseId = (el as { containerId?: string | null }).containerId || el.id
        const h = holders.get(leaseId)
        const conf = h && h.sid !== me ? this.o.core.confirmed(el.id) : undefined
        if (conf) {
          m.set(el.id, withGroupsFrom(el, conf, LEASED_GROUPS) as unknown as HistEl)
          substituted.add(el.id)
          continue
        }
      }
      m.set(el.id, el as unknown as HistEl)
    }
    return m
  }

  /**
   * A step boundary: one entry for everything the user changed since the previous one (or null). The
   * entry keeps the selection the step was made with (F11): the selection at the previous quiet boundary,
   * and the one now. A boundary that records nothing and finds a selection within `SELECTION_SETTLE_MS` of the
   * last step completes that step's selection when it ended with none (the engine had not applied the select
   * made in the same breath as the step).
   */
  boundary(label?: string): Entry | null {
    // inside `outside`: the write is being installed, and is never part of a step
    if (this.installingOutside > 0) return null
    // wave N.1: while the core installs a snapshot in chunks the scene is its own (read-only, every chunk absorbed):
    // nothing can be a step, and the record's pass over every element is skipped
    if (this.o.core.installing) return null
    const now = this.selectionNow()
    const entry = this.history.record(this.sceneMap('record'), label, {
      before: this.restSelection,
      after: now,
    })
    this.restSelection = now
    if (entry) this.settleUntil = this.now() + SELECTION_SETTLE_MS
    else if (now.length > 0 && this.now() <= this.settleUntil) this.history.settleSelection(now)
    return entry
  }

  /** The scene's selection (the gesture state's); none when the scene reports no selection. */
  private selectionNow(): readonly string[] {
    return [...(this.o.scene.read().gesture?.selectedElementIds ?? [])]
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
   * nothing or more than one step. When that previous step typed the first words into labels the step
   * before it made (a new mind-map topic), the two are one step too (`LobbyHistory.joinAction`, CR-3D-4).
   */
  joinPrevious<T>(write: () => T): T {
    this.boundary()
    const mark = this.history.mark()
    const result = write()
    this.history.joinAction(mark)
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
    this.settleUntil = 0
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
    this.restoreSelection(result.selection)
    return { result, kept: result.kept, keptBy: keptBy(result, holders) }
  }

  /**
   * F11: after an undo or a redo, the selection its step was made with, narrowed to what is still there to
   * select (live, unlocked). Left alone when the entry recorded none or it is already the selection.
   */
  private restoreSelection(ids: readonly string[] | null): void {
    if (!ids) return
    const els = new Map(this.o.scene.read().elements.map((e) => [e.id, e]))
    const keep = ids.filter((id) => {
      const el = els.get(id) as (SceneElement & { locked?: boolean }) | undefined
      return !!el && !el.isDeleted && !el.locked
    })
    this.restSelection = keep
    if (!this.o.select) return
    const now = this.selectionNow()
    if (now.length === keep.length && keep.every((id) => now.includes(id))) return
    this.o.select(keep, selectedGroups(keep, this.o.scene.read().elements))
  }
}

/**
 * The groups of a restored selection that were selected as a group: Excalidraw selects a group whole (every
 * member in `selectedElementIds`, the group in `selectedGroupIds`), so a selection that holds every live
 * member of a group is the group selected. Each selected element contributes the outermost of its groups that
 * the selection holds whole (`groupIds` run from the innermost group to the outermost, as Excalidraw's
 * `selectGroupsFromGivenElements` takes the last). Groups are read from the elements as they are now: an undo
 * of Ctrl+G, which ungroups, restores its members with no group, and a redo of it, which groups them again,
 * restores the group. A group with a member that is not in the selection (locked, say) stays its members,
 * and so does a group with fewer than 2 live members (the others deleted): Excalidraw never selects such a
 * group (`selectGroup` in @excalidraw/element groups.ts refuses one), so a lone member comes back as itself.
 */
export function selectedGroups(ids: readonly string[], elements: readonly SceneElement[]): readonly string[] {
  const selected = new Set(ids)
  const held: SceneElement[] = []
  const wanted = new Set<string>()
  for (const el of elements)
    if (selected.has(el.id)) {
      held.push(el)
      for (const g of groupIdsOf(el)) wanted.add(g)
    }
  if (wanted.size === 0) return []
  // a group with a live member the selection does not hold is not selected whole; one with fewer than 2
  // live members (selected or not) is not a group Excalidraw selects
  const broken = new Set<string>()
  const live = new Map<string, number>()
  for (const el of elements) {
    if (el.isDeleted) continue
    for (const g of groupIdsOf(el)) {
      if (!wanted.has(g)) continue
      live.set(g, (live.get(g) ?? 0) + 1)
      if (!selected.has(el.id)) broken.add(g)
    }
  }
  for (const g of wanted) if ((live.get(g) ?? 0) < 2) broken.add(g)
  const out = new Set<string>()
  for (const el of held) {
    const groups = groupIdsOf(el)
    for (let i = groups.length - 1; i >= 0; i--) {
      const g = groups[i] as string
      if (broken.has(g)) continue
      out.add(g)
      break
    }
  }
  return [...out]
}

const groupIdsOf = (el: SceneElement): readonly string[] =>
  Array.isArray(el.groupIds) ? (el.groupIds as string[]) : []

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
