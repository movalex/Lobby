import type { ExcalidrawImperativeAPI } from '@excalidraw/excalidraw/types'
import { useEffect, useRef, useState } from 'react'
import ExcalidrawHost from '../../engine/ExcalidrawHost.tsx'
import type { LobbyRole } from '../../engine/interaction.ts'
import { createSpikeHandle, installSpikeHandle } from '../harness.ts'
import { darkPixelsIn, EchoProbe, renderEngine, staticPixel } from './render-kit.ts'

/** A literal role prop trips the ARIA-role lint (ExcalidrawHost role is a Lobby role, not ARIA). */
const EDITOR: LobbyRole = 'editor'

/**
 * /spike/render-two — for the record (check A11): two <Excalidraw> instances (Lobby's ExcalidrawHost) on
 * one page, side by side: A (left, light) and B (right, dark by default: ?themeB=light for the same).
 *   extra.a / extra.b      { api, probe, pixel(x, y), dark(rect), root }
 *   extra.unmountB()       removes B; extra.mountB() puts it back (a fresh instance)
 * `ready` resolves when both have initialised.
 */
export default function RenderTwoPage() {
  const [spike] = useState(() => createSpikeHandle('editor', 'light'))
  const [showB, setShowB] = useState(true)
  const [keyB, setKeyB] = useState(0)
  const rootA = useRef<HTMLDivElement>(null)
  const rootB = useRef<HTMLDivElement>(null)
  const themeB = new URLSearchParams(location.search).get('themeB') === 'light' ? 'light' : 'dark'
  const readyCount = useRef(0)

  useEffect(() => {
    const extra = spike.handle.extra
    extra.unmountB = () => setShowB(false)
    extra.mountB = () => {
      readyCount.current = 1
      setKeyB((k) => k + 1)
      setShowB(true)
    }
    extra.engine = renderEngine
    return installSpikeHandle(spike.handle)
  }, [spike])

  const ready = (side: 'a' | 'b', root: () => HTMLDivElement | null) => (api: ExcalidrawImperativeAPI) => {
    const probe = new EchoProbe(api)
    spike.handle.extra[side] = {
      api,
      probe,
      id: api.id,
      root: root(),
      pixel: (x: number, y: number) => staticPixel(api, x, y, root() ?? document),
      dark: (r: { x: number; y: number; w: number; h: number }) => darkPixelsIn(api, r, root() ?? document),
    }
    if (side === 'a') spike.handle.api = api
    readyCount.current++
    if (readyCount.current >= 2 && spike.handle.api) spike.resolveReady(spike.handle.api)
  }

  return (
    <div data-testid="spike-render-two" style={{ position: 'fixed', inset: 0, display: 'flex' }}>
      <div ref={rootA} data-testid="instance-a" style={{ position: 'relative', flex: 1 }}>
        <ExcalidrawHost role={EDITOR} theme="light" onReady={ready('a', () => rootA.current)} />
      </div>
      {showB && (
        <div
          key={keyB}
          ref={rootB}
          data-testid="instance-b"
          style={{ position: 'relative', flex: 1, borderLeft: '2px solid #888' }}
        >
          <ExcalidrawHost role={EDITOR} theme={themeB} onReady={ready('b', () => rootB.current)} />
        </div>
      )}
    </div>
  )
}
