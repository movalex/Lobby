/**
 * The engine-neutral board-feature contract (docs/EXCALIDRAW-CONTRACTS.md §4): `CanvasFeature` and
 * `CanvasFeatureContext` replace features/types.ts's `BoardFeature` and `FeatureContext` for the
 * Excalidraw board page. The one change for a feature author: `ctx.editor` (tldraw's Editor) becomes
 * `ctx.canvas` (./lobby-canvas.ts), and tldraw's `overrides`, `components`, `options` and `Overlay`
 * become registry declarations (./registries.ts). Frozen at wave 1.
 *
 * Both contracts live side by side until wave 4: the tldraw board page keeps rendering `BOARD_FEATURES`
 * (features/registry.ts), the Excalidraw board page renders `CANVAS_FEATURES` (features/canvas-registry.ts,
 * one entry per ported feature). Ported code lives in `features/<id>/ported/**` (§1).
 */
import type { Board, Me } from '@draftroom/contracts'
import { type ComponentType, createContext, useContext } from 'react'
import type { ApiClient } from '../../api/client.ts'
import type { NoticeInput } from '../../board/board-context.ts'
import type { BoardEvents } from '../../features/events.ts'
import type { BoardRole } from '../../lib/permissions.ts'
import { claimKeyEvent, keyLikeOf, type WaveLKeyClaim, waveLKeyClaimOf } from '../input/keymap.ts'
import type { CustomDataHandlerSpec, KeyEventLike, KeyHandlerSpec, PointerToolSpec } from '../registries.ts'
import { currentPlatform, matchChord, type ParsedChord, type Platform, parseChord } from './keys.ts'
import type { LobbyCanvas } from './lobby-canvas.ts'
import type {
  CanvasPanelSpec,
  CommandSpec,
  ContentHandlerSpec,
  FeatureKeySpec,
  FeatureOverlaySpec,
  FeatureRegistries,
  FeatureToolSpec,
  HostSlotName,
  MenuEntrySpec,
  SelectionBarItemSpec,
  TopBarItemSpec,
} from './registries.ts'

/** What every feature gets: features/types.ts `FeatureContext` with `editor` replaced by `canvas`. */
export interface CanvasFeatureContext {
  readonly canvas: LobbyCanvas
  readonly registries: FeatureRegistries
  readonly board: Board
  /** the caller's current role (UI hints only: the servers enforce) */
  readonly role: BoardRole
  readonly me: Me
  readonly workspace: { readonly id: string; readonly name: string }
  readonly api: ApiClient
  readonly events: BoardEvents
  notify(n: NoticeInput): void
  dismiss(key: string): void
  /** open (or focus) a dock panel by id; null closes the dock */
  openPanel(panelId: string | null): void
  /** the open dock panel id, if any */
  readonly activePanel: string | null
}

/** The keys of CanvasFeatureContext (the contracts test resolves `context:<key>` targets against it). */
export const CANVAS_FEATURE_CONTEXT_KEYS = [
  'canvas',
  'registries',
  'board',
  'role',
  'me',
  'workspace',
  'api',
  'events',
  'notify',
  'dismiss',
  'openPanel',
  'activePanel',
] as const satisfies readonly (keyof CanvasFeatureContext)[]
type MissingContextKey = Exclude<keyof CanvasFeatureContext, (typeof CANVAS_FEATURE_CONTEXT_KEYS)[number]>
// fails to compile when a context key is added without listing it above
const contextKeysComplete: [MissingContextKey] extends [never] ? true : never = true
void contextKeysComplete

/**
 * One board feature on the Excalidraw page. Static declarations are registered by the board page in
 * feature order before `onMount` runs, and removed after its cleanup; `onMount` may register more
 * through `ctx.registries` (state-dependent entries).
 */
export interface CanvasFeature {
  /** as in BOARD_FEATURES ('canvas-ux', 'comments', 'workshops', …) */
  readonly id: string
  readonly panels?: readonly CanvasPanelSpec[]
  readonly topBar?: readonly TopBarItemSpec[]
  readonly commands?: readonly CommandSpec[]
  readonly keys?: readonly FeatureKeySpec[]
  readonly tools?: readonly FeatureToolSpec[]
  readonly overlays?: readonly FeatureOverlaySpec[]
  readonly contextMenu?: readonly MenuEntrySpec[]
  readonly mainMenu?: readonly MenuEntrySpec[]
  readonly selectionBar?: readonly SelectionBarItemSpec[]
  readonly slots?: Partial<Record<HostSlotName, ComponentType<{ readonly ctx: CanvasFeatureContext }>>>
  readonly contentHandlers?: readonly ContentHandlerSpec[]
  /**
   * Client-side handling of a customData.lobby key beyond its canvas-schema spec (custom-data.ts):
   * what onDuplicate writes on a copy. A NEW key is a change request to canvas-schema (the server
   * validates every key by its spec).
   */
  readonly customData?: readonly CustomDataHandlerSpec[]
  /** after the canvas is ready (the first `welcome` applied); return a cleanup */
  onMount?(ctx: CanvasFeatureContext): (() => void) | undefined
}

