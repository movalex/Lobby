// N1-1 (wave N, PERF-3a): the snapshot decode in a module Worker. The REAL worker module (./snapshot.worker.ts) runs
// here behind a fake Worker (its `postMessage` and `message` listener bridged in-process), so these tests run the
// worker's own code: the decode, the slices, the refusal. The page's decoder (./snapshot-decoder.ts) and the
// socket's in-order chain (./socket.ts) are the real ones.
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { WIRE_LIMITS } from '@draftroom/canvas-schema/limits'
import { encodeSnapshotFrame, ServerMessage, type SnapshotFrame } from '@draftroom/canvas-schema/protocol'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import { SAMPLE_ELEMENTS } from '../../../../../../packages/canvas-schema/src/test-samples.ts'
import { createManualClock } from '../testing/manualClock.ts'
import type { ServerInbound } from '../types.ts'
import {
  createSnapshotDecoder,
  type DecodeSide,
  SnapshotDecodeLost,
  WORKER_MIN_BYTES,
  type WorkerLike,
} from './snapshot-decoder.ts'
import { DECODE_SLICE, type DecodeRequest, type DecodeResponse } from './snapshot-protocol.ts'
import { createSocketTransport, DECODE_LOST_CLOSE, type WebSocketLike } from './socket.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const flush = async (n = 20) => {
  for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0))
}

// ---- the worker module, loaded once into a fake worker scope -------------------------------------------------

let toWorker: ((e: { data: DecodeRequest }) => void) | null = null
/** where the worker module's own postMessage goes (the current fake worker's listeners) */
let fromWorker: (m: DecodeResponse) => void = () => {}

beforeAll(async () => {
  // the worker's global scope, for this file (the module keeps calling it)
  const g = globalThis as unknown as Record<string, unknown>
  g.postMessage = (m: DecodeResponse) => fromWorker(m)
  g.addEventListener = (type: string, l: (e: { data: DecodeRequest }) => void) => {
    if (type === 'message') toWorker = l
  }
  await import('./snapshot.worker.ts')
})

/** A Worker running ./snapshot.worker.ts in-process; `kill()` makes it die as a crashed worker does. */
class FakeWorker implements WorkerLike {
  static made = 0
  readonly transfers: ArrayBuffer[][] = []
  readonly posted: DecodeRequest[] = []
  private readonly listeners = new Map<string, ((e: unknown) => void)[]>()
  terminated = false
  /** answers nothing (a worker that hangs, or dies, with the frame) */
  silent = false
  constructor(o: { ready?: boolean } = {}) {
    FakeWorker.made++
    // the module said `ready` when it loaded; a fresh worker says it again
    if (o.ready !== false) setTimeout(() => this.emit('message', { data: { type: 'ready' } }), 0)
  }
  addEventListener(type: string, l: (e: unknown) => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), l])
  }
  postMessage(message: DecodeRequest, transfer: ArrayBuffer[]): void {
    this.posted.push(message)
    this.transfers.push(transfer)
    if (this.silent) return
    // a structured clone each way, as postMessage does (the transferred buffer moves)
    const req = { id: message.id, bytes: message.bytes }
    setTimeout(() => {
      fromWorker = (m) => this.emit('message', { data: structuredClone(m) })
      toWorker?.({ data: req })
    }, 0)
  }
  emit(type: string, e: unknown): void {
    for (const l of this.listeners.get(type) ?? []) l(e)
  }
  kill(): void {
    this.emit('error', { message: 'crashed' })
  }
  terminate(): void {
    this.terminated = true
  }
}

const frameOf = (n: number): SnapshotFrame => {
  const kinds = Object.values(SAMPLE_ELEMENTS)
  return {
    type: 'snapshot',
    epoch: 'e1',
    clock: 7,
    horizon: 0,
    elements: Array.from({ length: n }, (_, i) => ({
      ...(kinds[i % kinds.length] as object),
      id: `el-${i}`,
      index: `a${i.toString(36).padStart(4, '0')}`,
    })) as never,
    doc: {},
  }
}

const exact = (bytes: Uint8Array) => new Uint8Array(bytes.slice().buffer)

