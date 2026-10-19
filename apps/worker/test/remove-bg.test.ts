// Wave W, WS2 (docs/WAVE-W-CONTRACTS.md §4.4): background removal on the worker, never with the real model. The child
// (ops/bg-child.ts) runs a tiny synthetic model encoded in the test (test/tiny-onnx.ts: sigmoid of the mean of the
// three channels, the u2netp shape), so a bright subject on a dark background is kept and the background goes clear.
// Checked: alpha present and the mask non-empty on fixtures; deterministic within a tolerance; the output scaled to a
// long edge of 4,096; a decompression bomb, a truncated PNG, an animated image, a GIF and a flat mask refused with the
// right codes; the 45 s kill (shortened here); a V8 heap out of memory gives REMOVE_BG_FAILED and the worker lives on;
// the model's hash re-checked in the child; and the ORT session is only ever created by the child.

import { createHash } from 'node:crypto'
import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { crc32 } from 'node:zlib'
import { REMOVE_BG_LIMITS, RemoveBgResult, WORKER_CAPABILITIES } from '@draftroom/contracts'
import sharp from 'sharp'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { type WorkerApi, WorkerApiError } from '../src/api-client.ts'
import { applyMask, maskBytes, removeBackground, toTensor } from '../src/ops/bg-child.ts'
import { parseWorkerOps, reportedCapabilities } from '../src/ops/capabilities.ts'
import type { ClaimedOp, OpLease, WorkerOpsApi } from '../src/ops/client.ts'
import { OP_RUNNERS, OpFailure } from '../src/ops/dispatch.ts'
import { runClaimedOp } from '../src/ops/loop.ts'
import {
  type BgChildRequest,
  checkedPng,
  childFailureCode,
  createRemoveBgRunner,
  removeBgRunner,
} from '../src/ops/remove-bg.ts'
import { cleanupRoots, tmpRoot } from './remote-helpers.ts'
import { tinyMaskModel } from './tiny-onnx.ts'

afterAll(cleanupRoots)

const SIZE = REMOVE_BG_LIMITS.modelSize

// ---- fixtures -----------------------------------------------------------------------------------------------------

/** A dark picture with a bright rectangle in its middle half (the "subject"). */
async function subject(width: number, height: number, format: 'png' | 'jpeg' | 'webp'): Promise<Buffer> {
  const inner = await sharp({
    create: {
      width: Math.round(width / 2),
      height: Math.round(height / 2),
      channels: 3,
      background: '#f4f4f4',
    },
  })
    .png()
    .toBuffer()
  const img = sharp({ create: { width, height, channels: 3, background: '#101010' } }).composite([
    { input: inner, left: Math.round(width / 4), top: Math.round(height / 4) },
  ])
  return format === 'png'
    ? img.png().toBuffer()
    : format === 'jpeg'
      ? img.jpeg().toBuffer()
      : img.webp().toBuffer()
}

/** A two-frame animated WebP. */
async function animatedWebp(): Promise<Buffer> {
  const frame = (background: string) =>
    sharp({ create: { width: 16, height: 16, channels: 4, background } })
      .png()
      .toBuffer()
  return sharp([await frame('red'), await frame('blue')], { join: { animated: true } })
    .webp()
    .toBuffer()
}

/** A PNG whose header claims width x height, with no pixel data behind it (a decompression bomb's header). */
function bombPng(width: number, height: number): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4)
    len.writeUInt32BE(data.length)
    const td = Buffer.concat([Buffer.from(type, 'ascii'), data])
    const crc = Buffer.alloc(4)
    crc.writeUInt32BE(crc32(td))
    return Buffer.concat([len, td, crc])
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 2 // RGB
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', Buffer.from([0x78, 0x9c, 0x63, 0x00, 0x00])),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

