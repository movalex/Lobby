import { Fonts } from '@excalidraw/excalidraw'
import type { ExcalidrawImperativeAPI } from '@excalidraw/excalidraw/types'
import { useEffect, useRef, useState } from 'react'
import ExcalidrawHost from '../../engine/ExcalidrawHost.tsx'
import { LOBBY_ROLES, type LobbyRole } from '../../engine/interaction.ts'
import { ImageLoader } from '../../files/loader.ts'
import { type HitGuardEvent, installHitGuard, RenderOverrides } from '../../overrides.ts'
import { createSpikeHandle, installSpikeHandle, pickParam } from '../harness.ts'
import {
  darkPixelsIn,
  EchoProbe,
  fixtureUrl,
  renderEngine,
  staticPixel,
  visibleFileIds,
} from './render-kit.ts'

const THEMES = ['light', 'dark'] as const

/**
 * /spike/render-lab — checks A7 (image failure echo), A9 (fonts), A10 (render overrides + hit guard), A12
 * (the built app works). ExcalidrawHost full-screen inside Lobby's wrapper div, plus:
 *   extra.probe      EchoProbe: onChange version changes a sync adapter would push
 *   extra.loader()   Lobby's ImageLoader on the fixture scheme (created on first use)
 *   extra.overrides  RenderOverrides (the single owner of setElementRenderOverrides)
 *   extra.guard      { enabled, setEnabled(b), log }: the hit-test guard on the wrapper
 *   extra.engine     engine exports (render-kit.ts), extra.Fonts
 *   extra.pixel(x, y), extra.dark(rect), extra.visibleFileIds()
 */
export default function RenderLabPage() {
  const [role] = useState<LobbyRole>(() => pickParam('role', LOBBY_ROLES, 'editor'))
  const [theme] = useState<'light' | 'dark'>(() => pickParam('theme', THEMES, 'light'))
  const [spike] = useState(() => createSpikeHandle(role, theme))
  const wrapper = useRef<HTMLDivElement>(null)

  useEffect(() => installSpikeHandle(spike.handle), [spike])

  const onReady = (api: ExcalidrawImperativeAPI) => {
    const wrap = wrapper.current
    if (!wrap) throw new Error('no wrapper')
    const extra = spike.handle.extra
    const probe = new EchoProbe(api)
    const overrides = new RenderOverrides(api, { elements: () => api.getSceneElementsIncludingDeleted() })
    const log: HitGuardEvent[] = []
    let uninstall: (() => void) | null = null
    const guard = {
      enabled: false,
      log,
      setEnabled(on: boolean) {
        if (on && !uninstall)
          uninstall = installHitGuard({ wrapper: wrap, api, overrides, onBlocked: (e) => log.push(e) })
        if (!on && uninstall) {
          uninstall()
          uninstall = null
        }
        guard.enabled = on
      },
    }
    guard.setEnabled(new URLSearchParams(location.search).get('guard') !== 'off')
    let loader: ImageLoader | null = null
    Object.assign(extra, {
      probe,
      overrides,
      guard,
      engine: renderEngine,
      Fonts,
      fixtureUrl,
      /**
       * The page's loader (created on first call). `urls` maps a version id to a same-origin path (a real
       * /files/<ast>/<ver>/d/<drv> route, for the CSP run); other ids use the fixture scheme.
       */
      loader: (
        opts: { retryWindowMs?: number; maxConcurrent?: number; urls?: Record<string, string> } = {},
      ) => {
        const { urls, ...rest } = opts
        loader ??= new ImageLoader({
          addFiles: (files) => api.addFiles(files),
          resolveUrl: (ver, derivative) => urls?.[ver] ?? fixtureUrl(ver, derivative),
          ...rest,
        })
        return loader
      },
      pixel: (x: number, y: number) => staticPixel(api, x, y),
      dark: (rect: { x: number; y: number; w: number; h: number }) => darkPixelsIn(api, rect),
      visibleFileIds: () => [...visibleFileIds(api)],
    })
    spike.handle.api = api
    spike.resolveReady(api)
  }

  return (
    <div
      ref={wrapper}
      data-testid="spike-render-lab"
      data-role={role}
      data-theme={theme}
      style={{ position: 'fixed', inset: 0 }}
    >
      <ExcalidrawHost
        role={role}
        theme={theme}
        onApi={(api) => {
          spike.handle.api = api
        }}
        onReady={onReady}
      />
    </div>
  )
}
