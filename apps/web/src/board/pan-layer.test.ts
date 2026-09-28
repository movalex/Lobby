import { atom, transact } from 'tldraw'
import { describe, expect, it } from 'vitest'
import { installPanLayer, PANNING_ATTR, panCompositing } from './pan-layer.ts'

describe('pan layer compositing', () => {
  it('composites only while the camera moves at the zoom the gesture started with', () => {
    expect(panCompositing({ moving: false, zoom: 1, startZoom: null })).toBe(false)
    expect(panCompositing({ moving: true, zoom: 0.5, startZoom: 0.5 })).toBe(true)
    expect(panCompositing({ moving: true, zoom: 0.6, startZoom: 0.5 })).toBe(false)
    expect(panCompositing({ moving: true, zoom: 0.5, startZoom: Number.NaN })).toBe(false)
  })

  it('sets the attribute for a pan, drops it for a zoom until the camera rests, and on uninstall', () => {
    const attrs = new Set<string>()
    const container = {
      setAttribute: (name: string) => attrs.add(name),
      removeAttribute: (name: string) => attrs.delete(name),
    }
    const state = atom('camera state', 'idle' as 'idle' | 'moving')
    const zoom = atom('zoom', 1)
    const editor = {
      getContainer: () => container,
      getCameraState: () => state.get(),
      getZoomLevel: () => zoom.get(),
    } as unknown as Parameters<typeof installPanLayer>[0]
    const uninstall = installPanLayer(editor)
    expect(attrs.has(PANNING_ATTR)).toBe(false)
    state.set('moving') // a pan starts
    expect(attrs.has(PANNING_ATTR)).toBe(true)
    zoom.set(1.2) // the gesture zooms: painted normally again (sharp text at the new scale)
    expect(attrs.has(PANNING_ATTR)).toBe(false)
    zoom.set(1) // even back at the start zoom, until the camera rests
    expect(attrs.has(PANNING_ATTR)).toBe(false)
    state.set('idle')
    state.set('moving') // the next gesture is a pan again
    expect(attrs.has(PANNING_ATTR)).toBe(true)
    state.set('idle')
    expect(attrs.has(PANNING_ATTR)).toBe(false)
    // a gesture whose first move already zooms (a wheel zoom) is never composited, not even for a frame
    transact(() => {
      zoom.set(1.5)
      state.set('moving')
    })
    expect(attrs.has(PANNING_ATTR)).toBe(false)
    uninstall()
    expect(attrs.has(PANNING_ATTR)).toBe(false)
  })
})
