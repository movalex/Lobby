/**
 * Lobby's undo wired to the engine core (docs/EXCALIDRAW-MIGRATION.md §2.8): the field-level stack
 * (./stack.ts) fed by the core's events, installed through the scene, pushed by the core as ordinary
 * edits.
 *
 *  - Recording: `boundary()` at a step boundary (the end of a gesture, a text-editor close, one keyboard
 *    action, one `CanvasPort.transact`) diffs the scene against `lastLocal`. An arrow whose change is only
 *    derived (E10, held by the core) is recorded at its server copy, so it never becomes a step.
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
import type { SceneAdapter, SceneElement } from '../sync/types.ts'
import type { ApplyContext, ApplyResult } from './apply.ts'
import type { HistEl, Scene } from './diff.ts'
import { fieldGroup } from './fields.ts'
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

  constructor(o: UndoControllerOptions) {
    this.o = o
    const sceneMap = () => this.sceneMap(false)
    // attached after the welcome: start from the scene as it is (nothing before this is undoable)
    if (o.core.welcome) this.history.reset(this.sceneMap(true))
    let epoch = o.core.welcome?.epoch ?? null
    this.off.push(
      o.core.on((e) => {
        if (e.kind === 'welcome') {
          // the first welcome, or a board restored to another epoch: nothing before is undoable. A
          // reconnect to the same epoch keeps the stacks (B3 L6 3f: an edit made offline is undone after
          // its replay); what changed meanwhile arrived as the core's 'applied' event and was absorbed like any remote edit
          if (epoch === null || e.welcome.epoch !== epoch) this.history.reset(this.sceneMap(true))
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
   * The scene as undo sees it. `forRecord`: a held derived arrow change counts as its server copy, and so
   * do the `text` and `layout` fields of a text whose lease another session holds (this tab cannot write
   * them: the core puts them back, §2.9.2), so neither is ever part of a step. B3 L6 (4): B's frame drag
   * moves N's label locally while A types in it; recording that move made B's undo of the drag report
   * "1 change kept" for a label position B never wrote.
   */
  private sceneMap(forRecord: boolean): Scene {
    const m = new Map<string, HistEl>()
    const holders = forRecord ? this.o.core.leaseHolders() : null
    const me = this.o.core.sid
    for (const el of this.o.scene.read().elements) {
      if (forRecord && this.o.core.isDerivedHeld(el.id)) {
        const conf = this.o.core.confirmed(el.id)
        if (conf) {
          m.set(el.id, conf as unknown as HistEl)
          continue
        }
      }
      if (holders && el.type === 'text') {
        const leaseId = (el as { containerId?: string | null }).containerId || el.id
        const h = holders.get(leaseId)
        const conf = h && h.sid !== me ? this.o.core.confirmed(el.id) : undefined
        if (conf) {
          m.set(el.id, withLeasedFrom(el, conf) as unknown as HistEl)
          continue
        }
      }
      m.set(el.id, el as unknown as HistEl)
    }
    return m
  }

  /** A step boundary: one entry for everything the user changed since the previous one (or null). */
  boundary(label?: string): Entry | null {
    return this.history.record(this.sceneMap(true), label)
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
    const scene = this.sceneMap(false)
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
      const next: SceneElement[] = []
      for (const el of this.o.scene.read().elements) {
        const patch = result.patches.get(el.id)
        next.push(patch ? this.o.bump(el, patch) : el)
      }
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

/** `el` with its `text` and `layout` fields (the lease-gated ones of a text) taken from `conf`. */
function withLeasedFrom(el: SceneElement, conf: SceneElement): SceneElement {
  const out: Record<string, unknown> = { ...(el as unknown as Record<string, unknown>) }
  const src = conf as unknown as Record<string, unknown>
  for (const k of new Set([...Object.keys(out), ...Object.keys(src)])) {
    const g = fieldGroup(el, k)
    if (g !== 'text' && g !== 'layout') continue
    if (k in src) out[k] = src[k]
    else delete out[k]
  }
  return out as unknown as SceneElement
}
