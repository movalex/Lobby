import { describe, expect, it } from 'vitest'
import {
  BOARD_TAG_PREFIX,
  boardTagMetaKey,
  isShapeTagMetaKey,
  MAX_TAGS_PER_BOARD,
  MAX_TAGS_PER_SHAPE,
  normalizeTagName,
  parseBoardTags,
  parseShapeTags,
  parseTagValue,
  SHAPE_TAG_PREFIX,
  shapeTagMetaKey,
  TAG_COLOR_ROTATION,
  TAG_COLORS,
  tagKey,
  tagNameError,
} from './tags.ts'

describe('tag names', () => {
  it('normalizes what people type: #, spacing, controls and bidi overrides go; case and accents stay', () => {
    expect(normalizeTagName('  #Research  ')).toBe('Research')
    expect(normalizeTagName('##  user   research')).toBe('user research')
    // Invisible and combining characters are built from code points (none are written in this file).
    const cp = String.fromCodePoint
    expect(normalizeTagName(`Cafe${cp(0x301)}`)).toBe(`Caf${cp(0xe9)}`) // NFC
    // NUL, a right-to-left override and a zero-width space
    expect(normalizeTagName(`a${cp(0)}b${cp(0x202e)}c${cp(0x200b)}d`)).toBe('abcd')
    expect(normalizeTagName(`x${cp(0x200b)} ${cp(0x200b)} y`)).toBe('x y')
    expect(normalizeTagName('line\nbreak\ttab')).toBe('line break tab')
    // emoji sequences keep their zero-width joiner
    const coder = `${cp(0x1f469)}${cp(0x200d)}${cp(0x1f4bb)}`
    expect(normalizeTagName(`${coder} dev`)).toBe(`${coder} dev`)
    expect(normalizeTagName('#')).toBe('')
  })

  it('refuses empty names and names over 24 characters (code points, not UTF-16 units)', () => {
    expect(tagNameError('')).toMatch(/Type a name/)
    expect(tagNameError('x'.repeat(24))).toBeNull()
    expect(tagNameError('x'.repeat(25))).toMatch(/at most 24/)
    expect(tagNameError('😀'.repeat(24))).toBeNull()
  })

  it('keys are case-insensitive, compatibility-folded and whitespace-free', () => {
    expect(tagKey('Research')).toBe('research')
    expect(tagKey('  #RESEARCH ')).toBe('research')
    expect(tagKey('User research')).toBe('user-research')
    expect(tagKey('user-research')).toBe('user-research')
    expect(tagKey('Ｒｅｓｅａｒｃｈ')).toBe('research') // fullwidth letters (NFKC)
    expect(tagKey('Résumé')).not.toBe(tagKey('Resume')) // accents are part of the word
    expect(/\s/.test(tagKey('a b\tc'))).toBe(false)
  })
})

describe('parsing stored tags (validated on read)', () => {
  it('reads valid entries and ignores everything else', () => {
    const meta = {
      [shapeTagMetaKey('research')]: { name: 'Research', color: 'blue' },
      [shapeTagMetaKey('idea')]: { name: 'Idea', color: 'not-a-colour' },
      [shapeTagMetaKey('other')]: { name: 'Mismatch', color: 'red' }, // key is not tagKey(name)
      [shapeTagMetaKey('padded')]: { name: ' padded', color: 'red' }, // not normalized
      [shapeTagMetaKey('long')]: { name: 'x'.repeat(25), color: 'red' },
      [shapeTagMetaKey('nul')]: null,
      drMindmap: { rootId: 'x' },
      research: { name: 'Research', color: 'blue' }, // no prefix
    }
    expect(parseShapeTags(meta)).toEqual([{ key: 'research', name: 'Research', color: 'blue' }])
    expect(parseShapeTags(null)).toEqual([])
    expect(parseShapeTags([])).toEqual([])
    expect(parseTagValue('research', { name: 'Research', color: 'blue', extra: 1 })).toEqual({
      key: 'research',
      name: 'Research',
      color: 'blue',
    })
  })

  it('caps a shape at 10 and a board at 200, the same subset for everyone (key order)', () => {
    const shape: Record<string, unknown> = {}
    for (let i = 0; i < 12; i++)
      shape[shapeTagMetaKey(`t${String(i).padStart(2, '0')}`)] = {
        name: `T${String(i).padStart(2, '0')}`,
        color: 'grey',
      }
    const read = parseShapeTags(shape)
    expect(read).toHaveLength(MAX_TAGS_PER_SHAPE)
    expect(read.map((t) => t.key)).toEqual(
      Array.from({ length: 10 }, (_, i) => `t${String(i).padStart(2, '0')}`),
    )

    const doc: Record<string, unknown> = {}
    for (let i = 0; i < 205; i++)
      doc[boardTagMetaKey(`b${String(i).padStart(3, '0')}`)] = {
        name: `B${String(i).padStart(3, '0')}`,
        color: 'red',
      }
    expect(parseBoardTags(doc)).toHaveLength(MAX_TAGS_PER_BOARD)
  })

  it('keeps shape and board entries apart', () => {
    const meta = {
      [shapeTagMetaKey('a')]: { name: 'A', color: 'red' },
      [boardTagMetaKey('b')]: { name: 'B', color: 'red' },
    }
    expect(parseShapeTags(meta).map((t) => t.key)).toEqual(['a'])
    expect(parseBoardTags(meta).map((t) => t.key)).toEqual(['b'])
    expect(SHAPE_TAG_PREFIX).toBe('drTags:')
    expect(BOARD_TAG_PREFIX).toBe('drTagList:')
    expect(isShapeTagMetaKey('drTags:a')).toBe(true)
    expect(isShapeTagMetaKey('drTagList:a')).toBe(false)
  })

  it('a key can never be a special property name', () => {
    expect(shapeTagMetaKey(tagKey('__proto__'))).toBe('drTags:__proto__')
    const meta = JSON.parse('{"drTags:__proto__": {"name": "__proto__", "color": "red"}}')
    expect(parseShapeTags(meta)).toEqual([{ key: '__proto__', name: '__proto__', color: 'red' }])
  })

  it('the colour rotation uses every note colour once', () => {
    expect([...TAG_COLOR_ROTATION].sort()).toEqual([...TAG_COLORS].sort())
  })
})
