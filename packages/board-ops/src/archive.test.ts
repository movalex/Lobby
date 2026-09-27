import { draftroomSchema, FILE_CARD_TYPE } from '@draftroom/canvas-schema'
import type { TLPageId, TLRecord, TLShape } from '@tldraw/tlschema'
import { structuredClone } from '@tldraw/utils'
import { describe, expect, it } from 'vitest'
import {
  ARCHIVE_LIMITS,
  type ArchiveAssetRef,
  ArchiveError,
  type ArchiveErrorCode,
  type BoardArchiveV1,
  exportBoardArchive,
  importBoardArchive,
} from './index.ts'
import {
  AST,
  arrow,
  arrowBinding,
  documentRecord,
  fileCard,
  frame,
  geo,
  image,
  imageAsset,
  note,
  PAGE,
  PAGE_2,
  page,
  SHA,
  sid,
  VER,
  validateAll,
} from './test-fixtures.ts'

// biome-ignore lint/suspicious/noExplicitAny: test-only view of arbitrary (deliberately tampered) archive JSON
type Json = any

const TARGET = 'page:imported' as TLPageId
const MANIFEST: ArchiveAssetRef[] = [
  {
    assetId: AST,
    versionId: VER,
    name: 'deck.pdf',
    mimeType: 'application/pdf',
    sizeBytes: 2274,
    sha256: SHA,
  },
]

function boardRecords(): TLRecord[] {
  const records: TLRecord[] = [
    documentRecord(),
    page(PAGE, 'Main'),
    frame('f', 'Sprint', { x: 0, y: 0, w: 1000, h: 800 }),
    note('n1', 'Idea one', { parentId: sid('f'), x: 20, y: 60, textLastEditedBy: 'user:someone' }),
    note('n2', 'Idea two', { parentId: sid('f'), x: 260, y: 60, index: 'a2' }),
    geo('g', 'Decision', { x: 1200, y: 0, index: 'a2' }),
    arrow('a', 'next', { x: 300, y: 900, index: 'a3' }),
    arrowBinding('s', sid('a'), sid('n1'), 'start'),
    arrowBinding('e', sid('a'), sid('g'), 'end'),
    imageAsset('img'),
    image('i', 'asset:img', { x: 0, y: 1000, index: 'a4', altText: 'moodboard' }),
    fileCard('fc', 'deck.pdf', { x: 400, y: 1000, index: 'a5' }),
  ]
  validateAll(records)
  return records
}

const camera = {
  id: 'camera:page:main',
  typeName: 'camera',
  x: 0,
  y: 0,
  z: 1,
  meta: {},
} as unknown as TLRecord

/** A JSON round trip of a fresh export: exactly what an upload would hand to the importer. */
function archiveJson(records: TLRecord[] = boardRecords(), manifest = MANIFEST): Json {
  return JSON.parse(JSON.stringify(exportBoardArchive(records, draftroomSchema.serialize(), manifest)))
}

function expectArchiveError(fn: () => unknown, code: ArchiveErrorCode): ArchiveError {
  try {
    fn()
  } catch (error) {
    expect(error).toBeInstanceOf(ArchiveError)
    expect((error as ArchiveError).code).toBe(code)
    return error as ArchiveError
  }
  throw new Error(`expected ArchiveError ${code}`)
}

const importJson = (value: unknown) => importBoardArchive(value, { targetPageId: TARGET })

/** Structure without ids/index values: parents, bindings and asset refs by position; sibling order as rank. */
function semantic(records: TLRecord[], pageIds: string[]) {
  const shapes = records.filter((r): r is TLShape => r.typeName === 'shape')
  const assets = records.filter((r) => r.typeName === 'asset')
  const bindings = records.filter((r) => r.typeName === 'binding')
  const label = new Map<string, string>([
    ...shapes.map((s, i) => [s.id as string, `S${i}`] as const),
    ...assets.map((a, i) => [a.id as string, `A${i}`] as const),
  ])
  const ref = (id: string) => label.get(id) ?? (pageIds.includes(id) ? 'PAGE' : `?${id}`)
  const rank = (shape: TLShape) =>
    shapes
      .filter((other) => other.parentId === shape.parentId)
      .map((other) => other.index)
      .sort()
      .indexOf(shape.index)
  return {
    shapes: shapes.map((shape) => {
      const { id: _id, index: _index, parentId, props, ...rest } = structuredClone(shape) as Json
      if ('assetId' in props && typeof props.assetId === 'string' && props.assetId.startsWith('asset:'))
        props.assetId = ref(props.assetId)
      if ('textLastEditedBy' in props) props.textLastEditedBy = null
      return { ...rest, parent: ref(parentId), rank: rank(shape), props }
    }),
    bindings: bindings.map((binding) => {
      const { id: _id, fromId, toId, ...rest } = structuredClone(binding) as Json
      return { ...rest, from: ref(fromId), to: ref(toId) }
    }),
    assets: assets.map((asset) => {
      const { id: _id, ...rest } = structuredClone(asset) as Json
      return rest
    }),
  }
}