let dir = ''
let modelPath = ''
let modelSha = ''
const req = (input: string, output: string, over: Partial<BgChildRequest> = {}): BgChildRequest => ({
  input,
  output,
  modelPath,
  modelSha256: modelSha,
  size: SIZE,
  maxInputPixels: REMOVE_BG_LIMITS.maxInputPixels,
  maxInputEdge: REMOVE_BG_LIMITS.maxInputEdge,
  maxOutputEdge: REMOVE_BG_LIMITS.maxOutputEdge,
  sharpTimeoutSeconds: 20,
  ...over,
})
const file = (name: string, bytes: Buffer) => {
  const p = join(dir, name)
  writeFileSync(p, bytes)
  return p
}

beforeAll(() => {
  dir = tmpRoot()
  const model = tinyMaskModel(SIZE)
  modelPath = join(dir, 'tiny-u2netp-shape.onnx')
  writeFileSync(modelPath, model)
  modelSha = createHash('sha256').update(model).digest('hex')
})

/** The alpha of pixel (x, y) of an RGBA PNG. */
async function alphaAt(png: Buffer, x: number, y: number): Promise<number> {
  const { data, info } = await sharp(png).raw().toBuffer({ resolveWithObject: true })
  return data[(y * info.width + x) * info.channels + 3] as number
}

// ---- the pieces -----------------------------------------------------------------------------------------------------

describe('the child’s pieces', () => {
  it('toTensor scales by the brightest value and normalises per channel, NCHW', () => {
    const two = toTensor(Uint8Array.from([255, 255, 255, 0, 0, 0, 255, 0, 0, 0, 0, 255]), 2)
    expect(two.length).toBe(12)
    // pixel 0, channel R: (1 - 0.485) / 0.229
    expect(two[0]).toBeCloseTo((1 - 0.485) / 0.229, 5)
    // pixel 1 (black), channel G (plane 1): (0 - 0.456) / 0.224
    expect(two[4 + 1]).toBeCloseTo(-0.456 / 0.224, 5)
  })

  it('maskBytes min-max normalises to 0..255, and refuses a flat or non-finite mask', () => {
    expect([...(maskBytes(Float32Array.from([0.2, 0.6, 1])) ?? [])]).toEqual([0, 128, 255])
    expect(maskBytes(Float32Array.from([0.5, 0.5, 0.5]))).toBeNull()
    expect(maskBytes(Float32Array.from([0.1, Number.NaN]))).toBeNull()
  })

  it('applyMask keeps the smaller of the picture’s alpha and the mask, and counts what stays', () => {
    const rgba = Uint8Array.from([1, 2, 3, 255, 1, 2, 3, 40, 1, 2, 3, 255])
    expect(applyMask(rgba, Uint8Array.from([200, 255, 10]))).toBeCloseTo(1 / 3, 5)
    expect([rgba[3], rgba[7], rgba[11]]).toEqual([200, 40, 10])
  })

  it('childFailureCode: each refusal as the code users see', () => {
    expect(childFailureCode('unsupported')).toBe('SOURCE_UNSUPPORTED')
    expect(childFailureCode('animated')).toBe('SOURCE_UNSUPPORTED')
    expect(childFailureCode('too_large')).toBe('IMAGE_TOO_LARGE')
    expect(childFailureCode('invalid')).toBe('REMOVE_BG_FAILED')
    expect(childFailureCode('empty')).toBe('REMOVE_BG_FAILED')
    expect(childFailureCode('model')).toBe('WORKER_UNAVAILABLE')
  })
})

// ---- the child's work (in this process, through its exported function) ---------------------------------------------

