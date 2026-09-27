import type { TLBinding, TLPageId, TLRecord, TLShape } from '@tldraw/tlschema'
import { type IndexKey, structuredClone } from '@tldraw/utils'
import { describe, expect, it } from 'vitest'
import { remapIds } from './index.ts'
import {
  AST,
  arrow,
  arrowBinding,
  byId,
  documentRecord,
  fileCard,
  frame,
  geo,
  group,
  image,
  imageAsset,
  note,
  PAGE,
  page,
  shapesOf,
  sid,
  text,
  validateAll,
} from './test-fixtures.ts'

const TARGET = 'page:target' as TLPageId

function source(): TLRecord[] {
  const records: TLRecord[] = [
    page(PAGE, 'Main'),
    documentRecord(),
    frame('f', 'Frame', { x: 100, y: 100, w: 800, h: 600, index: 'a1' }),
    // Listed out of index order on purpose.
    note('n2', 'second', { parentId: sid('f'), x: 300, y: 40, index: 'a3' }),
    note('n1', 'first', { parentId: sid('f'), x: 20, y: 40, index: 'a2' }),
    geo('g', 'target', { x: 1200, y: 100, index: 'a2' }),
    arrow('a', 'flow', { x: 400, y: 900, index: 'a3' }),
    arrowBinding('start', sid('a'), sid('n1'), 'start'),
    arrowBinding('end', sid('a'), sid('g'), 'end'),
    arrowBinding('dangling', sid('a'), sid('not-copied'), 'end'),
    imageAsset('img'),
    image('i', 'asset:img', { x: 0, y: 1200, index: 'a4' }),
    fileCard('fc', 'deck.pdf', { x: 400, y: 1200, index: 'a5' }),
    group('grp', { x: 2000, y: 0, index: 'a6' }),
    text('t2', 'group child 2', { parentId: sid('grp'), x: 0, y: 100, index: 'a1' }),
    text('t1', 'group child 1', { parentId: sid('grp'), x: 0, y: 0, index: 'a0' }),
    note('orphan', 'lost', { parentId: sid('deleted-frame'), x: 7, y: 8, index: 'a1' }),
  ]
  validateAll(records)
  return records
}

/** Replaces ids by their output position so two remaps can be compared structurally. */
function canonical(records: TLRecord[]): unknown[] {
  const label = new Map(records.map((record, i) => [record.id as string, `#${i}`]))
  const swap = (value: unknown) => (typeof value === 'string' && label.has(value) ? label.get(value) : value)
  return records.map((record) => {
    const copy = structuredClone(record) as unknown as Record<string, unknown>
    copy.id = swap(copy.id)
    if ('parentId' in copy) copy.parentId = swap(copy.parentId)
    if ('fromId' in copy) copy.fromId = swap(copy.fromId)
    if ('toId' in copy) copy.toId = swap(copy.toId)
    const props = copy.props as Record<string, unknown>
    if (props && 'assetId' in props) props.assetId = swap(props.assetId)
    return copy
  })
}

