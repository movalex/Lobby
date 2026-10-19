// Wave W, WS2 (docs/WAVE-W-CONTRACTS.md §4.5): a STAND-IN for u2netp, generated here, so the NAS measurement of time and
// memory runs a model of the same shape and size without the real file (which nobody has downloaded: the owner approves
// that separately). It is NOT u2netp and removes no background: random weights, a plain encoder-decoder of 3×3
// convolutions. What it shares with u2netp (xuebinqin/U-2-Net, U2NETP):
//   - the input [1, 3, 320, 320] and the first output [1, 1, 320, 320] after a Sigmoid;
//   - about the parameter count (u2netp: about 1.13 M; this: STANDIN_PARAMS, printed by the bench) and so the file
//     size (about 4.5 MB of float32);
//   - about the multiply-accumulates of u2netp's dominant layers, which run at 320² and 160² with 64 to 128 channels
//     (an estimate from the architecture, about 18 G here; the real model's count was not measured).
// Encoded byte by byte (onnx.proto3: ModelProto, GraphProto, NodeProto, AttributeProto, TensorProto, ValueInfoProto),
// opset 13, like test/tiny-onnx.ts.

const FLOAT = 1
const ATTR = { FLOAT: 1, INT: 2, STRING: 3, INTS: 7 } as const

function varint(n: number): Buffer {
  const out: number[] = []
  let v = n
  while (v > 0x7f) {
    out.push((v % 128) | 0x80)
    v = Math.floor(v / 128)
  }
  out.push(v)
  return Buffer.from(out)
}
const key = (field: number, wire: 0 | 2) => varint(field * 8 + wire)
const vint = (field: number, n: number) => Buffer.concat([key(field, 0), varint(n)])
const bytes = (field: number, b: Buffer) => Buffer.concat([key(field, 2), varint(b.length), b])
const str = (field: number, s: string) => bytes(field, Buffer.from(s, 'utf8'))

function attrInts(name: string, values: number[]): Buffer {
  return Buffer.concat([str(1, name), ...values.map((v) => vint(8, v)), vint(20, ATTR.INTS)])
}
function attrString(name: string, value: string): Buffer {
  return Buffer.concat([str(1, name), bytes(4, Buffer.from(value, 'utf8')), vint(20, ATTR.STRING)])
}

function node(op: string, name: string, inputs: string[], outputs: string[], attrs: Buffer[] = []): Buffer {
  return Buffer.concat([
    ...inputs.map((i) => str(1, i)),
    ...outputs.map((o) => str(2, o)),
    str(3, name),
    str(4, op),
    ...attrs.map((a) => bytes(5, a)),
  ])
}

function tensor(name: string, dims: number[], data: Float32Array): Buffer {
  return Buffer.concat([
    ...dims.map((d) => vint(1, d)),
    vint(2, FLOAT),
    str(8, name),
    bytes(9, Buffer.from(data.buffer, data.byteOffset, data.byteLength)),
  ])
}

function valueInfo(name: string, dims: number[]): Buffer {
  const shape = Buffer.concat(dims.map((d) => bytes(1, vint(1, d))))
  const t = Buffer.concat([vint(1, FLOAT), bytes(2, shape)])
  return Buffer.concat([str(1, name), bytes(2, bytes(1, t))])
}

/** A deterministic PRNG (mulberry32), so every run builds the same file. */
function rng(seed: number) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

type Layer = { conv: [number, number]; relu?: boolean } | { pool: true } | { up: true }