describe('removeBackground (the child’s work)', () => {
  it('PNG, JPEG and WebP: an RGBA PNG of the same size, the subject kept, the background clear', async () => {
    for (const format of ['png', 'jpeg', 'webp'] as const) {
      const input = file(`subject.${format}`, await subject(400, 300, format))
      const output = join(dir, `out-${format}.png`)
      const res = await removeBackground(req(input, output))
      expect(res, format).toMatchObject({ ok: true, width: 400, height: 300 })
      if (!res.ok) throw new Error('unreachable')
      // the subject is the middle quarter of the picture
      expect(res.coverage, format).toBeGreaterThan(0.15)
      expect(res.coverage, format).toBeLessThan(0.4)
      const png = readFileSync(output)
      const meta = await sharp(png).metadata()
      expect({ format: meta.format, channels: meta.channels, hasAlpha: meta.hasAlpha }).toEqual({
        format: 'png',
        channels: 4,
        hasAlpha: true,
      })
      expect(await alphaAt(png, 200, 150), `${format} centre`).toBeGreaterThan(220)
      expect(await alphaAt(png, 5, 5), `${format} corner`).toBeLessThan(30)
    }
  })

  it('is deterministic within a tolerance (two runs, the same alpha to within 1 per pixel)', async () => {
    const input = file('det.png', await subject(256, 256, 'png'))
    const a = join(dir, 'det-a.png')
    const b = join(dir, 'det-b.png')
    expect((await removeBackground(req(input, a))).ok).toBe(true)
    expect((await removeBackground(req(input, b))).ok).toBe(true)
    const ra = await sharp(readFileSync(a)).raw().toBuffer()
    const rb = await sharp(readFileSync(b)).raw().toBuffer()
    expect(ra.length).toBe(rb.length)
    let worst = 0
    for (let i = 3; i < ra.length; i += 4)
      worst = Math.max(worst, Math.abs((ra[i] as number) - (rb[i] as number)))
    expect(worst).toBeLessThanOrEqual(1)
  })

  it('scales a large picture down to a long edge of 4,096 (aspect kept)', async () => {
    const input = file('big.jpeg', await subject(6000, 3000, 'jpeg'))
    const res = await removeBackground(req(input, join(dir, 'big-out.png')))
    expect(res).toMatchObject({ ok: true, width: 4096, height: 2048 })
  })

  it('keeps alpha the picture already had: the result is the smaller of the two', async () => {
    const clear = await sharp({
      create: { width: 64, height: 64, channels: 4, background: { r: 250, g: 250, b: 250, alpha: 0 } },
    })
      .composite([
        {
          input: await sharp({ create: { width: 64, height: 32, channels: 4, background: '#101010ff' } })
            .png()
            .toBuffer(),
          left: 0,
          top: 32,
        },
      ])
      .png()
      .toBuffer()
    const output = join(dir, 'alpha-out.png')
    const res = await removeBackground(req(file('alpha.png', clear), output))
    expect(res.ok).toBe(true)
    // the top half was transparent already: it stays so even where the mask would keep it
    expect(await alphaAt(readFileSync(output), 32, 8)).toBe(0)
  })

  it('refuses a decompression bomb by its header (no pixel is decoded)', async () => {
    for (const [w, h] of [
      [30_000, 30_000],
      [7_000, 7_000], // 49 MP: over 40 MP, under 12,000 px
      [12_001, 100], // over the long edge, under the pixels
    ] as const) {
      const res = await removeBackground(req(file(`bomb-${w}x${h}.png`, bombPng(w, h)), join(dir, 'x.png')))
      expect(res, `${w}x${h}`).toMatchObject({ ok: false, reason: 'too_large' })
    }
  })

  it('refuses a truncated PNG, a GIF, an animated WebP, and something that is not an image', async () => {
    const whole = await subject(200, 200, 'png')
    const cases: [string, Buffer, string][] = [
      ['truncated.png', whole.subarray(0, Math.floor(whole.length / 2)), 'invalid'],
      [
        'still.gif',
        await sharp({ create: { width: 8, height: 8, channels: 3, background: 'red' } })
          .gif()
          .toBuffer(),
        'unsupported',
      ],
      ['anim.webp', await animatedWebp(), 'animated'],
      ['notes.txt', Buffer.from('not an image at all'), 'invalid'],
    ]
    for (const [name, bytes, reason] of cases) {
      const res = await removeBackground(req(file(name, bytes), join(dir, 'y.png')))
      expect(res, name).toMatchObject({ ok: false, reason })
    }
  })

  it('refuses a flat mask (nothing stands out) as empty', async () => {
    const flat = await sharp({ create: { width: 50, height: 50, channels: 3, background: '#808080' } })
      .png()
      .toBuffer()
    expect(await removeBackground(req(file('flat.png', flat), join(dir, 'z.png')))).toMatchObject({
      ok: false,
      reason: 'empty',
    })
  })

  it('re-checks the model file: another hash, an unpinned one or a missing file is a model failure', async () => {
    const input = file('m.png', await subject(64, 64, 'png'))
    for (const over of [
      { modelSha256: 'f'.repeat(64) },
      { modelSha256: null },
      { modelPath: join(dir, 'nope.onnx') },
    ])
      expect(await removeBackground(req(input, join(dir, 'm-out.png'), over))).toMatchObject({
        ok: false,
        reason: 'model',
      })
  })
})

