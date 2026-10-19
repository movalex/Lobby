// Wave W (docs/WAVE-W-CONTRACTS.md §4.4): a tiny synthetic ONNX model, encoded here byte by byte, so the background
// removal tests never need the real model file (which the owner downloads separately) or any network.
//
// The graph has the u2netp shape: input `input` float32 [1, 3, S, S] -> ReduceMean over the channel axis (keepdims) ->
// Sigmoid -> output `mask` float32 [1, 1, S, S]. So a pixel's "mask" is sigmoid(mean of its three channels): a
// deterministic, checkable stand-in for a saliency map. Only the protobuf fields ONNX needs are written (onnx.proto3:
// ModelProto, GraphProto, NodeProto, AttributeProto, ValueInfoProto, TypeProto, TensorShapeProto).

const FLOAT = 1 // TensorProto.DataType.FLOAT
const ATTR_INTS = 7 // AttributeProto.AttributeType.INTS
const ATTR_INT = 2 // AttributeProto.AttributeType.INT

function varint(n: number): number[] {
  const out: number[] = []
  let v = n
  while (v > 0x7f) {
    out.push((v & 0x7f) | 0x80)
    v = Math.floor(v / 128)
  }
  out.push(v)
  return out
}

const key = (field: number, wire: 0 | 2) => varint((field << 3) | wire)
const vint = (field: number, n: number) => [...key(field, 0), ...varint(n)]
const bytes = (field: number, b: number[]) => [...key(field, 2), ...varint(b.length), ...b]
const str = (field: number, s: string) => bytes(field, [...Buffer.from(s, 'utf8')])

function valueInfo(name: string, dims: number[]): number[] {
  const shape = dims.flatMap((d) => bytes(1, vint(1, d)))
  const tensor = [...vint(1, FLOAT), ...bytes(2, shape)]
  return [...str(1, name), ...bytes(2, bytes(1, tensor))]
}

function node(op: string, input: string, output: string, attrs: number[][] = []): number[] {
  return [
    ...str(1, input),
    ...str(2, output),
    ...str(3, `${op}_0`),
    ...str(4, op),
    ...attrs.flatMap((a) => bytes(5, a)),
  ]
}

/** The model's bytes for a square input of `size` pixels (u2netp uses 320; tests use small sizes). */
export function tinyMaskModel(size: number): Uint8Array {
  const axes = [...str(1, 'axes'), ...vint(8, 1), ...vint(20, ATTR_INTS)]
  const keepdims = [...str(1, 'keepdims'), ...vint(3, 1), ...vint(20, ATTR_INT)]
  const graph = [
    ...bytes(1, node('ReduceMean', 'input', 'mean', [axes, keepdims])),
    ...bytes(1, node('Sigmoid', 'mean', 'mask')),
    ...str(2, 'lobby-tiny-mask'),
    ...bytes(11, valueInfo('input', [1, 3, size, size])),
    ...bytes(12, valueInfo('mask', [1, 1, size, size])),
  ]
  const model = [
    ...vint(1, 8), // ir_version 8
    ...str(2, 'lobby-test'),
    ...bytes(7, graph),
    ...bytes(8, [...str(1, ''), ...vint(2, 13)]), // opset 13 (ReduceMean takes `axes` as an attribute)
  ]
  return Uint8Array.from(model)
}

/** What the tiny model computes for one pixel (the test's oracle). */
export const tinyMaskOf = (r: number, g: number, b: number) => 1 / (1 + Math.exp(-(r + g + b) / 3))