describe('exportBoardArchive', () => {
  it('keeps only page/asset/shape/binding records, in that order, with the schema and manifest', () => {
    const records = [...boardRecords(), camera]
    const schema = draftroomSchema.serialize()
    const archive: BoardArchiveV1 = exportBoardArchive(records, schema, MANIFEST)
    expect(archive.format).toBe('draftroom-board')
    expect(archive.version).toBe(1)
    expect(Number.isNaN(Date.parse(archive.exportedAt))).toBe(false)
    expect(archive.records.map((record) => record.typeName)).toEqual([
      'page',
      'asset',
      ...Array(7).fill('shape'),
      'binding',
      'binding',
    ])
    expect(archive.assets).toEqual(MANIFEST)
    expect(archive.schema).toEqual(schema)
    // Deep copies: mutating the archive does not touch the board.
    ;(archive.records[2] as { x: number }).x = 999
    expect(records.some((record) => (record as { x?: number }).x === 999)).toBe(false)
    // Collaborator user ids are not written to the portable file.
    const exportedNotes = archive.records.filter((r) => r.typeName === 'shape' && r.type === 'note') as Json[]
    expect(exportedNotes.map((n) => n.props.textLastEditedBy)).toEqual([null, null])
    expect(JSON.stringify(archive)).not.toContain('user:someone')
    const source = records.find((r) => r.id === sid('n1')) as Json
    expect(source.props.textLastEditedBy).toBe('user:someone')
  })

  it('rejects a malformed manifest entry', () => {
    expectArchiveError(
      () =>
        exportBoardArchive([], draftroomSchema.serialize(), [
          { ...MANIFEST[0], sha256: 'nope' } as ArchiveAssetRef,
        ]),
      'invalid-asset-ref',
    )
  })
})

describe('importBoardArchive round trip', () => {
  it('re-creates the same shapes, bindings and assets with fresh ids on the target page', () => {
    const original = boardRecords()
    const result = importJson(archiveJson(original))
    validateAll(result.records)
    expect(result.warnings).toEqual([])
    expect(result.assets).toEqual(MANIFEST)

    const originalIds = new Set(original.map((record) => record.id as string))
    for (const record of result.records) expect(originalIds.has(record.id)).toBe(false)
    expect(result.records.some((record) => ['page', 'document', 'camera'].includes(record.typeName))).toBe(
      false,
    )

    const kept = original.filter((record) => ['shape', 'binding', 'asset'].includes(record.typeName))
    expect(semantic(result.records, [TARGET])).toEqual(semantic(kept, [PAGE]))
  })

  it('does not import attribution from a tampered archive', () => {
    const archive = archiveJson()
    for (const record of archive.records)
      if (record.type === 'note') record.props.textLastEditedBy = 'user:spoofed'
    const result = importJson(archive)
    const importedNotes = result.records.filter((r) => r.typeName === 'shape' && r.type === 'note') as Json[]
    expect(importedNotes).toHaveLength(2)
    expect(importedNotes.map((n) => n.props.textLastEditedBy)).toEqual([null, null])
  })

  it('accepts an archive of exactly the maximum record count', () => {
    const notes = Array.from({ length: ARCHIVE_LIMITS.maxRecords - 1 }, (_, i) =>
      note(`bulk${i}`, `note ${i}`, { x: (i % 100) * 220, y: Math.floor(i / 100) * 220 }),
    )
    const result = importJson(archiveJson([page(PAGE, 'Main'), ...notes]))
    expect(result.records).toHaveLength(ARCHIVE_LIMITS.maxRecords - 1)
    expect(new Set(result.records.map((r) => (r as TLShape).index)).size).toBe(result.records.length)
  })

  it('imports twice without id collisions', () => {
    const a = importJson(archiveJson())
    const b = importJson(archiveJson())
    const ids = [...a.records, ...b.records].map((record) => record.id)
    expect(new Set(ids).size).toBe(ids.length)
  })
})

