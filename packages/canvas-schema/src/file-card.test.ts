import { createShapeId, type TLRecord } from '@tldraw/tlschema'
import { describe, expect, it } from 'vitest'
import { draftroomSchema, FILE_CARD_TYPE } from './index.ts'

const base = {
  id: createShapeId('fc1'),
  typeName: 'shape' as const,
  type: FILE_CARD_TYPE,
  x: 0,
  y: 0,
  rotation: 0,
  index: 'a1',
  parentId: 'page:page',
  isLocked: false,
  opacity: 1,
  meta: {},
  props: {
    w: 240,
    h: 160,
    assetId: 'ast_0123456789',
    versionId: 'ver_0123456789',
    kind: 'pdf',
    name: 'deck.pdf',
    mimeType: 'application/pdf',
    sizeBytes: 2274,
    status: 'ready',
    pageCount: 4,
    durationMs: null,
    posterDerivativeId: 'drv_0123456789',
  },
}

const validate = (r: unknown) => draftroomSchema.types.shape.validate(r)

describe('dr-file-card schema (server-side, React-free)', () => {
  it('accepts a valid record', () => {
    expect(() => validate(base)).not.toThrow()
  })
  it('rejects URLs, data: URLs, unknown status and extra props', () => {
    expect(() =>
      validate({ ...base, props: { ...base.props, posterDerivativeId: 'https://x/y?X-Amz-Signature=1' } }),
    ).toThrow()
    expect(() =>
      validate({ ...base, props: { ...base.props, assetId: 'data:application/pdf;base64,AAAA' } }),
    ).toThrow()
    expect(() => validate({ ...base, props: { ...base.props, status: 'done' } })).toThrow()
    expect(() => validate({ ...base, props: { ...base.props, url: 'https://x' } })).toThrow()
  })
  it('migrates a v0 record up (adds posterDerivativeId) and back down', () => {
    const current = draftroomSchema.serialize()
    expect(current.sequences[`com.tldraw.shape.${FILE_CARD_TYPE}`]).toBe(1)
    const v0Schema = {
      ...current,
      sequences: { ...current.sequences, [`com.tldraw.shape.${FILE_CARD_TYPE}`]: 0 },
    }
    const { posterDerivativeId: _drop, ...v0Props } = base.props
    const v0 = { ...base, props: v0Props } as unknown as TLRecord
    const up = draftroomSchema.migratePersistedRecord(v0, v0Schema, 'up')
    expect(up.type).toBe('success')
    if (up.type !== 'success') return
    expect((up.value as { props: Record<string, unknown> }).props.posterDerivativeId).toBeNull()
    expect(() => validate(up.value)).not.toThrow()
    const down = draftroomSchema.migratePersistedRecord(up.value, v0Schema, 'down')
    expect(down.type).toBe('success')
    if (down.type === 'success')
      expect('posterDerivativeId' in (down.value as { props: Record<string, unknown> }).props).toBe(false)
  })
})
