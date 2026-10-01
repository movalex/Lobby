/**
 * OWNER: 3a (canvas tools). CR-3A-6: the two Lobby tools of `BUILT_IN_TOOLS` the engine has no tool for,
 * wrapped around the C0 port's `setTool` / `tool` (everything else goes to the port unchanged):
 *
 *  - `highlight` (tldraw's highlighter; docs/EXCALIDRAW-MIGRATION.md §3.1: "Highlighter = `freedraw` with
 *    opacity 50 and a wide stroke, `customData.lobby.kind = 'highlight'`"). The engine's pen, with the next
 *    style switched to the highlight shade of the current colour at opacity 50 while the tool is on (and
 *    switched back after). Each stroke is stamped as it starts, in place on the engine's new element before
 *    anything of it is pushed (the sync core holds a stroke being drawn and pushes it once, at its end): the
 *    converter's highlight width (HIGHLIGHT_WIDTH, `packages/tldraw-import` convert.ts HIGHLIGHT) and
 *    `kind: 'highlight'`, a create-only key (canvas-schema custom-data.ts) that only a create may carry. The
 *    stroke is then an ordinary element: one undo step, pushed by the sync engine.
 *  - `hand` for read-only roles (viewers, commenters, limited guests). Under the `interaction` config the
 *    engine refuses and reverts every engine tool but the neutral selection state (canvas/tools/tools.ts),
 *    and in that state a read-only role's primary drag already pans (spike A4). So a read-only Hand is the
 *    neutral state reported as `hand` (tldraw's viewer toolbar has Select and Hand), with the grab cursor;
 *    any other tool ends it. Editors get the engine's own Hand.
 *
 * W5-11 (the wave-5 review), the connector tool: a connector drawn, re-ended or pasted with an end held
 * inside a shape (Excalidraw's `inside` binding, centre to centre through both shapes) ends on the shape's
 * outline once the gesture is over, with the same anchor (./connector-outline.ts), folded into the step that
 * made it.
 *
 * `tool()` reads the mode reactively (lib/signals), on top of the port's own tracked read in ../impl.ts.
 * Keys the allowlist routes straight to the engine (canvas/input) bypass this part: canvas-ux's feature
 * keys route P while highlighting, and H and V for read-only roles, through `setTool`.
 */

import { mutateElement } from '@excalidraw/element'
import type { ElementsMap, ExcalidrawElement } from '@excalidraw/element/types'
import type { AppState } from '@excalidraw/excalidraw/types'
import { atom } from '../../../lib/signals.ts'
import { onBoardEngine } from '../../overrides.ts'
import type { StyleValues } from '../lobby-canvas.ts'
import { connectorOutlinePatch, type OutlinePatch } from './connector-outline.ts'
import type { PartDeps } from './types.ts'

export interface ToolsPart {
  setTool(tool: string): boolean
  tool(): string | null
}

/** A highlight stroke's width (the converter's `HIGHLIGHT.m`, tldraw's default size). */
export const HIGHLIGHT_WIDTH = 9
/** A highlight stroke's opacity (plan §3.1). */
export const HIGHLIGHT_OPACITY = 50

/**
 * tldraw 5.4.2's light `highlightSrgb` per colour, keyed by the colour's stroke (`solid`, with Lobby's grey
 * ink): the same numbers as packages/tldraw-import/src/palette.ts, so a converted highlight and a new one
 * look alike. An unknown stroke colour highlights in yellow, tldraw's default.
 */
export const HIGHLIGHT_OF_STROKE: Readonly<Record<string, string>> = {
  '#1d1d1d': '#fddd00',
  '#1e1e1e': '#fddd00',
  '#4465e9': '#10acff',
  '#099268': '#00ffc8',
  '#5f6b7a': '#cbe7f1',
  '#9fa8b2': '#cbe7f1',
  '#4ba1f1': '#00f4ff',
  '#4cb05e': '#65f641',
  '#f87777': '#ff7fa3',
  '#e085f4': '#ff88ff',
  '#e16919': '#ffa500',
  '#e03131': '#ff636e',
  '#ae3ec9': '#c77cff',
  '#f1ac4b': '#fddd00',
  '#ffffff': '#ffffff',
}
const HIGHLIGHTS: ReadonlySet<string> = new Set(Object.values(HIGHLIGHT_OF_STROKE))
export const highlightOf = (stroke: string | undefined): string => {
  const s = (stroke ?? '').toLowerCase()
  if (HIGHLIGHTS.has(s)) return s
  return HIGHLIGHT_OF_STROKE[s] ?? '#fddd00'
}

type Saved = Pick<StyleValues, 'strokeColor' | 'opacity'>

/** A pointer gesture still holds the scene's linear elements (a connector being drawn or re-ended). */
function gestureHolds(s: AppState): boolean {
  return (
    s.newElement !== null ||
    s.multiElement !== null ||
    s.cursorButton === 'down' ||
    !!s.selectedLinearElement?.isDragging
  )
}

/**
 * W5-11 (./connector-outline.ts): the `inside` ends of the connectors `ids` move onto their shapes'
 * outlines, folded into the step that drew them (one undo removes the connector whole).
 */
