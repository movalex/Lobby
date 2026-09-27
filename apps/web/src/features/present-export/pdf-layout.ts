// Pure sizing rules for exports: PDF page size per frame, the page layout (a header band with the
// frame's title, the frame fitted below it, on frame-sized or uniform 16:9 / A4 pages), the raster
// resolution each page is drawn at, and the pixel size of an image export (for the dialog's size hint).

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

/** PDF page sizes the export offers: each page sized to its frame, or every page the same. */
export type PdfPageFormat = 'fit' | '16:9' | 'a4'
export const PDF_PAGE_FORMATS: readonly { id: PdfPageFormat; label: string }[] = [
  { id: 'fit', label: 'Fit each frame' },
  { id: '16:9', label: '16:9 landscape' },
  { id: 'a4', label: 'A4 landscape' },
]
export const isPdfPageFormat = (v: unknown): v is PdfPageFormat => PDF_PAGE_FORMATS.some((f) => f.id === v)

/** Fixed page sizes (pt): 16:9 = 13.333 × 7.5 in (widescreen slides), A4 = 297 × 210 mm. */
export const FIXED_PAGE_PT: Record<Exclude<PdfPageFormat, 'fit'>, { width: number; height: number }> = {
  '16:9': { width: 960, height: 540 },
  a4: { width: 841.89, height: 595.28 },
}

export interface PdfRect {
  /** From the page's left edge, pt. */
  x: number
  /** From the page's TOP edge, pt (pdf-build converts to PDF's bottom-up coordinates). */
  y: number
  width: number
  height: number
}

export interface PdfPagePlan {
  width: number
  height: number
  /** The band across the top of the page that carries the frame's title. */
  header: PdfRect & { fontSize: number; padX: number }
  /** Where the frame's image goes (aspect ratio kept). */
  image: PdfRect
  /** Points per board px inside `image` (maps the text layer). */
  ptPerPx: number
}

const clampN = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n))

/** The title band's height for a page `widthPt` wide: about 4% of the width, 28–120 pt. */
export function headerBandHeight(widthPt: number): number {
  return Math.round(clampN(widthPt * 0.04, 28, 120))
}

function header(widthPt: number): PdfPagePlan['header'] {
  const height = headerBandHeight(widthPt)
  return {
    x: 0,
    y: 0,
    width: widthPt,
    height,
    fontSize: Math.round(height * 0.42 * 10) / 10,
    padX: Math.round(height * 0.5),
  }
}

/**
 * The layout of one PDF page for a frame of `w`×`h` board px. Every page starts with a header band
 * (the frame's title, so a printed page says what it is). 'fit': the page is the frame's own size
 * (pdfPageSize) plus the band. '16:9' / 'a4': every page has the same landscape size and the frame is
 * scaled to fit below the band, centred, with margins.
 */
export function planPdfPage(w: number, h: number, format: PdfPageFormat = 'fit'): PdfPagePlan {
  const width = positive(w)
  const height = positive(h)
  if (format === 'fit') {
    const page = pdfPageSize(width, height)
    const band = header(page.width)
    let k = page.ptPerPx
    // The band must not push a page past the PDF size limit.
    if (height * k + band.height > MAX_PDF_SIDE_PT) k = (MAX_PDF_SIDE_PT - band.height) / height
    const iw = Math.max(MIN_PDF_SIDE_PT, width * k)
    const ih = Math.max(MIN_PDF_SIDE_PT, height * k)
    const pageWidth = Math.max(page.width, iw)
    return {
      width: pageWidth,
      height: ih + band.height,
      header: { ...band, width: pageWidth },
      image: { x: 0, y: band.height, width: iw, height: ih },
      ptPerPx: k,
    }
  }
  const size = FIXED_PAGE_PT[format]
  const band = header(size.width)
  const margin = Math.round(size.width * 0.03)
  const areaW = size.width - margin * 2
  const areaH = size.height - band.height - margin * 2
  const k = Math.min(areaW / width, areaH / height)
  const iw = width * k
  const ih = height * k
  return {
    width: size.width,
    height: size.height,
    header: band,
    image: {
      x: (size.width - iw) / 2,
      y: band.height + margin + (areaH - ih) / 2,
      width: iw,
      height: ih,
    },
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
export function pdfRasterScale(
  w: number,
  h: number,
  opts: RasterOptions = PDF_RASTER,
  /** Points per board px the frame is printed at (planPdfPage); default: its own 'fit' page. */
  ptPerPx?: number,
): number {
  const width = positive(w)
  const height = positive(h)
  const k =
    ptPerPx !== undefined && Number.isFinite(ptPerPx) && ptPerPx > 0
      ? ptPerPx
      : pdfPageSize(width, height).ptPerPx
  // Keep at least `preferred` pixels per page point-equivalent of the default 0.75 pt/px.
  const upscale = Math.max(1, k / PT_PER_PX)
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
