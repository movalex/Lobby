// Must stay the first import: it sets window.EXCALIDRAW_ASSET_PATH / EXCALIDRAW_THROTTLE_RENDER before
// @excalidraw/excalidraw is evaluated.
import './engineGlobals.ts'
import { Excalidraw } from '@excalidraw/excalidraw'
import '@excalidraw/excalidraw/index.css'
import type {
  ExcalidrawImperativeAPI,
  ExcalidrawInitialDataState,
  ExcalidrawProps,
  UIOptions,
} from '@excalidraw/excalidraw/types'
import { type ReactNode, useCallback, useEffect, useRef, useState } from 'react'
import { stampNoteDuplicates } from '../tools/notes.ts'
import { interactionForRole, type LobbyRole } from './interaction.ts'
import { CANVAS_LIGHT, installLobbyEngineTheme } from './theme.ts'

// Lobby's frame names and outlines, and its dark-mode colours, before anything is drawn (W5-10, W5-15)
installLobbyEngineTheme()

/**
 * Mounts <Excalidraw> with Lobby's fixed props (docs/EXCALIDRAW-MIGRATION.md §2.3.2). Every name was
 * checked against the installed 0.18.0-1118751 `dist/types/excalidraw/types.d.ts` (ExcalidrawProps,
 * lines 668-900; UIOptions/CanvasActions 900-927; InteractionConfig 549-633).
 *
 * Lazy-load it (it pulls in the whole engine): `lazy(() => import('.../ExcalidrawHost.tsx'))`.
 */
export interface ExcalidrawHostProps {
  role: LobbyRole
  theme: 'light' | 'dark'
  /** onExcalidrawAPI: the API before the editor is mounted or initialised; `null` on unmount. */
  onApi?: (api: ExcalidrawImperativeAPI | null) => void
  /** onInitialize: the initial scene is loaded and the API is usable. */
  onReady?: (api: ExcalidrawImperativeAPI) => void
  /** Runs AFTER Lobby's own duplicate stamp (created: null on notes, §2.11). */
  onDuplicate?: ExcalidrawProps['onDuplicate']
  onPaste?: ExcalidrawProps['onPaste']
  onLinkOpen?: ExcalidrawProps['onLinkOpen']
  gridModeEnabled?: boolean
  objectsSnapModeEnabled?: boolean
  /**
   * Lobby modules that listen on a wrapper around <Excalidraw> (canvas/input, canvas/presence,
   * canvas/tools). Each is attached once the engine is initialised and returns its detach. Keep the
   * array identity stable (memoize it). When set, <Excalidraw> is wrapped in a `display: contents` div
   * (no layout change; capture-phase listeners still see every event inside).
   */
  wiring?: readonly HostWiring[]
  /** Probe pages only: false skips Lobby's duplicate stamp, to show Excalidraw's own behaviour. */
  lobbyDuplicate?: boolean
  /**
   * Probe pages only. Lobby does NOT use onPointerUpdate (plan §2.3.2: it is silent for read-only roles
   * with no tool selected); spike A4 counts it to show that.
   */
  probePointerUpdate?: ExcalidrawProps['onPointerUpdate']
  children?: ReactNode
}

export type HostWiring = (wrapper: HTMLElement, api: ExcalidrawImperativeAPI) => () => void

/** Every canvasActions flag off; Excalidraw's own image insert path off (Lobby's loader owns files). */
const UI_OPTIONS: Partial<UIOptions> = Object.freeze({
  tools: Object.freeze({ image: false }),
  canvasActions: Object.freeze({
    changeViewBackgroundColor: false,
    clearCanvas: false,
    export: false as const,
    loadScene: false,
    saveToActiveFile: false,
    toggleTheme: false,
    saveAsImage: false,
  }),
})

/**
 * No scene: it arrives from the sync server. Only defaults for new elements: Nunito (FONT_FAMILY.Nunito
 * = 6), roughness 0 (architect), sharp corners (the engine's own are round: templates and converted
 * boards are sharp, W5-52), and Lobby's canvas colour. Not frozen: the engine owns the object once it is
 * passed in.
 */
const INITIAL_DATA: ExcalidrawInitialDataState = {
  // the canvas is tldraw's off-white, so white frames and notes stand out (W5-10; exports keep white)
  appState: {
    currentItemFontFamily: 6,
    currentItemRoughness: 0,
    currentItemRoundness: 'sharp',
    viewBackgroundColor: CANVAS_LIGHT,
  },
}

const neverEmbed = () => false
const renderNoEmbed = () => null

export function ExcalidrawHost(props: ExcalidrawHostProps) {
  const { wiring, onReady, onDuplicate, lobbyDuplicate } = props
  const wrapperRef = useRef<HTMLDivElement>(null)
  const [readyApi, setReadyApi] = useState<ExcalidrawImperativeAPI | null>(null)

  useEffect(() => {
    const wrapper = wrapperRef.current
    if (!wrapper || !readyApi || !wiring?.length) return
    const detach = wiring.map((attach) => attach(wrapper, readyApi))
    return () => {
      for (const d of detach.reverse()) d()
    }
  }, [readyApi, wiring])

  const handleReady = useCallback(
    (api: ExcalidrawImperativeAPI) => {
      setReadyApi(api)
      onReady?.(api)
    },
    [onReady],
  )

  // Lobby's duplicate stamp first (Ctrl+D, Alt-drag, paste: created -> null on notes), then the page's.
  const handleDuplicate = useCallback<NonNullable<ExcalidrawProps['onDuplicate']>>(
    (next, prev, data) => {
      const stamped = lobbyDuplicate === false ? undefined : stampNoteDuplicates(next, data.duplicateElements)
      if (!onDuplicate) return stamped
      const result = onDuplicate(stamped ?? next, prev, data)
      return result === undefined ? stamped : result
    },
    [onDuplicate, lobbyDuplicate],
  )

  const excalidraw = (
    <Excalidraw
      onExcalidrawAPI={props.onApi}
      onInitialize={handleReady}
      initialData={INITIAL_DATA}
      interaction={interactionForRole(props.role)}
      theme={props.theme}
      langCode="en"
      ui={false}
      handleKeyboardGlobally={false}
      aiEnabled={false}
      UIOptions={UI_OPTIONS}
      validateEmbeddable={neverEmbed}
      renderEmbeddable={renderNoEmbed}
      onDuplicate={handleDuplicate}
      onPaste={props.onPaste}
      onLinkOpen={props.onLinkOpen}
      onPointerUpdate={props.probePointerUpdate}
      gridModeEnabled={props.gridModeEnabled}
      objectsSnapModeEnabled={props.objectsSnapModeEnabled}
    >
      {props.children}
    </Excalidraw>
  )

  if (!wiring) return excalidraw
  return (
    <div ref={wrapperRef} data-lobby-canvas="" style={{ display: 'contents' }}>
      {excalidraw}
    </div>
  )
}

export default ExcalidrawHost
