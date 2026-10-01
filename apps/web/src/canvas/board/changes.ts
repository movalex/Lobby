/**
 * `LobbyCanvas.on('change')` (docs/EXCALIDRAW-CONTRACTS.md §2.1): batches of document changes with their
 * source, the replacement for tldraw's `store.listen` diff and its `sideEffects` handlers.
 *
 * Three feeds reach the board page:
 *  - the engine core's `applied` event: elements the core installed (a remote edit, a server repair, a
 *    reset from `confirmed`). Reported at once as `remote`, and the installed versions are remembered;
 *  - an undo or redo (Lobby's history): the ids it patched are marked before it installs them;
 *  - the port's `changed` event after Excalidraw's `onChange`: every element whose version moved. An id at
 *    a version the core installed was reported already (skipped); an id marked by history is `history`;
 *    anything else is `local` (a user gesture or a `transact`).
 *
 * Created / updated / deleted follow liveness: an element that was not live before and is live now is
 * created (a restore included), one that was live and is deleted now is deleted, a live one that stays
 * live is updated. A tombstone this tab never saw live is not reported.
 *
 * Pure (Node-tested): elements are read through the lookup the board page passes.
 */
import type { CanvasChange, ChangeSource } from '../api/lobby-canvas.ts'

export interface ChangeElement {
  readonly id: string
  readonly version: number
  readonly isDeleted: boolean
}

type Lookup = (id: string) => ChangeElement | undefined

interface Known {
  version: number
  live: boolean
}

export class ChangeClassifier {
  private readonly known = new Map<string, Known>()
  /** versions the engine core installed, not yet seen by a `changed` scan */
  private readonly remote = new Map<string, number>()
  /** ids an undo or redo is about to install */
  private readonly history = new Set<string>()

  /** Starts from a scene without reporting it (the page attached to a scene it already shows). */
  seed(elements: Iterable<ChangeElement>): void {
    for (const e of elements) this.known.set(e.id, { version: e.version, live: !e.isDeleted })
  }

  /** An undo or redo will install these ids (their next scan reports them as `history`). */
  markHistory(ids: Iterable<string>): void {
    for (const id of ids) this.history.add(id)
  }

  /** The core installed `ids` (its `applied` event): the remote batch, or null when nothing changed. */
  applied(ids: readonly string[], get: Lookup): CanvasChange | null {
    const out = batch('remote')
    for (const id of ids) {
      const el = get(id)
      this.remote.set(id, el?.version ?? -1)
      this.classify(id, el, out)
    }
    return nonEmpty(out)
  }

  /**
   * The port's `changed` ids after a scene scan: the `history` and `local` batches (at most one each, in
   * that order). Ids at a version the core installed are skipped.
   */
  scanned(ids: readonly string[], get: Lookup): CanvasChange[] {
    const hist = batch('history')
    const local = batch('local')
    for (const id of ids) {
      const el = get(id)
      const installed = this.remote.get(id)
      if (installed !== undefined) {
        this.remote.delete(id)
        if (installed === (el?.version ?? -1)) continue
      }
      const target = this.history.delete(id) ? hist : local
      this.classify(id, el, target)
    }
    return [hist, local].filter((b) => nonEmpty(b) !== null)
  }

  private classify(id: string, el: ChangeElement | undefined, out: MutableChange): void {
    const prev = this.known.get(id)
    const live = !!el && !el.isDeleted
    if (el) this.known.set(id, { version: el.version, live })
    else this.known.delete(id)
    const wasLive = prev?.live === true
    if (live && !wasLive) out.created.push(id)
    else if (!live && wasLive) out.deleted.push(id)
    else if (live && wasLive && prev?.version !== el?.version) out.updated.push(id)
  }
}

interface MutableChange {
  readonly source: ChangeSource
  readonly created: string[]
  readonly updated: string[]
  readonly deleted: string[]
}

const batch = (source: ChangeSource): MutableChange => ({ source, created: [], updated: [], deleted: [] })

const nonEmpty = (c: MutableChange): CanvasChange | null =>
  c.created.length || c.updated.length || c.deleted.length ? c : null
