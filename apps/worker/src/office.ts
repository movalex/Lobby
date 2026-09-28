// Office documents (DOCX, PPTX, XLSX, ODT, ODP, ODS): checked by content, converted to PDF by LibreOffice,
// then previewed by the existing PDF page pipeline (pdf.ts). The upload is kind 'pdf' (dev-assets
// classifyUpload), so the card, the page viewer and every PDF limit apply unchanged; the confirmed MIME
// type (the Office one) tells the card that the pages come from a conversion.
//
// The conversion sits behind OfficeConverter so it can run where it is safest:
//   - 'socket': the office sidecar (office-sidecar.ts), a container of the same image with no network,
//     no secrets and its own memory cap, reached over a Unix socket in a volume both share. Production.
//   - 'local': soffice as a child of the worker (soffice.ts). Development and tests only: it shares the
//     worker's network and user, so env.ts refuses it when NODE_ENV=production.
//   - 'off': every Office document fails with OFFICE_UNAVAILABLE, and stays downloadable.
import { stat } from 'node:fs/promises'
import { LIMITS, type OfficeExt, type OfficeFormat, officeFormatByMime } from '@draftroom/dev-assets'
import type { DerivativeWriter } from './derivatives.ts'
import { PreviewError, throwIfAborted } from './errors.ts'
import type { Derived } from './image.ts'
import {
  cfbDirectoryNames,
  checkInflatedSizes,
  readZipDirectory,
  readZipEntry,
  ZipFormatError,
} from './office-zip.ts'
import { derivePdf } from './pdf.ts'
import type { Sniffed } from './sniff.ts'
import { convertWithSoffice } from './soffice.ts'

export interface ConvertOptions {
  timeoutMs: number
  signal?: AbortSignal
}

export interface OfficeConverter {
  /** For the worker's startup log line (never a secret). */
  readonly describe: string
  /** Converts `input` to a PDF inside `outDir` and returns its path. Throws PreviewError, TransientError or AbortedError. */
  convert(input: string, format: OfficeFormat, outDir: string, o: ConvertOptions): Promise<string>
}

export function officeOff(reason = 'off'): OfficeConverter {
  return {
    describe: reason,
    async convert() {
      throw new PreviewError('OFFICE_UNAVAILABLE', 'office previews are off on this worker')
    },
  }
}

/** A Node stand-in (the tests' fake soffice) runs with this Node; anything else is an executable. */
export function sofficeCommand(path: string | undefined): string[] {
  const p = path?.trim() || 'soffice'
  return /\.(?:[cm]?js|[cm]?ts)$/i.test(p) ? [process.execPath, p] : [p]
}

/** soffice as a child of this process (development and tests; see the header). */
export function localOfficeConverter(o: { command: string[]; workRoot: string }): OfficeConverter {
  return {
    describe: 'local LibreOffice (development only: not isolated from the worker)',
    convert: (input, format, outDir, c) =>
      convertWithSoffice(input, format.ext, outDir, {
        command: o.command,
        workRoot: o.workRoot,
        timeoutMs: c.timeoutMs,
        maxOutputBytes: LIMITS.maxBytes.pdf,
        signal: c.signal,
      }),
  }
}

const ODF = new Set<OfficeExt>(['odt', 'odp', 'ods'])
const MANIFEST_MAX_BYTES = 1024 * 1024
/** OOXML parts that only macro-enabled packages have: a VBA project, Excel 4.0 macro sheets. */
const MACRO_PART_RE = /(?:^|\/)(?:vbaProject\.bin$|macrosheets\/)/i
/** Content types of those parts and of the macro-enabled main parts (…macroEnabled.main+xml). */
const MACRO_TYPE_RE = /macroEnabled|vbaProject|macrosheet/i

/**
 * Refuses, before any conversion, what LibreOffice should never be asked to open: a broken or
 * truncated ZIP, a zip bomb (declared uncompressed size or entry count over the caps, or an entry that
 * inflates past its declared size), encrypted entries or an encrypted ODF package, a package missing
 * the parts every document of its family has, and an OOXML package with macros (as the central
 * directory lists it, whatever the sniffer saw).
 */
