// OWNER: 3f. The workshops feature's element readers on the Excalidraw page.
import { describe, expect, it } from 'vitest'
import {
  elementIdOf,
  elementLabel,
  frameOf,
  isEligibleElement,
  isPlusOneTarget,
  labelOfRef,
  oneLine,
  refOf,
  typeNameOfRef,
  voteLookup,
  voteTypeOf,
} from './elements.ts'
import { el, note } from './test-kit.ts'

const VERSION = 'ver_0123456789abcdef'
const file = (kind: string, fileId = VERSION) =>
  el('f', 'image', {
    fileId,
    customData: {
      lobby: { file: { versionId: VERSION, kind, assetId: 'ast_0123456789', name: 'deck.pdf' } },
    },
  })

describe('the vote vocabulary (the api objectTypeOf table)', () => {
  it('names every element type as the api does', () => {
    expect(voteTypeOf(el('a', 'stickynote'))).toBe('note')
    for (const t of ['rectangle', 'ellipse', 'diamond']) expect(voteTypeOf(el('a', t))).toBe('geo')
    expect(voteTypeOf(el('a', 'text'))).toBe('text')
    expect(voteTypeOf(el('a', 'text', { containerId: 'n' }))).toBeNull()
    expect(voteTypeOf(el('a', 'freedraw'))).toBe('draw')
    expect(voteTypeOf(el('a', 'freedraw', { customData: { lobby: { kind: 'highlight' } } }))).toBe(
      'highlight',
    )
    for (const t of ['arrow', 'line', 'frame']) expect(voteTypeOf(el('a', t))).toBe(t)
    expect(voteTypeOf(el('a', 'embeddable'))).toBeNull()
  })

  it('tells images, file cards and videos apart by the file facts', () => {
    expect(voteTypeOf(el('a', 'image'))).toBe('image')
    expect(voteTypeOf(file('image'))).toBe('image')
    expect(voteTypeOf(file('pdf'))).toBe('dr-file-card')
    expect(voteTypeOf(file('other'))).toBe('dr-file-card')
    expect(voteTypeOf(file('video'))).toBe('video')
    // a placed PDF page is an image; facts of another version are not this file's
    expect(voteTypeOf(file('pdf', `${VERSION}.p2`))).toBe('image')
    expect(
      voteTypeOf(el('a', 'image', { fileId: VERSION, customData: { lobby: { file: { versionId: 'x' } } } })),
    ).toBe('image')
  })
})

describe('refs and eligibility', () => {
  it('maps element ids to the api refs it can name, and back', () => {
    expect(refOf('abc_-9')).toBe('shape:abc_-9')
    expect(refOf('a.b')).toBeNull() // the vote contract has no `.` or `:`
    expect(elementIdOf('shape:abc')).toBe('abc')
    expect(elementIdOf('abc')).toBeNull()
  })

  it('follows the shared rule: frame scope through frameId, labels never, deleted never', () => {
    const elements = [
      el('fr', 'frame'),
      ...note('in', 'Inside', { frameId: 'fr' }),
      ...note('out', 'Outside'),
      el('geo', 'rectangle', { frameId: 'fr' }),
      el('arr', 'arrow', { frameId: 'fr' }),
      el('gone', 'stickynote', { frameId: 'fr', isDeleted: true }),
    ]
    const get = (id: string) => elements.find((e) => e.id === id)
    const frameNotes = { scope: 'frame' as const, frameId: 'shape:fr', shapeTypes: ['note'] }
    expect(isEligibleElement('in', get, frameNotes)).toBe(true)
    expect(isEligibleElement('out', get, frameNotes)).toBe(false)
    expect(isEligibleElement('geo', get, frameNotes)).toBe(false)
    expect(isEligibleElement('fr', get, frameNotes)).toBe(false)
    expect(isEligibleElement('in-label', get, frameNotes)).toBe(false)
    expect(isEligibleElement('gone', get, frameNotes)).toBe(false)
    const board = { scope: 'board' as const, frameId: null, shapeTypes: null }
    expect(isEligibleElement('geo', get, board)).toBe(true)
    expect(isEligibleElement('fr', get, board)).toBe(true)
    expect(isEligibleElement('arr', get, board)).toBe(false)
    expect(voteLookup(get)('shape:in')).toEqual({ id: 'shape:in', type: 'note', parentId: 'shape:fr' })
    expect(voteLookup(get)('shape:out')).toEqual({ id: 'shape:out', type: 'note', parentId: 'page:page' })
  })
})

describe('labels', () => {
  const elements = [
    ...note('n', 'Idea 0\n\n  Owner:   producer '),
    el('fr', 'frame', { name: ' Retro ' }),
    el('img', 'image', { customData: { lobby: { alt: 'A photo' } } }),
    file('pdf'),
    el('box', 'rectangle'),
  ]
  const get = (id: string) => elements.find((e) => e.id === id)
  it('uses the words (lines joined with " · "), a frame name, alt text, a file name, else Untitled', () => {
    expect(oneLine('a\n\n b \r\nc')).toBe('a · b · c')
    expect(labelOfRef('shape:n', get)).toBe('Idea 0 · Owner: producer')
    expect(labelOfRef('shape:fr', get)).toBe('Retro')
    expect(labelOfRef('shape:img', get)).toBe('A photo')
    expect(labelOfRef('shape:f', get)).toBe('deck.pdf')
    expect(labelOfRef('shape:box', get)).toBe('Untitled shape')
    expect(labelOfRef('shape:nope', get)).toBe('Deleted object')
    expect(elementLabel(el('t', 'text', { originalText: 'x'.repeat(200) }), get)).toHaveLength(140)
  })
  it('type names for the CSV', () => {
    expect(typeNameOfRef('shape:n', get)).toBe('Sticky note')
    expect(typeNameOfRef('shape:box', get)).toBe('Shape')
    expect(typeNameOfRef('shape:f', get)).toBe('File')
    expect(typeNameOfRef('shape:nope', get)).toBe('Deleted')
  })
  it('frames and +1 targets', () => {
    const all = [el('fr', 'frame'), ...note('n2', 'x', { frameId: 'fr' })]
    const g = (id: string) => all.find((e) => e.id === id)
    expect(frameOf(g('n2-label'), g)?.id).toBe('fr')
    expect(frameOf(g('fr'), g)?.id).toBe('fr')
    expect(isPlusOneTarget(g('n2'))).toBe(true)
    expect(isPlusOneTarget(g('n2-label'))).toBe(false)
  })
})
