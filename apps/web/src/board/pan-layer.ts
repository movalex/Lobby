// Panning moves tldraw's shapes layer (`.tl-html-layer`, one CSS transform) as a composited layer
// (perf, docs/WAVE4-CONTRACTS.md §2, PRF-02).
//
// tldraw 5.4.2 pans by rewriting that layer's transform every frame. The layer is not composited on
// its own, so Chrome repaints and re-rasterizes every visible shape into the board's layer on each
// frame: on a zoomed-out 4,700-shape board that alone held a pan to ~11 fps (e2e/perf). While a pan is
// in progress the layer gets `will-change: transform`, so the compositor moves the already-rasterized
// shapes instead (~30 fps on the same board and machine).
//
// Only pure pans: once the zoom differs from where the gesture began, the layer goes back to normal
// painting, which draws text sharp at the new scale (a composited layer would scale its old raster).
// When the camera is idle again (tldraw's cameraMovingTimeoutMs) the layer is demoted, so text is
// painted into the board as before. Nothing is written to the store; it is a DOM attribute and CSS.

import { type Editor, react } from 'tldraw'
import './pan-layer.css'

export const PANNING_ATTR = 'data-dr-panning'

/** Whether the shapes layer should be composited: the camera is moving and the zoom has not changed. */
export function panCompositing(state: { moving: boolean; zoom: number; startZoom: number | null }): boolean {
  return state.moving && state.startZoom !== null && state.zoom === state.startZoom
}

export function installPanLayer(editor: Editor): () => void {
  const container = editor.getContainer()
  // The zoom while the camera rests: a gesture whose very first move zooms is never composited.
  let restingZoom = editor.getZoomLevel()
  let startZoom: number | null = null
  let on = false
  const stop = react('dr-pan-layer', () => {
    const moving = editor.getCameraState() === 'moving'
    const zoom = editor.getZoomLevel()
    if (!moving) {
      restingZoom = zoom
      startZoom = null
    } else if (startZoom === null) startZoom = restingZoom
    // A gesture that zoomed stays painted normally until the camera rests.
    if (moving && zoom !== startZoom) startZoom = Number.NaN
    const next = panCompositing({ moving, zoom, startZoom })
    if (next === on) return
    on = next
    if (on) container.setAttribute(PANNING_ATTR, '')
    else container.removeAttribute(PANNING_ATTR)
  })
  return () => {
    stop()
    container.removeAttribute(PANNING_ATTR)
  }
}
