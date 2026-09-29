// Board archive v2 (.lobby.json on the new canvas) and the v1 reader (tldraw archives through the
// converter, injected as the api will inject packages/tldraw-import's convertBoard).

import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { draftroomSchema } from '@draftroom/canvas-schema'
import { checkElement } from '@draftroom/canvas-schema/elements'
import { checkInvariants } from '@draftroom/canvas-schema/invariants'
import { ELEMENT_SCHEMA_VERSION } from '@draftroom/canvas-schema/protocol'
import type { TLRecord } from '@tldraw/tlschema'
import { describe, expect, it } from 'vitest'
import { convertBoard } from '../../../tldraw-import/src/index.ts'
import { exportBoardArchive } from '../archive.ts'
import {
  arrow,
  arrowBinding,
  documentRecord,
  frame,
  geo,
  note,
  PAGE,
  PAGE_2,
  page,
  sid,
  text,
} from '../test-fixtures.ts'
import { importAnyBoardArchive, type V1Converter } from './archive-v1.ts'
import {
  ARCHIVE_ENGINE_VERSION,
  ArchiveError,
  exportElementArchive,
  frameOutlineOf,
  importElementArchive,
  searchElements,
} from './index.ts'
import { metrics, SAMPLE_ASSET, SAMPLE_DOC, sampleBoard, seqIds } from './test-kit.ts'

type Any = Record<string, unknown>

/** A two-page tldraw board: a frame with a (bold) note, two boxes bound by an arrow, a text on page 2. */
function v1Records(): TLRecord[] {
  const bold = {
    type: 'doc',
    content: [
      { type: 'paragraph', content: [{ type: 'text', text: 'Bold idea', marks: [{ type: 'bold' }] }] },
    ],
  }
  return [
    documentRecord(),
    page(PAGE, 'Page 1', 'a1'),
    page(PAGE_2, 'Page 2', 'a2'),
    frame('f1', 'Ideas', { w: 600, h: 400 }),
    note('n1', bold as never, { parentId: sid('f1'), x: 20, y: 60 }),
    geo('g1', 'Start', { x: 700, y: 0 }),
    geo('g2', 'End', { x: 1000, y: 0 }),
    arrow('a1', '', { x: 800, y: 50, index: 'a5' }),
    arrowBinding('b1', sid('a1'), sid('g1'), 'start'),
    arrowBinding('b2', sid('a1'), sid('g2'), 'end'),
    text('t1', 'Second page words', { parentId: PAGE_2 }),
  ] as TLRecord[]
}
const board = sampleBoard()
const archive = () =>
  JSON.parse(JSON.stringify(exportElementArchive(board, SAMPLE_DOC, [SAMPLE_ASSET]))) as Any
const codeOf = (fn: () => unknown): string => {
  try {
    fn()
  } catch (e) {
    expect(e).toBeInstanceOf(ArchiveError)
    return (e as ArchiveError).code
  }
  throw new Error('expected an ArchiveError')
}

describe('archive v2 export', () => {
  const a = exportElementArchive(board, SAMPLE_DOC, [SAMPLE_ASSET], { exportedAt: new Date(0) })

  it('has the plan §3.7 envelope, pinned to the installed engine', () => {
    expect(Object.keys(a)).toEqual([
      'format',
      'version',
      'engine',
      'engineVersion',
      'schema',
      'exportedAt',
      'elements',
      'doc',
      'assets',
    ])
    expect([a.format, a.version, a.engine, a.schema, a.exportedAt]).toEqual([
      'lobby-board',
      2,
      'excalidraw',
      ELEMENT_SCHEMA_VERSION,
      '1970-01-01T00:00:00.000Z',
    ])
    const pkg = resolve(
      dirname(fileURLToPath(import.meta.url)),
      '../../../canvas-schema/node_modules/@excalidraw/element/package.json',
    )
    expect(a.engineVersion).toBe(JSON.parse(readFileSync(pkg, 'utf8')).version)
    expect(ARCHIVE_ENGINE_VERSION).toBe(a.engineVersion)
  })

  it('keeps live elements in paint order and leaves identities out of the file', () => {
    expect(a.elements.map((e) => e.id)).toEqual(board.filter((e) => !e.isDeleted).map((e) => e.id))
    const text = JSON.stringify(a)
    for (const who of ['usr_alice', 'usr_bob', 'Alice', 'Bob', 'lobbyServer', 'plusOne:', '"ai"', '"status"'])
      expect(text).not.toContain(who)
    const note = a.elements.find((e) => e.id === 'N') as Any
    expect((note.customData as Any).lobby).toEqual({
      'tag:research': { name: 'research', color: 'blue' },
      mindmap: { rootId: 'N', parentId: null, side: 'right', collapsed: false },
    })
    for (const e of a.elements) expect(checkElement(e), e.id).toMatchObject({ ok: true })
  })

  it("keeps the doc keys a client may write, never the server's import record", () => {
    expect(a.doc).toEqual({
      startView: SAMPLE_DOC.startView,
      'tagDef:research': SAMPLE_DOC['tagDef:research'],
      workshop: SAMPLE_DOC.workshop,
    })
  })

  it('refuses a malformed manifest entry', () => {
    expect(codeOf(() => exportElementArchive(board, {}, [{ ...SAMPLE_ASSET, sha256: 'x' }]))).toBe(
      'invalid-asset-ref',
    )
  })
})