describe('N1-1: the snapshot decoder', () => {
  it('decodes in the worker (the bytes transferred, not copied), in slices, equal to the main thread’s decode', async () => {
    const sides: DecodeSide[] = []
    let w: FakeWorker | null = null
    const d = createSnapshotDecoder({
      minBytes: 0,
      worker: true,
      createWorker: () => {
        w = new FakeWorker()
        return w
      },
      onDecoded: (s) => sides.push(s),
    })
    const frame = frameOf(DECODE_SLICE * 2 + 7)
    const bytes = exact(await encodeSnapshotFrame(frame))
    const buffer = bytes.buffer
    const got = await d.decode(bytes)
    expect(got).toEqual(frame)
    expect(sides).toEqual(['worker'])
    const fw = w as unknown as FakeWorker
    expect(fw.transfers[0]?.[0]).toBe(buffer)
    expect(fw.posted[0]?.bytes).toBe(buffer)
    expect(d.side).toBe('worker')
    d.dispose()
    expect(fw.terminated).toBe(true)
  })

  it('a frame under WORKER_MIN_BYTES decodes on the main thread (a small board opens as before)', async () => {
    let posted = 0
    const sides: DecodeSide[] = []
    const d = createSnapshotDecoder({
      worker: true,
      createWorker: () => {
        const w = new FakeWorker()
        const post = w.postMessage.bind(w)
        w.postMessage = (m, t) => {
          posted++
          post(m, t)
        }
        return w
      },
      onDecoded: (s) => sides.push(s),
    })
    d.warm()
    const small = frameOf(3)
    const bytes = await encodeSnapshotFrame(small)
    expect(bytes.byteLength).toBeLessThan(WORKER_MIN_BYTES)
    expect(await d.decode(bytes)).toEqual(small)
    expect(sides).toEqual(['main'])
    expect(posted).toBe(0)
    d.dispose()
  })

  it('the worker is created lazily: at the first frame or a reset welcome (warm), once', async () => {
    FakeWorker.made = 0
    const d = createSnapshotDecoder({ minBytes: 0, worker: true, createWorker: () => new FakeWorker() })
    expect(FakeWorker.made).toBe(0)
    d.warm()
    d.warm()
    expect(FakeWorker.made).toBe(1)
    await d.decode(exact(await encodeSnapshotFrame(frameOf(3))))
    await d.decode(exact(await encodeSnapshotFrame(frameOf(4))))
    expect(FakeWorker.made).toBe(1)
    d.dispose()
  })

  it('the Worker constructor throws: the same function decodes on the main thread', async () => {
    const sides: DecodeSide[] = []
    const logs: string[] = []
    const d = createSnapshotDecoder({
      minBytes: 0,
      worker: true,
      createWorker: () => {
        throw new Error('Workers are not allowed here')
      },
      onDecoded: (s) => sides.push(s),
      log: (e) => logs.push(e),
    })
    const frame = frameOf(5)
    expect(await d.decode(await encodeSnapshotFrame(frame))).toEqual(frame)
    expect(await d.decode(await encodeSnapshotFrame(frame))).toEqual(frame)
    expect(sides).toEqual(['main', 'main'])
    expect(logs).toContain('snapshot_worker_unavailable')
    expect(d.side).toBe('main')
  })

  it('WORKER_DECODE off: every frame on the main thread, no worker made', async () => {
    FakeWorker.made = 0
    const sides: DecodeSide[] = []
    const d = createSnapshotDecoder({
      worker: false,
      createWorker: () => new FakeWorker(),
      onDecoded: (s) => sides.push(s),
    })
    d.warm()
    const frame = frameOf(2)
    expect(await d.decode(await encodeSnapshotFrame(frame))).toEqual(frame)
    expect(sides).toEqual(['main'])
    expect(FakeWorker.made).toBe(0)
  })

  it('a worker that fails to start (its error before ready, or no ready in time): the frame decodes on the main thread, its bytes intact', async () => {
    const clock = createManualClock()
    const sides: DecodeSide[] = []
    let w: FakeWorker | null = null
    const d = createSnapshotDecoder({
      minBytes: 0,
      worker: true,
      createWorker: () => {
        w = new FakeWorker({ ready: false })
        return w
      },
      onDecoded: (s) => sides.push(s),
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
    })
    const frame = frameOf(4)
    const p = d.decode(await encodeSnapshotFrame(frame))
    await flush(2)
    ;(w as unknown as FakeWorker).kill()
    expect(await p).toEqual(frame)
    expect((w as unknown as FakeWorker).posted).toHaveLength(0)
    expect(sides).toEqual(['main'])
    // a silent one: after the start timeout
    const d2 = createSnapshotDecoder({
      minBytes: 0,
      worker: true,
      createWorker: () => new FakeWorker({ ready: false }),
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
    })
    const p2 = d2.decode(await encodeSnapshotFrame(frame))
    await flush(2)
    clock.advance(10_000)
    expect(await p2).toEqual(frame)
    expect(d2.side).toBe('main')
  })

  it('a worker that dies with a frame in it: that frame is lost (SnapshotDecodeLost), later ones decode on the main thread', async () => {
    let w: FakeWorker | null = null
    const d = createSnapshotDecoder({
      minBytes: 0,
      worker: true,
      createWorker: () => {
        w = new FakeWorker()
        w.silent = true
        return w
      },
    })
    const frame = frameOf(3)
    const p = d.decode(exact(await encodeSnapshotFrame(frame)))
    await flush()
    ;(w as unknown as FakeWorker).kill()
    await expect(p).rejects.toBeInstanceOf(SnapshotDecodeLost)
    expect(await d.decode(await encodeSnapshotFrame(frame))).toEqual(frame)
    expect(d.side).toBe('main')
  })

  it('a frame the worker refuses rejects with the main thread’s own error text (a corrupt gzip, a schema refusal)', async () => {
    const d = createSnapshotDecoder({ minBytes: 0, worker: true, createWorker: () => new FakeWorker() })
    const main = createSnapshotDecoder({ worker: false })
    const corrupt = new Uint8Array([31, 139, 8, 0, 1, 2, 3, 4, 5, 6, 7])
    const bad = await encodeSnapshotFrame({ ...frameOf(1), clock: -5 } as SnapshotFrame)
    for (const bytes of [corrupt, bad]) {
      const viaMain = await main.decode(bytes.slice()).then(
        () => 'resolved',
        (e) => String(e).slice(0, 200),
      )
      const viaWorker = await d.decode(exact(bytes)).then(
        () => 'resolved',
        (e) => String(e).slice(0, 200),
      )
      expect(viaMain).not.toBe('resolved')
      expect(viaWorker).toBe(viaMain)
    }
    d.dispose()
  })
})

