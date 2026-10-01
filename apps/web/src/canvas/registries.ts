/**
 * Extension points, so features never edit shared files (docs/EXCALIDRAW-MIGRATION.md §2.3.1, §7.1),
 * frozen at the spike B contracts step C0 (docs/research/excalidraw/spike-b/CONTRACTS.md). Lead-owned.
 *
 * - `keys`, `overlays`, `pointerTools`, `customData`: many registrations each.
 * - `hitGuard.isBlocked(scenePoint)`: provided by O5's hit guard (`canvas/overrides.ts`), consulted by
 *   O2's double-tap detector and double-click classifier.
 * - `hidden.isHidden(id)`: provided by O5's mind-map collapse, consulted by O2's `selectAll.ts` and the
 *   box/lasso post-filter (B12).
 * - `dragger.draggerOf(id)`: provided by O2's presence (who is dragging an element right now), read by
 *   O5's guard for "Bob is moving this".
 * - `slots`: UI slots O2's board page renders and O5 fills: `toolbar` (the vote tool button), `sheet`
 *   (the phone sheet), `timer`.
 * - installers: `registerInstaller(name, install)` / `runInstallers(port, registries)`; the board page
 *   calls `installAll` in `canvas/spike/installers.ts`, which registers O3's facade and O5's features.
 *
 * A single-provider point (`hitGuard`, `hidden`, `dragger`) keeps one provider; a second `provide`
 * replaces the first and the returned function removes only its own.
 */
import type { ComponentType } from 'react'
import type { CanvasElement, CanvasPort, ScenePoint } from './port.ts'

export interface Registry<T extends { readonly id: string }> {
  /** Adds (or replaces, by id) an entry. Returns the unregister function. */
  register(entry: T): () => void
  list(): readonly T[]
  get(id: string): T | undefined
}

/** A key event as handlers see it (no DOM type needed). */
export interface KeyEventLike {
  readonly key: string
  readonly code: string
  readonly ctrlKey: boolean
  readonly metaKey: boolean
  readonly altKey: boolean
  readonly shiftKey: boolean
}
/** A Lobby-owned key (§2.3.3): matched in the capture-phase allowlist listener; `handle` returns true when it acted. */
export interface KeyHandlerSpec {
  readonly id: string
  /** `canvas`: the board has the keyboard and no text editor is open; `editor`: inside a granted editor */
  readonly scope: 'canvas' | 'editor'
  match(e: KeyEventLike): boolean
  handle(e: KeyEventLike, port: CanvasPort): boolean
}

export interface OverlayLayerProps {
  readonly port: CanvasPort
}
/** One layer of the overlay above the canvas (cursors, pins, badges, chips); higher `order` draws on top. */
export interface OverlayLayerSpec {
  readonly id: string
  readonly order: number
  readonly component: ComponentType<OverlayLayerProps>
}

/** A pointer tool: a Lobby custom tool (`setActiveTool({type: 'custom', customType, locked: true})`). */
export interface PointerToolSpec {
  /** the Lobby tool name `CanvasPort.setTool` takes */
  readonly id: string
  readonly customType: string
  /** whether commenters, viewers and limited guests may use it (comment pins, votes, open-card) */
  readonly readOnlyAllowed: boolean
  readonly cursor?: string
  onPointerDown?(point: ScenePoint, hit: CanvasElement | null, port: CanvasPort): void
  onPointerUp?(point: ScenePoint, hit: CanvasElement | null, port: CanvasPort): void
  onDoubleClick?(point: ScenePoint, hit: CanvasElement | null, port: CanvasPort): void
}

/**
 * Client-side handling of a `customData.lobby` key beyond its canvas-schema spec (custom-data.ts):
 * what `onDuplicate` writes on the copy. Return `undefined` to strip the key.
 */
export interface CustomDataHandlerSpec {
  /** the key, or the prefix for `match: 'prefix'` (as in custom-data.ts LOBBY_KEY_SPECS) */
  readonly id: string
  readonly match: 'exact' | 'prefix'
  onDuplicate?(value: unknown, ctx: { readonly idMap: ReadonlyMap<string, string> }): unknown
}

/** Why a point may not be clicked (§2.7): a hidden element, or one under someone's drag preview. */
export type HitBlock =
  | { readonly kind: 'hidden' }
  | { readonly kind: 'moving'; readonly sid: string; readonly name: string }
