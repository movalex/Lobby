// Isolated Photoshop reader (wave R): `node --max-old-space-size=<n> psd-child.ts`, request JSON on stdin. It runs in
// its own process because ag-psd parses hostile bytes on the calling thread and a 40 MP composite is 160 MB of RGBA;
// the parent enforces a SIGKILL timeout and a heap cap. Only the flattened composite (or, without one, the embedded
// thumbnail) is ever decoded: compactPsd (psd-protocol.ts) strips the layers and every other resource first.
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import agPsd from 'ag-psd'
import { lockedSharp } from './image.ts'
import { compactPsd, type PsdChildRequest, type PsdChildResponse, psdPageFileName } from './psd-protocol.ts'

// stdout is reserved for the single JSON response.
const toStderr = (...a: unknown[]) => process.stderr.write(`${a.map(String).join(' ')}\n`)
console.log = toStderr
console.info = toStderr
console.warn = toStderr
console.debug = toStderr

// No canvas in Node: ag-psd's 8-bit RGBA buffers are plain typed arrays (useImageData), never a canvas.
agPsd.initializeCanvas(
  (() => {
    throw new Error('no canvas in the PSD child')
  }) as never,
  ((width: number, height: number) => ({
    width,
    height,
    data: new Uint8ClampedArray(width * height * 4),
  })) as never,
)

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = []
  for await (const c of process.stdin) chunks.push(c as Buffer)
  return Buffer.concat(chunks).toString('utf8')
}

const errorName = (e: unknown) => String((e as Error)?.name ?? 'Error')

async function read(req: PsdChildRequest): Promise<PsdChildResponse> {
  const buf = await readFile(req.input)
  const compacted = compactPsd(buf, req)
  if (!compacted.ok) return { ok: false, reason: compacted.reason, detail: compacted.detail }
  const { layout, length } = compacted.value
  const { width, height } = layout.header
  const psd = buf.subarray(0, length)
  const sharp = lockedSharp()
  const out = join(req.outDir, psdPageFileName)
  const options = {
    skipLayerImageData: true,
    skipLinkedFilesData: true,
    useImageData: true,
    useRawThumbnail: true,
    throwForMissingFeatures: false,
    logMissingFeatures: false,
    // the composite's RGBA and nothing else
    totalMemoryLimit: req.maxPixels * 4 + 16 * 1024 * 1024,
  }

  if (layout.hasRealMergedData === false) {
    // Saved without "Maximize Compatibility": the composite is blank. The embedded JPEG thumbnail is all there is.
    let thumb: { width: number; height: number; data: Uint8Array } | undefined
    try {
      const doc = agPsd.readPsd(psd, { ...options, skipCompositeImageData: true, skipThumbnail: false })
      thumb = doc.imageResources?.thumbnailRaw
    } catch (e) {
      return { ok: false, reason: 'invalid', detail: `thumbnail: ${errorName(e)}` }
    }
    if (!thumb?.data?.length) {
      return { ok: false, reason: 'no_composite', detail: 'no composite, no thumbnail' }
    }
    try {
      const webp = await sharp(Buffer.from(thumb.data), {
        limitInputPixels: 1_000_000,
        failOn: 'error',
      })
        .flatten({ background: '#ffffff' })
        .webp({ quality: req.quality })
        .timeout({ seconds: 10 })
        .toBuffer()
      await writeFile(out, webp)
    } catch (e) {
      return { ok: false, reason: 'no_composite', detail: `thumbnail decode: ${errorName(e)}` }
    }
    return { ok: true, composite: false, width, height }
  }

  let image: { width: number; height: number; data: Uint8ClampedArray } | undefined
  try {
    const doc = agPsd.readPsd(psd, { ...options, skipCompositeImageData: false, skipThumbnail: true })
    image = doc.imageData as typeof image
  } catch (e) {
    return { ok: false, reason: 'invalid', detail: `composite: ${errorName(e)}` }
  }
  const expected = width * height * 4
  if (!image || image.width !== width || image.height !== height || image.data.length !== expected) {
    return { ok: false, reason: 'invalid', detail: 'composite size' }
  }
  try {
    const webp = await sharp(image.data, {
      raw: { width, height, channels: 4 },
      limitInputPixels: req.maxPixels,
    })
      .flatten({ background: '#ffffff' })
      .resize({ width: req.maxEdge, height: req.maxEdge, fit: 'inside', withoutEnlargement: true })
      .webp({ quality: req.quality })
      .timeout({ seconds: 20 })
      .toBuffer()
    await writeFile(out, webp)
  } catch (e) {
    return { ok: false, reason: 'invalid', detail: `encode: ${errorName(e)}` }
  }
  return { ok: true, composite: true, width, height }
}

const req = JSON.parse(await readStdin()) as PsdChildRequest
let res: PsdChildResponse
try {
  res = await read(req)
} catch (e) {
  res = { ok: false, reason: 'invalid', detail: errorName(e) }
}
process.stdout.write(JSON.stringify(res), () => process.exit(0))