// ---- the socket with the decoder ---------------------------------------------------------------------------------

class FakeSocket implements WebSocketLike {
  static all: FakeSocket[] = []
  readyState = 0
  binaryType = 'blob'
  onopen: ((ev: unknown) => void) | null = null
  onmessage: ((ev: { readonly data: unknown }) => void) | null = null
  onclose: ((ev: { readonly code: number; readonly reason: string }) => void) | null = null
  onerror: ((ev: unknown) => void) | null = null
  closed: { code?: number; reason?: string } | null = null
  constructor(_url: string) {
    FakeSocket.all.push(this)
  }
  open() {
    this.readyState = 1
    this.onopen?.({})
  }
  send(_data: string) {}
  close(code?: number, reason?: string) {
    this.closed = { code, reason }
  }
}

const welcome = {
  type: 'welcome',
  proto: 1,
  schema: 1,
  sid: 'u:tab1',
  you: { uid: 'u', name: 'U', color: '#444444', role: 'editor', guest: false },
  readonly: false,
  epoch: 'e1',
  clock: 7,
  horizon: 0,
  doc: {},
  leases: [],
  roster: [],
  workshop: { voteOpen: false, anonymous: false },
  drags: [],
  limits: { ...WIRE_LIMITS },
  reset: true,
  catchUp: null,
  snapshot: { elements: 1, bytes: 0 },
}

it('the test welcome is a valid frame', () => {
  expect(ServerMessage.safeParse(welcome).error?.issues ?? []).toEqual([])
})

