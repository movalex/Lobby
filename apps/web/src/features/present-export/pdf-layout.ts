// Pure sizing rules for exports: PDF page size per frame, the raster resolution each page is drawn at,
// and the pixel size of an image export (for the dialog's size hint).

/** Board units are CSS px; 96 px = 72 pt = 1 inch, so a 1920×1080 frame becomes a 20×11.25 in page. */
export const PT_PER_PX = 0.75
/** Acrobat's page-size limit (200 in). */
export const MAX_PDF_SIDE_PT = 14_400
/** Tiny frames are scaled up so the page's long side is at least 2 in. */
export const MIN_PDF_LONG_SIDE_PT = 144
/** The PDF format's minimum page side. */
export const MIN_PDF_SIDE_PT = 3

export interface PdfPageSize {
  width: number
  height: number
  /** Points per board px used for this page (also maps text positions). */
  ptPerPx: number
}

const positive = (n: number, fallback = 1) => (Number.isFinite(n) && n > 0 ? n : fallback)

/** The page for a frame of `w`×`h` board px: 0.75 pt/px, scaled into [MIN_PDF_LONG_SIDE_PT, MAX_PDF_SIDE_PT]. */
export function pdfPageSize(w: number, h: number): PdfPageSize {
  const width = positive(w)
  const height = positive(h)
  const long = Math.max(width, height)
  let k = PT_PER_PX
  if (long * k > MAX_PDF_SIDE_PT) k = MAX_PDF_SIDE_PT / long
  else if (long * k < MIN_PDF_LONG_SIDE_PT) k = MIN_PDF_LONG_SIDE_PT / long
  return {
    width: Math.max(MIN_PDF_SIDE_PT, width * k),
    height: Math.max(MIN_PDF_SIDE_PT, height * k),
    ptPerPx: k,
  }
}

export interface RasterOptions {
  /** Pixels per board px we aim for (3 = ~288 dpi on a 0.75 pt/px page). */
  preferred: number
  /** Never less than this, unless the page would exceed maxPixels. */
  min: number
  /** Memory guard per page (RGBA canvas = 4 bytes per pixel). */
  maxPixels: number
}

export const PDF_RASTER: RasterOptions = { preferred: 3, min: 2, maxPixels: 50_000_000 }

/**
 * Pixels per board px for one PDF page: `preferred`, lowered to fit `maxPixels`, but not below `min`
 * unless even `min` would exceed `maxPixels` (then the largest scale that fits). Tiny frames get more
 * pixels so their page (scaled up to MIN_PDF_LONG_SIDE_PT) stays sharp.
 */
export function pdfRasterScale(w: number, h: number, opts: RasterOptions = PDF_RASTER): number {
  const width = positive(w)
  const height = positive(h)
  const page = pdfPageSize(width, height)
  // Keep at least `preferred` pixels per page point-equivalent of the default 0.75 pt/px.
  const upscale = Math.max(1, page.ptPerPx / PT_PER_PX)
  const wanted = opts.preferred * upscale
  const fit = Math.sqrt(opts.maxPixels / (width * height))
  const scale = Math.min(wanted, fit)
  if (scale >= opts.min) return round3(scale)
  return round3(Math.min(opts.min, fit))
}

const round3 = (n: number) => Math.floor(n * 1000) / 1000

/**
 * Conservative canvas limits across current browsers (tldraw measures the real ones internally and
 * silently shrinks exports that exceed them): Chrome/Edge draw up to 16,384² px, Firefox ~11,180² px of
 * area and 32,767 px per side; Safari less on iOS.
 */
export const CANVAS_SAFE = { maxSide: 16_384, maxArea: 11_180 * 11_180 }

/** Whether a `width`×`height` px image is likely to be reduced by the browser's canvas limits. */
export function exceedsCanvasLimits(width: number, height: number, limits = CANVAS_SAFE): boolean {
  return width > limits.maxSide || height > limits.maxSide || width * height > limits.maxArea
}

/** Output pixel size of an image export of `w`×`h` board px at `scale`. */
export function imagePixelSize(w: number, h: number, scale: number): { width: number; height: number } {
  return { width: Math.round(positive(w) * scale), height: Math.round(positive(h) * scale) }
}
