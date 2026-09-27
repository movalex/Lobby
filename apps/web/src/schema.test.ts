import { draftroomSchema } from '@draftroom/canvas-schema'
import { createTLSchemaFromUtils, defaultBindingUtils, defaultShapeUtils } from 'tldraw'
import { describe, expect, it } from 'vitest'
import { FileCardShapeUtil } from './file-card/FileCardShapeUtil.tsx'

const sortKeys = (v: unknown): unknown =>
  Array.isArray(v)
    ? v.map(sortKeys)
    : v && typeof v === 'object'
      ? Object.fromEntries(
          Object.entries(v as object)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([k, x]) => [k, sortKeys(x)]),
        )
      : v

describe('client schema == server schema', () => {
  it('utils-derived client schema serializes identically to the shared server schema', () => {
    const client = createTLSchemaFromUtils({
      shapeUtils: [...defaultShapeUtils, FileCardShapeUtil],
    }).serialize()
    const withBindings = createTLSchemaFromUtils({
      shapeUtils: [...defaultShapeUtils, FileCardShapeUtil],
      bindingUtils: [...defaultBindingUtils],
    }).serialize()
    const server = draftroomSchema.serialize()
    expect(JSON.stringify(sortKeys(client))).toBe(JSON.stringify(sortKeys(server)))
    expect(JSON.stringify(sortKeys(withBindings))).toBe(JSON.stringify(sortKeys(server)))
  })
  it('omitting defaultShapeUtils throws (arrow binding needs the arrow shape)', () => {
    expect(() =>
      createTLSchemaFromUtils({ shapeUtils: [FileCardShapeUtil], bindingUtils: [...defaultBindingUtils] }),
    ).toThrow()
  })
})