describe('archive v2 import', () => {
  it('round-trips: fresh ids, the same structure, valid for the server, on top of the target', () => {
    const imported = importElementArchive(archive(), { indexAbove: 'a5', newId: seqIds('m'), now: 3 })
    expect(imported.from).toBe(2)
    expect(imported.warnings).toEqual([])
    const els = imported.elements
    expect(els).toHaveLength(board.length - 1)
    for (const e of els) {
      expect(e.id).toMatch(/^m\d+$/)
      expect(checkElement(e), e.id).toMatchObject({ ok: true })
      expect((e.index as string) > 'a5').toBe(true)
    }
    expect(checkInvariants(els)).toEqual([])
    expect(frameOutlineOf(els).map((f) => f.name)).toEqual(['Ideas', 'Parking lot'])
    expect(searchElements(els, 'cafe')[0]?.id).toBe(imported.idMap.get('N'))
    // the slide order survives an import (present.index kept), tags with their definitions
    const f = els.find((e) => e.id === imported.idMap.get('F'))
    expect(f?.customData?.lobby).toEqual({ present: { index: 2 } })
    expect(imported.doc).toEqual({
      startView: { ...SAMPLE_DOC.startView, frameId: imported.idMap.get('F') },
      'tagDef:research': SAMPLE_DOC['tagDef:research'],
      workshop: SAMPLE_DOC.workshop,
    })
    expect(imported.assets).toEqual([SAMPLE_ASSET])
  })

  it('moves the import by an offset, and refuses one that leaves the canvas', () => {
    const moved = importElementArchive(archive(), { offset: { x: 100, y: 50 }, newId: seqIds() })
    const n = moved.elements.find((e) => e.id === moved.idMap.get('N'))
    expect([n?.x, n?.y]).toEqual([140, 150])
    expect(codeOf(() => importElementArchive(archive(), { offset: { x: 999_000, y: 0 } }))).toBe(
      'invalid-record',
    )
  })

  it('removes tags the archive does not define, and doc keys a client may not write', () => {
    const a = archive()
    delete (a.doc as Any)['tagDef:research']
    ;(a.doc as Any).import = SAMPLE_DOC.import
    ;(a.doc as Any).madeUp = 1
    const imported = importElementArchive(a)
    const note = imported.elements.find((e) => e.id === imported.idMap.get('N'))
    expect(note?.customData?.lobby?.['tag:research']).toBeUndefined()
    expect(imported.doc.import).toBeUndefined()
    expect(imported.warnings).toEqual([
      'Left out 2 board setting(s) that cannot be imported.',
      'Removed 1 tag(s) the archive does not define.',
    ])
  })

  it('repairs references to elements the archive does not hold, and says so', () => {
    const a = archive()
    a.elements = (a.elements as Any[]).filter((e) => e.id !== 'E')
    const imported = importElementArchive(a)
    const arrow = imported.elements.find((e) => e.id === imported.idMap.get('A'))
    expect(arrow?.type === 'arrow' && arrow.endBinding).toBeNull()
    expect(imported.warnings.some((w) => /^Repaired \d+ reference/.test(w))).toBe(true)
    expect(checkInvariants(imported.elements)).toEqual([])
  })

  it('warns about files missing from the manifest and deleted elements', () => {
    const a = archive()
    a.assets = []
    ;(a.elements as Any[]).push({ ...(a.elements as Any[])[0], id: 'gone', isDeleted: true })
    expect(importElementArchive(a).warnings).toEqual([
      'Left out 1 deleted element(s).',
      '1 referenced file(s) are not listed in the archive manifest.',
    ])
  })

  it.each([
    ['not an object', () => 'x', 'invalid-envelope'],
    ['another format', (a: Any) => ({ ...a, format: 'excalidraw' }), 'wrong-format'],
    ['another version', (a: Any) => ({ ...a, version: 3 }), 'unsupported-version'],
    ['an unknown key', (a: Any) => ({ ...a, extra: 1 }), 'invalid-envelope'],
    [
      'a __proto__ key',
      (a: Any) => JSON.parse(JSON.stringify(a).replace('"format"', '"__proto__":{},"format"')),
      'forbidden-key',
    ],
    ['another engine', (a: Any) => ({ ...a, engine: 'tldraw' }), 'invalid-envelope'],
    [
      'a newer element schema',
      (a: Any) => ({ ...a, schema: ELEMENT_SCHEMA_VERSION + 1 }),
      'incompatible-schema',
    ],
    ['a bad date', (a: Any) => ({ ...a, exportedAt: 'soon' }), 'invalid-envelope'],
    ['elements not a list', (a: Any) => ({ ...a, elements: {} }), 'invalid-envelope'],
    [
      'an iframe',
      (a: Any) => ({ ...a, elements: [{ ...(a.elements as Any[])[0], id: 'i', type: 'iframe' }] }),
      'forbidden-record-type',
    ],
    ['an unknown type', (a: Any) => ({ ...a, elements: [{ id: 'u', type: 'blob' }] }), 'unknown-shape-type'],
    [
      'a duplicate id',
      (a: Any) => ({ ...a, elements: [(a.elements as Any[])[0], (a.elements as Any[])[0]] }),
      'duplicate-id',
    ],
    [
      'an element the server refuses',
      (a: Any) => ({ ...a, elements: [{ ...(a.elements as Any[])[0], fontFamily: 9, x: 'far' }] }),
      'invalid-record',
    ],
    [
      'a javascript: link',
      (a: Any) => ({ ...a, elements: [{ ...(a.elements as Any[])[0], link: 'javascript:alert(1)' }] }),
      'invalid-record',
    ],
    [
      'an unknown customData key',
      (a: Any) => ({ ...a, elements: [{ ...(a.elements as Any[])[0], customData: { lobby: { evil: 1 } } }] }),
      'invalid-record',
    ],
  ])('refuses %s', (_label, mutate, code) => {
    expect(codeOf(() => importElementArchive((mutate as (a: Any) => unknown)(archive())))).toBe(code)
  })

  it('refuses more elements than the cap, before copying anything', () => {
    const a = archive()
    a.elements = Array.from({ length: 3 }, (_, i) => ({ ...(a.elements as Any[])[1], id: `n${i}` }))
    expect(codeOf(() => importElementArchive(a, { limits: { maxRecords: 2 } }))).toBe('too-large')
  })

  it('points a v1 archive at the v1 reader', () => {
    const v1 = exportBoardArchive(v1Records(), draftroomSchema.serialize(), [])
    expect(codeOf(() => importElementArchive(JSON.parse(JSON.stringify(v1))))).toBe('unsupported-version')
  })
})