describe('remapIds', () => {
  it('gives every shape, binding and asset a fresh id and keeps references consistent', () => {
    const input = source()
    const { records, idMap } = remapIds(input, { targetPageId: TARGET })
    validateAll(records)
    const oldIds = new Set(input.map((record) => record.id as string))
    for (const record of records) expect(oldIds.has(record.id)).toBe(false)
    expect(new Set(records.map((record) => record.id)).size).toBe(records.length)

    const out = byId(records)
    const get = (name: string) => out.get(idMap.get(sid(name)) as string) as TLShape
    expect(get('n1').parentId).toBe(idMap.get(sid('f')))
    expect(get('n2').parentId).toBe(idMap.get(sid('f')))
    expect(get('t1').parentId).toBe(idMap.get(sid('grp')))
    expect(get('f').parentId).toBe(TARGET)
    expect(get('g').parentId).toBe(TARGET)

    const start = out.get(idMap.get('binding:start') as string) as TLBinding
    const end = out.get(idMap.get('binding:end') as string) as TLBinding
    expect([start.fromId, start.toId]).toEqual([idMap.get(sid('a')), idMap.get(sid('n1'))])
    expect([end.fromId, end.toId]).toEqual([idMap.get(sid('a')), idMap.get(sid('g'))])
    expect(start.props).toEqual({
      terminal: 'start',
      normalizedAnchor: { x: 0.5, y: 0.5 },
      isExact: false,
      isPrecise: false,
      snap: 'none',
    })

    const newAssetId = idMap.get('asset:img')
    expect(newAssetId).toMatch(/^asset:/)
    expect(out.get(newAssetId as string)?.typeName).toBe('asset')
    expect((get('i').props as { assetId: string }).assetId).toBe(newAssetId)
    // dr-file-card file references are app ids, not records: unchanged.
    expect((get('fc').props as { assetId: string }).assetId).toBe(AST)
  })

  it('drops dangling bindings and non-shape/binding/asset records', () => {
    const { records, idMap } = remapIds(source(), { targetPageId: TARGET })
    expect(idMap.has('binding:dangling')).toBe(false)
    expect(records.filter((record) => record.typeName === 'binding')).toHaveLength(2)
    expect(records.some((record) => ['page', 'document'].includes(record.typeName))).toBe(false)
    const shapeIds = new Set(shapesOf(records).map((shape) => shape.id as string))
    for (const record of records) {
      if (record.typeName !== 'binding') continue
      expect(shapeIds.has(record.fromId)).toBe(true)
      expect(shapeIds.has(record.toId)).toBe(true)
    }
  })

  it('re-parents orphans to the target page and applies the offset only to top-level shapes', () => {
    const { records, idMap } = remapIds(source(), { targetPageId: TARGET, offset: { x: 1000, y: -50 } })
    const out = byId(records)
    const get = (name: string) => out.get(idMap.get(sid(name)) as string) as TLShape
    expect(get('orphan')).toMatchObject({ parentId: TARGET, x: 1007, y: -42 })
    expect(get('f')).toMatchObject({ x: 1100, y: 50 })
    expect(get('grp')).toMatchObject({ x: 3000, y: -50 })
    // Children stay relative to their (moved) parent.
    expect(get('n1')).toMatchObject({ x: 20, y: 40 })
    expect(get('t2')).toMatchObject({ x: 0, y: 100 })
  })

  it('preserves sibling order with fresh index keys', () => {
    const { records, idMap } = remapIds(source(), { targetPageId: TARGET, indexAbove: 'a9' as IndexKey })
    const out = byId(records)
    const index = (name: string) => (out.get(idMap.get(sid(name)) as string) as TLShape).index
    expect(index('n1') < index('n2')).toBe(true)
    expect(index('t1') < index('t2')).toBe(true)
    // Page-level order: f(a1) orphan(a1, later in input) g(a2) a(a3) i(a4) fc(a5) grp(a6)
    const top = ['f', 'orphan', 'g', 'a', 'i', 'fc', 'grp'].map(index)
    expect([...top].sort()).toEqual(top)
    expect(new Set(top).size).toBe(top.length)
    for (const key of top) expect(key > 'a9').toBe(true)
  })

  it('keeps asset ids and references with keepAssets', () => {
    const { records, idMap } = remapIds(source(), { targetPageId: TARGET, keepAssets: true })
    expect(idMap.has('asset:img')).toBe(false)
    expect(records.find((record) => record.typeName === 'asset')?.id).toBe('asset:img')
    const img = records.find((record) => record.typeName === 'shape' && record.type === 'image') as TLShape
    expect((img.props as { assetId: string }).assetId).toBe('asset:img')
    validateAll(records)
  })

  it('never mutates its input', () => {
    const input = source()
    const snapshot = structuredClone(input)
    remapIds(input, { targetPageId: TARGET, offset: { x: 5, y: 5 } })
    expect(input).toEqual(snapshot)
  })

  it('is stable under repeated application: same structure, no id collisions', () => {
    const first = remapIds(source(), { targetPageId: TARGET })
    const second = remapIds(first.records, { targetPageId: TARGET })
    const third = remapIds(second.records, { targetPageId: TARGET })
    const all = [...source(), ...first.records, ...second.records, ...third.records].map(
      (record) => record.id,
    )
    expect(new Set(all).size).toBe(all.length)
    expect(canonical(second.records)).toEqual(canonical(first.records))
    expect(canonical(third.records)).toEqual(canonical(first.records))
    validateAll(third.records)
  })

  it('breaks parent cycles instead of emitting them', () => {
    const records = [
      frame('c1', 'C1', { parentId: sid('c2') }),
      frame('c2', 'C2', { parentId: sid('c1') }),
      note('child', 'inside', { parentId: sid('c1') }),
    ]
    const { records: out, idMap } = remapIds(records, { targetPageId: TARGET })
    validateAll(out)
    const parents = new Map(shapesOf(out).map((shape) => [shape.id as string, shape.parentId as string]))
    // Walking up from every shape reaches the page.
    for (const start of parents.keys()) {
      let current: string | undefined = start
      for (let steps = 0; current && !current.startsWith('page:'); steps++) {
        expect(steps).toBeLessThan(5)
        current = parents.get(current)
      }
      expect(current).toBe(TARGET)
    }
    expect(parents.get(idMap.get(sid('child')) as string)).toBe(idMap.get(sid('c1')))
  })

  it('rejects an invalid target page or index key', () => {
    expect(() => remapIds([], { targetPageId: 'shape:x' as TLPageId })).toThrow(TypeError)
    expect(() => remapIds([], { targetPageId: TARGET, indexAbove: '' as IndexKey })).toThrow(TypeError)
    expect(remapIds([], { targetPageId: TARGET })).toEqual({ records: [], idMap: new Map() })
  })
})

