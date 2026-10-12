// LobbyCanvas exports on Excalidraw (docs/EXCALIDRAW-MIGRATION.md §2.10.4, §4.5; wave 3e): a bitmap
// (`exportToCanvas`), a PNG with one pHYs chunk, and a standalone SVG, of the board, a selection, a frame
// or an exact rectangle (plan.ts). Browser only; reads the engine, never writes it.
//
// Image bytes. An export never draws the canvas's runtime files as they are: the image loader holds
// 512 px previews (§2.10.3, "the original is never loaded on the canvas"). Each export builds its own,
// EXPORT-ONLY files map (never stored, never synced, revoked or dropped when the export is done):
//  - `original` (PNG, bitmaps, the clipboard; SVG when asked): an uploaded image's original upload
//    (`/files/<ast>/<ver>/original?board=`), as tldraw's exports resolved originals;
//  - `display` (SVG by default, F15: an SVG embeds every image, so originals made a 37-photo board a
//    252 MB file): the 2,048 px `display` derivative through the board's resolver;
//  - file cards (PDF, video, office) and placed PDF pages have no drawable original: their face's
//    `display` rendering. Anything that cannot be fetched falls back to what the canvas shows now;
//  - `canvas` (thumbnails): only what the canvas shows now, nothing fetched.
// For bitmaps the bytes become `blob:` URLs (same-origin, the canvas stays untainted); for SVG `data:`
// URLs, since `exportToSvg` writes each file's URL verbatim into `<image href>` (§2.10.4).
//
// Sizes: `scale` × the drawn size through `getDimensions` (Excalidraw's `exportToCanvas` wrapper ignores
// `exportScale` otherwise), capped by `maxSide` and the browser's canvas limits (plan.ts exportScale).
import { originalUrl } from '@draftroom/dev-assets/shared'
import { arrayToMap } from '@excalidraw/common'
import { getElementBounds, newFrameElement } from '@excalidraw/element'
import type { ExcalidrawElement, NonDeletedExcalidrawElement } from '@excalidraw/element/types'
import { exportToCanvas, exportToSvg } from '@excalidraw/excalidraw'
import type {
  AppState,
  BinaryFileData,
  BinaryFiles,
  ExcalidrawImperativeAPI,
} from '@excalidraw/excalidraw/types'
import { setPngDensity } from '../../features/present-export/png-density.ts'
import type { ExportOptions } from '../api/lobby-canvas.ts'
import { type Derivative, type FileKey, parseFileKey } from '../files/loader.ts'
import { FACES_METADATA_ID, facesTable, selfContainedProblems } from './fonts.ts'
import { softNoteShadows } from './note-shadow.ts'
import {
  EXPORT_BOUNDS_FRAME_ID,
  type ExportPlan,
  exportFrameRendering,
  exportScale,
  type PlanRect,
  planExport,
  reparentToBounds,
} from './plan.ts'
import { withoutLinks } from './select.ts'
import { fontFaceRules, namedFaces } from './svg.ts'

/** Which bytes an export draws for an uploaded image (see the header). */
export type ExportFileSource = 'original' | 'display' | 'canvas'

/** What an export reads: the engine, the board's file routes, the hidden set. */
export interface SceneExportContext {
  readonly api: Pick<ExcalidrawImperativeAPI, 'getSceneElements' | 'getFiles' | 'getAppState'>
  /** the board id (`?board=` of the file routes); null: only the canvas's runtime files are drawn */
  readonly boardId: string | null
  /** the board's file resolver (derivative URLs), once the image loader is installed */
  readonly resolver: {
    resolveUrl(versionId: string, derivative: Derivative, file: FileKey): Promise<string | null>
    assetOf(versionId: string): string | null
  } | null
  /** collapsed mind-map branches: never exported (render overrides do not change exports) */
  readonly isHidden: (id: string) => boolean
  readonly fetchImpl?: (url: string) => Promise<Response>
  /**
   * CR 3E-5: the face of a file card, asked before any URL is resolved (a PDF, video or Office card has no
   * drawable original; the export draws its whole face, ../api/parts/export-faces.ts). `null`: no face
   * (no DOM, a failed draw): the card's cover is used, as for any other file.
   */
  readonly faceOf?: (el: ExcalidrawElement & { fileId: string }, key: FileKey) => Promise<Blob | null>
}

export interface SceneExportOptions extends ExportOptions {
  readonly files?: ExportFileSource
}

interface FileFacts {
  readonly assetId?: unknown
  readonly kind?: unknown
  readonly mimeType?: unknown
}