describe('archive v1 through the converter (importAnyBoardArchive)', () => {
  const convertV1: V1Converter = (records) => convertBoard(records as never, { updatedAt: 1, metrics })
  const v1 = () => {
    return JSON.parse(JSON.stringify(exportBoardArchive(v1Records(), draftroomSchema.serialize(), []))) as Any
  }

  it('imports a tldraw archive as elements the server accepts, with fresh ids and a lossy report', () => {
    const imported = importAnyBoardArchive(v1(), { convertV1, newId: seqIds('v') })
    expect(imported.from).toBe(1)
    expect(imported.elements.length).toBeGreaterThan(0)
    for (const e of imported.elements) {
      expect(e.id).toMatch(/^v\d+$/)
      expect(checkElement(e), e.id).toMatchObject({ ok: true })
      expect(e.customData?.lobbyServer).toBeUndefined()
    }
    expect(checkInvariants(imported.elements)).toEqual([])
    expect(typeof imported.lossy).toBe('object')
  })

  it('needs the converter for v1, and reads v2 like importElementArchive', () => {
    expect(codeOf(() => importAnyBoardArchive(v1()))).toBe('unsupported-version')
    const v2 = importAnyBoardArchive(archive(), { convertV1 })
    expect(v2.from).toBe(2)
    expect(v2.elements).toHaveLength(board.length - 1)
  })

  it("keeps v1's own checks (a v1 archive the tldraw import refuses is refused)", () => {
    const bad = v1()
    bad.version = 7
    expect(codeOf(() => importAnyBoardArchive(bad, { convertV1 }))).toBe('unsupported-version')
    const evil = v1()
    ;(evil.records as Any[]).push({ id: 'shape:x', typeName: 'shape', type: 'nope' })
    expect(codeOf(() => importAnyBoardArchive(evil, { convertV1 }))).toBe('unknown-shape-type')
  })

  it('refuses a board the converter could not convert', () => {
    const failing: V1Converter = (records) => ({
      ...convertV1(records),
      failures: [{ id: 'shape:x', code: 'INVALID', detail: 'x' }],
    })
    expect(codeOf(() => importAnyBoardArchive(v1(), { convertV1: failing }))).toBe('invalid-record')
  })

  it('puts every page on the one canvas (as the v1 import always has), and keeps the frames and words', () => {
    const imported = importAnyBoardArchive(v1(), { convertV1 })
    expect(imported.lossy).toEqual({ 'rich-text-formatting': 1 })
    expect(imported.warnings).toEqual([
      'The archive has 2 pages; all of their content was placed on one page.',
      'Converted from the old canvas; not everything carries over: rich-text-formatting 1.',
    ])
    expect(frameOutlineOf(imported.elements).map((f) => f.name)).toEqual(['Ideas'])
    expect(searchElements(imported.elements, 'bold idea')[0]?.kind).toBe('note')
    expect(searchElements(imported.elements, 'second page')[0]?.kind).toBe('text')
    const arrowEl = imported.elements.find((e) => e.type === 'arrow')
    expect(arrowEl?.type === 'arrow' && [!!arrowEl.startBinding, !!arrowEl.endBinding]).toEqual([true, true])
  })
})
