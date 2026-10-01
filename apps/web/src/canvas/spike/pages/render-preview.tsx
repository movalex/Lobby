import type { ExcalidrawElement } from '@excalidraw/element/types'
import type { BinaryFileData, BinaryFiles, ExcalidrawImperativeAPI } from '@excalidraw/excalidraw/types'
import { useEffect, useRef, useState } from 'react'
import ExcalidrawHost from '../../engine/ExcalidrawHost.tsx'
import type { LobbyRole } from '../../engine/interaction.ts'
import { ImageLoader } from '../../files/loader.ts'
import { CheckpointPreview } from '../../preview/CheckpointPreview.ts'
import { createSpikeHandle, installSpikeHandle } from '../harness.ts'
import { EchoProbe, fixtureUrl, renderEngine, staticPixel } from './render-kit.ts'

/** A literal role prop trips the ARIA-role lint (ExcalidrawHost role is a Lobby role, not ARIA). */
const EDITOR: LobbyRole = 'editor'

/**
 * /spike/render-preview — check A11 (checkpoint preview through exportToCanvas with Lobby's pan and zoom).
 * The live board (ExcalidrawHost, left) and a checkpoint preview panel (right): a plain <canvas> drawn by
 * CheckpointPreview, never a second <Excalidraw>.
 *   extra.openPreview(elements)  loads the checkpoint's images with Lobby's loader into a preview-only
 *                                files map, renders the overview, fits; resolves with the stats
 *   extra.preview                the CheckpointPreview
 *   extra.previewPixel(x, y)     RGBA of the preview canvas at a scene point
 *   extra.probe                  EchoProbe on the live board
 */
export default function RenderPreviewPage() {
  const [spike] = useState(() => createSpikeHandle('editor', 'light'))
  const previewCanvas = useRef<HTMLCanvasElement>(null)
  const [open, setOpen] = useState(false)

  useEffect(() => installSpikeHandle(spike.handle), [spike])

  const onReady = (api: ExcalidrawImperativeAPI) => {
    const extra = spike.handle.extra
    const probe = new EchoProbe(api)
    let preview: CheckpointPreview | null = null
    Object.assign(extra, {
      probe,
      engine: renderEngine,
      livePixel: (x: number, y: number) => staticPixel(api, x, y),
      async openPreview(elements: ExcalidrawElement[], opts: { maxPixels?: number } = {}) {
        setOpen(true)
        await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))
        const canvas = previewCanvas.current
        if (!canvas) throw new Error('no preview canvas')
        // the checkpoint's images: Lobby's loader into a preview-only map (never api.addFiles)
        const files: BinaryFiles = {}
        const loader = new ImageLoader({
          addFiles: (list: BinaryFileData[]) => {
            for (const f of list) files[f.id] = f
          },
          resolveUrl: fixtureUrl,
        })
        loader.syncScene(elements)
        const deadline = performance.now() + 15_000
        while (loader.states().queued + loader.states().loading > 0 && performance.now() < deadline) {
          await new Promise((r) => setTimeout(r, 50))
        }
        preview?.dispose()
        preview = new CheckpointPreview(canvas, { elements, files, ...opts })
        extra.preview = preview
        await preview.init()
        preview.attachInteraction()
        preview.draw()
        return { ...preview.stats, loader: loader.states() }
      },
      closePreview() {
        preview?.dispose()
        preview = null
        setOpen(false)
      },
      previewPixel(x: number, y: number) {
        const canvas = previewCanvas.current
        const p = preview
        if (!canvas || !p) return null
        const v = p.sceneToView(x, y)
        const k = canvas.width / canvas.getBoundingClientRect().width
        const px = Math.round(v.x * k)
        const py = Math.round(v.y * k)
        if (px < 0 || py < 0 || px >= canvas.width || py >= canvas.height) return null
        const d = canvas.getContext('2d')?.getImageData(px, py, 1, 1).data
        return d ? [d[0], d[1], d[2], d[3]] : null
      },
      /** Dark pixels inside a scene rect of the preview canvas. */
      previewDark(rect: { x: number; y: number; w: number; h: number }) {
        const canvas = previewCanvas.current
        const p = preview
        if (!canvas || !p) return -1
        const k = canvas.width / canvas.getBoundingClientRect().width
        const a = p.sceneToView(rect.x, rect.y)
        const b = p.sceneToView(rect.x + rect.w, rect.y + rect.h)
        const x = Math.max(0, Math.round(a.x * k))
        const y = Math.max(0, Math.round(a.y * k))
        const w = Math.min(canvas.width - x, Math.round((b.x - a.x) * k))
        const h = Math.min(canvas.height - y, Math.round((b.y - a.y) * k))
        if (w <= 0 || h <= 0) return 0
        const d = canvas.getContext('2d')?.getImageData(x, y, w, h).data ?? new Uint8ClampedArray()
        let n = 0
        for (let i = 0; i < d.length; i += 4)
          if ((d[i] ?? 255) + (d[i + 1] ?? 255) + (d[i + 2] ?? 255) < 330) n++
        return n
      },
    })
    spike.handle.api = api
    spike.resolveReady(api)
  }

  return (
    <div data-testid="spike-render-preview" style={{ position: 'fixed', inset: 0, display: 'flex' }}>
      <div data-testid="live-board" style={{ position: 'relative', flex: 1 }}>
        <ExcalidrawHost role={EDITOR} theme="light" onReady={onReady} />
      </div>
      {open && (
        <aside
          data-testid="checkpoint-preview"
          style={{ position: 'relative', width: '50%', borderLeft: '1px solid #ccc', background: '#fff' }}
        >
          <canvas
            ref={previewCanvas}
            data-testid="checkpoint-preview-canvas"
            style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', touchAction: 'none' }}
          />
        </aside>
      )}
    </div>
  )
}