describe('remapIds adversarial review', () => {
  it('rebinds an arrow to a shape nested in a group inside a frame', () => {
    const records: TLRecord[] = [
      frame('f', 'Outer', { x: 100, y: 100, w: 900, h: 700 }),
      group('grp', { parentId: sid('f'), x: 50, y: 60 }),
      geo('deep', 'deep target', { parentId: sid('grp'), x: 10, y: 20 }),
      geo('sib', 'sibling', { parentId: sid('grp'), x: 300, y: 20, index: 'a2' }),
      arrow('a', '', { x: 0, y: 900, index: 'a2' }),
      arrowBinding('s', sid('a'), sid('deep'), 'start'),
      arrowBinding('e', sid('a'), sid('sib'), 'end'),
    ]
    validateAll(records)
    const { records: out, idMap } = remapIds(records, { targetPageId: TARGET, offset: { x: 5, y: 5 } })
    validateAll(out)
    const map = byId(out)
    const deep = map.get(idMap.get(sid('deep')) as string) as TLShape
    expect(deep).toMatchObject({ parentId: idMap.get(sid('grp')), x: 10, y: 20 })
    expect(map.get(idMap.get(sid('grp')) as string)).toMatchObject({ parentId: idMap.get(sid('f')) })
    const start = map.get(idMap.get('binding:s') as string) as TLBinding
    expect([start.fromId, start.toId]).toEqual([idMap.get(sid('a')), deep.id])
  })

  it('keeps both bindings of an arrow whose ends are bound to the same shape', () => {
    const records: TLRecord[] = [
      geo('loop', 'self loop target'),
      arrow('a', '', { index: 'a2' }),
      arrowBinding('s', sid('a'), sid('loop'), 'start'),
      arrowBinding('e', sid('a'), sid('loop'), 'end'),
    ]
    const { records: out, idMap } = remapIds(records, { targetPageId: TARGET })
    validateAll(out)
    const bindings = out.filter((r): r is TLBinding => r.typeName === 'binding')
    expect(bindings.map((b) => b.props.terminal).sort()).toEqual(['end', 'start'])
    for (const b of bindings)
      expect([b.fromId, b.toId]).toEqual([idMap.get(sid('a')), idMap.get(sid('loop'))])
    expect(new Set(bindings.map((b) => b.id)).size).toBe(2)
  })

  it('maps an asset shared by two image shapes to one new asset', () => {
    const records: TLRecord[] = [
      imageAsset('shared'),
      image('i1', 'asset:shared'),
      image('i2', 'asset:shared', { x: 400, index: 'a2' }),
    ]
    const { records: out, idMap } = remapIds(records, { targetPageId: TARGET })
    validateAll(out)
    const assets = out.filter((r) => r.typeName === 'asset')
    expect(assets).toHaveLength(1)
    const newAsset = idMap.get('asset:shared')
    expect(assets[0]?.id).toBe(newAsset)
    const refs = shapesOf(out).map((s) => (s.props as { assetId: string }).assetId)
    expect(refs).toEqual([newAsset, newAsset])
  })

  it('ignores records whose id prefix does not match their typeName (pasted JSON is untrusted)', () => {
    // A "shape" wearing an asset id used to share an idMap slot with the real asset, so the shape
    // came out with an asset: id (and the image lost its asset).
    const impostor = { ...geo('x', 'impostor'), id: 'asset:img' } as unknown as TLRecord
    const bindingImpostor = { ...geo('y', 'impostor 2'), id: 'binding:b' } as unknown as TLRecord
    const records: TLRecord[] = [
      impostor,
      bindingImpostor,
      imageAsset('img'),
      image('i', 'asset:img'),
      geo('g', 'target', { index: 'a2' }),
      arrow('a', '', { index: 'a3' }),
      arrowBinding('b', sid('a'), sid('g'), 'end'),
    ]
    const { records: out, idMap } = remapIds(records, { targetPageId: TARGET })
    validateAll(out)
    for (const record of out) expect(record.id.startsWith(`${record.typeName}:`)).toBe(true)
    expect(
      shapesOf(out)
        .map((s) => s.type)
        .sort(),
    ).toEqual(['arrow', 'geo', 'image'])
    expect(idMap.get('asset:img')).toMatch(/^asset:/)
    expect(idMap.get('binding:b')).toMatch(/^binding:/)
    const img = shapesOf(out).find((s) => s.type === 'image') as TLShape
    expect((img.props as { assetId: string }).assetId).toBe(idMap.get('asset:img'))
  })

  it('keeps the first of repeated ids', () => {
    const records: TLRecord[] = [note('dup', 'first'), note('dup', 'second', { x: 999 })]
    const { records: out } = remapIds(records, { targetPageId: TARGET })
    expect(out).toHaveLength(1)
    expect(shapesOf(out)[0]?.x).toBe(0)
  })
})
