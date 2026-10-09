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
import { useCallback, useMemo } from 'react'
import type { CanvasFeature, CanvasFeatureContext, LobbyCanvas } from '../../canvas/api/index.ts'
import { DEV_AUTH_ENABLED } from '../../lib/identity.ts'
import { type Atom, atom, useValue } from '../../lib/signals.ts'
import { commandEntries } from '../ai/command/provider.ts'
import { chromeMayZoom, chromeSpot } from '../canvas-ux/ported/navigation/chrome-keys.ts'
import { boardEntries, PALETTE_COMMAND_ID } from './board-index.ts'
import { type PaletteEntry, pushRecent, readRecents } from './model.ts'
import { Palette } from './Palette.tsx'
import { boardSearch } from './searches.ts'
import { workspaceSearch } from './workspace-search.ts'

export { PALETTE_COMMAND_ID }

interface OpenPalette {
  readonly key: number
  readonly query: string
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

/** Opens the palette (a new one each time: an empty field, or `query`). */
export function openPalette(ctx: CanvasFeatureContext, query = ''): void {
  paletteState(ctx.canvas).set({ key: ++opens, query })
}

/** The viewer's key for recents (the user id: recents follow the person in this browser, never a board). */
const viewerOf = (ctx: CanvasFeatureContext) => ctx.me.user.id

/** Runs a chosen line once the palette has closed (its dialog gone, the focus back on the board). */
export function runChosen(ctx: CanvasFeatureContext, entry: PaletteEntry): void {
  if (entry.recentKey) pushRecent(viewerOf(ctx), entry.recentKey)
  paletteState(ctx.canvas).set(null)
  setTimeout(() => {
    try {
      entry.run()
    } catch (e) {
      console.error(`command palette: ${entry.id} failed`, e)
    }
  }, 0)
}

function BoardPalette({ ctx, query }: { ctx: CanvasFeatureContext; query: string }) {
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
  return <BoardPalette key={open.key} ctx={ctx} query={open.query} />
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
    openPalette(ctx)
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
      run: (ctx) => openPalette(ctx),
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
  ],
  onMount(ctx) {
    const offs = [installDevHook(ctx), installChromeKey(ctx)]
    return () => {
      for (const off of offs) off()
      paletteState(ctx.canvas).set(null)
    }
  },
}