describe('importBoardArchive rejects untrusted input with typed errors', () => {
  it('rejects values that are not archive objects', () => {
    for (const value of [null, undefined, [], 'archive', 42, true])
      expectArchiveError(() => importJson(value), 'invalid-envelope')
  })

  it('rejects the wrong format and unsupported versions', () => {
    expectArchiveError(() => importJson({ ...archiveJson(), format: 'tldraw-file' }), 'wrong-format')
    expectArchiveError(() => importJson({ ...archiveJson(), version: 2 }), 'unsupported-version')
    expectArchiveError(() => importJson({ ...archiveJson(), version: '1' }), 'unsupported-version')
  })

  it('enforces the strict envelope', () => {
    expectArchiveError(() => importJson({ ...archiveJson(), extra: true }), 'invalid-envelope')
    const { records: _r, ...noRecords } = archiveJson()
    expectArchiveError(() => importJson(noRecords), 'invalid-envelope')
    expectArchiveError(() => importJson({ ...archiveJson(), exportedAt: 'yesterday' }), 'invalid-envelope')
    expectArchiveError(() => importJson({ ...archiveJson(), assets: {} }), 'invalid-envelope')
  })

  it('caps the record count (default 20k) before reading records', () => {
    const tooMany = { ...archiveJson(), records: new Array(ARCHIVE_LIMITS.maxRecords + 1).fill(null) }
    const error = expectArchiveError(() => importJson(tooMany), 'too-large')
    expect(error.path).toBe('records')
    expectArchiveError(
      () => importBoardArchive(archiveJson(), { targetPageId: TARGET, limits: { maxRecords: 3 } }),
      'too-large',
    )
  })

  it('rejects oversized strings and hostile nesting', () => {
    const big = archiveJson([
      page(PAGE, 'Main'),
      note('huge', 'x'.repeat(ARCHIVE_LIMITS.maxStringLength + 1)),
    ])
    const error = expectArchiveError(() => importJson(big), 'too-large')
    expect(error.path).toMatch(/^records\[1\]\.props\.richText/)
    const deep = archiveJson()
    let nested: Record<string, unknown> = {}
    const meta = nested
    for (let i = 0; i < 100; i++) {
      const next = {}
      nested.child = next
      nested = next
    }
    deep.records[2].meta = meta
    expectArchiveError(() => importJson(deep), 'too-large')
  })

  it('rejects unknown shape types and invalid props', () => {
    const unknownType = archiveJson()
    unknownType.records[2].type = 'evil-shape'
    expectArchiveError(() => importJson(unknownType), 'unknown-shape-type')

    const noteIndex = archiveJson().records.findIndex((r: Json) => r.type === 'note')
    const badColor = archiveJson()
    badColor.records[noteIndex].props.color = 'chartreuse'
    const error = expectArchiveError(() => importJson(badColor), 'invalid-record')
    expect(error.path).toBe(`records[${noteIndex}]`)
    const extraProp = archiveJson()
    extraProp.records[noteIndex].props.onclick = 'alert(1)'
    expectArchiveError(() => importJson(extraProp), 'invalid-record')
    const badNumber = archiveJson()
    const geoIndex = badNumber.records.findIndex((r: Json) => r.type === 'geo')
    badNumber.records[geoIndex].props.w = -5
    expectArchiveError(() => importJson(badNumber), 'invalid-record')
    const badUrl = archiveJson()
    badUrl.records[noteIndex].props.url = 'javascript:alert(1)'
    expectArchiveError(() => importJson(badUrl), 'invalid-record')
  })

  it('rejects prototype-pollution keys anywhere', () => {
    const json = JSON.stringify(archiveJson())
    const cases = [
      json.replace('{', '{"__proto__":{"polluted":true},'),
      json.replace('"meta":{}', '"meta":{"__proto__":{"polluted":true}}'),
      json.replace('"props":{', '"props":{"constructor":{"prototype":{"polluted":true}},'),
      json.replace('"sequences":{', '"sequences":{"__proto__":1,'),
      json.replace('"assets":[{', '"assets":[{"prototype":1,'),
    ]
    for (const text of cases) {
      expect(text).not.toBe(json)
      expectArchiveError(() => importJson(JSON.parse(text)), 'forbidden-key')
    }
    expect(({} as Record<string, unknown>).polluted).toBeUndefined()
    expect((Object.prototype as unknown as Record<string, unknown>).polluted).toBeUndefined()
  })

  it('rejects session and presence records, unknown record types and bad ids', () => {
    const presence = { id: 'instance_presence:x', typeName: 'instance_presence', meta: {} }
    const instance = { id: 'instance:instance', typeName: 'instance', meta: {} }
    const pointer = {
      id: 'pointer:pointer',
      typeName: 'pointer',
      x: 0,
      y: 0,
      lastActivityTimestamp: 0,
      meta: {},
    }
    const pageState = { id: 'instance_page_state:page:main', typeName: 'instance_page_state', meta: {} }
    for (const record of [camera, presence, instance, pointer, pageState]) {
      const archive = archiveJson()
      archive.records.push(record)
      expectArchiveError(() => importJson(archive), 'forbidden-record-type')
    }
    for (const record of [
      { id: 'comment:1', typeName: 'comment' },
      { id: 'toString:1', typeName: 'toString' },
    ]) {
      const archive = archiveJson()
      archive.records.push(record)
      expectArchiveError(() => importJson(archive), 'unknown-record-type')
    }
    const binding = archiveJson()
    binding.records.find((r: Json) => r.typeName === 'binding').type = 'magnet'
    expectArchiveError(() => importJson(binding), 'unknown-record-type')
    const mismatched = archiveJson()
    mismatched.records[2].id = 'binding:sneaky'
    expectArchiveError(() => importJson(mismatched), 'invalid-record')
    const duplicate = archiveJson()
    duplicate.records.push(structuredClone(duplicate.records[2]))
    expectArchiveError(() => importJson(duplicate), 'duplicate-id')
  })

  it('rejects malformed, newer or tampered schemas', () => {
    const newer = archiveJson()
    newer.schema.sequences[`com.tldraw.shape.${FILE_CARD_TYPE}`] = 2
    expectArchiveError(() => importJson(newer), 'incompatible-schema')
    const v1 = archiveJson()
    v1.schema = { schemaVersion: 1, storeVersion: 4, recordVersions: {} }
    expectArchiveError(() => importJson(v1), 'invalid-schema')
    const negative = archiveJson()
    negative.schema.sequences['com.tldraw.shape.note'] = -1
    expectArchiveError(() => importJson(negative), 'invalid-schema')
    const extraKey = archiveJson()
    extraKey.schema.extra = 1
    expectArchiveError(() => importJson(extraKey), 'invalid-schema')
    // Unknown sequences (even ones named like Object.prototype members) are ignored with a warning.
    const unknown = archiveJson()
    unknown.schema.sequences.toString = 3
    unknown.schema.sequences['com.example.future'] = 1
    const result = importJson(unknown)
    expect(result.warnings.join('\n')).toMatch(/2 unknown migration sequence/)
  })

  it('rejects malformed manifest entries', () => {
    const bad = archiveJson()
    bad.assets[0].sha256 = 'not-a-hash'
    expectArchiveError(() => importJson(bad), 'invalid-asset-ref')
    const extra = archiveJson()
    extra.assets[0].url = 'https://signed.example/x?sig=1'
    expectArchiveError(() => importJson(extra), 'invalid-asset-ref')
    const tooMany = { ...archiveJson(), assets: new Array(ARCHIVE_LIMITS.maxAssets + 1).fill(MANIFEST[0]) }
    expectArchiveError(() => importJson(tooMany), 'too-large')
  })

  it('rejects non-JSON values, accessors and exotic objects without throwing anything else', () => {
    const withFunction = archiveJson()
    withFunction.records[2].meta = { fn: () => 1 }
    expectArchiveError(() => importJson(withFunction), 'invalid-input')
    const withMap = archiveJson()
    withMap.records[2].props = new Map()
    expectArchiveError(() => importJson(withMap), 'invalid-input')
    const withNaN = archiveJson()
    withNaN.records[2].x = Number.NaN
    expectArchiveError(() => importJson(withNaN), 'invalid-input')
    const withGetter = archiveJson()
    Object.defineProperty(withGetter.records[2], 'x', { get: () => 1, enumerable: true })
    expectArchiveError(() => importJson(withGetter), 'invalid-input')
    const sparse = archiveJson()
    sparse.records.length += 3
    expectArchiveError(() => importJson(sparse), 'invalid-input')
    const hostile = new Proxy(archiveJson(), {
      ownKeys() {
        throw new Error('trap')
      },
    })
    expectArchiveError(() => importJson(hostile), 'invalid-input')
  })

  it('rejects an invalid target page with TypeError', () => {
    expect(() => importBoardArchive(archiveJson(), { targetPageId: 'shape:x' as TLPageId })).toThrow(
      TypeError,
    )
  })
})

