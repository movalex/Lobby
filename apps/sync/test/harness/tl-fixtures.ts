// tldraw 5.4.2 record builders for the tests that still make boards of the tldraw era (the conversion,
// the roll-forward, backups and restores of such files). Every record is validated against the era's
// one server schema (packages/tldraw-import/src/schema.ts), so a fixture that drifts fails here, not as a
// confusing converter error. tldraw symbols come from tldraw-import only (D13).
import { draftroomSchema } from '@draftroom/tldraw-import/schema'
import {
  createBindingId,
  createShapeId,
  type TLBinding,
  type TLShape,
  toRichText,
} from '@draftroom/tldraw-import/tldraw'

export const PAGE = 'page:page'

const base = (id: string, type: string, over: Partial<TLShape> = {}) => ({
  id: id.startsWith('shape:') ? id : createShapeId(id),
  typeName: 'shape',
  type,
  x: 0,
  y: 0,
  rotation: 0,
  index: 'a1',
  parentId: PAGE,
  isLocked: false,
  opacity: 1,
  meta: {},
  ...over,
})

const shape = (rec: object) => draftroomSchema.types.shape.validate(rec) as TLShape

export function note(id: string, text: string, over: Partial<TLShape> = {}): TLShape {
  return shape({
    ...base(id, 'note', over),
    props: {
      color: 'yellow',
      labelColor: 'black',
      size: 'm',
      font: 'draw',
      fontSizeAdjustment: 1,
      align: 'middle',
      verticalAlign: 'middle',
      growY: 0,
      url: '',
      richText: toRichText(text),
      scale: 1,
      textLastEditedBy: null,
    },
  })
}

export function geo(id: string, over: Partial<TLShape> = {}, text = ''): TLShape {
  return shape({
    ...base(id, 'geo', over),
    props: {
      geo: 'rectangle',
      dash: 'draw',
      url: '',
      w: 100,
      h: 100,
      growY: 0,
      scale: 1,
      flipX: false,
      flipY: false,
      labelColor: 'black',
      color: 'black',
      fill: 'none',
      size: 'm',
      font: 'draw',
      align: 'middle',
      verticalAlign: 'middle',
      richText: toRichText(text),
    },
  })
}

export function frame(id: string, name: string, over: Partial<TLShape> = {}): TLShape {
  return shape({ ...base(id, 'frame', over), props: { w: 400, h: 300, name, color: 'black' } })
}

export function group(id: string, over: Partial<TLShape> = {}): TLShape {
  return shape({ ...base(id, 'group', over), props: {} })
}

export function arrow(id: string, over: Partial<TLShape> = {}): TLShape {
  return shape({
    ...base(id, 'arrow', over),
    props: {
      kind: 'arc',
      labelColor: 'black',
      color: 'black',
      fill: 'none',
      dash: 'draw',
      size: 'm',
      arrowheadStart: 'none',
      arrowheadEnd: 'arrow',
      font: 'draw',
      start: { x: 0, y: 0 },
      end: { x: 200, y: 0 },
      bend: 0,
      richText: toRichText(''),
      labelPosition: 0.5,
      scale: 1,
      elbowMidPoint: 0.5,
    },
  })
}

export function arrowBinding(
  id: string,
  arrowId: string,
  toId: string,
  terminal: 'start' | 'end',
): TLBinding {
  return draftroomSchema.types.binding.validate({
    id: createBindingId(id),
    typeName: 'binding',
    type: 'arrow',
    fromId: arrowId,
    toId,
    meta: {},
    props: { terminal, normalizedAnchor: { x: 0.5, y: 0.5 }, isExact: false, isPrecise: false, snap: 'none' },
  }) as TLBinding
}

export async function until(check: () => boolean, timeoutMs = 10_000) {
  const end = Date.now() + timeoutMs
  while (!check()) {
    if (Date.now() > end) throw new Error('timed out')
    await new Promise((r) => setTimeout(r, 5))
  }
}

const B62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'
/** A distinct valid fractional index key per i (order does not matter to these tests). */
export function indexFor(i: number): TLShape['index'] {
  let n = i
  let digits = ''
  do {
    digits = B62[n % 62] + digits
    n = Math.floor(n / 62)
  } while (n > 0)
  return `a1${digits}V` as TLShape['index']
}
