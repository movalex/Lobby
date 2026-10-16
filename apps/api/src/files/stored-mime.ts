// Wave T (WS3): the type an original is stored and served with, decided once its bytes are in the blob store. One
// rule for every path that stores an original (an upload, a backup restore, a Miro import's files): everything but an
// attachment claiming one of the four audio types is mime.ts `initialServedMime`, decided without the bytes; such a
// claim (by its declared type or its extension) is checked against the stored file's first AUDIO_SNIFF_BYTES bytes
// (one ranged read of the blob just written: the worker never looks at an attachment), and a file whose bytes
// disagree (an HTML page named `.mp3`) is an octet-stream attachment (`uploadServedMime`), never served inline.
import type { AssetKind } from '@draftroom/dev-assets'
import type { BlobStore } from './blobs.ts'
import { AUDIO_SNIFF_BYTES, initialServedMime, uploadServedMime } from './mime.ts'

export async function storedServedMime(
  blobs: Pick<BlobStore, 'get'>,
  key: string,
  bytes: number,
  kind: AssetKind,
  declared: string,
  name: string,
): Promise<string> {
  const claimed = initialServedMime(kind, declared, name)
  if (kind !== 'other' || claimed === 'application/octet-stream') return claimed
  if (bytes === 0) return 'application/octet-stream'
  const end = Math.min(bytes, AUDIO_SNIFF_BYTES) - 1
  const obj = await blobs.get(key, { range: { start: 0, end } })
  if (!obj) throw new Error('the stored original could not be read back')
  const chunks: Buffer[] = []
  for await (const c of obj.body as AsyncIterable<Buffer | string>)
    chunks.push(typeof c === 'string' ? Buffer.from(c) : Buffer.from(c))
  return uploadServedMime(kind, declared, name, new Uint8Array(Buffer.concat(chunks)))
}
