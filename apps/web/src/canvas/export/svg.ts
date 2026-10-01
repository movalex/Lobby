// SVG and PNG export of the board (docs/EXCALIDRAW-MIGRATION.md §2.10.4 "PNG export", "SVG export",
// §4.5; spike B check B7, and B12's "left out of an export").
//
// SVG: `exportToSvg` writes each file's `dataURL` verbatim into `<image href>` (chunk-FN755BR4.js near
// 4276), so a `blob:` or `/files` URL would be dead in a downloaded file. The exporter builds an
// EXPORT-ONLY files map with `data:` URLs read at export time (from the runtime blob: URLs the loader made,
// same-origin), never stored or synced, so the durable-data rule holds. Fonts: `skipInliningFonts: true`
// (Excalidraw's subsetting needs `'unsafe-eval'`, §2.12) plus Lobby's own `@font-face` rules (fonts.ts),
// one per self-hosted woff2 file whose range covers the exported characters. The result must stand
// alone: `selfContainedProblems` finds any `blob:`, relative or foreign reference left in it.
//
// PNG: `exportToBlob` draws from the runtime files map; `blob:` URLs are same-origin, so the canvas stays
// untainted.
//
// Hidden elements (a collapsed mind-map branch, §4.7) are left out of both: render overrides do not
// change exports, so the exporter filters them itself.
import { FONT_FAMILY_FALLBACKS, getFontFamilyFallbacks } from '@excalidraw/common'
import type { ExcalidrawElement, NonDeletedExcalidrawElement } from '@excalidraw/element/types'
import { exportToBlob, exportToSvg, Fonts } from '@excalidraw/excalidraw'
import type { AppState, BinaryFileData, BinaryFiles } from '@excalidraw/excalidraw/types'
import {
  charsPerFamily,
  type FaceInfo,
  type FamilyInfo,
  fontFaceRule,
  selectFaces,
  selfContainedProblems,
  woff2DataUrl,
} from './fonts.ts'

import { exportElements as selectForExport, withoutLinks } from './select.ts'

export { selfContainedProblems }

export interface ExportSource {
  /** the scene (deleted elements are dropped here) */
  readonly elements: readonly ExcalidrawElement[]
  readonly appState: Partial<AppState>
  /** the engine's runtime files map (`api.getFiles()`) */
  readonly files: BinaryFiles
  /** hidden ids (a collapsed branch; labels and frame children included): left out */
  readonly isHidden?: (id: string) => boolean
  /** only these ids (a selection or a frame), after the hidden filter */
  readonly only?: ReadonlySet<string>
}

export interface SvgExportOptions {
  readonly fetchImpl?: (url: string) => Promise<Response>
  /** the page origin (same-origin check for font and file URLs); default `location.origin` */
  readonly origin?: string
  readonly exportPadding?: number
}

export interface SvgExportResult {
  readonly svg: SVGSVGElement
  readonly text: string
  /** file keys embedded as data: URLs */
  readonly embeddedFiles: readonly string[]
  /** woff2 files embedded (their self-hosted URLs) */
  readonly embeddedFonts: readonly string[]
  readonly bytes: number
}

/**
 * The elements an export draws (select.ts): live, not hidden, (with `only`) the chosen ones, and none with
 * a `link` (XSS-F1: `exportToSvg` would wrap it in `<a href>`, a reference outside the file).
 */
export const exportElements = (src: ExportSource): NonDeletedExcalidrawElement[] =>
  withoutLinks(selectForExport(src.elements, src)) as NonDeletedExcalidrawElement[]

const pageOrigin = () => (globalThis as { location?: { origin?: string } }).location?.origin ?? ''

/** The same-origin path of a URL, or null (only same-origin bytes are ever read). */
function sameOrigin(url: string, origin: string): string | null {
  if (url.startsWith('/') && !url.startsWith('//')) return url
  try {
    const u = new URL(url)
    return u.origin === origin ? u.href : null
  } catch {
    return null
  }
}

async function blobToDataUrl(blob: Blob, mime: string): Promise<string> {
  const u8 = new Uint8Array(await blob.arrayBuffer())
  let bin = ''
  for (let i = 0; i < u8.length; i += 0x8000) bin += String.fromCharCode(...u8.subarray(i, i + 0x8000))
  return `data:${mime};base64,${btoa(bin)}`
}

/**
 * The export-only files map: every image the export draws, as a `data:` URL. Runtime `blob:` URLs are
 * read (they are this page's own); a same-origin path is fetched; anything else is left out (Excalidraw
 * draws its placeholder for it, which is still a valid, self-contained SVG).
 */
