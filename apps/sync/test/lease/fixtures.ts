import { draftroomSchema } from '@draftroom/canvas-schema'
import { createShapeId, type TLShape, toRichText } from '@tldraw/tlschema'

/** A schema-valid default note shape (validated, so a schema change breaks the fixture loudly). */
export function note(text: string, over: Partial<TLShape> = {}): TLShape {
  const rec = {
    id: createShapeId('n1'),
    typeName: 'shape',
    type: 'note',
    x: 0,
    y: 0,
    rotation: 0,
    index: 'a1',
    parentId: 'page:page',
    isLocked: false,
    opacity: 1,
    meta: {},
    props: {
      color: 'black',
      labelColor: 'black',
      size: 'm',
      font: 'draw',
      fontSizeAdjustment: null,
      align: 'middle',
      verticalAlign: 'middle',
      growY: 0,
      url: '',
      richText: toRichText(text),
      scale: 1,
      textLastEditedBy: null,
    },
    ...over,
  }
  return draftroomSchema.types.shape.validate(rec) as TLShape
}