async function socketWith(decoder: ReturnType<typeof createSnapshotDecoder> | undefined) {
  FakeSocket.all = []
  const got: ServerInbound[] = []
  const logs: { event: string; detail: Readonly<Record<string, unknown>> }[] = []
  const closes: { code: number; reason: string }[] = []
  const t = createSocketTransport({
    url: () => 'ws://x/connect/b',
    WebSocketImpl: FakeSocket,
    heartbeatMs: 0,
    backoffMs: [60_000],
    random: () => 0.5,
    ...(decoder ? { decoder } : {}),
    log: (event, detail) => logs.push({ event, detail }),
  })
  t.onMessage((m) => got.push(m))
  t.onState((_s, c) => {
    if (c) closes.push(c)
  })
  t.connect()
  await flush(2)
  const s = FakeSocket.all[0] as FakeSocket
  s.open()
  return { t, s, got, logs, closes }
}

describe('N1-1: the socket decodes through the worker in arrival order', () => {
  it('frames after a snapshot are delivered after it, in order (a worker decode is slow: they wait)', async () => {
    const d = createSnapshotDecoder({ minBytes: 0, worker: true, createWorker: () => new FakeWorker() })
    const { t, s, got } = await socketWith(d)
    s.onmessage?.({ data: JSON.stringify(welcome) })
    const bytes = await encodeSnapshotFrame(frameOf(DECODE_SLICE + 3))
    s.onmessage?.({ data: exact(bytes).buffer })
    s.onmessage?.({ data: JSON.stringify({ type: 'contracts', rev: 12 }) })
    s.onmessage?.({ data: JSON.stringify({ type: 'changes', clock: 8, ops: [] }) })
    await flush(40)
    expect(got.map((m) => m.type)).toEqual(['welcome', 'snapshot', 'contracts', 'changes'])
    expect((got[1] as SnapshotFrame).elements).toHaveLength(DECODE_SLICE + 3)
    t.close()
    d.dispose()
  })

  it('a corrupt gzip takes the same path as on the main thread: logged as invalid, dropped, no close', async () => {
    const corrupt = new Uint8Array([31, 139, 8, 0, 9, 9, 9, 9])
    const runs: { got: string[]; logs: unknown[]; closes: unknown[] }[] = []
    for (const decoder of [
      undefined,
      createSnapshotDecoder({ minBytes: 0, worker: true, createWorker: () => new FakeWorker() }),
    ]) {
      const { t, s, got, logs, closes } = await socketWith(decoder)
      s.onmessage?.({ data: JSON.stringify(welcome) })
      s.onmessage?.({ data: exact(corrupt).buffer })
      s.onmessage?.({ data: JSON.stringify({ type: 'contracts', rev: 12 }) })
      await flush(40)
      runs.push({
        got: got.map((m) => m.type),
        logs: logs.map((l) => [l.event, l.detail]),
        closes: [...closes],
      })
      expect(s.closed).toBeNull()
      t.close()
      decoder?.dispose()
    }
    expect(runs[0]?.got).toEqual(['welcome', 'contracts'])
    expect(runs[1]).toEqual(runs[0])
    expect(runs[0]?.logs.some((l) => (l as [string])[0] === 'snapshot_frame_invalid')).toBe(true)
  })

  it('a worker that dies with the frame: the socket is dropped and reconnects (the next welcome resends it)', async () => {
    let w: FakeWorker | null = null
    const d = createSnapshotDecoder({
      minBytes: 0,
      worker: true,
      createWorker: () => {
        w = new FakeWorker()
        w.silent = true
        return w
      },
    })
    const { t, s, got, closes, logs } = await socketWith(d)
    s.onmessage?.({ data: JSON.stringify(welcome) })
    s.onmessage?.({ data: exact(await encodeSnapshotFrame(frameOf(2))).buffer })
    await flush(10)
    ;(w as unknown as FakeWorker).kill()
    await flush(10)
    expect(got.map((m) => m.type)).toEqual(['welcome'])
    expect(closes.at(-1)).toEqual({ ...DECODE_LOST_CLOSE })
    expect(s.closed).toEqual({ ...DECODE_LOST_CLOSE })
    expect(logs.some((l) => l.event === 'snapshot_decode_lost')).toBe(true)
    t.close()
  })
})

// ---- the worker's module graph -----------------------------------------------------------------------------------

