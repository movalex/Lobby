/**
 * OWNER: WS1 (wave N, N1-6; landed by the wave N foundation as a naive, correct implementation). The scene index
 * (`canvas.index`, lobby-canvas.ts SceneIndex): the live notes, the elements carrying a `customData.lobby` key
 * prefix (`react:`, `plusOne:`), the elements of a frame and the elements of a `customData.lobby.kind`, so a
 * feature overlay finds what it draws without walking the whole scene on every change (a 10k-element board).
 *
 * The index is built once, at its first read (one walk of the scene), and from then on kept up to date from the
 * port's `changed` ids (the board page's `afterSceneChange` names every element whose version moved and every one
 * that left the scene): each such id is looked up (`port.get`, the engine's map) and moved between the sets. A read
 * is the set's members in paint order ((index, id), as the scene orders them), cached until a change touches the
 * set. Reads are reactive (a `source` bumped at every change batch, as `items()` is), and `onChanged` listeners
 * hear a batch once the index answers for it. scene-index.test.ts holds every answer to a full rebuild
 * (`sceneIndexOf`) after random op sequences. Reads only: nothing here writes the scene.
 *
 * And the dev-only full-walk counter (`noteSceneWalk`, `sceneWalks`): dev-auth and dev builds count every walk of
 * the whole scene by its site (the index's own build, the LOD pass, the presence hub, the frame-name guard, the
 * hidden-branch expansion, and every `canvas.items()` read), so a perf spec can count walks per pointer move
 * (e2e/excalidraw/n1-drag-10k.spec.ts, `window.__lobbyWalks`). Production builds count nothing.
 */
import { DEV_AUTH_ENABLED } from '../../../lib/identity.ts'
import { source } from '../../../lib/signals.ts'
import type { CanvasElement } from '../../port.ts'
import type { SceneIndex } from '../lobby-canvas.ts'
import type { PartDeps } from './types.ts'

const lobbyOf = (el: CanvasElement): Readonly<Record<string, unknown>> | undefined =>
  (el.customData as { lobby?: Record<string, unknown> } | undefined)?.lobby

/** Whether `el` has a `customData.lobby` key starting with `prefix` (with something after it). */
export function hasLobbyKeyPrefix(el: CanvasElement, prefix: string): boolean {
  const lobby = lobbyOf(el)
  if (!lobby) return false
  for (const k of Object.keys(lobby)) if (k.length > prefix.length && k.startsWith(prefix)) return true
  return false
}

/** `el`'s `customData.lobby.kind`, or null. */
export function lobbyKindOf(el: CanvasElement): string | null {
  const kind = lobbyOf(el)?.kind
  return typeof kind === 'string' ? kind : null
}

/** The index's answers over a list of live elements (a full rebuild: the reference every implementation equals). */
export function sceneIndexOf(items: () => readonly CanvasElement[]): Omit<SceneIndex, 'onChanged'> {
  return {
    notes: () => items().filter((e) => e.type === 'stickynote'),
    withLobbyKeyPrefix: (prefix) => (prefix ? items().filter((e) => hasLobbyKeyPrefix(e, prefix)) : []),
    byFrame: (frameId) => items().filter((e) => e.frameId === frameId),
    byKind: (kind) => items().filter((e) => lobbyKindOf(e) === kind),
  }
}

// ---- the dev-only full-walk counter --------------------------------------------------------------------------

const walkCounting: boolean = (() => {
  try {
    return DEV_AUTH_ENABLED || !!import.meta.env?.DEV
  } catch {
    return false
  }
})()
const walks = new Map<string, number>()

/** Counts one walk of the whole scene at `site` (dev and dev-auth builds; a no-op otherwise). */
export function noteSceneWalk(site: string): void {
  if (walkCounting) walks.set(site, (walks.get(site) ?? 0) + 1)
}

/** The walks counted so far, by site (empty in a production build). */
export function sceneWalks(): Record<string, number> {
  return Object.fromEntries(walks)
}

export function resetSceneWalks(): void {
  walks.clear()
}

/** The files a `canvas.items()` read passes through on its way to the port (never its caller). */
const ITEMS_PLUMBING = /\/src\/canvas\/(api\/impl|board\/session|port-impl)\.ts/

/**
 * N1-6: the walk counter's site for a `canvas.items()` read: `items:<area>/<name>` of the first caller frame under
 * /src/ (the Vite dev server's module URLs: `items:features/workshops`, `items:canvas/lod`); `items` alone in a
 * production build, whose bundles name no module.
 */
export function itemsCallerOf(stack: string | undefined): string {
  for (const line of (stack ?? '').split('\n').slice(1)) {
    if (ITEMS_PLUMBING.test(line)) continue
    const m = /\/src\/([a-z0-9-]+)\/([a-z0-9-]+)/i.exec(line)
    if (m) return `items:${m[1]}/${m[2]}`
  }
  return 'items'
}

/** Whether walks are counted in this build. */
export const sceneWalksCounted = (): boolean => walkCounting

// ---- the incremental index -------------------------------------------------------------------------------------

interface Entry {
  readonly el: CanvasElement
  readonly note: boolean
  readonly frame: string | null
  readonly kind: string | null
  readonly keys: readonly string[]
}

/** Paint order: (index, id), as the scene keeps its array. */
const paintOrder = (a: CanvasElement, b: CanvasElement): number => {
  const ai = (a.index as string | null | undefined) ?? ''
  const bi = (b.index as string | null | undefined) ?? ''
  if (ai !== bi) return ai < bi ? -1 : 1
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
}

