// Test-only builders for real tldraw 5.4.2 records (default props from the tldraw ShapeUtils'
// getDefaultProps). Not exported from the package index.
import { FILE_CARD_TYPE } from '@draftroom/canvas-schema'
import { draftroomSchema } from './schema.ts'
import type {
  TLArrowBinding,
  TLAsset,
  TLDocument,
  TLPage,
  TLPageId,
  TLParentId,
  TLRecord,
  TLRichText,
  TLShape,
  TLShapeId,
} from './tldraw.ts'
import { type IndexKey, type JsonObject, toRichText } from './tldraw.ts'

export const PAGE: TLPageId = 'page:main' as TLPageId
export const PAGE_2: TLPageId = 'page:second' as TLPageId

export const sid = (name: string) => `shape:${name}` as TLShapeId

interface Base {
  x?: number
  y?: number
  rotation?: number
  parentId?: TLParentId
  index?: string
  meta?: JsonObject
}

function base(type: string, name: string, b: Base) {
  return {
    id: sid(name),
    typeName: 'shape' as const,
    type,
    x: b.x ?? 0,
    y: b.y ?? 0,
    rotation: b.rotation ?? 0,
    index: (b.index ?? 'a1') as IndexKey,
    parentId: b.parentId ?? PAGE,
    isLocked: false,
    opacity: 1,
    meta: b.meta ?? {},
  }
}

export function page(id: TLPageId, name: string, index = 'a1'): TLPage {
  return { id, typeName: 'page', name, index: index as IndexKey, meta: {} }
}

export function documentRecord(): TLDocument {
  return {
    id: 'document:document',
    typeName: 'document',
    gridSize: 10,
    name: 'Board',
    meta: {},
  } as TLDocument
}

export function note(
  name: string,
  text: string | TLRichText,
  b: Base & { color?: string; textLastEditedBy?: string | null } = {},
): TLShape {
  return {
    ...base('note', name, b),
    props: {
      color: b.color ?? 'yellow',
      richText: typeof text === 'string' ? toRichText(text) : text,
      size: 'm',
      font: 'draw',
      align: 'middle',
      verticalAlign: 'middle',
      labelColor: 'black',
      growY: 0,
      fontSizeAdjustment: 1,
      url: '',
      scale: 1,
      textLastEditedBy: b.textLastEditedBy ?? null,
    },
  } as TLShape
}

export function text(name: string, value: string, b: Base = {}): TLShape {
  return {
    ...base('text', name, b),
    props: {
      color: 'black',
      size: 'm',
      w: 200,
      font: 'draw',
      textAlign: 'start',
      autoSize: true,
      scale: 1,
      richText: toRichText(value),
    },
  } as TLShape
}

export function geo(
  name: string,
  label: string,
  b: Base & { w?: number; h?: number; color?: string } = {},
): TLShape {
  return {
    ...base('geo', name, b),
    props: {
      w: b.w ?? 100,
      h: b.h ?? 100,
      geo: 'rectangle',
      dash: 'draw',
      growY: 0,
      url: '',
      scale: 1,
      flipX: false,
      flipY: false,
      color: b.color ?? 'black',
      labelColor: 'black',
      fill: 'none',
      size: 'm',
      font: 'draw',
      align: 'middle',
      verticalAlign: 'middle',
      richText: toRichText(label),
    },
  } as TLShape
}

export function frame(name: string, title: string, b: Base & { w?: number; h?: number } = {}): TLShape {
  return {
    ...base('frame', name, b),
    props: { w: b.w ?? 320, h: b.h ?? 180, name: title, color: 'black' },
  } as TLShape
}

export function group(name: string, b: Base = {}): TLShape {
  return { ...base('group', name, b), props: {} } as TLShape
}