export type IsBlocked = (point: ScenePoint) => HitBlock | null
export type IsHidden = (id: string) => boolean
export type DraggerOf = (id: string) => { readonly sid: string; readonly name: string } | null

export const SLOT_NAMES = ['toolbar', 'sheet', 'timer'] as const
export type SlotName = (typeof SLOT_NAMES)[number]
export interface SlotProps {
  readonly port: CanvasPort
}
export interface SlotEntry {
  readonly id: string
  readonly order: number
  readonly component: ComponentType<SlotProps>
}

export interface CanvasRegistries {
  readonly keys: Registry<KeyHandlerSpec>
  readonly overlays: Registry<OverlayLayerSpec>
  readonly pointerTools: Registry<PointerToolSpec>
  readonly customData: Registry<CustomDataHandlerSpec>
  readonly slots: {
    register(slot: SlotName, entry: SlotEntry): () => void
    list(slot: SlotName): readonly SlotEntry[]
  }
  readonly hitGuard: { provide(fn: IsBlocked): () => void; isBlocked(point: ScenePoint): HitBlock | null }
  readonly hidden: { provide(fn: IsHidden): () => void; isHidden(id: string): boolean }
  readonly dragger: { provide(fn: DraggerOf): () => void; draggerOf(id: string): ReturnType<DraggerOf> }
  /** Called after any registration changes (the board page re-renders its slots and overlays). */
  subscribe(listener: () => void): () => void
}

function createRegistry<T extends { readonly id: string }>(changed: () => void): Registry<T> {
  const entries = new Map<string, T>()
  return {
    register(entry) {
      entries.set(entry.id, entry)
      changed()
      return () => {
        if (entries.get(entry.id) === entry) {
          entries.delete(entry.id)
          changed()
        }
      }
    },
    list: () => [...entries.values()],
    get: (id) => entries.get(id),
  }
}

function createProvider<F extends (...a: never[]) => unknown>(fallback: F, changed: () => void) {
  let current: F | null = null
  return {
    provide(fn: F) {
      current = fn
      changed()
      return () => {
        if (current === fn) {
          current = null
          changed()
        }
      }
    },
    call: ((...a: Parameters<F>) => (current ?? fallback)(...a)) as F,
  }
}

/** A fresh set of registries (one per board page). */
export function createRegistries(): CanvasRegistries {
  const listeners = new Set<() => void>()
  const changed = () => {
    for (const l of [...listeners]) l()
  }
  const slots = new Map<SlotName, Registry<SlotEntry>>(
    SLOT_NAMES.map((s) => [s, createRegistry<SlotEntry>(changed)]),
  )
  const hit = createProvider<IsBlocked>(() => null, changed)
  const hidden = createProvider<IsHidden>(() => false, changed)
  const dragger = createProvider<DraggerOf>(() => null, changed)
  return {
    keys: createRegistry<KeyHandlerSpec>(changed),
    overlays: createRegistry<OverlayLayerSpec>(changed),
    pointerTools: createRegistry<PointerToolSpec>(changed),
    customData: createRegistry<CustomDataHandlerSpec>(changed),
    slots: {
      register: (slot, entry) => (slots.get(slot) as Registry<SlotEntry>).register(entry),
      list: (slot) => [...(slots.get(slot) as Registry<SlotEntry>).list()].sort((a, b) => a.order - b.order),
    },
    hitGuard: { provide: hit.provide, isBlocked: hit.call },
    hidden: { provide: hidden.provide, isHidden: hidden.call },
    dragger: { provide: dragger.provide, draggerOf: dragger.call },
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
}

// ---- installers -----------------------------------------------------------------------------------------

/** Installs a feature set on a board page; returns its uninstall (or nothing). */
export type Installer = (port: CanvasPort, registries: CanvasRegistries) => (() => void) | undefined

const installers = new Map<string, Installer>()

/** Registers an installer by name (a second registration of a name replaces the first). */
export function registerInstaller(name: string, install: Installer): void {
  installers.set(name, install)
}

/** Runs every registered installer in registration order; returns one uninstall for all of them. */
export function runInstallers(port: CanvasPort, registries: CanvasRegistries): () => void {
  const undo: (() => void)[] = []
  for (const install of installers.values()) {
    const u = install(port, registries)
    if (u) undo.push(u)
  }
  return () => {
    for (const u of undo.reverse()) u()
  }
}