describe('importBoardArchive migrations', () => {
  it('migrates dr-file-card v0 records (no posterDerivativeId) to the current schema', () => {
    const old = archiveJson()
    old.schema.sequences[`com.tldraw.shape.${FILE_CARD_TYPE}`] = 0
    const card = old.records.find((r: Json) => r.type === FILE_CARD_TYPE)
    delete card.props.posterDerivativeId
    // Unmigrated, the record is invalid for today's schema.
    expect(() => draftroomSchema.types.shape.validate(card)).toThrow()
    const result = importJson(old)
    const imported = result.records.find((r) => r.typeName === 'shape' && r.type === FILE_CARD_TYPE) as Json
    expect(imported.props.posterDerivativeId).toBeNull()
    expect(imported.props).toMatchObject({ assetId: AST, versionId: VER, name: 'deck.pdf' })
    validateAll(result.records)
  })

  it('migrates archives with an older store version through the snapshot path', () => {
    const old = archiveJson()
    old.schema.sequences['com.tldraw.store'] = 4
    const result = importJson(old)
    validateAll(result.records)
    expect(result.records.filter((r) => r.typeName === 'shape')).toHaveLength(7)
  })

  it('reports a migration that cannot run as a typed error', () => {
    const old = archiveJson()
    // Claims notes predate rich text, but the records carry no `text` to migrate from.
    old.schema.sequences['com.tldraw.shape.note'] = 8
    expectArchiveError(() => importJson(old), 'migration-failed')
  })
})