export function arrow(name: string, label: string, b: Base = {}): TLShape {
  return {
    ...base('arrow', name, b),
    props: {
      kind: 'arc',
      elbowMidPoint: 0.5,
      dash: 'draw',
      size: 'm',
      fill: 'none',
      color: 'black',
      labelColor: 'black',
      bend: 0,
      start: { x: 0, y: 0 },
      end: { x: 200, y: 0 },
      arrowheadStart: 'none',
      arrowheadEnd: 'arrow',
      richText: toRichText(label),
      labelPosition: 0.5,
      font: 'draw',
      scale: 1,
    },
  } as TLShape
}

export function arrowBinding(
  name: string,
  arrowId: TLShapeId,
  toId: TLShapeId,
  terminal: 'start' | 'end',
): TLArrowBinding {
  return {
    id: `binding:${name}`,
    typeName: 'binding',
    type: 'arrow',
    fromId: arrowId,
    toId,
    props: { terminal, normalizedAnchor: { x: 0.5, y: 0.5 }, isExact: false, isPrecise: false, snap: 'none' },
    meta: {},
  } as TLArrowBinding
}

export const AST = 'ast_0123456789abcdef'
export const VER = 'ver_0123456789abcdef'
export const SHA = 'a'.repeat(64)

export function imageAsset(name: string, src: string | null = `/files/${AST}/${VER}/original`): TLAsset {
  return {
    id: `asset:${name}`,
    typeName: 'asset',
    type: 'image',
    props: { w: 640, h: 480, name: 'photo.png', isAnimated: false, mimeType: 'image/png', src },
    meta: {},
  } as TLAsset
}

export function image(name: string, assetId: string | null, b: Base & { altText?: string } = {}): TLShape {
  return {
    ...base('image', name, b),
    props: {
      w: 320,
      h: 240,
      assetId,
      playing: true,
      url: '',
      crop: null,
      flipX: false,
      flipY: false,
      altText: b.altText ?? '',
    },
  } as TLShape
}

export function fileCard(name: string, fileName: string, b: Base = {}): TLShape {
  return {
    ...base(FILE_CARD_TYPE, name, b),
    props: {
      w: 240,
      h: 160,
      assetId: AST,
      versionId: VER,
      kind: 'pdf',
      name: fileName,
      mimeType: 'application/pdf',
      sizeBytes: 2274,
      status: 'ready',
      pageCount: 4,
      durationMs: null,
      posterDerivativeId: null,
    },
  } as TLShape
}

/** Throws (with the tldraw validation message) unless the record passes `draftroomSchema`. */
export function validate(record: unknown): void {
  const typeName = (record as { typeName: string }).typeName
  const type = (draftroomSchema.types as Record<string, { validate(r: unknown): unknown }>)[typeName]
  if (!type) throw new Error(`unknown typeName ${typeName}`)
  type.validate(record)
}

export function validateAll(records: readonly unknown[]): void {
  for (const record of records) validate(record)
}

export function byId(records: readonly TLRecord[]): Map<string, TLRecord> {
  return new Map(records.map((record) => [record.id, record]))
}

export function shapesOf(records: readonly TLRecord[]): TLShape[] {
  return records.filter((record): record is TLShape => record.typeName === 'shape')
}

/** Minimal RFC 4180 reader for asserting on CSV output (keeps every field verbatim). */
export function readCsv(csv: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let quoted = false
  for (let i = 0; i < csv.length; i++) {
    const ch = csv[i] as string
    if (quoted) {
      if (ch === '"' && csv[i + 1] === '"') {
        field += '"'
        i++
      } else if (ch === '"') quoted = false
      else field += ch
    } else if (ch === '"') quoted = true
    else if (ch === ',') {
      row.push(field)
      field = ''
    } else if (ch === '\r' && csv[i + 1] === '\n') {
      row.push(field)
      rows.push(row)
      row = []
      field = ''
      i++
    } else field += ch
  }
  if (field !== '' || row.length > 0) {
    row.push(field)
    rows.push(row)
  }
  return rows
}