export async function exportFilesMap(
  elements: readonly ExcalidrawElement[],
  files: BinaryFiles,
  opts: SvgExportOptions = {},
): Promise<{ files: BinaryFiles; embedded: string[] }> {
  const doFetch = opts.fetchImpl ?? ((u: string) => fetch(u, { credentials: 'same-origin' }))
  const origin = opts.origin ?? pageOrigin()
  const out: BinaryFiles = {}
  const embedded: string[] = []
  const ids = new Set<string>()
  for (const e of elements) if (e.type === 'image' && e.fileId) ids.add(e.fileId)
  for (const id of ids) {
    const f = files[id]
    if (!f) continue
    let dataURL: string | null = null
    if (f.dataURL.startsWith('data:')) dataURL = f.dataURL
    else {
      const url = f.dataURL.startsWith('blob:') ? f.dataURL : sameOrigin(f.dataURL, origin)
      if (!url) continue
      try {
        const res = await doFetch(url)
        if (!res.ok) continue
        dataURL = await blobToDataUrl(await res.blob(), f.mimeType)
      } catch {
        continue
      }
    }
    out[id] = { ...f, dataURL: dataURL as BinaryFileData['dataURL'] }
    embedded.push(id)
  }
  return { files: out, embedded }
}

/** The engine's registered faces for Lobby's families and their fallbacks, as plain data (fonts.ts). */
export function registeredFaces(): Map<number, FamilyInfo> {
  const out = new Map<number, FamilyInfo>()
  for (const [id, { metadata, fontFaces }] of Fonts.registered) {
    out.set(id, {
      local: !!metadata.local,
      faces: fontFaces.map(
        (f): FaceInfo => ({
          family: f.fontFace.family.replace(/^["']|["']$/g, ''),
          url: String(f.urls[0] ?? ''),
          unicodeRange: f.fontFace.unicodeRange === 'U+0-10FFFF' ? '' : f.fontFace.unicodeRange,
          weight: f.fontFace.weight,
          style: f.fontFace.style,
        }),
      ),
    })
  }
  return out
}

/** Excalidraw's fallback family ids for a family (Excalifont → Xiaolai for CJK; generic ones are not fonts). */
export const fallbackFamilies = (family: number): number[] =>
  getFontFamilyFallbacks(family)
    .map((name) => FONT_FAMILY_FALLBACKS[name as keyof typeof FONT_FAMILY_FALLBACKS])
    .filter((id): id is number => typeof id === 'number')

/** Lobby's `@font-face` rules for the exported text: the covering woff2 files as data: URLs. */
export async function fontFaceRules(
  elements: readonly ExcalidrawElement[],
  opts: SvgExportOptions & { registered?: ReadonlyMap<number, FamilyInfo> } = {},
): Promise<{ rules: string[]; urls: string[] }> {
  const doFetch = opts.fetchImpl ?? ((u: string) => fetch(u, { credentials: 'same-origin' }))
  const origin = opts.origin ?? pageOrigin()
  const faces = selectFaces(
    charsPerFamily(elements as unknown as Iterable<{ type: string }>),
    opts.registered ?? registeredFaces(),
    fallbackFamilies,
  )
  const rules: string[] = []
  const urls: string[] = []
  for (const face of faces) {
    const url = sameOrigin(face.url, origin)
    if (!url) continue // never a foreign font (the host rewrite makes every fallback same-origin)
    try {
      const res = await doFetch(url)
      if (!res.ok) continue
      rules.push(fontFaceRule(face, woff2DataUrl(await res.arrayBuffer())))
      urls.push(face.url)
    } catch {
      // a font that cannot be read leaves that text to the viewer's fonts
    }
  }
  return { rules, urls }
}

/** The board (or `only`) as a standalone SVG. */
export async function exportBoardSvg(
  src: ExportSource,
  opts: SvgExportOptions = {},
): Promise<SvgExportResult> {
  const elements = exportElements(src)
  const { files, embedded } = await exportFilesMap(elements, src.files, opts)
  const svg = await exportToSvg({
    elements,
    appState: { ...src.appState, exportEmbedScene: false, exportBackground: true },
    files,
    skipInliningFonts: true,
    exportPadding: opts.exportPadding ?? 16,
  })
  const { rules, urls } = await fontFaceRules(elements, opts)
  const doc = svg.ownerDocument
  let style = svg.querySelector('style.style-fonts')
  if (!style) {
    style = doc.createElementNS('http://www.w3.org/2000/svg', 'style')
    style.classList.add('style-fonts')
    ;(svg.querySelector('defs') ?? svg).appendChild(style)
  }
  style.textContent = `\n${rules.join('\n')}\n`
  const text = new XMLSerializer().serializeToString(svg)
  const problems = selfContainedProblems(text)
  if (problems.length) throw new Error(`the exported SVG is not self-contained: ${problems.join(', ')}`)
  return { svg, text, embeddedFiles: embedded, embeddedFonts: urls, bytes: new Blob([text]).size }
}

/** The board (or `only`) as a PNG, drawn from the runtime files map (same-origin blob: URLs). */
export async function exportBoardPng(
  src: ExportSource,
  opts: { exportPadding?: number } = {},
): Promise<Blob> {
  const elements = exportElements(src)
  return exportToBlob({
    elements,
    appState: { ...src.appState, exportEmbedScene: false, exportBackground: true },
    files: src.files,
    mimeType: 'image/png',
    exportPadding: opts.exportPadding ?? 16,
  })
}
