// A stored object as the backup reader's RangeSource (wave R, WS4; docs/WAVE-R-CONTRACTS.md §5): a restore spools the
// upload to the blob store (R2 on Render: its /tmp is small and shared) and reads it back by range GETs, so a 2 GiB
// backup is read without a disk and with one chunk in memory. A GET that answers fewer bytes than asked fails.

import type { RangeSource } from '@draftroom/board-archive'
import type { BlobStore } from '../../files/blobs.ts'

async function collect(body: NodeJS.ReadableStream, max: number): Promise<Buffer> {
  const parts: Buffer[] = []
  let n = 0
  for await (const chunk of body as AsyncIterable<Buffer>) {
    n += chunk.length
    if (n > max) {
      ;(body as { destroy?: () => void }).destroy?.()
      throw new Error('the store answered more bytes than asked')
    }
    parts.push(chunk)
  }
  return Buffer.concat(parts)
}

/** `key` (which must exist, `size` bytes long) as a RangeSource. */
export function blobRangeSource(blobs: BlobStore, key: string, size: number): RangeSource {
  const open = async (start: number, length: number) => {
    const obj = await blobs.get(key, { range: { start, end: start + length - 1 } })
    if (!obj) throw new Error('the spooled backup is gone')
    return obj.body
  }
  return {
    size,
    async read(start, length) {
      if (length === 0) return Buffer.alloc(0)
      if (start < 0 || start + length > size) throw new Error('a read past the end of the backup')
      const out = await collect(await open(start, length), length)
      if (out.length !== length) throw new Error('the store answered fewer bytes than asked')
      return out
    },
    async *stream(start, length) {
      const n = Math.min(length, size - start)
      if (n <= 0) return
      const body = await open(start, n)
      try {
        for await (const chunk of body as AsyncIterable<Buffer>) yield chunk
      } finally {
        ;(body as { destroy?: () => void }).destroy?.()
      }
    },
  }
}