// ---- React access -----------------------------------------------------------------------------------------

const Ctx = createContext<CanvasFeatureContext | null>(null)

/** The board page wraps every feature component (panels, overlays, slots, menus) in this provider. */
export const CanvasFeatureContextProvider = Ctx.Provider

/** The feature context inside any component the board page renders. Throws outside the board page. */
export function useCanvasFeatureContext(): CanvasFeatureContext {
  const ctx = useContext(Ctx)
  if (!ctx) throw new Error('useCanvasFeatureContext outside the Excalidraw board page')
  return ctx
}

// ---- installing features ------------------------------------------------------------------------------------

/** A command's or a key's claim on a chord, for the keyboard-map test and the shortcuts dialog. */
export interface KeyClaim {
  readonly chord: string
  readonly scope: 'canvas' | 'editor' | 'anywhere'
  readonly by: string
  readonly featureId: string
  /** CR-3A-9: the pointer tool the key acts under (`FeatureKeySpec.tool`); absent: under any tool */
  readonly tool?: string
  /** wave L: the wave L key claim it declares (`CommandSpec.claim`, `FeatureKeySpec.claim`) */
  readonly claim?: WaveLKeyClaim
}

/** Every chord the features claim (commands with `kbd`, keys, tools with `kbd`), in feature order. */
export function collectKeyClaims(features: readonly CanvasFeature[]): KeyClaim[] {
  const out: KeyClaim[] = []
  for (const f of features) {
    for (const c of f.commands ?? []) {
      for (const k of c.kbd ?? [])
        out.push({
          chord: k,
          scope: c.scope ?? 'canvas',
          by: c.id,
          featureId: f.id,
          ...(c.claim ? { claim: c.claim } : {}),
        })
    }
    for (const k of f.keys ?? []) {
      for (const chord of k.chords)
        out.push({
          chord,
          scope: k.scope,
          by: k.id,
          featureId: f.id,
          ...(k.tool ? { tool: k.tool } : {}),
          ...(k.claim ? { claim: k.claim } : {}),
        })
    }
    for (const t of f.tools ?? []) {
      for (const k of t.kbd ?? [])
        out.push({ chord: k, scope: 'canvas', by: `tool:${t.id}`, featureId: f.id })
    }
  }
  return out
}

/**
 * Chords claimed twice in the same scope (a registry conflict the keyboard-map test fails on). Chords
 * are compared parsed, so 'Mod+F' and 'mod+f' collide. A tool's claims (CR-3A-9, `KeyClaim.tool`) collide only
 * with claims under the same tool: one under a tool and one under any tool both act only when the tool's key
 * steps aside, which the keyboard-map test checks by feature order.
 */
export function keyConflicts(claims: readonly KeyClaim[]): { chord: string; scope: string; by: string[] }[] {
  const seen = new Map<string, KeyClaim[]>()
  for (const c of claims) {
    const p = parseChord(c.chord)
    const scopes = c.scope === 'anywhere' ? ['canvas', 'editor'] : [c.scope]
    for (const s of scopes) {
      const key = `${s}|${c.tool ?? ''}|${p.key}|${+p.mod}${+p.ctrl}${+p.meta}${+p.alt}${+p.shift}`
      seen.set(key, [...(seen.get(key) ?? []), c])
    }
  }
  return [...seen.entries()]
    .filter(([, v]) => v.length > 1)
    .map(([k, v]) => ({ chord: v[0]?.chord ?? '', scope: k.split('|')[0] ?? '', by: v.map((c) => c.by) }))
}

/**
 * Whether `e` is one of `chords`. With a wave L `claim` (CommandSpec.claim, FeatureKeySpec.claim): only a press
 * the claim reads as its own (canvas/input/keymap.ts waveLKeyClaimOf: never with AltGr or while composing), a
 * letter by the layout's character (claimKeyEvent), as the allowlist reads the claim.
 */
export function chordsMatch(
  chords: readonly ParsedChord[],
  e: KeyEventLike,
  platform: Platform,
  claim?: WaveLKeyClaim,
): boolean {
  if (!claim) return chords.some((c) => matchChord(c, e, platform))
  // the board's input layer passes the DOM event (AltGr and composition read from it); a plain object works too
  const k = keyLikeOf(e as unknown as KeyboardEvent)
  if (waveLKeyClaimOf(k) !== claim) return false
  const laid = claimKeyEvent(k)
  return chords.some((c) => matchChord(c, laid, platform))
}

/** Adapts a command with `kbd` to the C0 key registry (the capture-phase allowlist reads `registries.keys`). */
function commandKey(cmd: CommandSpec, ctx: CanvasFeatureContext, scope: 'canvas' | 'editor'): KeyHandlerSpec {
  const chords = (cmd.kbd ?? []).map(parseChord)
  const platform = currentPlatform()
  return {
    id: `command:${cmd.id}:${scope}`,
    scope,
    match: (e) => chordsMatch(chords, e, platform, cmd.claim),
    handle: () => {
      if (cmd.available && !cmd.available(ctx)) return false
      if (ctx.canvas.readOnly() && !cmd.readOnlyAllowed) return false
      if (cmd.enabled && !cmd.enabled(ctx)) return false
      // wave L: a disabled reason declines the key like `enabled` (the next claimant, then the allowlist, gets it)
      if (cmd.disabledReason && cmd.disabledReason(ctx) !== null) return false
      void cmd.run(ctx, 'kbd')
      return true
    },
  }
}