function outlineConnectors(deps: PartDeps, elements: readonly ExcalidrawElement[], ids: readonly string[]) {
  let canvas: ReturnType<PartDeps['self']>
  try {
    canvas = deps.self()
  } catch {
    return
  }
  if (canvas.readOnly()) return
  const byId = new Map(elements.map((e) => [e.id, e]))
  const patches = new Map<string, OutlinePatch>()
  for (const id of ids) {
    const el = byId.get(id)
    if (!el || el.locked) continue
    const p = connectorOutlinePatch(el, elements)
    if (p) patches.set(id, p)
  }
  if (!patches.size) return
  try {
    canvas.transact(
      'connector outline',
      (tx) => {
        for (const [id, p] of patches) tx.update(id, { ...p })
      },
      { joinPrevious: true },
    )
  } catch {
    // a write the canvas refuses (a role change meanwhile) leaves the connector as drawn
  }
}

export function createToolsPart(deps: PartDeps): ToolsPart {
  const { port, registries } = deps
  const highlighting = atom('canvas.tool.highlight', false)
  const viewerHand = atom('canvas.tool.viewer-hand', false)
  let saved: Saved | null = null
  const stamped = new Set<string>()

  const readOnly = () => {
    try {
      return deps.self().readOnly()
    } catch {
      return false
    }
  }
  const setCursor = (c: string | null) => {
    try {
      deps.self().setCursor(c)
    } catch {
      // a bare port (unit tests): no cursor
    }
  }

  const endHighlight = () => {
    if (!highlighting.get()) return
    highlighting.set(false)
    const s = saved
    saved = null
    if (!s) return
    try {
      deps.self().styles.setNext(s)
    } catch {
      // a bare port: no next style
    }
  }
  const endViewerHand = () => {
    if (!viewerHand.get()) return
    viewerHand.set(false)
    setCursor(null)
  }

  // the engine's tool moved on by itself (a tool letter, Escape, a stroke that ended the tool): the modes
  // end with it. New strokes of the highlighter are stamped as they start.
  onBoardEngine(registries, ({ api }) => {
    // W5-40: new connectors are straight, as tldraw's are (Excalidraw's own default is curved). A next-style
    // default of the engine's app state, never a document write; CR-W5-3A-1 asks 2C's next-style mapping
    // (canvas/board/handles.ts) to carry the connector's straight / curved kind, so the style panel's Line
    // pick for the next connector reaches it too.
    if (api.getAppState().currentItemArrowType === 'round')
      api.updateScene({ appState: { currentItemArrowType: 'sharp' } })
    // W5-11: connectors this tab drew, re-ended or pasted, outlined once no gesture holds them
    const pending = new Set<string>()
    let flushing = false
    const flush = () => {
      flushing = false
      if (!pending.size) return
      const state = api.getAppState()
      if (gestureHolds(state)) return
      const ids = [...pending]
      pending.clear()
      outlineConnectors(deps, api.getSceneElements() as readonly ExcalidrawElement[], ids)
    }
    const schedule = () => {
      if (flushing) return
      flushing = true
      setTimeout(flush, 0)
    }
    // pasted (and any other locally created) connectors; `self()` is ready once createLobbyCanvas returned
    const listen = () =>
      deps.self().on('change', (c) => {
        if (c.source !== 'local') return
        for (const id of c.created) pending.add(id)
        if (pending.size) schedule()
      })
    try {
      listen()
    } catch {
      queueMicrotask(() => {
        try {
          listen()
        } catch {
          // a bare port (unit tests): no change events
        }
      })
    }
    api.onChange((elements, appState) => {
      const drawn = appState.newElement as ExcalidrawElement | null
      if (drawn?.type === 'arrow') pending.add(drawn.id)
      const linear = appState.selectedLinearElement
      if (linear?.isDragging && linear.selectedPointsIndices?.length) pending.add(linear.elementId)
      if (pending.size && !gestureHolds(appState)) schedule()
      const type = appState.activeTool.type
      if (highlighting.get() && type !== 'freedraw') endHighlight()
      if (viewerHand.get() && type !== 'selection') endViewerHand()
      const el = appState.newElement as ExcalidrawElement | null
      if (!highlighting.get() || !el || el.type !== 'freedraw' || stamped.has(el.id)) return
      stamped.add(el.id)
      const map = new Map(elements.map((e) => [e.id, e])) as unknown as ElementsMap
      const custom = (el.customData ?? {}) as Record<string, unknown>
      const lobby = (custom.lobby ?? {}) as Record<string, unknown>
      mutateElement(el as never, map, {
        strokeWidth: HIGHLIGHT_WIDTH,
        opacity: HIGHLIGHT_OPACITY,
        customData: { ...custom, lobby: { ...lobby, kind: 'highlight' } },
      } as never)
    })
  })

  return {
    setTool(tool) {
      if (tool === 'highlight') {
        if (readOnly()) return false
        endViewerHand()
        if (!port.setTool('freedraw')) return false
        if (!highlighting.get()) {
          try {
            const styles = deps.self().styles
            const next = styles.next()
            saved = { strokeColor: next.strokeColor, opacity: next.opacity }
            styles.setNext({ strokeColor: highlightOf(next.strokeColor), opacity: HIGHLIGHT_OPACITY })
          } catch {
            saved = null
          }
          highlighting.set(true)
        }
        return true
      }
      if (tool === 'hand' && readOnly()) {
        endHighlight()
        if (!port.setTool('select')) return false
        viewerHand.set(true)
        setCursor('grab')
        return true
      }
      endHighlight()
      endViewerHand()
      return port.setTool(tool)
    },
    tool() {
      const t = port.tool()
      if (highlighting.get() && t === 'freedraw') return 'highlight'
      if (viewerHand.get() && t === 'select') return 'hand'
      return t
    },
  }
}