const add = (m: Map<string, Set<string>>, k: string, id: string) => {
  let s = m.get(k)
  if (!s) {
    s = new Set()
    m.set(k, s)
  }
  s.add(id)
}
const remove = (m: Map<string, Set<string>>, k: string, id: string) => {
  const s = m.get(k)
  if (!s) return
  s.delete(id)
  if (!s.size) m.delete(k)
}

/**
 * The index's state: built from a full list once, then moved per changed id. Pure (no port, no signals):
 * `get(id)` reads an element's current copy (undefined or deleted: gone). Exported for the tests.
 */
export class IncrementalSceneIndex {
  private readonly entries = new Map<string, Entry>()
  private readonly noteIds = new Set<string>()
  private readonly frames = new Map<string, Set<string>>()
  private readonly kinds = new Map<string, Set<string>>()
  /** per prefix asked for so far: the ids with a key of it (prefixes nobody asked for are not kept) */
  private readonly prefixes = new Map<string, Set<string>>()
  /** the sorted answers, per query, until a change touches them */
  private readonly cache = new Map<string, CanvasElement[]>()

  constructor(items: readonly CanvasElement[]) {
    for (const el of items) if (!el.isDeleted) this.put(el)
  }

  /** Elements `ids` changed (created, updated, deleted, or gone from the scene): `get` reads them now. */
  update(ids: Iterable<string>, get: (id: string) => CanvasElement | undefined): void {
    for (const id of ids) {
      this.drop(id)
      const el = get(id)
      if (el && !el.isDeleted) this.put(el)
    }
  }

  notes(): readonly CanvasElement[] {
    return this.answer('n', () => this.noteIds)
  }

  withLobbyKeyPrefix(prefix: string): readonly CanvasElement[] {
    if (!prefix) return []
    let set = this.prefixes.get(prefix)
    if (!set) {
      // the first ask for this prefix: the index's own entries, once (never the scene)
      set = new Set()
      for (const [id, e] of this.entries)
        if (e.keys.some((k) => k.length > prefix.length && k.startsWith(prefix))) set.add(id)
      this.prefixes.set(prefix, set)
    }
    const s = set
    return this.answer(`p:${prefix}`, () => s)
  }

  byFrame(frameId: string): readonly CanvasElement[] {
    return this.answer(`f:${frameId}`, () => this.frames.get(frameId))
  }

  byKind(kind: string): readonly CanvasElement[] {
    return this.answer(`k:${kind}`, () => this.kinds.get(kind))
  }

  private answer(key: string, set: () => ReadonlySet<string> | undefined): readonly CanvasElement[] {
    const hit = this.cache.get(key)
    if (hit) return hit
    const out: CanvasElement[] = []
    for (const id of set() ?? []) {
      const e = this.entries.get(id)
      if (e) out.push(e.el)
    }
    out.sort(paintOrder)
    this.cache.set(key, out)
    return out
  }

  private put(el: CanvasElement): void {
    const lobby = lobbyOf(el)
    const e: Entry = {
      el,
      note: el.type === 'stickynote',
      frame: (el.frameId as string | null | undefined) ?? null,
      kind: lobbyKindOf(el),
      keys: lobby ? Object.keys(lobby) : [],
    }
    this.entries.set(el.id, e)
    this.touch(e)
    if (e.note) this.noteIds.add(el.id)
    if (e.frame) add(this.frames, e.frame, el.id)
    if (e.kind) add(this.kinds, e.kind, el.id)
    for (const [prefix, set] of this.prefixes)
      if (e.keys.some((k) => k.length > prefix.length && k.startsWith(prefix))) set.add(el.id)
  }

  private drop(id: string): void {
    const e = this.entries.get(id)
    if (!e) return
    this.entries.delete(id)
    this.touch(e)
    this.noteIds.delete(id)
    if (e.frame) remove(this.frames, e.frame, id)
    if (e.kind) remove(this.kinds, e.kind, id)
    for (const set of this.prefixes.values()) set.delete(id)
  }

  /** The cached answers `e` is (or was) part of go. */
  private touch(e: Entry): void {
    if (e.note) this.cache.delete('n')
    if (e.frame) this.cache.delete(`f:${e.frame}`)
    if (e.kind) this.cache.delete(`k:${e.kind}`)
    for (const prefix of this.prefixes.keys())
      if (e.keys.some((k) => k.length > prefix.length && k.startsWith(prefix)))
        this.cache.delete(`p:${prefix}`)
  }
}

export function createSceneIndexPart(deps: PartDeps): SceneIndex {
  const changes = source('canvas.index')
  const listeners = new Set<(ids: readonly string[]) => void>()
  let index: IncrementalSceneIndex | null = null
  const built = (): IncrementalSceneIndex => {
    if (!index) {
      noteSceneWalk('index.build')
      index = new IncrementalSceneIndex(deps.port.items())
    }
    return index
  }
  deps.port.on('changed', (ids) => {
    // the index answers for the batch first, then the readers and listeners hear it
    index?.update(ids, (id) => deps.port.get(id))
    changes.bump()
    for (const l of [...listeners])
      try {
        l(ids)
      } catch (err) {
        console.error('canvas.index onChanged listener failed', err)
      }
  })
  const read = <T>(fn: (i: IncrementalSceneIndex) => T): T => {
    changes.track()
    return fn(built())
  }
  return {
    notes: () => read((i) => i.notes()),
    withLobbyKeyPrefix: (prefix) => read((i) => i.withLobbyKeyPrefix(prefix)),
    byFrame: (frameId) => read((i) => i.byFrame(frameId)),
    byKind: (kind) => read((i) => i.byKind(kind)),
    onChanged: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
}