// ---- the runner, end to end with a real child --------------------------------------------------------------------

const OP_ID = 'wop_0123456789abcdefghij'
const LEASE: OpLease = { opId: OP_ID, attempt: 1 }

/** A claim for `bytes`, served by `api.blobRequest` from memory; the PUT lands in `uploads`. */
function harness(bytes: Buffer, over: Partial<ClaimedOp['source']> = {}) {
  const uploads: Buffer[] = []
  const calls: string[] = []
  const realFetch = globalThis.fetch
  const op: ClaimedOp = {
    id: OP_ID,
    kind: 'remove-bg',
    capability: WORKER_CAPABILITIES['remove-bg'],
    boardId: 'b-0123456789',
    sourceVersionId: 'ver_0123456789abcdefghij',
    params: {},
    attempt: 1,
    leaseMs: 120_000,
    source: {
      kind: 'image',
      name: 'Key art.png',
      mimeType: 'image/png',
      sizeBytes: bytes.length,
      pageCount: null,
      ...over,
    },
    original: { url: 'mem://source', headers: {} },
  }
  const api = {
    blobRequest: (ref: { url: string }) => ({ url: ref.url, headers: {} }),
  } as unknown as WorkerApi
  const ops: WorkerOpsApi = {
    async claim() {
      return null
    },
    async heartbeat() {
      calls.push('heartbeat')
      return { leaseMs: 120_000 }
    },
    async output(_lease, draft) {
      calls.push(`output ${draft.role} ${draft.mimeType} ${draft.width}x${draft.height} ${draft.bytes}`)
      return {
        outputId: 'wpo_0123456789abcdefghij',
        upload: { url: 'mem://put', headers: {}, method: 'PUT' },
      }
    },
    async text() {
      calls.push('text')
    },
    async complete(_lease, outputs, result) {
      calls.push(`complete ${outputs.join(',')} ${JSON.stringify(result)}`)
    },
    async fail(_lease, code, opts) {
      calls.push(`fail ${code}${opts?.retry ? ' retry' : ''}`)
    },
  }
  const install = () => {
    globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
      const u = String(url)
      if (u === 'mem://source')
        return new Response(new Uint8Array(bytes), {
          status: 200,
          headers: { 'content-length': String(bytes.length) },
        })
      if (u === 'mem://put' && init?.method === 'PUT') {
        uploads.push(Buffer.from(init.body as Uint8Array))
        return new Response(null, { status: 200 })
      }
      return new Response(null, { status: 404 })
    }) as typeof fetch
  }
  const restore = () => {
    globalThis.fetch = realFetch
  }
  return { op, api, ops, uploads, calls, install, restore }
}