describe('importBoardArchive policy', () => {
  it('clears non-stable file sources and dangling asset references', () => {
    const archive = archiveJson()
    archive.records.push(
      imageAsset('inline', 'data:image/png;base64,AAAA'),
      imageAsset('hosted', 'https://cdn.example.com/x.png?X-Amz-Signature=abc'),
      image('dangling', 'asset:missing', { index: 'a9' }),
    )
    const result = importJson(archive)
    validateAll(result.records)
    const srcs = result.records.filter((r) => r.typeName === 'asset').map((r) => (r as Json).props.src)
    expect(srcs.sort()).toEqual([`/files/${AST}/${VER}/original`, null, null].sort())
    const images = result.records.filter((r) => r.typeName === 'shape' && r.type === 'image') as Json[]
    expect(images.map((shape) => shape.props.assetId === null)).toContain(true)
    expect(result.warnings.join('\n')).toMatch(/Cleared 2 file source/)
    expect(result.warnings.join('\n')).toMatch(/Cleared 1 reference/)
  })

  it('places every page and every orphan on the target page, dropping document and user records', () => {
    const archive = archiveJson([
      ...boardRecords(),
      page(PAGE_2, 'Two', 'a2'),
      note('p2', 'from page two', { parentId: PAGE_2 }),
      note('orphan', 'lost', { parentId: sid('deleted') }),
    ])
    archive.records.push(documentRecord(), {
      id: 'user:ann',
      typeName: 'user',
      name: 'Ann',
      color: '#ff0000',
      imageUrl: '',
      meta: {},
    })
    const result = importJson(archive)
    const topLevel = result.records.filter((r) => r.typeName === 'shape' && !r.parentId.startsWith('shape:'))
    expect(topLevel.every((shape) => (shape as TLShape).parentId === TARGET)).toBe(true)
    expect(topLevel).toHaveLength(7) // f, g, a, i, fc, p2, orphan
    const warnings = result.warnings.join('\n')
    expect(warnings).toMatch(/2 pages/)
    expect(warnings).toMatch(/1 shape\(s\) had a missing parent/)
    expect(warnings).toMatch(/Left out 2 board-settings\/user record/)
    expect(result.records.some((r) => r.typeName === 'user' || r.typeName === 'document')).toBe(false)
  })

  it('warns about files that are referenced but missing from the manifest', () => {
    const result = importJson(archiveJson(boardRecords(), []))
    expect(result.assets).toEqual([])
    expect(result.warnings.join('\n')).toMatch(/1 referenced file\(s\) are not listed/)
  })
})

