// OWNER: WS3 (wave T). A panel's picture drawn for an export, in the browser: the engine's export of the picture's
// elements clipped to its region (features/storyboard-play/model.ts PanelPicture), on white. The sheet takes it as a
// JPEG data: URL for the PDF page's own image object (never put anywhere else: not in an element, not in a request);
// the image sequence draws the canvas itself into its frame.
import type { LobbyCanvas } from '../../../canvas/api/index.ts'
import type { PanelPicture } from '../../storyboard-play/model.ts'
import type { SheetPicture } from './layout.ts'

/** The picture as a canvas no larger than `maxSide` on its long side (null when it has no area). */
export async function pictureCanvas(
  canvas: LobbyCanvas,
  picture: PanelPicture,
  maxSide: number,
  files: 'display' | 'original' = 'display',
): Promise<HTMLCanvasElement | null> {
  const { width, height } = picture.bounds
  if (!(width > 0 && height > 0)) return null
  const scale = Math.min(4, maxSide / Math.max(width, height))
  return canvas.export.canvas({
    ids: picture.ids,
    bounds: picture.bounds,
    scale,
    maxSide,
    background: true,
    theme: 'light',
    files,
  })
}

/** The picture as a JPEG data: URL for a PDF page (null when it cannot be drawn). */
export async function sheetPicture(
  canvas: LobbyCanvas,
  picture: PanelPicture,
  maxSide: number,
): Promise<SheetPicture | null> {
  const c = await pictureCanvas(canvas, picture, maxSide).catch(() => null)
  if (!c || c.width <= 0 || c.height <= 0) return null
  try {
    // JPEG has no alpha: paper white under it
    const out = document.createElement('canvas')
    out.width = c.width
    out.height = c.height
    const g = out.getContext('2d')
    if (!g) return null
    g.fillStyle = '#ffffff'
    g.fillRect(0, 0, out.width, out.height)
    g.drawImage(c, 0, 0)
    const dataUrl = out.toDataURL('image/jpeg', 0.86)
    out.width = 0
    out.height = 0
    return dataUrl.startsWith('data:image/jpeg;base64,')
      ? { dataUrl, width: c.width, height: c.height }
      : null
  } finally {
    c.width = 0
    c.height = 0
  }
}
