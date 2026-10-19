// Wave W, WS2 (docs/WAVE-W-CONTRACTS.md §4.1 step 2): the background-removal child. OWNER: WS2.
// `node --max-old-space-size=256 bg-child.ts`, a BgChildRequest (ops/remove-bg.ts) on stdin, ONE BgChildResponse on
// stdout, then exit. The parent (remove-bg.ts) holds the SIGKILL timer, caps stdout, gives this process the minimal
// environment (run.ts childEnv) and re-checks the PNG written here.
//
//   1. the header (sharp, the loader allowlist of image.ts): JPEG, PNG or WebP only; an animation is refused (a GIF is
//      not an input type at all); at most maxInputPixels and maxInputEdge after EXIF orientation;
//   2. decoded once (failOn 'warning': a truncated or corrupt file fails), oriented, scaled down to a long edge of
//      maxOutputEdge, as RGBA (an input with alpha keeps it: the result is the smaller of the two);
//   3. the model's input: that picture resized to size² (Lanczos), scaled by its brightest value and normalised with the
//      ImageNet mean and deviation, NCHW float32 (U²-Net's preprocessing, as rembg does it);
//   4. the model, through ops/bg-inference.ts createOrtInference: the ONLY place a background model runs, in this child
//      only. Its bytes come from bg-model.ts loadBgModel (the configured file, its sha256 re-checked here);
//   5. the mask min-max normalised (a flat mask, where nothing stands out, is refused as `empty`), resized to the output
//      (Lanczos) and applied as alpha; a PNG RGBA to `output`.
//
// Nothing but the answer goes to stdout (stdout is the protocol); errors are reported by class name, never by message.

import { fileURLToPath } from 'node:url'
import type { SharpOptions } from 'sharp'
import { lockedSharp } from '../image.ts'
import { createOrtInference } from './bg-inference.ts'
import { loadBgModel } from './bg-model.ts'
import type { BgChildRequest, BgChildResponse } from './remove-bg.ts'

const toStderr = (...a: unknown[]) => process.stderr.write(`${a.map(String).join(' ')}\n`)
console.log = toStderr
console.info = toStderr
console.warn = toStderr
console.debug = toStderr

/** U²-Net's normalisation (ImageNet), per channel R, G, B. */
const MEAN = [0.485, 0.456, 0.406] as const
const STD = [0.229, 0.224, 0.225] as const
const INPUT_FORMATS = new Set(['jpeg', 'png', 'webp'])

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = []
  for await (const c of process.stdin) chunks.push(c as Buffer)
  return Buffer.concat(chunks).toString('utf8')
}

/** The model's NCHW float32 input from an RGB buffer of size × size pixels. */
export function toTensor(rgb: Uint8Array, size: number): Float32Array {
  const plane = size * size
  let max = 0
  for (let i = 0; i < rgb.length; i++) if ((rgb[i] as number) > max) max = rgb[i] as number
  const scale = 1 / Math.max(max, 1e-6)
  const out = new Float32Array(3 * plane)
  for (let p = 0; p < plane; p++) {
    for (let c = 0; c < 3; c++) {
      const v = (rgb[p * 3 + c] as number) * scale
      out[c * plane + p] = (v - (MEAN[c] as number)) / (STD[c] as number)
    }
  }
  return out
}

/** The mask min-max normalised to 0..255, or null when it is flat (nothing stands out from anything else). */
export function maskBytes(mask: Float32Array): Uint8Array | null {
  let lo = Number.POSITIVE_INFINITY
  let hi = Number.NEGATIVE_INFINITY
  for (const v of mask) {
    if (!Number.isFinite(v)) return null
    if (v < lo) lo = v
    if (v > hi) hi = v
  }
  if (!(hi - lo > 1e-6)) return null
  const out = new Uint8Array(mask.length)
  const k = 255 / (hi - lo)
  for (let i = 0; i < mask.length; i++) out[i] = Math.round(((mask[i] as number) - lo) * k)
  return out
}

/** Alpha = min(the picture's own alpha, the mask); returns the share of pixels left at least half opaque. */
export function applyMask(rgba: Uint8Array, mask: Uint8Array): number {
  let kept = 0
  for (let p = 0, a = 3; p < mask.length; p++, a += 4) {
    const m = mask[p] as number
    const own = rgba[a] as number
    const alpha = m < own ? m : own
    rgba[a] = alpha
    if (alpha >= 128) kept++
  }
  return mask.length ? kept / mask.length : 0
}