describe('importBoardArchive adversarial review', () => {
  const bindingsOf = (records: TLRecord[]) =>
    records.filter((r) => r.typeName === 'binding') as unknown as {
      fromId: string
      toId: string
      props: { terminal: string }
    }[]

  it('breaks parent cycles: every imported shape reaches the target page', () => {
    const archive = archiveJson([
      page(PAGE, 'Main'),
      frame('c1', 'Cycle 1', { parentId: sid('c2') }),
      frame('c2', 'Cycle 2', { parentId: sid('c1'), index: 'a2' }),
      note('inside', 'in the cycle', { parentId: sid('c1') }),
      frame('self', 'Self parent', { parentId: sid('self'), index: 'a3' }),
    ])
    const result = importJson(archive)
    validateAll(result.records)
    const parents = new Map(
      result.records
        .filter((r): r is TLShape => r.typeName === 'shape')
        .map((shape) => [shape.id as string, shape.parentId as string]),
    )
    expect(parents.size).toBe(4)
    for (const start of parents.keys()) {
      let current: string | undefined = start
      for (let steps = 0; current?.startsWith('shape:'); steps++) {
        expect(steps).toBeLessThan(5)
        current = parents.get(current)
      }
      expect(current).toBe(TARGET)
    }
  })

  it('drops arrow bindings tldraw cannot hold (non-arrow source, arrow target, self, repeated terminal)', () => {
    const archive = archiveJson([
      page(PAGE, 'Main'),
      geo('g1', 'one'),
      geo('g2', 'two', { index: 'a2' }),
      arrow('a', '', { index: 'a3' }),
      arrow('b', '', { index: 'a4' }),
      arrowBinding('ok-start', sid('a'), sid('g1'), 'start'),
      arrowBinding('ok-end', sid('a'), sid('g2'), 'end'),
      // tldraw's ArrowBindingUtil casts `fromId` to an arrow shape and reads its arrow props.
      arrowBinding('from-geo', sid('g1'), sid('g2'), 'start'),
      // ArrowShapeUtil.canBind: arrows never bind to arrows (and so never to themselves).
      arrowBinding('to-arrow', sid('b'), sid('a'), 'start'),
      arrowBinding('to-self', sid('b'), sid('b'), 'end'),
      // A second binding for a terminal that is already bound.
      arrowBinding('second-start', sid('a'), sid('g2'), 'start'),
    ])
    const result = importJson(archive)
    validateAll(result.records)
    const shapes = new Map(
      result.records.filter((r): r is TLShape => r.typeName === 'shape').map((s) => [s.id as string, s]),
    )
    const bindings = bindingsOf(result.records)
    expect(bindings).toHaveLength(2)
    for (const binding of bindings) {
      expect(shapes.get(binding.fromId)?.type).toBe('arrow')
      expect(shapes.get(binding.toId)?.type).toBe('geo')
    }
    expect(bindings.map((b) => b.props.terminal).sort()).toEqual(['end', 'start'])
    expect(result.warnings.join('\n')).toMatch(/Dropped 4 arrow binding/)
  })

  it('keeps an arrow whose two ends are bound to the same shape', () => {
    const archive = archiveJson([
      page(PAGE, 'Main'),
      geo('loop', 'loop'),
      arrow('a', '', { index: 'a2' }),
      arrowBinding('s', sid('a'), sid('loop'), 'start'),
      arrowBinding('e', sid('a'), sid('loop'), 'end'),
    ])
    const result = importJson(archive)
    expect(
      bindingsOf(result.records)
        .map((b) => b.props.terminal)
        .sort(),
    ).toEqual(['end', 'start'])
    expect(result.warnings).toEqual([])
  })

  it('keeps an asset shared by two image shapes shared', () => {
    const archive = archiveJson([
      page(PAGE, 'Main'),
      imageAsset('shared'),
      image('i1', 'asset:shared'),
      image('i2', 'asset:shared', { x: 400, index: 'a2' }),
    ])
    const result = importJson(archive)
    const assets = result.records.filter((r) => r.typeName === 'asset')
    expect(assets).toHaveLength(1)
    const refs = result.records
      .filter((r): r is TLShape => r.typeName === 'shape')
      .map((s) => (s.props as { assetId: string }).assetId)
    expect(refs).toEqual([assets[0]?.id, assets[0]?.id])
  })

  it('ignores limit overrides that are not finite non-negative numbers', () => {
    const tooMany = { ...archiveJson(), records: new Array(ARCHIVE_LIMITS.maxRecords + 1).fill(null) }
    for (const maxRecords of [undefined, Number.NaN, Number.POSITIVE_INFINITY, -1, '1e9']) {
      expectArchiveError(
        () =>
          importBoardArchive(tooMany, { targetPageId: TARGET, limits: { maxRecords: maxRecords as never } }),
        'too-large',
      )
    }
    const deep = archiveJson()
    let nested: Record<string, unknown> = {}
    deep.records[2].meta = nested
    for (let i = 0; i < 100; i++) {
      const next = {}
      nested.child = next
      nested = next
    }
    expectArchiveError(
      () => importBoardArchive(deep, { targetPageId: TARGET, limits: { maxDepth: undefined as never } }),
      'too-large',
    )
  })

  it('rejects 100k-deep JSON and huge arrays with typed errors, quickly', () => {
    const depth = 100_000
    const deepText = JSON.stringify(archiveJson()).replace(
      '"meta":{}',
      `"meta":{"x":${'['.repeat(depth)}${']'.repeat(depth)}}`,
    )
    const start = Date.now()
    expectArchiveError(() => importJson(JSON.parse(deepText)), 'too-large')
    const wide = archiveJson()
    wide.records[2].meta = { list: new Array(50_000).fill(0) }
    expectArchiveError(
      () => importBoardArchive(wide, { targetPageId: TARGET, limits: { maxNodes: 10_000 } }),
      'too-large',
    )
    expect(Date.now() - start).toBeLessThan(2000)
  })

  it('rejects ids whose prefix does not match the typeName for every record type', () => {
    for (const [typeName, id] of [
      ['asset', 'shape:img'],
      ['binding', 'asset:b'],
      ['shape', 'shapes:x'],
      ['shape', 'shape'],
    ] as const) {
      const archive = archiveJson()
      const record = archive.records.find((r: Json) => r.typeName === typeName)
      record.id = id
      expectArchiveError(() => importJson(archive), 'invalid-record')
    }
  })
})

