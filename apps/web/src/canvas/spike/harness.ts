import '../engine/engineGlobals.ts'
import {
  CaptureUpdateAction,
  convertToExcalidrawElements,
  FONT_FAMILY,
  newElementWith,
  restoreElements,
  sceneCoordsToViewportCoords,
  viewportCoordsToSceneCoords,
} from '@excalidraw/excalidraw'
import type { ExcalidrawImperativeAPI } from '@excalidraw/excalidraw/types'
import { DEV_AUTH_ENABLED } from '../../lib/identity.ts'
import type { LobbyRole } from '../engine/interaction.ts'

/**
 * Engine helpers for spike tests. e2e specs never import @excalidraw; they call these through
 * `window.__lobbySpike.lib` inside page.evaluate.
 */
export const spikeLib = Object.freeze({
  CaptureUpdateAction,
  convertToExcalidrawElements,
  FONT_FAMILY,
  newElementWith,
  restoreElements,
  sceneCoordsToViewportCoords,
  viewportCoordsToSceneCoords,
})

/** `window.__lobbySpike`: the test handle of a spike page (dev-auth builds only). */
export interface LobbySpike {
  /** The imperative API once onExcalidrawAPI has fired (not yet initialised: await `ready`). */
  api: ExcalidrawImperativeAPI | null
  /** Resolves with the API after onInitialize (the initial scene is loaded). */
  ready: Promise<ExcalidrawImperativeAPI>
  role: LobbyRole
  setRole?: (role: LobbyRole) => void
  theme: 'light' | 'dark'
  setTheme?: (theme: 'light' | 'dark') => void
  lib: typeof spikeLib
  /** Free-form slot a page can use to expose page-specific hooks. */
  extra: Record<string, unknown>
}

declare global {
  interface Window {
    __lobbySpike?: LobbySpike
  }
}

/** A fresh handle (pure: safe in a state initialiser). Install it from an effect. */
export function createSpikeHandle(role: LobbyRole, theme: 'light' | 'dark') {
  let resolveReady: (api: ExcalidrawImperativeAPI) => void = () => {}
  const ready = new Promise<ExcalidrawImperativeAPI>((resolve) => {
    resolveReady = resolve
  })
  const handle: LobbySpike = { api: null, ready, role, theme, lib: spikeLib, extra: {} }
  return { handle, resolveReady }
}

/** Sets `window.__lobbySpike` (only behind the dev-auth guard); returns the effect cleanup. */
export function installSpikeHandle(handle: LobbySpike): () => void {
  if (!DEV_AUTH_ENABLED) return () => {}
  window.__lobbySpike = handle
  return () => {
    if (window.__lobbySpike === handle) delete window.__lobbySpike
  }
}

/** Query-string value from a fixed list, or the fallback. */
export function pickParam<T extends string>(name: string, allowed: readonly T[], fallback: T): T {
  const v = new URLSearchParams(location.search).get(name)
  return (allowed as readonly string[]).includes(v ?? '') ? (v as T) : fallback
}
