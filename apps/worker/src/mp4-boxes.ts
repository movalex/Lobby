// Top-level ISO-BMFF box scan: reads box headers only, never decodes media. A faststart MP4 cut
// short still passes ffprobe and poster extraction (verified in research), but its last top-level
// box then claims bytes past EOF, which this scan detects.
import { open } from 'node:fs/promises'

export interface BoxScan {
  fileSize: number
  types: string[]
  /** 'moov' precedes 'mdat', so playback can start without fetching the file tail. */
  faststart: boolean
  /** A box claims bytes past EOF (or a header is cut off). */
  truncated: boolean
  /** A box header is impossible (size < 8): not an MP4 at all, or corrupt. */
  corrupt: boolean
  /** Scanning stopped at maxBoxes before EOF, so `truncated` only covers the boxes seen. */
  partial: boolean
}

export async function scanTopLevelBoxes(file: string, maxBoxes = 4096): Promise<BoxScan> {
  const fh = await open(file, 'r')
  try {
    const { size: fileSize } = await fh.stat()
    const types: string[] = []
    const hdr = Buffer.alloc(16)
    let pos = 0
    let truncated = false
    let corrupt = false
    while (pos < fileSize && types.length < maxBoxes) {
      const { bytesRead } = await fh.read(hdr, 0, 16, pos)
      if (bytesRead < 8) {
        truncated = true
        break
      }
      let size = hdr.readUInt32BE(0)
      const type = hdr.toString('latin1', 4, 8)
      if (size === 1) {
        if (bytesRead < 16) {
          truncated = true
          break
        }
        size = Number(hdr.readBigUInt64BE(8)) // 64-bit largesize
      } else if (size === 0) {
        size = fileSize - pos // box runs to EOF
      }
      if (size < 8) {
        corrupt = true
        break
      }
      types.push(type)
      if (pos + size > fileSize) truncated = true
      pos += size
    }
    const moov = types.indexOf('moov')
    const mdat = types.indexOf('mdat')
    return {
      fileSize,
      types,
      faststart: moov !== -1 && (mdat === -1 || moov < mdat),
      truncated,
      corrupt,
      partial: pos < fileSize && !truncated && !corrupt,
    }
  } finally {
    await fh.close()
  }
}