describe('importBoardArchive embed policy (adversarial review)', () => {
  const embed = (name: string, url: string, index: string) =>
    ({
      id: sid(name),
      typeName: 'shape',
      type: 'embed',
      x: 0,
      y: 0,
      rotation: 0,
      index,
      parentId: PAGE,
      isLocked: false,
      opacity: 1,
      meta: {},
      props: { w: 560, h: 315, url },
    }) as unknown as TLRecord

  it('clears embed URLs that are not http(s): the embed prop is a bare string and becomes an iframe src', () => {
    const records = [
      page(PAGE, 'Main'),
      embed('video', 'https://www.youtube.com/watch?v=abc123', 'a1'),
      embed('js', 'javascript:alert(document.domain)', 'a2'),
      embed('html', 'data:text/html,<form action=https://evil.example>', 'a3'),
      embed('file', 'file:///etc/passwd', 'a4'),
      embed('blob', 'blob:https://app.example/1234', 'a5'),
    ]
    validateAll(records)
    const result = importJson(archiveJson(records))
    validateAll(result.records)
    const urls = result.records
      .filter((r): r is TLShape => r.typeName === 'shape')
      .map((s) => (s.props as { url: string }).url)
    expect(urls).toEqual(['https://www.youtube.com/watch?v=abc123', '', '', '', ''])
    expect(result.warnings.join('\n')).toMatch(/Cleared 4 embed URL/)
  })
})