/**
 * Wave K.1: `e` types one of `chars` (its `key`), Shift or not, with no Ctrl, Meta or Alt; AltGr (Ctrl+Alt on
 * Windows) is typing and counts.
 */
export function matchChar(chars: readonly string[], e: KeyEventLike): boolean {
  if (!chars.includes(e.key) || e.metaKey) return false
  return e.ctrlKey === e.altKey
}

function featureKey(spec: FeatureKeySpec, ctx: CanvasFeatureContext): KeyHandlerSpec {
  const chords = spec.chords.map(parseChord)
  const chars = spec.chars ?? []
  const platform = currentPlatform()
  return {
    id: `key:${spec.id}`,
    scope: spec.scope,
    match: (e) =>
      // CR-3A-9: a tool's key acts only while its tool is on
      (spec.tool === undefined || ctx.canvas.tool() === spec.tool) &&
      (chordsMatch(chords, e, platform, spec.claim) || matchChar(chars, e)) &&
      (spec.match ? spec.match(e, ctx) : true),
    handle: (e) => spec.handle(e, ctx),
  }
}

function pointerTool(spec: FeatureToolSpec, ctx: CanvasFeatureContext): PointerToolSpec {
  const ev = (
    point: { x: number; y: number },
    hit: Parameters<NonNullable<PointerToolSpec['onPointerDown']>>[1],
  ) => ({
    point,
    hit,
    shiftKey: ctx.canvas.pointer()?.shift ?? false,
    altKey: ctx.canvas.pointer()?.alt ?? false,
  })
  return {
    id: spec.id,
    customType: `lobby-${spec.id}`,
    readOnlyAllowed: spec.readOnlyAllowed,
    ...(spec.cursor ? { cursor: spec.cursor } : {}),
    onPointerDown: spec.onPointerDown ? (p, hit) => spec.onPointerDown?.(ev(p, hit), ctx) : undefined,
    onPointerUp: spec.onPointerUp ? (p, hit) => spec.onPointerUp?.(ev(p, hit), ctx) : undefined,
    onDoubleClick: spec.onDoubleClick ? (p, hit) => spec.onDoubleClick?.(ev(p, hit), ctx) : undefined,
  }
}

/**
 * Registers every feature's static declarations (feature order), then runs each `onMount`. Returns one
 * cleanup that undoes both in reverse. A feature whose `onMount` throws is logged and skipped; its
 * declarations stay (they are data). The board page (2C) calls this once per canvas.
 */
export function installCanvasFeatures(
  features: readonly CanvasFeature[],
  ctx: CanvasFeatureContext,
): () => void {
  const r = ctx.registries
  const undo: (() => void)[] = []
  const add = (u: () => void) => undo.push(u)
  for (const f of features) {
    for (const p of f.panels ?? []) add(r.panels.register(p))
    for (const t of f.topBar ?? []) add(r.topBar.register(t))
    for (const c of f.commands ?? []) {
      add(r.commands.register(c))
      if (c.kbd?.length) {
        const scopes: ('canvas' | 'editor')[] =
          c.scope === 'anywhere' ? ['canvas', 'editor'] : [c.scope ?? 'canvas']
        for (const s of scopes) add(r.keys.register(commandKey(c, ctx, s)))
      }
    }
    for (const k of f.keys ?? []) {
      add(r.featureKeys.register(k))
      add(r.keys.register(featureKey(k, ctx)))
    }
    for (const t of f.tools ?? []) {
      add(r.tools.register(t))
      add(r.pointerTools.register(pointerTool(t, ctx)))
    }
    for (const o of f.overlays ?? []) add(r.featureOverlays.register(o))
    for (const m of f.contextMenu ?? []) add(r.contextMenu.register(m))
    for (const m of f.mainMenu ?? []) add(r.mainMenu.register(m))
    for (const s of f.selectionBar ?? []) add(r.selectionBar.register(s))
    for (const h of f.contentHandlers ?? []) add(r.contentHandlers.register(h))
    for (const c of f.customData ?? []) add(r.customData.register(c))
    for (const [slot, component] of Object.entries(f.slots ?? {}) as [
      HostSlotName,
      ComponentType<{ ctx: CanvasFeatureContext }>,
    ][]) {
      add(r.hostSlots.provide(slot, { featureId: f.id, component }))
    }
  }
  for (const f of features) {
    try {
      const cleanup = f.onMount?.(ctx)
      if (typeof cleanup === 'function') add(cleanup)
    } catch (e) {
      console.error(`canvas feature ${f.id} failed to mount`, e)
    }
  }
  return () => {
    for (const u of undo.reverse()) {
      try {
        u()
      } catch (e) {
        console.error('canvas feature cleanup failed', e)
      }
    }
  }
}