const factsOf = (el: ExcalidrawElement): FileFacts | null => {
  const f = (el.customData as { lobby?: { file?: unknown } } | undefined)?.lobby?.file
  return f && typeof f === 'object' ? (f as FileFacts) : null
}

const defaultFetch = (url: string) => fetch(url, { credentials: 'same-origin' })

async function blobToDataUrl(blob: Blob, mime: string): Promise<string> {
  const u8 = new Uint8Array(await blob.arrayBuffer())
  let bin = ''
  for (let i = 0; i < u8.length; i += 0x8000) bin += String.fromCharCode(...u8.subarray(i, i + 0x8000))
  return `data:${mime};base64,${btoa(bin)}`
}

/** The URL of the bytes `source` wants for one image element, or null (use the runtime file). */
async function sourceUrl(
  ctx: SceneExportContext,
  el: ExcalidrawElement & { fileId: string },
  source: ExportFileSource,
): Promise<{ url: string; mime: string | null } | null> {
  const key = parseFileKey(el.fileId)
  if (!key || !ctx.boardId || source === 'canvas') return null
  const facts = factsOf(el)
  if (source === 'original' && key.page === null && facts?.kind === 'image') {
    const assetId = typeof facts.assetId === 'string' ? facts.assetId : ctx.resolver?.assetOf(key.versionId)
    if (assetId)
      return {
        url: originalUrl(ctx.boardId, assetId, key.versionId),
        mime: typeof facts.mimeType === 'string' ? facts.mimeType : null,
      }
  }
  const url = await ctx.resolver?.resolveUrl(key.versionId, 'display', key).catch(() => null)
  return url ? { url, mime: null } : null
}

export interface ExportFiles {
  readonly files: BinaryFiles
  /** file keys drawn from bytes fetched for this export (the rest are the canvas's runtime files) */
  readonly fetched: readonly string[]
  /** revokes the export's own blob: URLs */
  release(): void
}

/**
 * The export-only files map for `elements` (see the header): `blob:` URLs for bitmaps, `data:` URLs for
 * SVG. At most 6 fetches at once, like the image loader.
 */
export async function exportFiles(
  ctx: SceneExportContext,
  elements: readonly ExcalidrawElement[],
  source: ExportFileSource,
  encode: 'blob' | 'data',
): Promise<ExportFiles> {
  const doFetch = ctx.fetchImpl ?? defaultFetch
  const runtime = ctx.api.getFiles()
  const images = new Map<string, ExcalidrawElement & { fileId: string }>()
  for (const e of elements)
    if (e.type === 'image' && typeof (e as { fileId?: unknown }).fileId === 'string')
      images.set((e as { fileId: string }).fileId, e as ExcalidrawElement & { fileId: string })
  const files: BinaryFiles = {}
  const fetched: string[] = []
  const urls: string[] = []
  const one = async (fileId: string, el: ExcalidrawElement & { fileId: string }) => {
    const have = runtime[fileId]
    let blob: Blob | null = null
    let mime: string | null = null
    // CR 3E-5: a card's face first, whatever the source (a face is made for this export only)
    const key = ctx.faceOf ? parseFileKey(fileId) : null
    if (ctx.faceOf && key) {
      const face = await ctx.faceOf(el, key).catch(() => null)
      if (face) {
        blob = face
        mime = face.type || 'image/png'
      }
    }
    const src = blob ? null : await sourceUrl(ctx, el, source)
    if (src) {
      try {
        const res = await doFetch(src.url)
        if (res.ok) {
          blob = await res.blob()
          mime =
            (res.headers.get('content-type') ?? '').split(';')[0]?.trim() || src.mime || blob.type || null
        }
      } catch {
        blob = null
      }
    }
    if (blob && mime) {
      const dataURL = encode === 'blob' ? URL.createObjectURL(blob) : await blobToDataUrl(blob, mime)
      if (encode === 'blob') urls.push(dataURL)
      files[fileId] = {
        id: fileId as BinaryFileData['id'],
        mimeType: mime as BinaryFileData['mimeType'],
        dataURL: dataURL as BinaryFileData['dataURL'],
        created: have?.created ?? Date.now(),
      }
      fetched.push(fileId)
      return
    }
    if (!have) return // Excalidraw draws its placeholder: still a valid, self-contained export
    if (encode === 'blob' || have.dataURL.startsWith('data:')) {
      files[fileId] = have
      return
    }
    try {
      const res = await doFetch(have.dataURL)
      if (res.ok)
        files[fileId] = {
          ...have,
          dataURL: (await blobToDataUrl(await res.blob(), have.mimeType)) as BinaryFileData['dataURL'],
        }
    } catch {
      // left out: the placeholder
    }
  }
  const queue = [...images]
  await Promise.all(
    Array.from({ length: Math.min(6, queue.length) }, async () => {
      for (let next = queue.shift(); next; next = queue.shift()) await one(next[0], next[1])
    }),
  )
  return {
    files,
    fetched,
    release() {
      for (const u of urls.splice(0)) URL.revokeObjectURL(u)
    },
  }
}