describe('the remove-bg runner (a real child process, the tiny model)', () => {
  const runner = () => createRemoveBgRunner({ modelPath: () => modelPath, modelSha256: modelSha })

  it('is registered in OP_RUNNERS, but the capability is reported only with a model that passes the pin', () => {
    expect(OP_RUNNERS['remove-bg']).toBe(removeBgRunner)
    // the shipped pin is null (the owner’s TODO): with any file the capability stays unreported
    const report = reportedCapabilities({
      enabled: parseWorkerOps(undefined),
      runners: OP_RUNNERS,
      bgModel: { ok: false, reason: 'unpinned' },
    })
    expect(report.capabilities).not.toContain(WORKER_CAPABILITIES['remove-bg'])
    expect(report.missing).toContainEqual({
      kind: 'remove-bg',
      why: 'the model file is not usable (unpinned)',
    })
  })

  it('downloads, runs the child, reserves one PNG original, uploads it and completes with its facts', async () => {
    const h = harness(await subject(480, 320, 'png'))
    h.install()
    try {
      const work = tmpRoot()
      const out = await runClaimedOp(h.op, {
        ops: h.ops,
        api: h.api,
        capabilities: [WORKER_CAPABILITIES['remove-bg']],
        runners: { 'remove-bg': runner() },
        tmpDir: work,
        signal: new AbortController().signal,
        log: () => {},
      })
      expect(out).toEqual({ kind: 'done', opId: OP_ID })
      expect(readdirSync(work)).toEqual([]) // the op's temp dir is gone
      expect(h.uploads).toHaveLength(1)
      const png = h.uploads[0] as Buffer
      expect(h.calls[0]).toBe(`output original image/png 480x320 ${png.length}`)
      const done = h.calls.at(-1) as string
      expect(done.startsWith('complete wpo_0123456789abcdefghij ')).toBe(true)
      const result = RemoveBgResult.parse(JSON.parse(done.slice(done.indexOf('{'))))
      expect(result).toEqual({
        sha256: createHash('sha256').update(png).digest('hex'),
        width: 480,
        height: 320,
        bytes: png.length,
      })
      expect(await alphaAt(png, 240, 160)).toBeGreaterThan(220)
      expect(await alphaAt(png, 3, 3)).toBeLessThan(30)
    } finally {
      h.restore()
    }
  })

  it('refuses what the api should never have sent (a PDF, a GIF, too many bytes) without downloading it', async () => {
    for (const [over, code] of [
      [{ kind: 'pdf' as const, mimeType: 'application/pdf' }, 'SOURCE_UNSUPPORTED'],
      [{ mimeType: 'image/gif' }, 'SOURCE_UNSUPPORTED'],
      [{ sizeBytes: REMOVE_BG_LIMITS.maxInputBytes + 1 }, 'IMAGE_TOO_LARGE'],
    ] as const) {
      const h = harness(Buffer.from('x'), over)
      const err = await runner()
        .run({
          op: h.op,
          lease: LEASE,
          ops: h.ops,
          api: h.api,
          tmpDir: tmpRoot(),
          signal: new AbortController().signal,
          log: () => {},
        })
        .catch((e: unknown) => e)
      expect(err).toBeInstanceOf(OpFailure)
      expect((err as OpFailure).code).toBe(code)
      expect(h.calls).toEqual([])
    }
  })

  it('no model path configured: WORKER_UNAVAILABLE (never a guess, never a download)', async () => {
    const h = harness(Buffer.from('x'))
    const err = await createRemoveBgRunner({ modelPath: () => undefined, modelSha256: modelSha })
      .run({
        op: h.op,
        lease: LEASE,
        ops: h.ops,
        api: h.api,
        tmpDir: tmpRoot(),
        signal: new AbortController().signal,
        log: () => {},
      })
      .catch((e: unknown) => e)
    expect((err as OpFailure).code).toBe('WORKER_UNAVAILABLE')
  })

  it('the child’s refusals end the op with their codes, nothing reserved: a bomb, a truncated PNG, an animation', async () => {
    const whole = await subject(200, 200, 'png')
    for (const [bytes, code] of [
      [bombPng(30_000, 30_000), 'IMAGE_TOO_LARGE'],
      [whole.subarray(0, whole.length >> 1), 'REMOVE_BG_FAILED'],
      [await animatedWebp(), 'SOURCE_UNSUPPORTED'],
    ] as const) {
      const h = harness(Buffer.from(bytes))
      h.install()
      try {
        const err = await runner()
          .run({
            op: h.op,
            lease: LEASE,
            ops: h.ops,
            api: h.api,
            tmpDir: tmpRoot(),
            signal: new AbortController().signal,
            log: () => {},
          })
          .catch((e: unknown) => e)
        expect((err as OpFailure).code).toBe(code)
        expect(h.calls).toEqual([])
      } finally {
        h.restore()
      }
    }
  })

  it('a child that hangs is killed at its time limit: TIMEOUT', async () => {
    const h = harness(await subject(32, 32, 'png'))
    h.install()
    try {
      const t0 = Date.now()
      const err = await createRemoveBgRunner({
        modelPath: () => modelPath,
        modelSha256: modelSha,
        childPath: join(import.meta.dirname, 'children', 'hang-child.ts'),
        timeoutMs: 1_500,
      })
        .run({
          op: h.op,
          lease: LEASE,
          ops: h.ops,
          api: h.api,
          tmpDir: tmpRoot(),
          signal: new AbortController().signal,
          log: () => {},
        })
        .catch((e: unknown) => e)
      expect((err as OpFailure).code).toBe('TIMEOUT')
      expect(Date.now() - t0).toBeLessThan(15_000)
    } finally {
      h.restore()
    }
  })

  it('a child that runs out of V8 heap: REMOVE_BG_FAILED (no retry), and this process carries on', async () => {
    const oom = join(tmpRoot(), 'oom-child.mjs')
    writeFileSync(
      oom,
      'const keep = []\nprocess.stdin.resume()\nfor (;;) keep.push(new Array(1e6).fill({ a: Math.random() }))\n',
    )
    const h = harness(await subject(32, 32, 'png'))
    h.install()
    try {
      const err = await createRemoveBgRunner({
        modelPath: () => modelPath,
        modelSha256: modelSha,
        childPath: oom,
        heapMb: 32,
        timeoutMs: 30_000,
      })
        .run({
          op: h.op,
          lease: LEASE,
          ops: h.ops,
          api: h.api,
          tmpDir: tmpRoot(),
          signal: new AbortController().signal,
          log: () => {},
        })
        .catch((e: unknown) => e)
      expect(err).toBeInstanceOf(OpFailure)
      expect((err as OpFailure).code).toBe('REMOVE_BG_FAILED')
      expect((err as OpFailure).retry).toBe(false)
    } finally {
      h.restore()
    }
  })

  it('a missing source (404) is SOURCE_MISSING; an upload that fails is retried later (INTERNAL, retry)', async () => {
    const missing = harness(Buffer.from('x'))
    // no fetch installed for mem://: the global fetch rejects the scheme, which is a transient failure; use a 404
    const realFetch = globalThis.fetch
    globalThis.fetch = (async () => new Response(null, { status: 404 })) as typeof fetch
    try {
      const err = await runner()
        .run({
          op: missing.op,
          lease: LEASE,
          ops: missing.ops,
          api: missing.api,
          tmpDir: tmpRoot(),
          signal: new AbortController().signal,
          log: () => {},
        })
        .catch((e: unknown) => e)
      expect((err as OpFailure).code).toBe('SOURCE_MISSING')
    } finally {
      globalThis.fetch = realFetch
    }
    const bytes = await subject(64, 64, 'png')
    const h = harness(bytes)
    globalThis.fetch = (async (url: string | URL) =>
      String(url) === 'mem://source'
        ? new Response(new Uint8Array(bytes), { status: 200 })
        : new Response(null, { status: 503 })) as typeof fetch
    try {
      const err = await runner()
        .run({
          op: h.op,
          lease: LEASE,
          ops: h.ops,
          api: h.api,
          tmpDir: tmpRoot(),
          signal: new AbortController().signal,
          log: () => {},
        })
        .catch((e: unknown) => e)
      expect((err as OpFailure).code).toBe('INTERNAL')
      expect((err as OpFailure).retry).toBe(true)
    } finally {
      globalThis.fetch = realFetch
    }
  })

  it('a complete the api refuses with an op code (quota gone meanwhile) fails the op with that code, no retry', async () => {
    for (const [code, want, opts] of [
      ['QUOTA_EXCEEDED', 'QUOTA_EXCEEDED', undefined],
      ['CANCELLED', 'CANCELLED', undefined],
      ['OUTPUT_MISSING', 'INTERNAL', { retry: true }], // not an op code: a transient trouble, tried again
    ] as const) {
      const h = harness(Buffer.from('x'))
      const failed: unknown[] = []
      const ops: WorkerOpsApi = {
        ...h.ops,
        async complete() {
          throw new WorkerApiError('rejected', 409, `HTTP 409 ${code}`, null, code)
        },
        async fail(_lease, c, o) {
          failed.push([c, o])
        },
      }
      const out = await runClaimedOp(h.op, {
        ops,
        api: h.api,
        capabilities: [WORKER_CAPABILITIES['remove-bg']],
        runners: { 'remove-bg': { kind: 'remove-bg', run: async () => ({ outputs: [], result: {} }) } },
        tmpDir: tmpRoot(),
        signal: new AbortController().signal,
        log: () => {},
      })
      expect(out, code).toEqual({ kind: 'failed', opId: OP_ID, code: want })
      expect(failed, code).toEqual([[want, opts ?? {}]])
    }
  })

  it('checkedPng refuses an output that is not an RGBA PNG of the size the child said', async () => {
    const rgb = file(
      'rgb.png',
      await sharp({ create: { width: 4, height: 4, channels: 3, background: 'red' } })
        .png()
        .toBuffer(),
    )
    await expect(checkedPng(rgb, { width: 4, height: 4 })).rejects.toThrow(/RGBA/)
    const rgba = file(
      'rgba.png',
      await sharp({ create: { width: 4, height: 4, channels: 4, background: 'red' } })
        .png()
        .toBuffer(),
    )
    await expect(checkedPng(rgba, { width: 5, height: 4 })).rejects.toThrow(/differs/)
    await expect(checkedPng(rgba, { width: 4, height: 4 })).resolves.toMatchObject({ width: 4, height: 4 })
  })
})

