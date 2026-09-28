import { formatBytes } from '../lib/format.ts'
import { type AssetKind, classifyUpload, maxUploadBytes } from './contract.ts'

/**
 * Image types that become native tldraw image shapes. It is the intersection of what tldraw's image
 * asset util decodes and what the preview worker accepts. SVG is deliberately absent: untrusted SVG is
 * never rendered inline (it becomes an attachment card, contract §6).
 */
export const NATIVE_IMAGE_MIME_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'] as const
const NATIVE_IMAGES = new Set<string>(NATIVE_IMAGE_MIME_TYPES)

export interface CardFile {
  file: File
  kind: AssetKind
}
export interface Partitioned {
  images: File[]
  cards: CardFile[]
  rejected: { file: File; reason: string }[]
}

export function partitionFiles(files: readonly File[]): Partitioned {
  const out: Partitioned = { images: [], cards: [], rejected: [] }
  for (const file of files) {
    const kind = classifyUpload(file.type, file.name)
    const limit = maxUploadBytes(kind, file.type, file.name)
    // Checked here, before anything reaches tldraw: its own maxAssetSize toast does not say which
    // file was too large, and a drop of several files needs that.
    if (kind === 'image' && NATIVE_IMAGES.has(file.type.toLowerCase())) {
      if (file.size > limit) {
        out.rejected.push({ file, reason: `is larger than ${formatBytes(limit)}, the limit for images` })
      } else {
        out.images.push(file)
      }
    } else if (file.size > limit) {
      out.rejected.push({ file, reason: `is larger than the ${formatBytes(limit)} limit for this file type` })
    } else {
      // Includes images without a usable MIME type: tldraw cannot decode those, but they are still files.
      out.cards.push({ file, kind })
    }
  }
  return out
}