/** The layers: [input channels, output channels] of each 3×3 convolution, the 2× pools and 2× upsamplings. */
export const STANDIN_LAYERS: readonly Layer[] = [
  // 320²
  { conv: [3, 64] },
  { conv: [64, 16] },
  { pool: true }, // 160²
  { conv: [16, 64] },
  { conv: [64, 64] },
  { conv: [64, 16] },
  { pool: true }, // 80²
  { conv: [16, 64] },
  { conv: [64, 64] },
  { conv: [64, 16] },
  { pool: true }, // 40²
  { conv: [16, 64] },
  { conv: [64, 64] },
  { conv: [64, 64] },
  { pool: true }, // 20²
  { pool: true }, // 10²: the deep stack holds most parameters and little compute, as u2netp's inner stages do
  ...Array.from({ length: 14 }, (): Layer => ({ conv: [64, 64] })),
  { up: true }, // 20²
  { up: true }, // 40²
  { up: true }, // 80²
  { conv: [64, 64] },
  { conv: [64, 64] },
  { up: true }, // 160²
  { conv: [64, 128] },
  { conv: [128, 64] },
  { conv: [64, 16] },
  { up: true }, // 320²
  { conv: [16, 128] },
  { conv: [128, 64] },
  { conv: [64, 16] },
  { conv: [16, 1], relu: false },
]

export interface StandinFacts {
  params: number
  macs: number
  bytes: number
}

/** The stand-in's bytes for a square input of `size` (u2netp: 320) and its facts. */
export function standinU2netp(size = 320): { model: Buffer; facts: StandinFacts } {
  const rand = rng(20261019)
  const nodes: Buffer[] = []
  const inits: Buffer[] = []
  let cur = 'input.1'
  let res = size
  let params = 0
  let macs = 0
  let n = 0
  const scales = Float32Array.from([1, 1, 2, 2])
  inits.push(tensor('up_scales', [4], scales))
  for (const layer of STANDIN_LAYERS) {
    n++
    if ('pool' in layer) {
      const out = `pool${n}`
      nodes.push(
        node(
          'MaxPool',
          `pool${n}`,
          [cur],
          [out],
          [attrInts('kernel_shape', [2, 2]), attrInts('strides', [2, 2])],
        ),
      )
      cur = out
      res = Math.floor(res / 2)
      continue
    }
    if ('up' in layer) {
      const out = `up${n}`
      nodes.push(node('Resize', `up${n}`, [cur, '', 'up_scales'], [out], [attrString('mode', 'nearest')]))
      cur = out
      res *= 2
      continue
    }
    const [cin, cout] = layer.conv
    const w = new Float32Array(cout * cin * 9)
    const scale = Math.sqrt(2 / (cin * 9))
    for (let i = 0; i < w.length; i++) w[i] = (rand() * 2 - 1) * scale
    const b = new Float32Array(cout)
    for (let i = 0; i < b.length; i++) b[i] = (rand() * 2 - 1) * 0.01
    inits.push(tensor(`w${n}`, [cout, cin, 3, 3], w), tensor(`b${n}`, [cout], b))
    params += w.length + b.length
    macs += res * res * cin * cout * 9
    const conv = `conv${n}`
    nodes.push(
      node(
        'Conv',
        conv,
        [cur, `w${n}`, `b${n}`],
        [conv],
        [attrInts('kernel_shape', [3, 3]), attrInts('pads', [1, 1, 1, 1])],
      ),
    )
    cur = conv
    if (layer.relu !== false) {
      const r = `relu${n}`
      nodes.push(node('Relu', r, [conv], [r]))
      cur = r
    }
  }
  nodes.push(node('Sigmoid', 'd0', [cur], ['d0']))
  const graph = Buffer.concat([
    ...nodes.map((x) => bytes(1, x)),
    str(2, 'lobby-standin-u2netp'),
    ...inits.map((x) => bytes(5, x)),
    bytes(11, valueInfo('input.1', [1, 3, size, size])),
    bytes(12, valueInfo('d0', [1, 1, size, size])),
  ])
  const model = Buffer.concat([
    vint(1, 8), // ir_version 8
    str(2, 'lobby-test'),
    bytes(7, graph),
    bytes(8, Buffer.concat([str(1, ''), vint(2, 13)])), // opset 13
  ])
  return { model, facts: { params, macs, bytes: model.length } }
}