describe('the model runs only in the child', () => {
  it('only bg-child.ts imports bg-inference.ts, and nothing in src imports onnxruntime-node but bg-inference.ts', () => {
    const src = join(import.meta.dirname, '..', 'src')
    const files: string[] = []
    const walk = (d: string) => {
      for (const e of readdirSync(d, { withFileTypes: true })) {
        if (e.isDirectory()) walk(join(d, e.name))
        else if (e.name.endsWith('.ts')) files.push(join(d, e.name))
      }
    }
    walk(src)
    const importers = (re: RegExp) =>
      files
        .filter((f) => re.test(readFileSync(f, 'utf8')))
        .map((f) => f.slice(src.length + 1).replaceAll('\\', '/'))
    expect(importers(/from '\.\/bg-inference\.ts'|from '\.\.\/ops\/bg-inference\.ts'/)).toEqual([
      'ops/bg-child.ts',
    ])
    expect(importers(/['"]onnxruntime-node['"]/)).toEqual(['ops/bg-inference.ts'])
    // the runner itself spawns the child and never touches the model
    const runnerSrc = readFileSync(join(src, 'ops', 'remove-bg.ts'), 'utf8')
    expect(runnerSrc).not.toMatch(/import[^\n]*(bg-inference|onnxruntime)/)
    expect(runnerSrc).not.toMatch(/createOrtInference\(/)
  })
})
