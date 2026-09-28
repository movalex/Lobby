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
import type { ReactNode } from 'react'
import { interactionForRole, type LobbyRole } from './interaction.ts'

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
  onDuplicate?: ExcalidrawProps['onDuplicate']
  onPaste?: ExcalidrawProps['onPaste']
  onLinkOpen?: ExcalidrawProps['onLinkOpen']
  gridModeEnabled?: boolean
  objectsSnapModeEnabled?: boolean
  children?: ReactNode
}

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
 * = 6) and roughness 0 (architect). Not frozen: the engine owns the object once it is passed in.
 */
const INITIAL_DATA: ExcalidrawInitialDataState = {
  appState: { currentItemFontFamily: 6, currentItemRoughness: 0 },
}

const neverEmbed = () => false
const renderNoEmbed = () => null

export function ExcalidrawHost(props: ExcalidrawHostProps) {
  return (
    <Excalidraw
      onExcalidrawAPI={props.onApi}
      onInitialize={props.onReady}
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
      onDuplicate={props.onDuplicate}
      onPaste={props.onPaste}
      onLinkOpen={props.onLinkOpen}
      gridModeEnabled={props.gridModeEnabled}
      objectsSnapModeEnabled={props.objectsSnapModeEnabled}
    >
      {props.children}
    </Excalidraw>
  )
}

export default ExcalidrawHost
