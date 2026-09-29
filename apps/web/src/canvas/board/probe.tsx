/**
 * A probe `CanvasFeature` for the board page's own e2e checks (dev-auth builds only: the page installs
 * it through `window.__lobbyBoard.installProbe()`, never on its own). It uses every place the board page
 * renders or dispatches registry entries (docs/EXCALIDRAW-CONTRACTS.md §3), so a spec can check the
 * chrome without a ported feature: a dock panel, a pinned top-bar item, a scene overlay pinned to an
 * element, a screen overlay that stays in focus mode, the toolbar host slot, a command with a chord,
 * and the `change` and `input` streams from `onMount`.
 */
import { useValue } from '../../lib/signals.ts'
import { type CanvasFeature, useCanvasFeatureContext } from '../api/feature.ts'
import type { CanvasChange } from '../api/lobby-canvas.ts'

export interface ProbeRecord {
  mounted: boolean
  role: string | null
  changes: CanvasChange[]
  inputs: number
  commands: number
  /** the probe tool's pointer-ups and double-clicks (the hit element's id, or null), and its exits */
  toolUps: (string | null)[]
  toolDoubleClicks: (string | null)[]
  toolExits: number
}

declare global {
  interface Window {
    __lobbyProbe?: ProbeRecord
  }
}

function ProbeIcon() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
      <circle cx="12" cy="12" r="7" fill="none" stroke="currentColor" strokeWidth="1.8" />
    </svg>
  )
}

/** A pin at the top-left of the first note, in overlay coordinates (moves with the camera). */
function ProbePin() {
  const { canvas } = useCanvasFeatureContext()
  const at = useValue('probe-pin', () => {
    const note = canvas.items().find((e) => e.type === 'stickynote')
    return note ? { id: note.id, ...canvas.sceneToOverlay({ x: note.x, y: note.y }) } : null
  }, [canvas])
  if (!at) return null
  return (
    <div
      data-testid="probe-pin"
      data-lobby-probe-pin={at.id}
      style={{ position: 'absolute', left: at.x, top: at.y, width: 8, height: 8, background: '#e11d48' }}
    />
  )
}

export const PROBE_FEATURE: CanvasFeature = {
  id: 'probe',
  panels: [
    {
      id: 'probe',
      label: 'Probe',
      icon: ProbeIcon,
      order: 999,
      component: ({ ctx, close }) => (
        <div data-testid="probe-panel" data-role={ctx.role}>
          <p>Probe panel for {ctx.board.title}</p>
          <button type="button" data-testid="probe-panel-close" onClick={close}>
            Close
          </button>
        </div>
      ),
    },
  ],
  topBar: [
    {
      id: 'probe',
      order: 999,
      pinned: true,
      component: () => (
        <button type="button" className="dr-btn dr-btn--sm" data-testid="probe-topbar">
          Probe
        </button>
      ),
    },
  ],
  overlays: [
    { id: 'probe-scene', layer: 'scene', order: 50, component: ProbePin },
    {
      id: 'probe-screen',
      layer: 'screen',
      order: 60,
      focusMode: 'show',
      component: ({ ctx }) => (
        <button
          type="button"
          data-testid="probe-screen"
          style={{ position: 'absolute', right: 12, top: 60 }}
          onClick={() => ctx.canvas.settings.set({ focusMode: !ctx.canvas.settings.get().focusMode })}
        >
          Focus
        </button>
      ),
    },
  ],
  slots: {
    toolbar: () => <div data-testid="probe-toolbar">Probe toolbar</div>,
  },
  tools: [
    {
      id: 'probe-tool',
      label: 'Probe tool',
      readOnlyAllowed: true,
      cursor: 'crosshair',
      onPointerUp: (e) => void window.__lobbyProbe?.toolUps.push(e.hit?.id ?? null),
      onDoubleClick: (e) => void window.__lobbyProbe?.toolDoubleClicks.push(e.hit?.id ?? null),
      onExit: () => {
        if (window.__lobbyProbe) window.__lobbyProbe.toolExits++
      },
    },
  ],
  commands: [
    {
      id: 'probe.hello',
      label: 'Probe hello',
      kbd: ['mod+alt+shift+p'],
      run: (ctx) => {
        if (window.__lobbyProbe) window.__lobbyProbe.commands++
        ctx.notify({ key: 'probe', text: 'Probe command ran', testId: 'probe-toast' })
      },
    },
  ],
  onMount(ctx) {
    const rec: ProbeRecord = {
      mounted: true,
      role: ctx.role,
      changes: [],
      inputs: 0,
      commands: 0,
      toolUps: [],
      toolDoubleClicks: [],
      toolExits: 0,
    }
    window.__lobbyProbe = rec
    const offChange = ctx.canvas.on('change', (c) => {
      rec.changes.push(c)
      if (rec.changes.length > 200) rec.changes.shift()
    })
    const offInput = ctx.canvas.on('input', () => {
      rec.inputs++
    })
    return () => {
      offChange()
      offInput()
      rec.mounted = false
    }
  },
}
