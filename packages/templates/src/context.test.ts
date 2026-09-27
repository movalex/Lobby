import type { TLPageId } from '@tldraw/tlschema'
import type { IndexKey } from '@tldraw/utils'
import { describe, expect, it } from 'vitest'
import {
  getTemplate,
  instantiateTemplate,
  isTemplateId,
  parseTemplateContext,
  TEMPLATES,
  type TemplateContext,
  TemplateError,
  type TemplateId,
} from './index.ts'
import { PAGE, shapesOf } from './test-utils.ts'

const good = { pageId: PAGE, origin: { x: 10, y: 20 } }

function errorOf(fn: () => unknown): TemplateError {
  try {
    fn()
  } catch (err) {
    expect(err).toBeInstanceOf(TemplateError)
    return err as TemplateError
  }
  throw new Error('expected a TemplateError')
}

describe('untrusted template ids', () => {
  it.each([
    'nope',
    '__proto__',
    'constructor',
    'toString',
    'hasOwnProperty',
    'BRAINSTORM',
    ' brainstorm',
    '',
    42,
    null,
    undefined,
    {},
    ['brainstorm'],
  ])('rejects %j with a typed error', (id) => {
    expect(errorOf(() => instantiateTemplate(id as TemplateId, good)).code).toBe('unknown-template')
    expect(isTemplateId(id)).toBe(false)
    expect(getTemplate(id)).toBeUndefined()
  })
})

describe('untrusted template contexts', () => {
  const origin = { x: 0, y: 0 }
  const cases: Array<[string, unknown]> = [
    ['null', null],
    ['a string', 'page:abc'],
    ['an empty object', {}],
    ['a shape id as page', { pageId: 'shape:abc', origin }],
    ['a bare page prefix', { pageId: 'page:', origin }],
    ['a page id with spaces', { pageId: 'page:a b', origin }],
    ['a page id with markup', { pageId: 'page:<script>', origin }],
    ['a very long page id', { pageId: `page:${'a'.repeat(500)}`, origin }],
    ['a numeric page id', { pageId: 7, origin }],
    ['a missing origin', { pageId: PAGE }],
    ['a null origin', { pageId: PAGE, origin: null }],
    ['NaN coordinates', { pageId: PAGE, origin: { x: Number.NaN, y: 0 } }],
    ['infinite coordinates', { pageId: PAGE, origin: { x: 0, y: Number.POSITIVE_INFINITY } }],
    ['huge coordinates', { pageId: PAGE, origin: { x: 1e12, y: 0 } }],
    ['string coordinates', { pageId: PAGE, origin: { x: '0', y: '0' } }],
    ['object coordinates', { pageId: PAGE, origin: { x: { valueOf: () => 1 }, y: 0 } }],
    ['an invalid indexAbove', { pageId: PAGE, origin, indexAbove: 'zzz' }],
    ['an empty indexAbove', { pageId: PAGE, origin, indexAbove: '' }],
    ['a non-string indexAbove', { pageId: PAGE, origin, indexAbove: 5 }],
    ['a __proto__ indexAbove', { pageId: PAGE, origin, indexAbove: '__proto__' }],
    [
      'a throwing getter',
      Object.defineProperty({ origin }, 'pageId', {
        enumerable: true,
        get: () => {
          throw new Error('boom')
        },
      }),
    ],
    ['inherited fields only', Object.create({ pageId: PAGE, origin })],
    ['an inherited origin', Object.assign(Object.create({ origin }), { pageId: PAGE })],
  ]

  it.each(cases)('rejects %s with a typed error', (_label, ctx) => {
    expect(errorOf(() => instantiateTemplate('brainstorm', ctx as TemplateContext)).code).toBe(
      'invalid-context',
    )
    expect(errorOf(() => parseTemplateContext(ctx)).code).toBe('invalid-context')
    // The definitions' own build() validates too.
    for (const t of TEMPLATES)
      expect(errorOf(() => t.build(ctx as TemplateContext)).code).toBe('invalid-context')
  })

  it('rejects a Proxy whose traps throw', () => {
    const hostile = new Proxy(
      {},
      {
        getOwnPropertyDescriptor() {
          throw new Error('trap')
        },
        get() {
          throw new Error('trap')
        },
      },
    )
    expect(errorOf(() => parseTemplateContext(hostile)).code).toBe('invalid-context')
  })

  it('accepts valid contexts, ignores unknown keys and copies the values it keeps', () => {
    const ctx = {
      pageId: 'page:Main_1-2' as TLPageId,
      origin: { x: -500, y: 1e6 },
      indexAbove: 'a1V' as IndexKey,
      extra: { evil: true },
      __proto__: { polluted: true },
    }
    const parsed = parseTemplateContext(ctx)
    expect(parsed).toEqual({ pageId: 'page:Main_1-2', origin: { x: -500, y: 1e6 }, indexAbove: 'a1V' })
    expect(parsed.origin).not.toBe(ctx.origin)
    const { records, bounds } = instantiateTemplate('storyboard', ctx)
    expect(bounds.x).toBe(-500)
    expect(bounds.y).toBe(1e6)
    ctx.origin.x = 999
    expect(bounds.x).toBe(-500)
    for (const s of shapesOf(records)) {
      expect(s.parentId === 'page:Main_1-2' || s.parentId.startsWith('shape:')).toBe(true)
    }
  })

  it('does not pollute Object.prototype', () => {
    const before = Object.getOwnPropertyNames(Object.prototype).sort()
    for (const t of TEMPLATES)
      instantiateTemplate(t.id, JSON.parse(`{"pageId":"${PAGE}","origin":{"x":0,"y":0},"__proto__":{"x":1}}`))
    expect(Object.getOwnPropertyNames(Object.prototype).sort()).toEqual(before)
    expect(({} as Record<string, unknown>).x).toBeUndefined()
  })
})