function sharpFailure(e: unknown): BgChildResponse {
  const msg = String((e as Error)?.message ?? '')
  if (/pixel limit/i.test(msg)) return { ok: false, reason: 'too_large', name: 'PixelLimit' }
  return { ok: false, reason: 'invalid', name: String((e as Error)?.name ?? 'Error') }
}

export async function removeBackground(req: BgChildRequest): Promise<BgChildResponse> {
  const t0 = performance.now()
  const sharp = lockedSharp()
  const INPUT: SharpOptions = { limitInputPixels: req.maxInputPixels, failOn: 'warning', animated: false }
  let width: number
  let height: number
  try {
    const meta = await sharp(req.input, INPUT).metadata()
    if (!INPUT_FORMATS.has(meta.format)) return { ok: false, reason: 'unsupported', name: 'Format' }
    if ((meta.pages ?? 1) > 1) return { ok: false, reason: 'animated', name: 'Animated' }
    width = meta.autoOrient.width
    height = meta.autoOrient.height
  } catch (e) {
    return sharpFailure(e)
  }
  if (!(width > 0 && height > 0)) return { ok: false, reason: 'invalid', name: 'BadSize' }
  if (width * height > req.maxInputPixels || Math.max(width, height) > req.maxInputEdge)
    return { ok: false, reason: 'too_large', name: 'Edge' }
  const scale = Math.min(1, req.maxOutputEdge / Math.max(width, height))
  const outW = Math.max(1, Math.min(req.maxOutputEdge, Math.round(width * scale)))
  const outH = Math.max(1, Math.min(req.maxOutputEdge, Math.round(height * scale)))

  let rgba: Buffer
  let small: Buffer
  try {
    rgba = await sharp(req.input, { ...INPUT, autoOrient: true })
      .resize(outW, outH, { fit: 'fill' })
      .ensureAlpha()
      .raw()
      .timeout({ seconds: req.sharpTimeoutSeconds })
      .toBuffer()
    if (rgba.length !== outW * outH * 4) return { ok: false, reason: 'invalid', name: 'Decode' }
    small = await sharp(rgba, { raw: { width: outW, height: outH, channels: 4 } })
      .removeAlpha()
      .resize(req.size, req.size, { fit: 'fill', kernel: 'lanczos3' })
      .raw()
      .timeout({ seconds: req.sharpTimeoutSeconds })
      .toBuffer()
  } catch (e) {
    return sharpFailure(e)
  }

  let mask: Float32Array
  const tm = performance.now()
  try {
    const model = loadBgModel(req.modelPath, req.modelSha256)
    const inference = await createOrtInference(model, { size: req.size })
    try {
      mask = await inference.run(toTensor(small, req.size))
    } finally {
      await inference.close()
    }
  } catch (e) {
    return { ok: false, reason: 'model', name: String((e as Error)?.name ?? 'Error') }
  }
  const modelMs = Math.round(performance.now() - tm)
  const grey = maskBytes(mask)
  if (!grey) return { ok: false, reason: 'empty', name: 'FlatMask' }

  let coverage: number
  try {
    const big = await sharp(grey, { raw: { width: req.size, height: req.size, channels: 1 } })
      .resize(outW, outH, { fit: 'fill', kernel: 'lanczos3' })
      .extractChannel(0) // one band out, whatever colour interpretation libvips gave the grey plane
      .raw()
      .timeout({ seconds: req.sharpTimeoutSeconds })
      .toBuffer()
    if (big.length !== outW * outH) return { ok: false, reason: 'invalid', name: 'Mask' }
    coverage = applyMask(rgba, big)
    await sharp(rgba, { raw: { width: outW, height: outH, channels: 4 } })
      .png({ compressionLevel: 6 })
      .timeout({ seconds: req.sharpTimeoutSeconds })
      .toFile(req.output)
  } catch (e) {
    return sharpFailure(e)
  }
  return {
    ok: true,
    width: outW,
    height: outH,
    coverage: Math.round(coverage * 10_000) / 10_000,
    ms: { model: modelMs, total: Math.round(performance.now() - t0) },
  }
}

// Run as the child (the parent spawns this file); imported by a test, it only exports.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  let res: BgChildResponse
  try {
    res = await removeBackground(JSON.parse(await readStdin()) as BgChildRequest)
  } catch (e) {
    res = { ok: false, reason: 'invalid', name: String((e as Error)?.name ?? 'Error') }
  }
  // exit once the answer is flushed: a leftover native handle must not keep the child alive until the parent's SIGKILL
  process.stdout.write(JSON.stringify(res), () => process.exit(0))
}
