// OWNER: W3 (wave L, L3-2, L3-3). The command palette on the Excalidraw board page: Ctrl/Cmd+K (the wave L
// key claim 'palette', canvas/input/keymap.ts WAVE_L_KEY_CLAIMS) opens one field over every command, tool,
// panel, frame and template of the board (./board-index.ts, built from the live registries when it opens),
// the board's own search and the workspace's (./searches.ts, ./workspace-search.ts), and plain-language
// board commands (features/ai/command: the local grammar, then AI).
//
// The key: the command 'command-palette.open' with kbd mod+k and claim 'palette', so it matches the K
// character on any layout (Dvorak's K is on code KeyV) and never with AltGr or while composing; every role
// (a viewer finds, selects and jumps). The key registry runs on the canvas scope only: inside the granted
// text editor mod+k stays blocked by the allowlist (no link editor, no palette). From the board page's chrome
// (the top bar, the dock) the same key opens it too, never from a text field, a menu or another dialog.
//
// Nothing is requested before it opens: the index is built from what the page holds; the searches go out
// only for two or more typed characters. Recents are this viewer's, in this browser (try/catch storage).
//
// Wave M (M3-1, M3-3):
//  - an on-screen entry: a top-bar item "Search or do… Ctrl+K" (./PaletteButton.tsx) and the phone sheet's row, both
//    running 'command-palette.open' (args {via: 'button' | 'phone'}, counted `palette.open:<key|button|phone>`);
//  - the "Try it" of the What's new card lands on a board with `?try=<hint>` (./try-hints.ts): on mount the hint is read,
//    taken out of the address bar, and shown as a coach mark on the thing (the palette opens with that line marked, or a
//    bubble under the top-bar button), once;
//  - a chosen command line is counted `palette.run:<command id>` (the contract's fixed list).
import { isUsageEvent } from '@draftroom/contracts'
import { useCallback, useMemo } from 'react'
import {
  type CanvasFeature,
  type CanvasFeatureContext,
  type CommandSource,
  type LobbyCanvas,
  roomReadyOf,
} from '../../canvas/api/index.ts'
import { DEV_AUTH_ENABLED } from '../../lib/identity.ts'
import { type Atom, atom, useValue } from '../../lib/signals.ts'
import { countUsage } from '../../lib/usage.ts'
import { commandEntries } from '../ai/command/provider.ts'
import { chromeMayZoom, chromeSpot } from '../canvas-ux/ported/navigation/chrome-keys.ts'
import { boardEntries, PALETTE_COMMAND_ID } from './board-index.ts'
import { COMMAND_PALETTE_TOPBAR_ID } from './ids.ts'
import { type PaletteEntry, pushRecent, readRecents } from './model.ts'
import { Palette } from './Palette.tsx'
import { PaletteButton } from './PaletteButton.tsx'
import { boardSearch } from './searches.ts'
import { showCoachBubble, TryCoach } from './TryCoach.tsx'
import { TRY_COACH, TRY_COACH_FALLBACK, type TryHint, tryHintOf, withoutTryParam } from './try-hints.ts'
import { workspaceSearch } from './workspace-search.ts'

export { PALETTE_COMMAND_ID }

/** Where a palette opening came from (the contract's `palette.open:<key|button|phone>`). */
export type OpenedVia = 'key' | 'button' | 'phone'

/** The args of 'command-palette.open' (anything else is ignored). */
export function paletteArgs(args: unknown): { via?: 'button' | 'phone' } {
  const via = typeof args === 'object' && args !== null ? (args as { via?: unknown }).via : undefined
  return via === 'button' || via === 'phone' ? { via } : {}
}

/** How an opening by the command is counted: its args first, else the key (the registry runs a key with source 'kbd'). */
export function openedVia(source: CommandSource, args: unknown): OpenedVia | null {
  return paletteArgs(args).via ?? (source === 'kbd' ? 'key' : null)
}

/** A line of the palette that a "Try it" marks: its id and what it says. */
export interface PaletteCoach {
  readonly entryId: string
  readonly text: string
}

interface OpenPalette {
  readonly key: number
  readonly query: string
  readonly coach?: PaletteCoach
}

const states = new WeakMap<LobbyCanvas, Atom<OpenPalette | null>>()
let opens = 0

/** The palette's open state on one board page (null: closed). */
export function paletteState(canvas: LobbyCanvas): Atom<OpenPalette | null> {
  let a = states.get(canvas)
  if (!a) {
    a = atom<OpenPalette | null>('command-palette.open', null)
    states.set(canvas, a)
  }
  return a
}

/**
 * Opens the palette (a new one each time: an empty field, or `query`). `via` counts the opening; `coach` marks a line
 * (a "Try it" from the What's new card).
 */
export function openPalette(
  ctx: CanvasFeatureContext,
  query = '',
  opts: { via?: OpenedVia; coach?: PaletteCoach } = {},
): void {
  if (opts.via) countUsage(`palette.open:${opts.via}`)
  paletteState(ctx.canvas).set({ key: ++opens, query, ...(opts.coach ? { coach: opts.coach } : {}) })
}