export async function checkOfficeContainer(path: string, format: OfficeFormat): Promise<void> {
  let entries: Awaited<ReturnType<typeof readZipDirectory>>
  try {
    entries = await readZipDirectory(path, LIMITS.officeMaxZipEntries)
  } catch (e) {
    if (e instanceof ZipFormatError && e.kind === 'limit') throw new PreviewError('FILE_TOO_LARGE', e.message)
    throw new PreviewError('OFFICE_INVALID', e instanceof ZipFormatError ? e.message : 'unreadable ZIP')
  }
  const declared = entries.reduce((sum, e) => sum + e.size, 0)
  if (declared > LIMITS.officeMaxUnzippedBytes) {
    throw new PreviewError('FILE_TOO_LARGE', `declares ${declared} bytes uncompressed`)
  }
  if (entries.some((e) => (e.flags & 1) === 1))
    throw new PreviewError('OFFICE_ENCRYPTED', 'ZIP-encrypted entries')
  const byName = new Map(entries.map((e) => [e.name, e]))
  const required = ODF.has(format.ext)
    ? ['mimetype', 'content.xml', 'META-INF/manifest.xml']
    : ['[Content_Types].xml', '_rels/.rels']
  for (const part of required) {
    if (!byName.has(part)) throw new PreviewError('OFFICE_INVALID', `missing ${part}`)
  }
  if (!ODF.has(format.ext)) {
    // Macro-enabled packages stay attachments. The sniffer (file-type) walks local headers and can be
    // shown a decoy [Content_Types].xml; LibreOffice reads the central directory, and so does this.
    if (entries.some((e) => MACRO_PART_RE.test(e.name)))
      throw new PreviewError('TYPE_MISMATCH', 'macro-enabled package (VBA or macro sheet part)')
    const types = byName.get('[Content_Types].xml')
    let xml = ''
    try {
      if (types) xml = (await readZipEntry(path, types, MANIFEST_MAX_BYTES)).toString('utf8')
    } catch (e) {
      throw new PreviewError(
        'OFFICE_INVALID',
        `content types: ${e instanceof ZipFormatError ? e.message : 'unreadable'}`,
      )
    }
    if (MACRO_TYPE_RE.test(xml))
      throw new PreviewError('TYPE_MISMATCH', 'macro-enabled package (content types)')
  }
  if (ODF.has(format.ext)) {
    const manifest = byName.get('META-INF/manifest.xml')
    if (!manifest) throw new PreviewError('OFFICE_INVALID', 'missing manifest')
    let xml: string
    try {
      xml = (await readZipEntry(path, manifest, MANIFEST_MAX_BYTES)).toString('utf8')
    } catch (e) {
      throw new PreviewError(
        'OFFICE_INVALID',
        `manifest: ${e instanceof ZipFormatError ? e.message : 'unreadable'}`,
      )
    }
    // A password-protected ODF file lists how each part is encrypted.
    if (xml.includes('encryption-data')) throw new PreviewError('OFFICE_ENCRYPTED', 'encrypted ODF package')
  }
  // Last, as it reads the whole file: the declared sizes checked above must be the real ones.
  try {
    await checkInflatedSizes(path, entries)
  } catch (e) {
    if (e instanceof ZipFormatError && e.kind === 'limit') throw new PreviewError('FILE_TOO_LARGE', e.message)
    throw new PreviewError('OFFICE_INVALID', e instanceof ZipFormatError ? e.message : 'unreadable ZIP')
  }
}

/**
 * The Office format of an upload of kind 'pdf', decided by its content: one of OFFICE_FORMATS (checked
 * by checkOfficeContainer), or null for anything else (a real PDF, or content that confirmKind() then
 * reports as a type mismatch). A password-protected OOXML file is an MS-CFB container with an
 * EncryptedPackage stream: that is reported as such rather than as a mismatch.
 */
export async function officeInput(path: string, sniffed: Sniffed): Promise<OfficeFormat | null> {
  const format = officeFormatByMime(sniffed.mime)
  if (format) {
    await checkOfficeContainer(path, format)
    return format
  }
  if (sniffed.mime === 'application/x-cfb') {
    let names: string[] = []
    try {
      names = await cfbDirectoryNames(path)
    } catch {}
    if (names.includes('EncryptedPackage') || names.includes('EncryptionInfo')) {
      throw new PreviewError('OFFICE_ENCRYPTED', 'encrypted OOXML package')
    }
  }
  return null
}

export interface OfficeDeriveOptions {
  office?: OfficeConverter
  officeTimeoutMs?: number
  pdfTimeoutMs?: number
  pdfChildPath?: string
  pdfHeapMb?: number
  signal?: AbortSignal
}

/** The PDF pipeline's failures, worded for the Office document the user uploaded. */
function asOfficeFailure(e: PreviewError): PreviewError {
  switch (e.code) {
    case 'PDF_TOO_MANY_PAGES':
      return new PreviewError('OFFICE_TOO_MANY_PAGES', e.detail, e.probe)
    case 'PDF_INVALID':
    case 'PDF_ENCRYPTED':
      return new PreviewError('OFFICE_INVALID', `converted PDF: ${e.detail}`, e.probe)
    default:
      return e
  }
}

/** Converts, then renders the converted PDF's pages exactly like an uploaded PDF (cover thumb + eager pages). */
export async function deriveOffice(
  input: string,
  format: OfficeFormat,
  writer: DerivativeWriter,
  o: OfficeDeriveOptions = {},
): Promise<Derived> {
  const size = (await stat(input)).size
  if (size > LIMITS.maxOfficeBytes) throw new PreviewError('FILE_TOO_LARGE', `${size} bytes`)
  throwIfAborted(o.signal)
  const outDir = await writer.makeTempDir()
  const converter = o.office ?? officeOff()
  const pdf = await converter.convert(input, format, outDir, {
    timeoutMs: o.officeTimeoutMs ?? LIMITS.officeConvertTimeoutMs,
    signal: o.signal,
  })
  throwIfAborted(o.signal)
  try {
    return await derivePdf(pdf, writer, {
      timeoutMs: o.pdfTimeoutMs,
      childPath: o.pdfChildPath,
      heapMb: o.pdfHeapMb,
      signal: o.signal,
    })
  } catch (e) {
    throw e instanceof PreviewError ? asOfficeFailure(e) : e
  }
}