const REPO = resolve(HERE, '../../../../../..')
const PACKAGES: Record<string, string> = {
  '@draftroom/canvas-schema': join(REPO, 'packages/canvas-schema'),
  '@draftroom/contracts': join(REPO, 'packages/contracts'),
  '@draftroom/permissions': join(REPO, 'packages/permissions'),
}

/** A module's runtime imports (type-only imports and exports are erased, so left out). */
function importsOf(file: string): string[] {
  const text = readFileSync(file, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
  const out: string[] = []
  const typeOnly = (braces: string) =>
    braces
      .slice(1, -1)
      .split(',')
      .map((x) => x.trim())
      .filter(Boolean)
      .every((x) => x.startsWith('type '))
  // import 'x'; import a from 'x'; import * as a from 'x'; import a, { b } from 'x'; import { type a } from 'x'
  const imp =
    /^[ \t]*import[ \t]+(type[ \t]+)?(?:([\w$]+[ \t]*,?[ \t]*)?(\*[ \t]+as[ \t]+[\w$]+|\{[^}]*\})?[ \t]*from[ \t]*)?['"]([^'"\n]+)['"]/gm
  for (const m of text.matchAll(imp)) {
    if (m[1]) continue
    if (!m[2] && m[3]?.startsWith('{') && typeOnly(m[3])) continue
    out.push(m[4] as string)
  }
  const exp =
    /^[ \t]*export[ \t]+(type[ \t]+)?(\*(?:[ \t]+as[ \t]+[\w$]+)?|\{[^}]*\})[ \t]*from[ \t]*['"]([^'"\n]+)['"]/gm
  for (const m of text.matchAll(exp)) {
    if (m[1] || (m[2]?.startsWith('{') && typeOnly(m[2]))) continue
    out.push(m[3] as string)
  }
  for (const m of text.matchAll(/\bimport\([ \t]*['"]([^'"\n]+)['"][ \t]*\)/g)) out.push(m[1] as string)
  return out
}

function resolveSpec(from: string, spec: string): string | null {
  if (spec.startsWith('.')) return resolve(dirname(from), spec)
  for (const [name, dir] of Object.entries(PACKAGES)) {
    if (spec !== name && !spec.startsWith(`${name}/`)) continue
    const exp = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).exports as Record<string, string>
    const key = spec === name ? '.' : `.${spec.slice(name.length)}`
    const target = exp[key]
    if (!target) throw new Error(`no export ${key} in ${name}`)
    return join(dir, target)
  }
  return null
}

describe('N1-1: the worker’s module graph', () => {
  it('its first import sets zod jitless, before any module that builds a schema', () => {
    const imports = importsOf(join(HERE, 'snapshot.worker.ts'))
    expect(imports[0]).toBe('./worker-jitless.ts')
    expect(importsOf(join(HERE, 'worker-jitless.ts'))).toEqual([])
  })

  it('worker-jitless sets jitless on the object zod reads its config from', async () => {
    const g = globalThis as { __zod_globalConfig?: Record<string, unknown> }
    const was = g.__zod_globalConfig
    try {
      g.__zod_globalConfig = undefined
      vi.resetModules()
      await import('./worker-jitless.ts')
      expect(g.__zod_globalConfig).toEqual({ jitless: true })
    } finally {
      g.__zod_globalConfig = Object.assign(was ?? {}, { jitless: true })
    }
  })

  it('imports no @excalidraw module (only canvas-schema, the contracts and zod)', () => {
    const seen = new Set<string>()
    const bare = new Set<string>()
    const stack = [join(HERE, 'snapshot.worker.ts')]
    while (stack.length) {
      const file = stack.pop() as string
      if (seen.has(file)) continue
      seen.add(file)
      for (const spec of importsOf(file)) {
        const next = resolveSpec(file, spec)
        if (next) stack.push(next)
        else bare.add(spec)
      }
    }
    expect([...bare].filter((s) => s.startsWith('@excalidraw'))).toEqual([])
    expect([...bare].sort()).toEqual(['zod'])
    expect([...seen].some((f) => f.includes(join('packages', 'canvas-schema', 'src', 'protocol.ts')))).toBe(
      true,
    )
    expect([...seen].some((f) => f.includes('engine'))).toBe(false)
  })
})