const rectOf = (e: ExcalidrawElement, map: ReturnType<typeof arrayToMap<ExcalidrawElement>>): PlanRect => {
  const [x1, y1, x2, y2] = getElementBounds(e, map as never)
  return { x: x1, y: y1, width: x2 - x1, height: y2 - y1 }
}

interface PreparedExport {
  readonly plan: ExportPlan<ExcalidrawElement>
  /** what the exporter is given (a `bounds` export: re-parented copies after the synthetic frame) */
  readonly elements: NonDeletedExcalidrawElement[]
  readonly exportingFrame: NonDeletedExcalidrawElement | null
  readonly padding: number
  readonly appState: Partial<AppState>
}

/** The light board background exports draw on (tldraw's light export background). */
const LIGHT_BACKGROUND = '#ffffff'

function prepare(ctx: SceneExportContext, opts: SceneExportOptions): PreparedExport {
  const scene = ctx.api.getSceneElements() as readonly ExcalidrawElement[]
  const map = arrayToMap(scene)
  const plan = planExport(
    scene,
    {
      ...(opts.ids ? { ids: opts.ids } : {}),
      ...(opts.bounds ? { bounds: opts.bounds } : {}),
      ...(opts.frameId ? { frameId: opts.frameId } : {}),
      ...(opts.padding !== undefined ? { padding: opts.padding } : {}),
    },
    { isHidden: ctx.isHidden, boundsOf: (e) => rectOf(e, map) },
  )
  const appState: Partial<AppState> = {
    exportBackground: opts.background ?? true,
    viewBackgroundColor: LIGHT_BACKGROUND,
    exportWithDarkMode: opts.theme === 'dark',
    exportEmbedScene: false,
    frameRendering: exportFrameRendering(ctx.api.getAppState()?.frameRendering),
  }
  // no `link` reaches the exporter (select.ts withoutLinks, XSS-F1): the export's own copies
  if (plan.kind === 'frame')
    return {
      plan,
      elements: withoutLinks(plan.elements) as NonDeletedExcalidrawElement[],
      exportingFrame: plan.frame as NonDeletedExcalidrawElement,
      padding: 0,
      appState,
    }
  if (plan.kind === 'bounds') {
    const b = plan.bounds
    const frame = {
      ...newFrameElement({ x: b.x, y: b.y, width: b.width, height: b.height }),
      id: EXPORT_BOUNDS_FRAME_ID,
    } as ExcalidrawElement
    return {
      plan,
      elements: withoutLinks(reparentToBounds(plan.elements, frame)) as NonDeletedExcalidrawElement[],
      exportingFrame: frame as NonDeletedExcalidrawElement,
      padding: 0,
      appState,
    }
  }
  return {
    plan,
    elements: withoutLinks(plan.elements) as NonDeletedExcalidrawElement[],
    exportingFrame: null,
    padding: plan.padding,
    appState,
  }
}

/** Whether an export would draw anything (a `frame` export always draws its frame's rectangle). */
export function exportIsEmpty(ctx: SceneExportContext, opts: SceneExportOptions): boolean {
  const p = prepare(ctx, opts)
  return p.plan.kind === 'elements' ? p.plan.elements.length === 0 : false
}

export interface CanvasExport {
  readonly canvas: HTMLCanvasElement
  /** the scale it was drawn at (below the asked one when a cap applied) */
  readonly scale: number
}