/** The viewer's key for recents (the user id: recents follow the person in this browser, never a board). */
const viewerOf = (ctx: CanvasFeatureContext) => ctx.me.user.id

/** A chosen command line is counted by its command id (`palette.run:<id>`; a frame, a tool or a search hit is not). */
function countRun(entry: PaletteEntry): void {
  if (!entry.id.startsWith('cmd:')) return
  const event = `palette.run:${entry.id.slice(4)}`
  if (isUsageEvent(event)) countUsage(event)
}

/** Runs a chosen line once the palette has closed (its dialog gone, the focus back on the board). */
export function runChosen(ctx: CanvasFeatureContext, entry: PaletteEntry): void {
  if (entry.recentKey) pushRecent(viewerOf(ctx), entry.recentKey)
  countRun(entry)
  paletteState(ctx.canvas).set(null)
  setTimeout(() => {
    try {
      entry.run()
    } catch (e) {
      console.error(`command palette: ${entry.id} failed`, e)
    }
  }, 0)
}

function BoardPalette({
  ctx,
  query,
  coach,
}: {
  ctx: CanvasFeatureContext
  query: string
  coach?: PaletteCoach
}) {
  // built once per opening: the commands' state, the frames and the tools as they are now
  const entries = useMemo(() => boardEntries(ctx), [ctx])
  const recents = useMemo(() => readRecents(viewerOf(ctx)), [ctx])
  const searches = useMemo(
    () => [boardSearch(ctx), workspaceSearch(ctx.api, ctx.workspace.id, ctx.board.id)],
    [ctx],
  )
  const queryEntries = useCallback((q: string) => commandEntries(ctx, q), [ctx])
  return (
    <Palette
      label="Command palette"
      placeholder={
        ctx.canvas.readOnly()
          ? 'Find a command, a frame, or something on this board…'
          : 'Type a command, a frame, or what to do (“make the red notes yellow”)…'
      }
      entries={entries}
      queryEntries={queryEntries}
      searches={searches}
      recents={recents}
      initialQuery={query}
      {...(coach ? { coach } : {})}
      onChoose={(entry) => runChosen(ctx, entry)}
      onClose={() => {
        paletteState(ctx.canvas).set(null)
        // the dialog gives the keyboard back to where it was; when that was nowhere, to the board
        requestAnimationFrame(() => {
          const a = document.activeElement
          if (!a || a === document.body) ctx.canvas.focus({ preventScroll: true })
        })
      }}
    />
  )
}

function PaletteOverlay({ ctx }: { ctx: CanvasFeatureContext }) {
  const open = useValue('command-palette.state', () => paletteState(ctx.canvas).get(), [ctx.canvas])
  if (!open) return null
  return (
    <BoardPalette
      key={open.key}
      ctx={ctx}
      query={open.query}
      {...(open.coach ? { coach: open.coach } : {})}
    />
  )
}

// ---- M3-3: `?try=<hint>` ------------------------------------------------------------------------------------------

/** How long the coach waits for the thing to be on the board (the AI status, say) once the room is ready. */
export const TRY_WAIT_MS = 12_000
const TRY_POLL_MS = 250

/** The line of the index with this id, when it can run now. */
function readyEntry(ctx: CanvasFeatureContext, entryId: string): PaletteEntry | null {
  try {
    const e = boardEntries(ctx).find((x) => x.id === entryId)
    return e && !e.disabledReason ? e : null
  } catch {
    return null
  }
}

/**
 * The hint just taken out of the address bar, for the board page's next mount at the same path: React's StrictMode (the
 * development server) runs an effect, its cleanup and the effect again, and the second run would find no parameter.
 */
let carried: { readonly path: string; readonly hint: TryHint; readonly at: number } | null = null
const CARRY_MS = 3000

/** Tests only. */
export function resetTryHintForTests(): void {
  carried = null
}

/**
 * Reads `?try=` once on mount, takes it out of the address bar (a reload or a copied link never repeats it), and shows the
 * coach for that hint when the board is ready. An unknown value is ignored (nothing shown, the address untouched).
 * Returns the cancel.
 */
