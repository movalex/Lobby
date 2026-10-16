// OWNER: WS3 (wave T). The image sequence (the design §3.2): one PNG per panel at the chosen width and the
// storyboard's aspect (the picture fitted on white, the shot number burned in at the top-left unless turned off), plus
// timings.csv and animatic.edl (./timings.ts), in a store-only ZIP (./zip.ts). An editor rebuilds the animatic from
// it with exact timings. Frames are drawn one at a time (only the current frame's pixels are held; the ZIP keeps the
// PNG Blobs).
import { formatDuration } from '@draftroom/canvas-schema/planning'
import type { LobbyCanvas } from '../../../canvas/api/index.ts'
import { type PanelView, type StoryboardView, shotLabel } from '../../storyboard-play/model.ts'
import { ExportCancelled } from '../ported/exporter.ts'
import { fileStem } from '../storyboard-sheet/pick.tsx'
import { pictureCanvas } from '../storyboard-sheet/pictures.ts'
import { animaticEdl, frameName, type SequenceFps, timingsCsv } from './timings.ts'
import { StoreZip } from './zip.ts'

export const SEQUENCE_WIDTHS = [1280, 1920, 3840] as const
export type SequenceWidth = (typeof SEQUENCE_WIDTHS)[number]

/** A frame's size: `width` wide at the storyboard's aspect (an even height). */
export function frameSize(width: number, ratio: number): { w: number; h: number } {
  const r = ratio > 0 ? ratio : 16 / 9
  return { w: width, h: Math.max(2, Math.round(width / r / 2) * 2) }
}

const FONT = 'ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif'

const blobOf = (c: HTMLCanvasElement) =>
  new Promise<Blob>((resolve, reject) =>
    c.toBlob((b) => (b ? resolve(b) : reject(new Error('the canvas gave no image'))), 'image/png'),
  )

/** One panel's frame as a PNG. */
export async function renderFrame(
  canvas: LobbyCanvas,
  panel: PanelView,
  size: { w: number; h: number },
  burnIn: boolean,
): Promise<Blob> {
  const frame = document.createElement('canvas')
  frame.width = size.w
  frame.height = size.h
  const g = frame.getContext('2d')
  if (!g) throw new Error('the browser cannot draw a frame here')
  try {
    g.fillStyle = '#ffffff'
    g.fillRect(0, 0, size.w, size.h)
    const pic = panel.picture
      ? await pictureCanvas(canvas, panel.picture, Math.max(size.w, size.h), 'original')
      : null
    if (pic && pic.width > 0 && pic.height > 0) {
      const k = Math.min(size.w / pic.width, size.h / pic.height)
      const w = pic.width * k
      const h = pic.height * k
      g.imageSmoothingQuality = 'high'
      g.drawImage(pic, (size.w - w) / 2, (size.h - h) / 2, w, h)
      pic.width = 0
      pic.height = 0
    }
    if (burnIn) {
      const px = Math.max(14, Math.round(Math.min(size.w, size.h) * 0.04))
      const text = `${shotLabel(panel.number)} · ${formatDuration(panel.durationMs)}`
      g.font = `bold ${px}px ${FONT}`
      const pad = Math.round(px * 0.5)
      const w = g.measureText(text).width + pad * 2
      const h = Math.round(px * 1.6)
      const x = Math.round(px * 0.6)
      const y = Math.round(px * 0.6)
      g.fillStyle = 'rgba(27, 35, 48, 0.88)'
      g.beginPath()
      g.roundRect?.(x, y, w, h, h / 2)
      if (!g.roundRect) g.rect(x, y, w, h)
      g.fill()
      g.fillStyle = '#ffffff'
      g.textBaseline = 'middle'
      g.fillText(text, x + pad, y + h / 2)
    }
    return await blobOf(frame)
  } finally {
    frame.width = 0
    frame.height = 0
  }
}

export interface SequenceResult {
  readonly blob: Blob
  readonly frames: number
  readonly stem: string
}

const encoder = new TextEncoder()

export async function makeSequenceZip(args: {
  readonly canvas: LobbyCanvas
  readonly view: StoryboardView
  readonly width: SequenceWidth
  readonly fps: SequenceFps
  readonly burnIn: boolean
  readonly signal?: AbortSignal
  readonly onProgress?: (p: { done: number; total: number }) => void
}): Promise<SequenceResult> {
  const { canvas, view, signal } = args
  const stem = fileStem(view.title)
  const size = frameSize(args.width, view.ratio)
  const zip = new StoreZip()
  const total = view.panels.length
  for (const [i, panel] of view.panels.entries()) {
    args.onProgress?.({ done: i, total })
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
    if (signal?.aborted) throw new ExportCancelled()
    await zip.add(frameName(stem, i + 1), await renderFrame(canvas, panel, size, args.burnIn))
  }
  if (signal?.aborted) throw new ExportCancelled()
  await zip.add('timings.csv', encoder.encode(timingsCsv(view, stem, args.fps)))
  await zip.add('animatic.edl', encoder.encode(animaticEdl(view, stem, args.fps)))
  args.onProgress?.({ done: total, total })
  return { blob: zip.finish(), frames: total, stem }
}