/** A bitmap of the export (PDF pages, thumbnails, previews, PNG). */
export async function exportSceneCanvas(
  ctx: SceneExportContext,
  opts: SceneExportOptions,
): Promise<CanvasExport> {
  const p = prepare(ctx, opts)
  if (p.plan.kind === 'elements' && p.elements.length === 0) throw new Error('export: nothing to export')
  const files = await exportFiles(ctx, p.elements, opts.files ?? 'original', 'blob')
  let drawn = 1
  // W5-37 (CR 3E-7): notes get the SVG export's soft shadow, on this export's canvas only (./note-shadow.ts)
  const shadows = softNoteShadows()
  shadows.begin()
  try {
    const canvas = await exportToCanvas({
      elements: p.elements,
      appState: p.appState,
      files: files.files,
      exportPadding: p.padding,
      exportingFrame: p.exportingFrame as never,
      getDimensions: (width: number, height: number) => {
        shadows.markExportCanvas()
        drawn = exportScale(width, height, {
          ...(opts.scale !== undefined ? { scale: opts.scale } : {}),
          ...(opts.maxSide !== undefined ? { maxSide: opts.maxSide } : {}),
        })
        return {
          width: Math.max(1, Math.round(width * drawn)),
          height: Math.max(1, Math.round(height * drawn)),
          scale: drawn,
        }
      },
    })
    return { canvas, scale: drawn }
  } finally {
    shadows.end()
    files.release()
  }
}

const canvasBlob = (canvas: HTMLCanvasElement, type: string, quality?: number) =>
  new Promise<Blob>((resolve, reject) =>
    canvas.toBlob(
      (b) => (b ? resolve(b) : reject(new Error('export: the canvas gave no image'))),
      type,
      quality,
    ),
  )

/** The canvas as a PNG marked `scale`× (one pHYs chunk, png-density.ts). */
export async function pngOf(canvas: HTMLCanvasElement, scale: number): Promise<Blob> {
  const blob = await canvasBlob(canvas, 'image/png')
  const bytes = setPngDensity(new Uint8Array(await blob.arrayBuffer()), scale)
  return new Blob([bytes as BlobPart], { type: 'image/png' })
}

export async function exportScenePng(ctx: SceneExportContext, opts: SceneExportOptions): Promise<Blob> {
  const { canvas, scale } = await exportSceneCanvas(ctx, opts)
  return pngOf(canvas, scale)
}

export interface SceneSvg {
  readonly text: string
  readonly bytes: number
  readonly fetchedFiles: readonly string[]
  readonly embeddedFonts: readonly string[]
}

/**
 * A standalone SVG: images as `data:` URLs (`display` previews unless `files: 'original'`), Lobby's own
 * `@font-face` rules (svg.ts `fontFaceRules`: `skipInliningFonts`, no `unsafe-eval`, §2.12), and
 * nothing that refers outside the file (fonts.ts `selfContainedProblems`).
 */
export async function exportSceneSvg(ctx: SceneExportContext, opts: SceneExportOptions): Promise<SceneSvg> {
  const p = prepare(ctx, opts)
  if (p.plan.kind === 'elements' && p.elements.length === 0) throw new Error('export: nothing to export')
  const files = await exportFiles(ctx, p.elements, opts.files ?? 'display', 'data')
  const svg = await exportToSvg({
    elements: p.elements,
    appState: { ...p.appState, exportScale: opts.scale ?? 1 },
    files: files.files,
    exportPadding: p.padding,
    exportingFrame: p.exportingFrame as never,
    skipInliningFonts: true,
  })
  // wave N (WS6): `fonts: 'names'` leaves the faces to the consumer (the PDF worker embeds subset fonts itself):
  // no @font-face at all, only the table of the faces the text needs (fonts.ts FACES_METADATA_ID), same-origin
  // paths, nothing fetched here
  const names = opts.fonts === 'names'
  const { rules, urls } = names
    ? { rules: [] as string[], urls: [] as string[] }
    : await fontFaceRules(p.elements, ctx.fetchImpl ? { fetchImpl: ctx.fetchImpl } : {})
  let style = svg.querySelector('style.style-fonts')
  if (!style) {
    style = svg.ownerDocument.createElementNS('http://www.w3.org/2000/svg', 'style')
    style.classList.add('style-fonts')
    ;(svg.querySelector('defs') ?? svg).appendChild(style)
  }
  style.textContent = `\n${rules.join('\n')}\n`
  if (names) {
    const meta = svg.ownerDocument.createElementNS('http://www.w3.org/2000/svg', 'metadata')
    meta.setAttribute('id', FACES_METADATA_ID)
    meta.textContent = JSON.stringify(facesTable(namedFaces(p.elements)))
    ;(svg.querySelector('defs') ?? svg).appendChild(meta)
  }
  const text = new XMLSerializer().serializeToString(svg)
  const problems = selfContainedProblems(text)
  if (problems.length) throw new Error(`the exported SVG is not self-contained: ${problems.join(', ')}`)
  return { text, bytes: new Blob([text]).size, fetchedFiles: files.fetched, embeddedFonts: urls }
}