export function startTryHint(ctx: CanvasFeatureContext, hint: TryHint | null = null): () => void {
  if (typeof window === 'undefined') return () => {}
  const fromAddress = hint ?? tryHintOf(window.location.search)
  const path = window.location.pathname
  const again = !fromAddress && carried && carried.path === path && Date.now() - carried.at < CARRY_MS
  const wanted = fromAddress ?? (again && carried ? carried.hint : null)
  if (!wanted) return () => {}
  if (fromAddress) {
    carried = { path, hint: fromAddress, at: Date.now() }
    try {
      window.history.replaceState(window.history.state, '', withoutTryParam(window.location.href))
    } catch {
      // a blocked history API: the hint still shows once, in this tab
    }
  }
  const copy = TRY_COACH[wanted]
  let waited = 0
  let readyAt: number | null = null
  let timer: ReturnType<typeof setInterval> | undefined
  const finish = () => {
    if (timer !== undefined) clearInterval(timer)
    timer = undefined
  }
  /** The coach has been shown (or given up): a later mount does not show it again. */
  const done = () => {
    carried = null
    finish()
  }
  const tick = () => {
    waited += TRY_POLL_MS
    if (!roomReadyOf(ctx.canvas).get()) {
      // a board that never comes up shows nothing (its own error screen speaks)
      if (waited > TRY_WAIT_MS * 4) done()
      return
    }
    readyAt ??= waited
    if (copy.entry) {
      if (readyEntry(ctx, copy.entry)) {
        done()
        openPalette(ctx, '', { coach: { entryId: copy.entry, text: copy.text } })
        return
      }
      if (waited - readyAt < TRY_WAIT_MS) return
      // not there for this person (AI off on this board, a viewer): the palette is still the way in
      done()
      showCoachBubble(ctx.canvas, TRY_COACH_FALLBACK, copy.anchors)
      return
    }
    done()
    if (copy.panel && ctx.registries.panels.get(copy.panel) && !ctx.canvas.readOnly())
      ctx.openPanel(copy.panel)
    // a moment later, so the bar and the panel are laid out
    setTimeout(() => showCoachBubble(ctx.canvas, copy.text, copy.anchors), 50)
  }
  timer = setInterval(tick, TRY_POLL_MS)
  return finish
}

// ---- e2e hook (dev-auth builds only) --------------------------------------------------------------------

export interface PaletteDevHook {
  open(query?: string): void
  /** the lines the palette would list now, for `query` (static and Do lines; not the searches) */
  entries(query?: string): { id: string; label: string; group: string; disabledReason: string | null }[]
  /** the feature key ids registered on this page (a test learns whether another wave L key is there) */
  featureKeys(): string[]
}

declare global {
  interface Window {
    __lobbyPalette?: PaletteDevHook
  }
}

function installDevHook(ctx: CanvasFeatureContext): () => void {
  if (!DEV_AUTH_ENABLED || typeof window === 'undefined') return () => {}
  const hook: PaletteDevHook = {
    open: (query) => openPalette(ctx, query ?? ''),
    entries: (query = '') =>
      [...commandEntries(ctx, query), ...boardEntries(ctx)].map((e) => ({
        id: e.id,
        label: e.label,
        group: e.group,
        disabledReason: e.disabledReason ?? null,
      })),
    featureKeys: () => ctx.registries.featureKeys.list().map((k) => k.id),
  }
  window.__lobbyPalette = hook
  return () => {
    if (window.__lobbyPalette === hook) delete window.__lobbyPalette
  }
}

/** Ctrl/Cmd+K from the board page's chrome (the canvas's own key is the registry's). */
function installChromeKey(ctx: CanvasFeatureContext): () => void {
  const doc = ctx.canvas.container()?.ownerDocument ?? (typeof document === 'undefined' ? null : document)
  if (!doc) return () => {}
  const onKey = (e: KeyboardEvent) => {
    if (e.defaultPrevented || e.isComposing) return
    // the registry's own spec for the canvas key: the same chord, claim and layout rule
    const spec = ctx.registries.keys.get(`command:${PALETTE_COMMAND_ID}:canvas`)
    if (!spec?.match(e)) return
    if (!chromeMayZoom(chromeSpot(e.target, doc, ctx.canvas.hasKeyboard()))) return
    e.preventDefault()
    openPalette(ctx, '', { via: 'key' })
  }
  doc.addEventListener('keydown', onKey)
  return () => doc.removeEventListener('keydown', onKey)
}

export const feature: CanvasFeature = {
  id: 'command-palette',
  commands: [
    {
      id: PALETTE_COMMAND_ID,
      label: 'Command palette',
      kbd: ['mod+k'],
      claim: 'palette',
      scope: 'canvas',
      readOnlyAllowed: true,
      keywords: ['search', 'commands', 'actions', 'go to', 'jump', 'do'],
      group: 'Help',
      run: (ctx, source, args) => {
        const via = openedVia(source, args)
        openPalette(ctx, '', via ? { via } : {})
      },
    },
  ],
  // M3-1: not pinned, so a tablet, a phone and a crowded bar fold it into the "⋯" menu (board/topbar-fit.ts)
  topBar: [
    {
      id: COMMAND_PALETTE_TOPBAR_ID,
      order: 12,
      overflowCaption: 'Search',
      component: PaletteButton,
    },
  ],
  overlays: [
    {
      id: 'command-palette.overlay',
      layer: 'screen',
      order: 95,
      pointer: 'auto',
      // presenting too: jump to a frame without leaving the presentation
      focusMode: 'show',
      component: PaletteOverlay,
    },
    {
      id: 'command-palette.coach',
      layer: 'screen',
      order: 96,
      pointer: 'auto',
      component: TryCoach,
    },
  ],
  onMount(ctx) {
    const offs = [installDevHook(ctx), installChromeKey(ctx), startTryHint(ctx)]
    return () => {
      for (const off of offs) off()
      paletteState(ctx.canvas).set(null)
    }
  },
}
